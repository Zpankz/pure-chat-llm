// The models the shared memory uses, from the plugin's settings: the worker layer for the
// librarian, and an OpenAI-compatible `/embeddings` endpoint for recall by meaning. Kept apart
// from MemoryService so the service stays free of the plugin (and testable with fake models).
import { EmptyApiKey } from '../assets/constants';
import { layerFetch, layerProblem, resolveLayer } from '../agents/layers';
import type PureChatLLM from '../main';
import type { PureChatLLMAPI } from '../types';
import type { Embedded } from './MemoryGraph';
import type { MemoryService, MemorySettings } from './MemoryService';
import { compactVector } from './text';

/** Stored vector length for models trained so that a cut vector still works. */
export const EMBED_DIMS = 256;

/** An embeddings endpoint and model. */
export interface EmbeddingTarget {
  endpoint: PureChatLLMAPI;
  model: string;
  /** Ask for (or cut to) this many dimensions; 0 keeps the model's. */
  dims: number;
  /** The provider takes a `dimensions` field. */
  sendDims: boolean;
}

/** Usual embedding models of the providers that have an OpenAI-compatible endpoint for them. */
const KNOWN: { host: RegExp; model: string; dims: number; sendDims: boolean }[] = [
  { host: /api\.openai\.com/, model: 'text-embedding-3-small', dims: EMBED_DIMS, sendDims: true },
  {
    host: /generativelanguage\.googleapis\.com/,
    model: 'gemini-embedding-001',
    dims: EMBED_DIMS,
    sendDims: false,
  },
  { host: /api\.mistral\.ai/, model: 'mistral-embed', dims: 0, sendDims: false },
  {
    host: /localhost:11434|127\.0\.0\.1:11434/,
    model: 'nomic-embed-text',
    dims: 0,
    sendDims: false,
  },
];

/** Models trained so that the first dimensions of a vector still work on their own. */
const CUTTABLE = /text-embedding-3|gemini-embedding|nomic-embed-text/;

function hasKey(endpoint: PureChatLLMAPI): boolean {
  return (
    (!!endpoint.apiKey && endpoint.apiKey !== EmptyApiKey) ||
    /localhost|127\.0\.0\.1/.test(endpoint.endpoint)
  );
}

/**
 * The endpoint and model for embeddings: the one named in settings, or else the first of
 * OpenAI, Gemini and Mistral that has a key. Null when there is none or embeddings are off.
 * @param settings - Memory settings.
 * @param endpoints - Configured endpoints.
 */
export function embeddingTarget(
  settings: Pick<MemorySettings, 'embeddingEndpoint' | 'embeddingModel'>,
  endpoints: PureChatLLMAPI[],
): EmbeddingTarget | null {
  const choice = settings.embeddingEndpoint.trim();
  if (choice.toLowerCase() === 'off') return null;
  const pick = (endpoint: PureChatLLMAPI): EmbeddingTarget | null => {
    if (!hasKey(endpoint)) return null;
    const known = KNOWN.find(k => k.host.test(endpoint.endpoint));
    const model = settings.embeddingModel.trim() || known?.model || '';
    if (!model) return null;
    const dims = CUTTABLE.test(model) ? EMBED_DIMS : 0;
    return {
      endpoint,
      model,
      dims,
      sendDims: dims > 0 && /api\.openai\.com/.test(endpoint.endpoint),
    };
  };
  if (choice) {
    const named = endpoints.find(e => e.name === choice);
    return named ? pick(named) : null;
  }
  for (const known of KNOWN.slice(0, 3)) {
    const endpoint = endpoints.find(e => known.host.test(e.endpoint) && hasKey(e));
    if (endpoint) return pick(endpoint);
  }
  return null;
}

/**
 * Calls an OpenAI-compatible `/embeddings` endpoint.
 * @param target - Endpoint and model.
 * @param texts - Texts.
 * @param signal - Cancels it.
 */
export async function fetchEmbeddings(
  target: EmbeddingTarget,
  texts: string[],
  signal?: AbortSignal,
): Promise<Embedded[]> {
  // eslint-disable-next-line no-restricted-globals
  const response = await fetch(`${target.endpoint.endpoint.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.endpoint.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: target.model,
      input: texts,
      ...(target.sendDims ? { dimensions: target.dims } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Embeddings from ${target.endpoint.name} failed (${response.status}).`);
  }
  const body = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
  const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== texts.length) throw new Error('The embeddings answer was incomplete.');
  const model = `${target.endpoint.name}/${target.model}${target.dims ? `@${target.dims}` : ''}`;
  return data.map(d => ({ model, vector: compactVector(d.embedding ?? [], target.dims) }));
}

/**
 * Gives the plugin's memory its models, once: the worker layer for the librarian and the
 * embeddings endpoint. Safe to call often; returns the memory service.
 * @param plugin - Plugin.
 */
export function memoryWithModels(plugin: PureChatLLM): MemoryService | undefined {
  const memory = plugin.memory;
  if (!memory || memory.hasModels) return memory;
  memory.setModels({
    complete: async (system, user) => {
      const response = await layerFetch(
        plugin,
        resolveLayer(plugin, 'worker'),
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_completion_tokens: 3000,
        },
        { timeoutMs: 120_000, label: 'The memory librarian request' },
      );
      return response.content ?? '';
    },
    completeProblem: () => layerProblem(plugin, resolveLayer(plugin, 'worker')),
    embedModel: () => {
      const target = embeddingTarget(plugin.settings.memory, plugin.settings.endpoints);
      return target
        ? `${target.endpoint.name}/${target.model}${target.dims ? `@${target.dims}` : ''}`
        : '';
    },
    embed: async texts => {
      const target = embeddingTarget(plugin.settings.memory, plugin.settings.endpoints);
      if (!target) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const out: Embedded[] = [];
        for (let i = 0; i < texts.length; i += 64) {
          out.push(...(await fetchEmbeddings(target, texts.slice(i, i + 64), controller.signal)));
        }
        return out;
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return memory;
}
