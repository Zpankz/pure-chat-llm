/**
 * The contract every tool follows, shared by chat, voice, the orchestrator, workers and code mode.
 *
 * 1. **Errors:** a failed call returns text that starts with `Error:`, then the error type and a
 *    one-line reason, then optional recovery lines. `isToolError` is the one test for it, used by
 *    the worker loop (stuck detection), code mode (throws) and voice (spoken failures).
 * 2. **Structured output:** tools that return data take `format: "text" | "json"`. JSON is one
 *    object, compact, with stable keys, so code mode scripts and workers can use it without
 *    scraping. Code mode asks for JSON by default when a tool offers it.
 * 3. **Layers:** each built-in tool lists the layers it may run in. Workers run in the
 *    background with nobody watching, so tools that open modals, change the user's workspace or
 *    flash notices are not given to them.
 * 4. **Time limits:** every loop that runs tools (chat, workers, code mode, voice) wraps each call
 *    in `withToolTimeout(name, toolTimeoutMs(name), ...)`, so a hung call comes back as
 *    `Error: Timeout: ...` instead of stalling the loop. Tools that may wait for a person's click
 *    get no limit (see `WAITS_FOR_USER`).
 * 5. **Read-only tools** (`isReadOnlyTool`) may run side by side, and a voice model need not wait
 *    for them; everything else runs one at a time, in order.
 */

/** Where a tool may run. */
export type ToolLayer =
  /** A note chat with the user present. */
  | 'chat'
  /** A voice model calling tools itself (the `direct` voice role). */
  | 'voice'
  /** The orchestrator agent between voice and workers. */
  | 'orchestrator'
  /** Background sub-agents. */
  | 'worker'
  /** Code mode scripts. */
  | 'codemode';

const ALL: ToolLayer[] = ['chat', 'voice', 'orchestrator', 'worker', 'codemode'];
const WRITES: ToolLayer[] = ['chat', 'voice', 'worker', 'codemode'];
const FOREGROUND: ToolLayer[] = ['chat', 'voice'];

/**
 * Layers for the built-in tools. Tools not listed (MCP tools, skills, layer and orchestrator
 * tools, which check their own roles) are allowed everywhere their own checks allow.
 */
export const TOOL_LAYERS: Record<string, ToolLayer[]> = {
  // Read and search: everywhere.
  read_file: ALL,
  // Deprecated alias of traverse_graph with direction in.
  get_backlinks: ALL,
  read_note_section: ALL,
  search_vault: ALL,
  glob_vault_files: ALL,
  list_vault_folders: ALL,
  smart_connections_rag: ALL,
  traverse_graph: ALL,
  vault_ontology: ALL,
  graph_cli: ['chat', 'voice', 'orchestrator', 'worker'],
  // What the user has open: foreground, and the orchestrator so it can resolve "this note".
  // Workers get the active note in their brief instead (it can change while they run).
  get_active_context: ['chat', 'voice', 'orchestrator', 'codemode'],
  // Writes: follow the write policy for whoever calls them.
  create_obsidian_note: WRITES,
  // Deprecated alias of write_note_section in append mode.
  patch_note: WRITES,
  write_note_section: WRITES,
  replace_in_note: WRITES,
  delete_obsidian_note: WRITES,
  manage_templates: WRITES,
  // Foreground only: they open modals, cost money or change the user's screen.
  manage_workspace: FOREGROUND,
  show_obsidian_notice: FOREGROUND,
  manage_plugin_settings: ['chat'],
  generate_image: FOREGROUND,
  suno_music_gen: FOREGROUND,
  run_obsidian_command: FOREGROUND,
  // Only the voice marks topics in a call.
  new_topic: ['voice'],
};

/**
 * Whether a tool may run in a layer.
 * @param name - Tool name.
 * @param layer - Layer.
 */
export function allowedIn(name: string, layer: ToolLayer): boolean {
  const layers = TOOL_LAYERS[name];
  return !layers || layers.includes(layer);
}

/**
 * The layer a chat role runs in.
 * @param role - `PureChatLLMChat.role`.
 */
