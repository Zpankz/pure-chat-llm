// A pi-ai provider whose models are the plugin's layers (orchestrator, worker, evaluator). Every
// request goes through the plugin's own `layerFetch`, so sign-ins (ChatGPT, Google), endpoints,
// reasoning levels, deadlines, retries and `[timing]` logs stay exactly as validated on the Classic
// engine. pi-ai only sees a provider that answers each request in one piece.
import type { ChatRequestOptions, ChatResponse, MediaMessage, ToolDefinition } from '../types';
import {
  collapseSystemMessages,
  createAssistantMessageEventStream,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
} from './pi';
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ModelToolCall,
  ProviderStreams,
  StreamOptions,
  TranscriptContext,
  Usage,
} from './pi';

/** The provider id durable conversations name in their model choice. */
export const LAYER_PROVIDER_ID = 'voice-agent';
/** The pi-ai API name of a layer model (one implementation, below). */
export const LAYER_API = 'voice-agent-layer';

export type LayerName = 'orchestrator' | 'worker' | 'evaluator';
export const LAYER_NAMES: readonly LayerName[] = ['orchestrator', 'worker', 'evaluator'];

/** One request on a layer, in the Chat Completions shape `layerFetch` takes. */
export interface LayerSendRequest {
  messages: ChatRequestOptions['messages'];
  tools?: ToolDefinition[];
  max_completion_tokens?: number;
}

/** Sends one request on a layer; the plugin passes a wrapper around `layerFetch`. */
export type LayerSend = (
  layer: LayerName,
  request: LayerSendRequest,
  control: { signal?: AbortSignal },
) => Promise<ChatResponse>;

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * The catalog entry of one layer. Reasoning is off on pi's side because the layer's own effort
 * setting is applied by `layerFetch`; the limits are generous because the layer's model decides.
 * @param layer - Layer name, also the model id.
 */
export function layerModel(layer: LayerName): Model<string> {
  return {
    id: layer,
    name: `Voice Agent ${layer} layer`,
    api: LAYER_API,
    provider: LAYER_PROVIDER_ID,
    baseUrl: '',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
  };
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('\n');
}

/**
 * Turns pi-ai's transcript into the Chat Completions request `layerFetch` sends: one leading
 * system message with the current prompt (later system messages replayed into it), the current
 * tools, and the turns in order. Thinking is not sent back (`layerFetch` doesn't take it).
 * @param context - Normalized transcript.
 */
export function toLayerRequest(context: TranscriptContext): LayerSendRequest {
  const collapsed = collapseSystemMessages(context);
  const messages: ChatRequestOptions['messages'] = [];
  const prompt = getCurrentSystemPrompt(collapsed.messages);
  if (prompt) messages.push({ role: 'system', content: prompt });
  for (const message of collapsed.messages) {
    switch (message.role) {
      case 'system':
        break; // folded into the leading prompt above
      case 'user': {
        if (typeof message.content === 'string') {
          messages.push({ role: 'user', content: message.content });
          break;
        }
        const parts: MediaMessage[] = message.content.map(part =>
          part.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
            : { type: 'text', text: part.text },
        );
        messages.push({ role: 'user', content: parts });
        break;
      }
      case 'assistant': {
        const calls = message.content.filter((c): c is ModelToolCall => c.type === 'toolCall');
        const content = textOf(message.content);
        messages.push({
          role: 'assistant',
          content: content || null,
          ...(calls.length
            ? {
                tool_calls: calls.map(c => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                  ...(c.thoughtSignature ? { thought_signature: c.thoughtSignature } : {}),
                })),
              }
            : {}),
        });
        break;
      }
      case 'toolResult':
        messages.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: textOf(message.content) || '(no output)',
        });
        break;
    }
  }
  const tools: ToolDefinition[] = getCurrentTools(collapsed.messages).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as ToolDefinition['function']['parameters'],
    },
  }));
  return { messages, ...(tools.length ? { tools } : {}) };
}

/**
 * Turns a layer's answer into pi-ai's assistant message. Arguments that are not one JSON object
 * become `{}` with `argumentsError`, so pi's validation tells the model what was wrong.
 * @param response - Layer response.
 * @param model - Layer model.
 * @param timestamp - When the request started.
 */
