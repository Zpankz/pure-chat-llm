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
 * The reason line of a tool error, without the `Error:` prefix.
 * @param output - Tool output.
 */
export function toolErrorMessage(output: string): string {
  const first = output.trim().split('\n')[0] ?? '';
  return first.replace(/^(Error|ERROR)\s*:?\s*/, '').trim() || 'Tool failed.';
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
  enum: ['text', 'json'],
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