export function layerForRole(role: string | undefined): ToolLayer {
  switch (role) {
    case 'subagent':
      return 'worker';
    case 'orchestrator-agent':
      return 'orchestrator';
    case 'voice':
    case 'orchestrator':
    case 'direct-voice':
      return 'voice';
    default:
      return 'chat';
  }
}

/**
 * The one test for a failed tool call. Matches `Error:` and the older `ERROR: Type` headers.
 * @param output - Tool output.
 */
export function isToolError(output: string): boolean {
  return /^\s*(Error:|ERROR[:\s])/.test(output);
}

/**
 * The reason line of a tool error, without the `Error:` prefix (the type stays: `NotFound: ...`).
 * @param output - Tool output.
 */
export function toolErrorMessage(output: string): string {
  const first = output.trim().split('\n')[0] ?? '';
  return first.replace(/^(Error|ERROR)\s*:?\s*/, '').trim() || 'Tool failed.';
}

/**
 * The error type of a failed call: `NotFound` for `Error: NotFound: ...`, `FileNotFound` for the
 * older `ERROR: FileNotFound (Recoverable)`, `Error` when the output names no type, and undefined
 * when the output is not an error.
 * @param output - Tool output.
 */
export function toolErrorType(output: string): string | undefined {
  if (!isToolError(output)) return undefined;
  const match = /^([A-Z][A-Za-z0-9]*)(?=:|\s*\(|$)/.exec(toolErrorMessage(output));
  return match ? match[1] : 'Error';
}

/**
 * The reason of a failed call, without the `Error:` prefix or the type.
 * @param output - Tool output.
 */
export function toolErrorReason(output: string): string {
  const message = toolErrorMessage(output);
  const type = toolErrorType(output);
  if (!type || type === 'Error' || !message.startsWith(type)) return message;
  return (
    message
      .slice(type.length)
      .replace(/^\s*(\([^)]*\))?\s*:?\s*/, '')
      .trim() || message
  );
}

/**
 * The recovery suggestions of a failed call (the `- ` lines after `Try:`).
 * @param output - Tool output.
 */
