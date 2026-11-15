import { HttpStatusError } from './requestControl';
import type { ChatRequestOptions, ChatResponse, ReasoningEffort, ToolCall } from '../types';

/**
 * Calls the Gemini API's native `generateContent` with a Chat Completions-shaped request and
 * returns a Chat Completions-shaped answer. Used for the Google sign-in, whose OAuth tokens the
 * native API documents (the OpenAI-compatible endpoint documents API keys only).
 *
 * - System text goes to `systemInstruction`; assistant turns are `model` turns; tool results
 *   are `functionResponse` parts in a `user` turn, matched to their call by name.
 * - Tools are sent as `functionDeclarations` with `parametersJsonSchema`, so full JSON Schema
 *   passes through unchanged.
 * - Gemini 3 and later return a `thoughtSignature` with each function call that must be sent back
 *   with it; it rides on the tool call as `thought_signature`.
 * - Reasoning effort maps to `thinkingConfig.thinkingLevel` (low, medium or high).
 */
export interface GeminiCall {
  model: string;
  token: (retry: boolean) => Promise<string>;
  projectId: string;
  options: ChatRequestOptions;
  effort?: ReasoningEffort;
  /** Cancels the request. */
  signal?: AbortSignal;
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

type Part = Record<string, unknown>;
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

/** @param effort - Plugin effort. */
export function thinkingLevel(effort: ReasoningEffort | undefined): string | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/** @param content - Message content. */
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map(p =>
        typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text) : '',
      )
      .filter(Boolean)
      .join('\n');
  return '';
}

/**
 * @param options - Chat Completions request.
 * @param effort - Reasoning effort.
 */
export function toGeminiBody(
  options: ChatRequestOptions,
  effort?: ReasoningEffort,
): Record<string, unknown> {
  const system: string[] = [];
  const contents: Content[] = [];
  const names = new Map<string, string>();
  const push = (role: Content['role'], parts: Part[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of options.messages) {
    const t = text(m.content);
    if (m.role === 'system' || m.role === 'developer') {
      if (t) system.push(t);
    } else if (m.role === 'assistant') {
      const parts: Part[] = t ? [{ text: t }] : [];
      for (const call of m.tool_calls ?? []) {
        if (call.id) names.set(call.id, call.function.name);
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }
        parts.push({
          functionCall: { name: call.function.name, args },
          ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}),
        });
      }
      if (parts.length) push('model', parts);
    } else if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id ?? '';
      push('user', [
        { functionResponse: { name: names.get(id) ?? 'tool', response: { content: t } } },
      ]);
    } else {
      push('user', [{ text: t || ' ' }]);
    }
  }
  const generationConfig: Record<string, unknown> = {};
  if (options.max_completion_tokens)
    generationConfig.maxOutputTokens = options.max_completion_tokens;
  const level = thinkingLevel(effort);
  if (level) generationConfig.thinkingConfig = { thinkingLevel: level };
  const body: Record<string, unknown> = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (options.tools?.length) {
    body.tools = [
      {
        functionDeclarations: options.tools.map(tool => ({
          name: tool.function.name,
          description: tool.function.description,
          parametersJsonSchema: tool.function.parameters,
        })),
      },
    ];
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: Part[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/** @param data - generateContent response. */
export function fromGeminiResponse(data: GeminiResponse): ChatResponse {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  if (!parts.length) {
    const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason;
    if (reason && reason !== 'STOP') throw new Error(`Gemini returned nothing (${reason}).`);
  }
  let out = '';
  const calls: ToolCall[] = [];
  for (const part of parts) {
    if (part.thought) continue;
    if (typeof part.text === 'string') out += part.text;
    const fc = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
    if (fc?.name) {
      calls.push({
        id: fc.id ?? `call_${calls.length}_${Date.now().toString(36)}`,
        type: 'function',
        function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
        ...(typeof part.thoughtSignature === 'string'
          ? { thought_signature: part.thoughtSignature }
          : {}),
      });
    }
  }
  return calls.length
    ? { role: 'assistant', content: out || null, tool_calls: calls }
    : { role: 'assistant', content: out };
}

/**
 * One non-streamed generateContent call, retried once after a 401 with a fresh token.
 * @param call - Request.
 */
export async function callGemini(call: GeminiCall): Promise<ChatResponse> {
  const model = call.model.replace(/^models\//, '');
  const body = JSON.stringify(toGeminiBody(call.options, call.effort));
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await call.token(attempt > 0);
    // eslint-disable-next-line no-restricted-globals
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-user-project': call.projectId,
        'content-type': 'application/json',
      },
      body,
      signal: call.signal,
    });
    if (res.status === 401 && attempt === 0) continue;
    let data: GeminiResponse = {};
    try {
      data = (await res.json()) as GeminiResponse;
    } catch {
      // Not JSON.
    }
    if (!res.ok)
      throw new HttpStatusError(
        `Gemini (${res.status}): ${data.error?.message ?? res.statusText}`,
        res.status,
      );
    return fromGeminiResponse(data);
  }
  throw new Error('Gemini: not authorised. Sign in with Google again.');
}
