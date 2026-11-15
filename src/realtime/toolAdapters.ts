import type { ToolRegistry } from '../tools';
import type { McpServerConfig, ToolDefinition, VoiceProviderId, VoiceSettings } from '../types';
import {
  allowedIn,
  clipDescription,
  clipToolText,
  isReadOnlyTool,
  isToolError,
  toolErrorLine,
  toolErrorType,
} from '../tools/toolContract';

/** Providers that accept remote MCP servers natively (`type: "mcp"`). */
export const NATIVE_MCP_PROVIDERS: VoiceProviderId[] = [
  'openai-realtime',
  'openai-live',
  'xai-voice',
];

/** Tools kept when voice tool exposure is "code mode only". */
const CODEMODE_CORE = ['codemode', 'activate_skill', 'read_skill_file'];

/** Hard cap for one tool description sent to a voice model. */
const MAX_DESCRIPTION = 4000;

/**
 * Picks the function tools and native MCP servers for one voice provider.
 *
 * - `codemode` exposure gives the voice model one programmable tool (plus skills) instead of
 *   dozens of functions, which keeps realtime models fast and accurate with large tool sets.
 * - MCP servers set to `native` are handed to providers that support remote MCP and removed from
 *   the bridged function list there; other providers keep the bridged functions.
 * @param registry - Tool registry of the voice chat.
 * @param settings - Voice settings.
 * @param provider - Target provider.
 * @param mcpServers - Enabled MCP servers.
 */
export function selectVoiceTools(
  registry: ToolRegistry,
  settings: VoiceSettings,
  provider: VoiceProviderId,
  mcpServers: McpServerConfig[],
): { tools: ToolDefinition[]; nativeMcp: McpServerConfig[] } {
  const nativeCapable = NATIVE_MCP_PROVIDERS.includes(provider);
  const nativeMcp = nativeCapable ? mcpServers.filter(s => s.mode === 'native') : [];
  const nativePrefixes = nativeMcp.map(s => `mcp__${s.name.replace(/[^A-Za-z0-9_-]/g, '_')}__`);

  let tools = registry.getEnabledDefinitions();
  tools = tools.filter(
    t =>
      !nativePrefixes.some(p => t.function.name.startsWith(p)) &&
      allowedIn(t.function.name, 'voice'),
  );

  if (settings.toolExposure === 'codemode') {
    const core = tools.filter(t => CODEMODE_CORE.includes(t.function.name));
    if (core.some(t => t.function.name === 'codemode')) tools = core;
  }
  return { tools, nativeMcp };
}

/**
 * Trims a description for realtime models, keeping its start (the summary line) and saying how
 * much was cut.
 * @param text - Description.
 */
export function voiceDescription(text: string): string {
  return clipDescription(text, MAX_DESCRIPTION);
}

/**
 * OpenAI Realtime and Grok Voice function tool.
 * @param def - Plugin tool definition.
 */
export function toRealtimeFunctionTool(def: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: def.function.name,
    description: voiceDescription(def.function.description),
    parameters: def.function.parameters,
  };
}

/**
 * Responses API function tool (used by GPT-Live Responses delegation).
 * @param def - Plugin tool definition.
 */
export function toResponsesFunctionTool(def: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: def.function.name,
    description: def.function.description,
    parameters: def.function.parameters,
    strict: false,
  };
}

/**
 * Which Gemini functions are declared NON_BLOCKING (the model keeps talking while they run):
 * - `false`: none.
 * - `true` or `'reads'`: read-only tools only (`isReadOnlyTool`). Writes, UI actions, code mode,
 *   MCP tools and task control stay blocking, so the model does not talk past a change before it
 *   has happened or been refused.
 * - `'all'`: every function, for models that only accept NON_BLOCKING functions.
 */
export type GeminiNonBlocking = boolean | 'reads' | 'all';

/**
 * The NON_BLOCKING mode for a Gemini session.
 * @param nonBlockingTools - The user's "Non-blocking tools" setting.
 * @param supportsScheduling - `geminiSupportsScheduling(model)`; models without it only accept
 *   NON_BLOCKING functions.
 */
export function geminiNonBlockingMode(
  nonBlockingTools: boolean,
  supportsScheduling: boolean,
): GeminiNonBlocking {
  if (!supportsScheduling) return 'all';
  return nonBlockingTools ? 'reads' : false;
}

/**
 * The `response` of a Gemini function response: `{ output }`, or for a failed call
 * `{ error, error_type }` with the type, reason and recovery on one line.
 * @param output - Tool output (already clipped).
 */
export function geminiFunctionResponse(output: string): Record<string, unknown> {
  return isToolError(output)
    ? { error: toolErrorLine(output), error_type: toolErrorType(output) }
    : { output };
}

/**
 * Gemini Live function declaration. Uses `parametersJsonSchema`, which accepts full JSON Schema,
 * so schemas no longer need `additionalProperties` stripped.
 * @param def - Plugin tool definition.
 * @param nonBlocking - Which functions are NON_BLOCKING (see `GeminiNonBlocking`).
 */
export function toGeminiFunctionDeclaration(
  def: ToolDefinition,
  nonBlocking: GeminiNonBlocking,
): Record<string, unknown> {
  const name = def.function.name;
  const declare = nonBlocking === 'all' || (!!nonBlocking && isReadOnlyTool(name));
  return {
    name,
    description: voiceDescription(def.function.description),
    parametersJsonSchema: def.function.parameters,
    ...(declare ? { behavior: 'NON_BLOCKING' } : {}),
  };
}

/**
 * Keeps tool output small enough for a voice model. The first line (the summary) stays whole, and
 * for a failed call so do the error type, reason and recovery lines, so the voice can say what
 * went wrong; then the start and end of the rest, with a note of how much was cut.
 * @param text - Tool output.
 * @param max - Maximum characters.
 */
export function clipToolOutput(text: string, max: number): string {
  return clipToolText(text, max, 0.7);
}

/** Guidance appended to voice instructions when tools are available. */
export const VOICE_TOOL_GUIDANCE = [
  'You are speaking out loud. Keep answers short and natural, and never read out markdown, code, URLs or long lists.',
  'Before a tool that may take a moment, say a brief phrase such as "Let me check" so the user is not left in silence.',
  'Summarise tool results conversationally. If a tool fails, say so plainly and suggest what to try next.',
  'Ask before deleting or overwriting notes.',
  "For a note's connections or local graph use traverse_graph; for the notes in a folder use list_vault_folders with the folder name; search_vault can be limited to a folder.",
  'If you did not catch what the user said, or it does not fit the conversation, ask them to repeat it. Never act on a guess.',
].join(' ');