export function toolErrorRecovery(output: string): string[] {
  if (!isToolError(output)) return [];
  const lines = output.trim().split('\n');
  const start = lines.findIndex(l => /^\s*Try:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/**
 * One line for a failed call: type, reason and recovery. Code mode throws it; logs show it.
 * @param output - Tool output.
 */
export function toolErrorLine(output: string): string {
  const recovery = toolErrorRecovery(output);
  const message = toolErrorMessage(output);
  return recovery.length ? `${message} Try: ${recovery.join('; ')}` : message;
}

/**
 * Splits tool output into the part that must survive clipping and the rest. For an error the
 * kept part is the `Error: Type: reason` line and its `Try:` lines; otherwise it is the first
 * line (the summary), when that line is short enough to be one.
 * @param output - Tool output.
 * @param max - Clipping budget, used to judge whether the first line is a summary.
 */
function keptHead(output: string, max: number): { head: string; rest: string } {
  const lines = output.split('\n');
  if (isToolError(output)) {
    let end = 1;
    if (/^\s*Try:\s*$/.test(lines[1] ?? '')) {
      end = 2;
      while (end < lines.length && /^\s*-\s/.test(lines[end])) end++;
    }
    return { head: lines.slice(0, end).join('\n'), rest: lines.slice(end).join('\n') };
  }
  if (lines.length > 1 && lines[0].length <= max * 0.4) {
    return { head: lines[0], rest: lines.slice(1).join('\n') };
  }
  return { head: '', rest: output };
}

/**
 * Clips long tool output to about `max` characters. Keeps the summary line (or, for an error, the
 * type, reason and recovery lines) whole, then the start and end of the rest, and says how much
 * was cut.
 * @param output - Tool output.
 * @param max - Maximum characters (0 or less: no limit).
 * @param headShare - Share of the remaining budget given to the start (the rest to the end).
 */
export function clipToolText(output: string, max: number, headShare = 0.6): string {
  if (!max || max <= 0 || output.length <= max) return output;
  const { head, rest } = keptHead(output, max);
  const marker = (cut: number) => `…[${cut} of ${output.length} characters cut]…`;
  const budget = max - head.length - marker(output.length).length - 3;
  if (budget <= 0) {
    // Only the kept part fits. An error's reason is never cut; a summary is.
    const kept = isToolError(output) ? head : output.slice(0, Math.max(0, max - 40));
    return `${kept}\n${marker(output.length - kept.length)}`;
  }
  const start = Math.floor(budget * headShare);
  const end = budget - start;
  const body = `${rest.slice(0, start)}\n${marker(rest.length - start - end)}\n${end > 0 ? rest.slice(-end) : ''}`;
  return head ? `${head}\n${body}` : body;
}

/**
 * Clips a tool description to `max` characters, keeping its start (the summary comes first) and
 * saying how much was cut.
 * @param text - Description.
 * @param max - Maximum characters.
 */
export function clipDescription(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = (n: number) => ` …[${n} characters cut]`;
  const keep = Math.max(0, max - note(text.length).length);
  return `${text.slice(0, keep).trimEnd()}${note(text.length - keep)}`;
}

/**
 * Formats a tool error.
 * @param type - Short error type, such as `NotFound`.
 * @param message - One-line reason.
 * @param recovery - What to try instead.
 */
export function toolError(type: string, message: string, recovery: string[] = []): string {
  const lines = [`Error: ${type}: ${message}`];
  if (recovery.length) lines.push('Try:', ...recovery.map(r => `- ${r}`));
  return lines.join('\n');
}

/** The `format` parameter every data-returning tool takes. */
export const FORMAT_PARAMETER = {
  type: 'string',
  description:
    '`text` (default) for reading; `json` for one compact JSON object with stable keys, for scripts and workers.',
  // Widened so it fits `ToolParameter.enum` inside `as const` tool parameters.
  enum: ['text', 'json'] as string[],
} as const;

/**
 * Whether the caller asked for JSON.
 * @param args - Tool arguments.
 */
export function wantsJson(args: { format?: unknown }): boolean {
  return args.format === 'json';
}

/**
 * Serialises a tool's JSON result.
 * @param data - Result object.
 */
export function jsonResult(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

/**
 * Whether a tool's parameters offer `format: json`.
 * @param parameters - JSON Schema of the tool's parameters.
 */
export function offersJson(parameters: unknown): boolean {
  const props = (parameters as { properties?: Record<string, { enum?: unknown[] }> })?.properties;
  return !!props?.format?.enum?.includes('json');
}

/** Time limit for one tool call when nothing more specific applies. */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** Time limit for tools from MCP servers (remote, often slower). */
export const MCP_TOOL_TIMEOUT_MS = 120_000;

/** Longer limits for built-in tools known to be slow. */
export const TOOL_TIMEOUT_MS: Record<string, number> = {
  smart_connections_rag: 120_000,
  traverse_graph: 120_000,
  graph_cli: 120_000,
  generate_image: 180_000,
  request_evaluation: 180_000,
};

/**
 * Tools that may wait for a person: a review or confirmation dialog in the foreground, and the
 * same dialog (or two reviewer models) for workers under the write policy. They get no time
 * limit of their own, because a person may take a while; code mode also pauses its script
 * deadline while one of these runs. They are still cancelled through the abort signal when the
 * request or script they belong to ends.
 */
export const WAITS_FOR_USER = new Set([
  'create_obsidian_note',
  'write_note_section',
  'replace_in_note',
  'patch_note',
  'delete_obsidian_note',
  'manage_plugin_settings',
  'suno_music_gen',
]);

/**
 * Time limit for one call of a tool in ms; 0 means none.
 * @param name - Tool name.
 */
export function toolTimeoutMs(name: string): number {
  // Code mode keeps its own script deadline (paused while a tool waits for the user).
  if (name === 'codemode' || WAITS_FOR_USER.has(name)) return 0;
  return (
    TOOL_TIMEOUT_MS[name] ??
    (name.startsWith('mcp__') ? MCP_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS)
  );
}

/**
 * Formats milliseconds for a message.
 * @param ms - Milliseconds.
 */
export function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The error a call returns when it runs out of time.
 * @param name - Tool name.
 * @param ms - The limit that passed.
 */
export function timeoutError(name: string, ms: number): string {
  return toolError('Timeout', `${name} did not finish within ${formatSeconds(ms)}.`, [
    'It was cancelled; anything it had not finished was not done. Check before calling it again.',
    'Ask for less (a narrower folder or query, fewer results) or split the work.',
  ]);
}

/**
 * The error a call returns when the request or script it belongs to was cancelled.
 * @param name - Tool name.
 */
export function cancelledError(name: string): string {
  return toolError('Cancelled', `${name} was cancelled because the request it belongs to ended.`);
}

/**
 * Something tools read their abort signal from: the chat (`PureChatLLMChat.abortSignal`).
 * Tools should take `this.chat.abortSignal` at the start of `execute`, before any `await`, and
 * check `signal?.aborted` right before they change anything.
 */
export interface AbortHost {
  abortSignal?: AbortSignal;
}

/**
 * Starts a tool call with `host.abortSignal` set to `signal`, and puts the previous signal back
 * as soon as the call has started. Tools take the signal synchronously at the start of
 * `execute`, so calls that run side by side each keep their own.
 * @param host - The chat the tool reads its signal from.
 * @param signal - Signal for this call.
 * @param start - Starts the call (for example `registry.executeTool(...)`).
 */
export function callWithSignal<T>(
  host: AbortHost | undefined,
  signal: AbortSignal,
  start: () => Promise<T>,
): Promise<T> {
  if (!host) return start();
  const previous = host.abortSignal;
  host.abortSignal = signal;
  try {
    return start();
  } finally {
    if (host.abortSignal === signal) host.abortSignal = previous;
  }
}

/**
 * Runs one tool call with a time limit and an abort signal. When the limit passes, or `parent`
 * aborts, the call's signal is aborted (so a write that checks it does not land) and the call
 * resolves to a `Timeout` or `Cancelled` tool error. A call that throws resolves to a
 * `ToolFailed` error, so every loop sees one kind of failure.
 * @param name - Tool name (for the message).
 * @param ms - Limit in ms; 0 or less runs without one.
 * @param run - Starts the call with its signal.
 * @param parent - Signal of the request, script or task the call belongs to.
 */
export function withToolTimeout(
  name: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<string>,
  parent?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  if (parent?.aborted) return Promise.resolve(cancelledError(name));
  return new Promise<string>(resolve => {
    let timer = 0;
    const finish = (output: string) => {
      window.clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
      resolve(output);
    };
    const onParentAbort = () => {
      controller.abort(parent?.reason);
      finish(cancelledError(name));
    };
    parent?.addEventListener('abort', onParentAbort, { once: true });
    if (ms > 0) {
      timer = window.setTimeout(() => {
        controller.abort(new Error(`${name} timed out`));
        finish(timeoutError(name, ms));
      }, ms);
    }
    void (async () => run(controller.signal))().then(finish, (error: unknown) =>
      finish(
        toolError(
          'ToolFailed',
          `${name} threw: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    );
  });
}

/**
 * Read-only tools: they change nothing in the vault, the workspace, the plugin or running tasks,
 * so several may run side by side and a voice model may keep talking while one runs. Anything not
 * listed (writes, UI, code mode, MCP tools, task control) is treated as having effects.
 */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'read_note_section',
  'search_vault',
  'glob_vault_files',
  'list_vault_folders',
  'get_backlinks',
  'smart_connections_rag',
  'traverse_graph',
  'vault_ontology',
  'get_active_context',
  'activate_skill',
  'read_skill_file',
  'check_tasks',
  'get_task_result',
  'orchestrator_activity',
  'read_task_thread',
]);

/**
 * Whether a tool only reads.
 * @param name - Tool name.
 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}
