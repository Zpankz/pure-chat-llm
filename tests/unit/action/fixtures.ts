/**
 * Fixtures for the action tools: a chat whose plugin can save settings, a record of opened
 * modals, and fake workspace tabs. Self-contained; nothing here reaches the network.
 */
import type { Tool } from '../../../src/tools';
import { createApp, MarkdownView, Modal, type MockApp, type TFile } from '../obsidian-mock';

// Modals and their no-answer timers use `window`, which Node lacks.
(globalThis as { window?: unknown }).window ??= globalThis;

/** Every modal opened since the last `resetModals()`. */
export const openedModals: Modal[] = [];
Modal.prototype.open = function (this: Modal) {
  openedModals.push(this);
};
/** Forgets the opened modals. */
export function resetModals(): void {
  openedModals.length = 0;
}

export interface ActionChat {
  app: MockApp;
  plugin: { app: MockApp; settings: Record<string, unknown>; saveSettings(): Promise<void> };
  chat: Record<string, unknown>;
  statuses: string[];
  saves: number;
  /** Builds a tool against this chat. */
  tool<T>(ToolClass: new (chat: never, registry: never) => T): T;
}

/**
 * @param options - Chat role, settings and extra chat fields (endpoint, file).
 * @param options.role - `PureChatLLMChat.role` (undefined is a note chat).
 * @param options.settings - Plugin settings.
 * @param options.chat - Extra fields on the chat.
 */
export function actionChat(
  options: {
    role?: string;
    settings?: Record<string, unknown>;
    chat?: Record<string, unknown>;
  } = {},
): ActionChat {
  const app = createApp();
  const statuses: string[] = [];
  const out = { app, statuses, saves: 0 } as ActionChat;
  out.plugin = {
    app,
    settings: options.settings ?? {},
    saveSettings: async () => {
      out.saves++;
    },
  };
  out.chat = { plugin: out.plugin, role: options.role, ...(options.chat ?? {}) };
  const registry = {
    statusUpdate: async (m: string) => {
      statuses.push(m);
    },
  };
  out.tool = ToolClass => new ToolClass(out.chat as never, registry as never);
  return out;
}

/** Lets pending promise callbacks run (so a tool reaches its modal). */
export const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Runs a tool and returns its output. */
export function run<A>(tool: Tool<A>, args: A): Promise<string> {
  return tool.execute(args);
}

export interface FakeLeaf {
  view: MarkdownView & { file: TFile | null; mode: 'source' | 'preview'; saved: number };
  pinned: boolean;
  getViewState(): { type: string; pinned: boolean };
  openFile(file: TFile, opts?: { active?: boolean }): Promise<void>;
  detach(): void;
}

/**
 * Replaces the app's workspace with tabs showing the given notes.
 * @param app - Mock app.
 * @param tabs - Paths shown, in layout order.
 * @param activePath - Note in focus.
 */
export function fakeWorkspace(
  app: MockApp,
  tabs: { path: string; pinned?: boolean; mode?: 'source' | 'preview' }[],
  activePath?: string,
) {
  const leaves: FakeLeaf[] = [];
  const calls: string[] = [];
  const makeLeaf = (path: string | null, pinned = false, mode: 'source' | 'preview' = 'source') => {
    const view = Object.assign(new MarkdownView(), {
      file: path ? app.vault.getFileByPath(path) : null,
      mode,
      saved: 0,
      getMode: () => view.mode,
      getState: () => ({ mode: view.mode }) as Record<string, unknown>,
      setState: async (state: Record<string, unknown>) => {
        view.mode = state.mode as 'source' | 'preview';
      },
      save: async () => {
        view.saved++;
        calls.push(`save:${view.file?.path ?? ''}`);
      },
    });
    const leaf: FakeLeaf = {
      view,
      pinned,
      getViewState: () => ({ type: 'markdown', pinned: leaf.pinned }),
      openFile: async file => {
        view.file = file;
        if (!leaves.includes(leaf)) leaves.push(leaf);
      },
      detach: () => {
        calls.push(`detach:${view.file?.path ?? ''}`);
        leaves.splice(leaves.indexOf(leaf), 1);
      },
    };
    return leaf;
  };
  for (const t of tabs) leaves.push(makeLeaf(t.path, t.pinned, t.mode));
  let active = activePath;
  app.workspace = {
    ...app.workspace,
    getLeavesOfType: (type: string) => (type === 'markdown' ? [...leaves] : []),
    getActiveViewOfType: () => leaves.find(l => l.view.file?.path === active)?.view ?? null,
    getLeaf: (kind?: unknown, dir?: unknown) => {
      calls.push(`getLeaf:${String(kind)}${dir ? `:${String(dir)}` : ''}`);
      return makeLeaf(null);
    },
    revealLeaf: async (leaf: FakeLeaf) => {
      calls.push(`reveal:${leaf.view.file?.path ?? ''}`);
    },
    setActiveLeaf: (leaf: FakeLeaf) => {
      active = leaf.view.file?.path;
    },
  };
  return { leaves, calls };
}
