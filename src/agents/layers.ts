import { DEFAULT_SETTINGS, EmptyApiKey } from '../assets/constants';
import { LLMService } from '../core/LLMService';
import { callResponses } from '../core/ResponsesClient';
import type PureChatLLM from '../main';
import { callGemini } from '../core/GeminiClient';
import { CHATGPT_SIGN_IN, GOOGLE_SIGN_IN } from '../types';
import type {
  ChatRequestOptions,
  ChatResponse,
  LayerModel,
  LayerSettings,
  OrchestratorSettings,
  PureChatLLMAPI,
  ToolDefinition,
} from '../types';

/**
 * The four layers each run on their own model:
 *
 * 1. Voice: the realtime model (GPT-Live, OpenAI Realtime, Gemini Live, Grok), set in voice
 *    settings. It translates and filters, and relays to the orchestrator.
 * 2. Orchestrator: plans, writes briefs and runs workers.
 * 3. Worker: background sub-agents, and by default the two write reviewers.
 * 4. Evaluator (optional): checks plans and results when the orchestrator asks.
 *
 * Layers 2 to 4 are resolved here to an endpoint, a model, a reasoning effort and an API.
 */
export type LayerId = keyof LayerSettings;

export const LAYER_IDS: LayerId[] = ['orchestrator', 'worker', 'evaluator'];

/**
 * Settings migration: fills in layers, and carries the old sub-agent model over to the worker.
 * @param loaded - Saved orchestrator settings.
 */
export function mergeLayers(
  loaded: (Partial<OrchestratorSettings> & { subAgentModel?: string }) | undefined,
): LayerSettings {
  const d = DEFAULT_SETTINGS.orchestrator.layers;
  const l = loaded?.layers;
  const worker = { ...d.worker, ...l?.worker };
  if (!l?.worker && loaded?.subAgentModel?.trim()) {
    // Before layers, sub-agents ran on the default endpoint with this model.
    worker.endpoint = '';
    worker.model = loaded.subAgentModel.trim();
  }
  return {
    orchestrator: { ...d.orchestrator, ...l?.orchestrator },
    worker,
    evaluator: { ...d.evaluator, ...l?.evaluator },
  };
}

export interface ResolvedLayer {
  layer: string;
  /** Null when the layer runs on ChatGPT sign-in. */
  endpoint: PureChatLLMAPI | null;
  model: string;
  effort: LayerModel['effort'];
  api: 'chat' | 'responses' | 'gemini';
  chatgpt: boolean;
  /** Runs on Gemini with the Google sign-in. */
  google?: boolean;
  /** Short description for settings and logs. */
  label: string;
}

/**
 * Resolves a layer (or an explicit layer model) to what is called.
 * @param plugin - Plugin.
 * @param layer - Layer id or a layer model.
 * @param modelOverride - Model to use instead of the layer's.
 */
export function resolveLayer(
  plugin: PureChatLLM,
  layer: LayerId | LayerModel,
  modelOverride?: string,
): ResolvedLayer {
  const s = plugin.settings;
  const cfg = typeof layer === 'string' ? s.orchestrator.layers[layer] : layer;
  const name = typeof layer === 'string' ? layer : 'custom';
  const fallback = s.endpoints[s.endpoint];
  if (cfg.endpoint === CHATGPT_SIGN_IN) {
    const model = modelOverride?.trim() || cfg.model.trim() || 'gpt-6.1-sol';
    return {
      layer: name,
      endpoint: null,
      model,
      effort: cfg.effort,
      api: 'responses',
      chatgpt: true,
      label: `${model} (ChatGPT sign-in)`,
    };
  }
  if (cfg.endpoint === GOOGLE_SIGN_IN) {
    const model = modelOverride?.trim() || cfg.model.trim() || 'gemini-4-argon';
    return {
      layer: name,
      endpoint: null,
      model,
      effort: cfg.effort,
      api: 'gemini',
      chatgpt: false,
      google: true,
      label: `${model} (Google sign-in)`,
    };
  }
  const endpoint =
    (cfg.endpoint.trim() && s.endpoints.find(e => e.name === cfg.endpoint.trim())) || fallback;
  const model = modelOverride?.trim() || cfg.model.trim() || endpoint.defaultmodel;
  const isOpenAI = /api\.openai\.com/.test(endpoint.endpoint);
  const api = cfg.api === 'auto' ? (isOpenAI ? 'responses' : 'chat') : cfg.api;
  return {
    layer: name,
    endpoint,
    model,
    effort: cfg.effort,
    api,
    chatgpt: false,
    label: `${model} on ${endpoint.name}`,
  };
}