export function toAssistantMessage(
  response: ChatResponse,
  model: Model<string>,
  timestamp: number,
): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  const text = (response.content ?? '').trim();
  if (text) content.push({ type: 'text', text });
  for (const [i, call] of (response.tool_calls ?? []).entries()) {
    if (!call.function?.name) continue;
    const raw = call.function.arguments || '{}';
    let args: Record<string, unknown> = {};
    let argumentsError: string | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else argumentsError = `The arguments were not one JSON object: ${raw.slice(0, 500)}`;
    } catch {
      argumentsError = `The arguments were not valid JSON: ${raw.slice(0, 500)}`;
    }
    content.push({
      type: 'toolCall',
      id: call.id || `call_${timestamp}_${i}`,
      name: call.function.name,
      arguments: args as ModelToolCall['arguments'],
      ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}),
      ...(argumentsError ? { argumentsError } : {}),
    });
  }
  const usesTools = content.some(c => c.type === 'toolCall');
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: usesTools ? 'toolUse' : 'stop',
    timestamp,
  };
}

function failure(
  model: Model<string>,
  timestamp: number,
  reason: 'error' | 'aborted',
  message: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: reason,
    errorMessage: message,
    timestamp,
  };
}

/** Replays a finished message as pi-ai's event sequence: start, each block, done. */
function emit(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  const partial: AssistantMessage = { ...message, content: [] };
  stream.push({ type: 'start', partial: { ...partial } });
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      partial.content.push({ type: 'text', text: '' });
      stream.push({ type: 'text_start', contentIndex: index, partial: { ...partial } });
      partial.content[index] = { type: 'text', text: block.text };
      stream.push({
        type: 'text_delta',
        contentIndex: index,
        delta: block.text,
        partial: { ...partial },
      });
      stream.push({
        type: 'text_end',
        contentIndex: index,
        content: block.text,
        partial: { ...partial },
      });
    } else if (block.type === 'toolCall') {
      partial.content.push({ ...block, arguments: {} });
      stream.push({ type: 'toolcall_start', contentIndex: index, partial: { ...partial } });
      partial.content[index] = block;
      stream.push({
        type: 'toolcall_delta',
        contentIndex: index,
        delta: JSON.stringify(block.arguments),
        partial: { ...partial },
      });
      stream.push({
        type: 'toolcall_end',
        contentIndex: index,
        toolCall: block,
        partial: { ...partial },
      });
    }
  });
  stream.push({
    type: 'done',
    reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
    message,
  });
}

/**
 * The provider's stream implementation: one `send` per request, replayed as events.
 * @param send - Sends a request on a layer.
 */
export function layerStreams(send: LayerSend): ProviderStreams {
  const stream = (
    model: Model<string>,
    context: TranscriptContext,
    options?: StreamOptions,
  ): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    const timestamp = Date.now();
    void (async () => {
      const signal = options?.signal;
      if (!LAYER_NAMES.includes(model.id as LayerName)) {
        out.push({
          type: 'error',
          reason: 'error',
          error: failure(model, timestamp, 'error', `Unknown layer "${model.id}".`),
        });
        return;
      }
      try {
        const request = toLayerRequest(context);
        if (options?.maxTokens) request.max_completion_tokens = options.maxTokens;
        const response = await send(model.id as LayerName, request, { signal });
        emit(out, toAssistantMessage(response, model, timestamp));
      } catch (error) {
        const aborted = signal?.aborted === true;
        const message = error instanceof Error ? error.message : String(error);
        out.push({
          type: 'error',
          reason: aborted ? 'aborted' : 'error',
          error: failure(model, timestamp, aborted ? 'aborted' : 'error', message),
        });
      }
    })();
    return out;
  };
  return { stream, streamSimple: stream };
}

/**
 * The pi-ai provider of the plugin's layers. It needs no key of its own: `layerFetch` checks each
 * layer's sign-in or key and fails the request with the same message as on the Classic engine.
 * @param send - Sends a request on a layer.
 */
export function createLayerProvider(send: LayerSend) {
  return createProvider({
    id: LAYER_PROVIDER_ID,
    name: 'Voice Agent layers',
    auth: { apiKey: { name: 'Voice Agent layers', resolve: async () => ({ auth: {} }) } },
    models: LAYER_NAMES.map(layerModel),
    api: layerStreams(send),
  });
}
