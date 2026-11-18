import type { ChatRequestOptions, ChatResponse, ToolCall, ToolDefinition } from '../types';
import { HttpStatusError } from './requestControl';
import type { ReasoningEffort } from '../types';

/**
 * Calls OpenAI's Responses API with a Chat Completions-shaped request and returns a Chat
 * Completions-shaped answer, so agent loops work the same on both APIs.
 *
 * Used for OpenAI models whose tool calling needs Responses (such as gpt-6.1-sol) and for Sign in
 * with ChatGPT, whose documented limits shape the request: `store: false` and `stream: true`,
 * the full history in `input` each time (no `previous_response_id`), system text sent as
 * `instructions` (system-role items are rejected), function tools only, and no `temperature`,
 * `max_output_tokens`, `metadata` or `user`.
 */
export interface ResponsesCall {
  url: string;
  /** Returns the bearer token; called again once after a 401. */
  token: (retry: boolean) => Promise<string>;
  options: ChatRequestOptions;
  effort?: ReasoningEffort;
  /** Send only fields Sign in with ChatGPT accepts. */
  chatgptPlan?: boolean;
  /** Cancels the request. */
  signal?: AbortSignal;
}

interface InputItem {
  [key: string]: unknown;
}

/** @param options - Chat Completions request. */
export function toResponsesBody(
  options: ChatRequestOptions,
  effort: ReasoningEffort | undefined,
  chatgptPlan: boolean,
): Record<string, unknown> {
  const instructions: string[] = [];
  const input: InputItem[] = [];
  for (const m of options.messages) {
    const text = contentText(m.content);
    if (m.role === 'system' || m.role === 'developer') {
      if (text) instructions.push(text);
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: text });
    } else if (m.role === 'assistant') {
      if (text) input.push({ role: 'assistant', content: text });
      for (const call of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        });
      }
    } else {
      input.push({ role: 'user', content: text });
    }
  }
  const body: Record<string, unknown> = {
    model: options.model,
    input,
    store: false,
    stream: true,
  };
  if (instructions.length) body.instructions = instructions.join('\n\n');
  if (options.tools?.length) body.tools = options.tools.map(toResponsesTool);
  if (effort && effort !== 'none') body.reasoning = { effort };
  if (!chatgptPlan && options.max_completion_tokens)
    body.max_output_tokens = options.max_completion_tokens;
  return body;
}

/** @param tool - Chat Completions tool. */
function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    // The Responses API checks schemas strictly unless told not to, and our
    // tool schemas don't meet strict rules (optional fields, open objects).
    strict: false,
  };
}

/** @param content - Message content in any of the chat shapes. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part =>
        typeof part === 'object' && part && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

interface OutputItem {
  type?: string;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
}

/**
 * Reads a Responses stream until `response.completed` (or the stream ends).
 * @param body - Response body stream.
 */
export async function readResponsesStream(body: ReadableStream<Uint8Array>): Promise<ChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';
  const items: OutputItem[] = [];
  let completed: OutputItem[] | null = null;
  let failure = '';

  const handle = (data: string) => {
    if (!data || data === '[DONE]') return;
    let event: {
      type?: string;
      delta?: string;
      item?: OutputItem;
      response?: { output?: OutputItem[]; error?: { message?: string } };
      error?: { message?: string };
      message?: string;
    };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      return;
    }
    switch (event.type) {
      case 'response.output_text.delta':
        text += event.delta ?? '';
        break;
      case 'response.output_item.done':
        if (event.item) items.push(event.item);
        break;
      case 'response.completed':
        completed = event.response?.output ?? null;
        break;
      case 'response.failed':
      case 'response.incomplete':
        failure = event.response?.error?.message ?? event.type;
        break;
      case 'error':
        failure = event.error?.message ?? event.message ?? 'stream error';
        break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) handle(trimmed.slice(5).trim());
    }
    if (completed || failure) break;
  }
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());
  void reader.cancel().catch(() => undefined);

  const output: OutputItem[] = completed ?? items;
  if (!output.length && failure) throw new Error(`Responses API: ${failure}`);
  const calls: ToolCall[] = [];
  let finalText = '';
  for (const item of output) {
    if (item.type === 'function_call' && item.name) {
      calls.push({
        id: item.call_id ?? item.id ?? `call_${calls.length}`,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      });
    } else if (item.type === 'message') {
      finalText += (item.content ?? [])
        .filter(c => c.type === 'output_text' || c.type === 'text')
        .map(c => c.text ?? '')
        .join('');
    }
  }
  if (!finalText) finalText = text;
  return calls.length
    ? { role: 'assistant', content: finalText || null, tool_calls: calls }
    : { role: 'assistant', content: finalText };
}

/**
 * Sends one Responses request and returns the answer in Chat Completions shape.
 * @param call - Request.
 */
export async function callResponses(call: ResponsesCall): Promise<ChatResponse> {
  const body = JSON.stringify(toResponsesBody(call.options, call.effort, !!call.chatgptPlan));
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await call.token(attempt > 0);
    // eslint-disable-next-line no-restricted-globals
    const res = await fetch(`${call.url}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body,
      signal: call.signal,
    });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok || !res.body) {
      let detail = res.statusText;
      try {
        const data = (await res.json()) as { error?: { message?: string } | string };
        detail = typeof data.error === 'string' ? data.error : (data.error?.message ?? detail);
      } catch {
        // Not JSON.
      }
      throw new HttpStatusError(`Responses API (${res.status}): ${detail}`, res.status);
    }
    return readResponsesStream(res.body);
  }
  throw new Error('Responses API: not authorised. Sign in again.');
}
