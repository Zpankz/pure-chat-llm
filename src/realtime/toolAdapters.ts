import type { ToolRegistry } from '../tools';
import type { McpServerConfig, ToolDefinition, VoiceProviderId, VoiceSettings } from '../types';

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
  tools = tools.filter(t => !nativePrefixes.some(p => t.function.name.startsWith(p)));

  if (settings.toolExposure === 'codemode') {
    const core = tools.filter(t => CODEMODE_CORE.includes(t.function.name));
    if (core.some(t => t.function.name === 'codemode')) tools = core;
  }
  return { tools, nativeMcp };
}

/**
 * Trims a description for realtime models.
 * @param text - Description.
 */
function voiceDescription(text: string): string {
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
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
 * Gemini Live function declaration. Uses `parametersJsonSchema`, which accepts full JSON Schema,
 * so schemas no longer need `additionalProperties` stripped.
 * @param def - Plugin tool definition.
 * @param nonBlocking - Declare the function NON_BLOCKING so the model keeps talking while it runs.
 */
export function toGeminiFunctionDeclaration(
  def: ToolDefinition,
  nonBlocking: boolean,
): Record<string, unknown> {
  return {
    name: def.function.name,
    description: voiceDescription(def.function.description),
    parametersJsonSchema: def.function.parameters,
    ...(nonBlocking ? { behavior: 'NON_BLOCKING' } : {}),
  };
}

/**
 * Keeps tool output small enough for a voice model, keeping the start and the end.
 * @param text - Tool output.
 * @param max - Maximum characters.
 */
export function clipToolOutput(text: string, max: number): string {
  if (!max || text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(-tail)}`;
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
