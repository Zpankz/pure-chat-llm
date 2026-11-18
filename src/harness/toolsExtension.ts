// The plugin's tools as one Pi Durable extension. Each tool's JSON Schema passes straight through
// (1.5's tools take JSON Schema), and each call runs through the same path as on the Classic
// engine: the tool registry of a chat with the caller's role (so the write policy, reviewers and
// proposals apply unchanged), its time limit and its abort signal. Pi Durable's own read, write,
// edit, bash and code mode are not installed.
import type { ToolDefinition } from '../types';
import { defineExtension, defineTool, hook, text, ToolTask } from './pi';
import type { Extension, ToolExecutionResult, ToolHookCall, ToolRegistration } from './pi';

/** Name of the orchestrator's tools extension. */
export const VAULT_TOOLS_EXTENSION = 'voice-agent-tools';
/** Name of a worker's tools extension. */
export const WORKER_TOOLS_EXTENSION = 'voice-agent-worker-tools';

/** Where the extension reads tool definitions and runs calls. */
export interface ToolSource {
  /** Definitions offered to the model. */
  definitions(): ToolDefinition[];
  /**
   * Runs one call with its time limit; resolves to the tool's text output, an `Error: Type: ...`
   * text for a failure.
   */
  run(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<string>;
  /** Read-only tools rerun after a restart; anything else is reported as interrupted. */
  readOnly(name: string): boolean;
  /** A reason to refuse the call before it runs (the hook of the write gate), or undefined. */
  gate?(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined> | string | undefined;
}

/** Whether a tool's text output is the shared `Error:` form. */
export function isErrorOutput(output: string): boolean {
  return /^(Error|ERROR)\b/.test(output.trimStart());
}

/**
 * One tool registration for a plugin tool.
 * @param definition - Its definition.
 * @param source - Where it runs.
 */
export function toDurableTool(definition: ToolDefinition, source: ToolSource): ToolRegistration {
  const { name, description, parameters } = definition.function;
  return defineTool({
    name,
    description,
    parameters: parameters as object,
    replay: source.readOnly(name) ? 'safe' : 'unsafe',
    // Writes keep their order, as on the Classic engine; read-only calls may run side by side.
    executionMode: source.readOnly(name) ? 'parallel' : 'sequential',
    execute: async (args, _api, context): Promise<ToolExecutionResult> => {
      const output = await source.run(
        name,
        (args ?? {}) as Record<string, unknown>,
        context.abortSignal,
      );
      return { ...text(output), isError: isErrorOutput(output) };
    },
  });
}

/**
 * The extension: the source's tools, and a `beforeTool` hook that asks the source's gate.
 * @param source - Tool definitions, runner and gate.
 * @param name - Extension name, one per role.
 */
export function createToolsExtension(source: ToolSource, name = VAULT_TOOLS_EXTENSION): Extension {
  return defineExtension({
    name,
    tools: source.definitions().map(d => toDurableTool(d, source)),
    hooks: source.gate
      ? [
          hook(ToolTask, {
            beforeTool: async (call: ToolHookCall) => {
              const reason = await source.gate?.(
                call.name,
                (call.arguments ?? {}) as Record<string, unknown>,
              );
              return reason ? { block: reason } : undefined;
            },
          }),
        ]
      : [],
  });
}
