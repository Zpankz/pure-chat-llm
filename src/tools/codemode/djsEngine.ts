import { normalizePath } from 'obsidian';
import type PureChatLLM from '../../main';
import { Sandbox, SandboxError } from '../../vendor/djs/sandbox';
import { buildDjsScript } from './sandboxSource';

/** What a code mode run returns, whichever engine ran it. */
export interface CodeModeRunResult {
  ok: boolean;
  ret?: string;
  error?: string;
  outputs: string[];
  console: string[];
}

/** Host side of a run: tool calls and store writes. */
export interface CodeModeHost {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  store(key: string, json: string): void;
}

let cached: { path: string; module: Promise<WebAssembly.Module | null> } | null = null;

/**
 * Where the djs WebAssembly module is read from: the setting, or `djs.wasm` in the plugin folder.
 * @param plugin - Plugin.
 */
export function djsModulePath(plugin: PureChatLLM): string {
  const configured = plugin.settings.codeMode.djsModulePath?.trim();
  return normalizePath(configured || `${plugin.manifest.dir ?? ''}/djs.wasm`);
}

/**
 * Compiles the djs module once per path. Resolves to null when the file is missing or invalid.
 * @param plugin - Plugin.
 */
export function loadDjsModule(plugin: PureChatLLM): Promise<WebAssembly.Module | null> {
  const path = djsModulePath(plugin);
  if (cached?.path === path) return cached.module;
  const module = (async () => {
    try {
      if (!(await plugin.app.vault.adapter.exists(path))) return null;
      const bytes = await plugin.app.vault.adapter.readBinary(path);
      return await WebAssembly.compile(bytes);
    } catch (error) {
      plugin.console?.error('Could not load the djs module', error);
      return null;
    }
  })();
  cached = { path, module };
  void module.then(m => {
    if (!m && cached?.path === path) cached = null;
  });
  return module;
}

/** Forgets the compiled module, e.g. after the path setting changes. */
export function resetDjsModule(): void {
  cached = null;
}

/**
 * Runs a code mode script in a fresh djs sandbox. Each run gets its own wasm instance and heap,
 * a fuel budget, a memory cap and a wall-clock deadline. Scripts may be TypeScript.
 * @param module - Compiled djs module.
 * @param code - The model's script.
 * @param meta - Tool metadata and the persisted store.
 * @param meta.tools - Tools the script may call.
 * @param meta.store - Persisted values for `load()`.
 * @param host - Tool calls and store writes.
 * @param opts - Limits.
 * @param opts.timeoutMs - Wall-clock deadline.
 * @param opts.maxFuel - Instruction budget.
 * @param opts.memoryLimitBytes - Heap cap.
 */
export async function runWithDjs(
  module: WebAssembly.Module,
  code: string,
  meta: { tools: unknown[]; store: Record<string, string> },
  host: CodeModeHost,
  opts: { timeoutMs: number; maxFuel: number; memoryLimitBytes: number },
): Promise<CodeModeRunResult> {
  const sandbox = await Sandbox.create({
    module,
    typescript: true,
    maxFuel: opts.maxFuel,
    memoryLimit: opts.memoryLimitBytes,
    unhandledRejections: 'warn',
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    asyncFunctions: {
      '__host.call': async (name: unknown, argsJson: unknown) => {
        const args = JSON.parse(typeof argsJson === 'string' ? argsJson : '{}') as Record<
          string,
          unknown
        >;
        return JSON.stringify((await host.call(String(name), args)) ?? null);
      },
    },
    functions: {
      '__host.store': (key: unknown, json: unknown) => {
        host.store(String(key), String(json));
        return undefined;
      },
    },
  });

  let timer = 0;
  const deadline = new Promise<CodeModeRunResult>(resolve => {
    timer = window.setTimeout(() => {
      sandbox.dispose();
      resolve({
        ok: false,
        error: `Timed out after ${opts.timeoutMs} ms`,
        outputs: [],
        console: [],
      });
    }, opts.timeoutMs);
  });

  const run = (async (): Promise<CodeModeRunResult> => {
    try {
      const raw = await sandbox.runAsync(buildDjsScript(code), { __meta: meta });
      return JSON.parse(String(raw)) as CodeModeRunResult;
    } catch (error) {
      const message =
        error instanceof SandboxError
          ? error.kind === 'fuel'
            ? 'Stopped: the script used its whole instruction budget.'
            : error.kind === 'memory'
              ? 'Stopped: the script ran out of memory.'
              : `${error.kind}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      return { ok: false, error: message, outputs: [], console: [] };
    }
  })();

  try {
    return await Promise.race([run, deadline]);
  } finally {
    window.clearTimeout(timer);
    sandbox.dispose();
  }
}
