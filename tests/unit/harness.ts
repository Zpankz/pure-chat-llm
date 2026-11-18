/**
 * Helpers to run one tool against the in-memory vault, as a chat in a given role would.
 * Groups add their own fixtures; keep this file small and shared.
 */
import type { Tool } from '../../src/tools';
import { createApp, type MockApp } from './obsidian-mock';

export interface ToolHarness {
  app: MockApp;
  /** Status lines the tool reported. */
  statuses: string[];
  /** Runs a tool class with the given args. */
  run<A>(ToolClass: new (chat: never, registry: never) => Tool<A>, args: A): Promise<string>;
}

/**
 * @param files - Vault fixture: path to content.
 * @param options - Chat role and plugin settings to merge in.
 * @param options.role - `PureChatLLMChat.role` (undefined is a note chat).
 * @param options.settings - Extra plugin settings.
 */
export function toolHarness(
  files: Record<string, string> = {},
  options: { role?: string; settings?: Record<string, unknown> } = {},
): ToolHarness {
  const app = createApp();
  for (const [path, content] of Object.entries(files)) app.vault.put(path, content);
  const statuses: string[] = [];
  const plugin = { app, settings: { ...(options.settings ?? {}) } };
  const chat = { plugin, role: options.role };
  const registry = {
    statusUpdate: async (m: string) => {
      statuses.push(m);
    },
  };
  return {
    app,
    statuses,
    run: async (ToolClass, args) => new ToolClass(chat as never, registry as never).execute(args),
  };
}