/**
 * Splits `model@Endpoint name` (used for reviewer models).
 * @param ref - Model reference.
 */
export function parseModelRef(ref: string): { model: string; endpoint: string } {
  const at = ref.lastIndexOf('@');
  if (at > 0) return { model: ref.slice(0, at).trim(), endpoint: ref.slice(at + 1).trim() };
  return { model: ref.trim(), endpoint: '' };
}

/**
 * Whether a layer can run now (has a key or a sign-in). Returns a reason when it can't.
 * @param plugin - Plugin.
 * @param resolved - Resolved layer.
 */
export function layerProblem(plugin: PureChatLLM, resolved: ResolvedLayer): string {
  if (resolved.chatgpt) {
    return plugin.chatgpt?.signedIn ? '' : 'Sign in with ChatGPT in settings first.';
  }
  if (resolved.google) {
    return plugin.google?.signedIn ? '' : 'Sign in with Google in settings first.';
  }
  const ep = resolved.endpoint;
  if (!ep) return 'No endpoint.';
  if ((!ep.apiKey || ep.apiKey === EmptyApiKey) && !/localhost|127\.0\.0\.1/.test(ep.endpoint))
    return `Add an API key for ${ep.name}.`;
  return '';
}

const service = new LLMService(false);

/** One agent turn's request; the layer supplies the model. */
export interface LayerRequest {
  messages: ChatRequestOptions['messages'];
  tools?: ToolDefinition[];
  max_completion_tokens?: number;
}

/**
 * Sends one non-streamed agent turn on a layer: Chat Completions with `reasoning_effort`, or
 * Responses (with an API key or the ChatGPT sign-in) with `reasoning.effort`.
 * @param plugin - Plugin.
 * @param resolved - Resolved layer.
 * @param options - Chat Completions request; `model` is replaced by the layer's.
 */
export async function layerFetch(
  plugin: PureChatLLM,
  resolved: ResolvedLayer,
  options: LayerRequest,
): Promise<ChatResponse> {
  const problem = layerProblem(plugin, resolved);
  if (problem) throw new Error(problem);
  const request: ChatRequestOptions = { ...options, model: resolved.model, stream: false };
  if (resolved.google) {
    return callGemini({
      model: resolved.model,
      token: retry => (retry ? plugin.google.refresh() : plugin.google.accessToken()),
      projectId: plugin.google.projectId,
      options: request,
      effort: resolved.effort,
    });
  }
  if (resolved.api === 'responses') {
    if (resolved.chatgpt) {
      return callResponses({
        url: 'https://api.openai.com/v1',
        token: retry => (retry ? plugin.chatgpt.refresh() : plugin.chatgpt.accessToken()),
        options: request,
        effort: resolved.effort,
        chatgptPlan: true,
      });
    }
    const ep = resolved.endpoint as PureChatLLMAPI;
    return callResponses({
      url: ep.endpoint,
      token: () => Promise.resolve(ep.apiKey),
      options: request,
      effort: resolved.effort,
    });
  }
  if (resolved.effort) request.reasoning_effort = resolved.effort;
  return service.fetchResponse(resolved.endpoint as PureChatLLMAPI, request);
}
