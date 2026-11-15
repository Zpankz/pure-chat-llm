import { normalizePath, requestUrl } from 'obsidian';
import type PureChatLLM from '../../main';
import { Sandbox, SandboxError } from '../../vendor/djs/sandbox';
import { buildDjsScript } from './sandboxSource';

/** What a code mode run returns, whichever engine ran it. */
export interface CodeModeRunResult {
  ok: boolean;
  ret?: string;
  error?: string;
  /** `ToolError` for an uncaught failed tool call, otherwise the JavaScript error name. */
  errorType?: string;
  /** Set when an engine limit stopped the script (`fuel` or `memory`). */
  limit?: 'fuel' | 'memory';
  outputs: string[];
  console: string[];
}

/** Host side of a run: tool calls, store writes and streamed output. */
export interface CodeModeHost {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  store(key: string, json: string): void;
  /** Each `text()` value or console line, as the script makes it. */
  out?(kind: 'text' | 'console', text: string): void;
}

/**
 * Where the djs WebAssembly module may be downloaded from when it is not in the plugin folder,
 * and the sha256 it must have. Both empty: no download. A URL without a hash is never used.
 * Settings `codeMode.djsModuleUrl` and `codeMode.djsModuleSha256` override these when present.
 */
export const DJS_WASM_URL = '';
export const DJS_WASM_SHA256 = '';

// Set by esbuild.config.mjs when the release build embeds djs.wasm (built from source in CI).
declare const __DJS_WASM_BASE64__: string | undefined;
declare const __DJS_WASM_SHA256__: string | undefined;
declare const __DJS_WASM_COMMIT__: string | undefined;

/** The djs module built into main.js, if this build has one. */
let embedded = {
  base64: typeof __DJS_WASM_BASE64__ === 'string' ? __DJS_WASM_BASE64__ : '',
  sha256: typeof __DJS_WASM_SHA256__ === 'string' ? __DJS_WASM_SHA256__ : '',
  commit: typeof __DJS_WASM_COMMIT__ === 'string' ? __DJS_WASM_COMMIT__ : '',
};

/** The built-in djs module's checksum and source commit, or null when this build has none. */
export function embeddedDjs(): { sha256: string; commit: string } | null {
  return embedded.base64 ? { sha256: embedded.sha256, commit: embedded.commit } : null;
}

/**
 * Replaces the built-in module (tests only).
 * @param next - Base64 bytes, sha256 and commit; empty base64 for none.
 */
export function setEmbeddedDjsForTests(next: { base64: string; sha256: string; commit?: string }) {
  embedded = { commit: '', ...next };
  resetDjsModule();
}

/**
 * Decodes base64 to bytes.
 * @param base64 - Base64 text.
 */
function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Whether the user pointed code mode at a djs module of their own (a path or a download), which
 * then takes the place of the built-in one.
 * @param plugin - Plugin.
 */
function hasOwnDjsSource(plugin: PureChatLLM): boolean {
  const s = plugin.settings.codeMode as { djsModulePath?: string; djsModuleUrl?: string };
  return !!(s.djsModulePath?.trim() || s.djsModuleUrl?.trim());
}

/** Fetches bytes from a URL (tests pass a fake). */
export type BytesFetcher = (url: string) => Promise<ArrayBuffer>;

/** Downloads with Obsidian's `requestUrl` (no CORS limits, works on mobile). */
const defaultFetcher: BytesFetcher = async url =>
  (await requestUrl({ url, method: 'GET' })).arrayBuffer;

let cached: { key: string; module: Promise<WebAssembly.Module | null> } | null = null;
let lastProblem: string | undefined;

/**
 * Where the djs WebAssembly module is read from and cached: the setting, or `djs.wasm` in the
 * plugin folder.
 * @param plugin - Plugin.
 */
export function djsModulePath(plugin: PureChatLLM): string {
  const configured = plugin.settings.codeMode.djsModulePath?.trim();
  return normalizePath(configured || `${plugin.manifest.dir ?? ''}/djs.wasm`);
}

/**
 * Download URL and pinned hash, from settings when set, else the constants.
 * @param plugin - Plugin.
 */
export function djsSource(plugin: PureChatLLM): { url: string; sha256: string } {
  const s = plugin.settings.codeMode as { djsModuleUrl?: string; djsModuleSha256?: string };
  return {
    url: (s.djsModuleUrl ?? '').trim() || DJS_WASM_URL,
    sha256: ((s.djsModuleSha256 ?? '').trim() || DJS_WASM_SHA256).toLowerCase(),
  };
}

/**
 * SHA-256 of bytes as lower-case hex.
 * @param bytes - Bytes.
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Checks bytes against a pinned sha256 before anything instantiates them.
 * @param bytes - Module bytes.
 * @param expected - Pinned hash (64 hex characters).
 */
export async function verifyDjsBytes(
  bytes: ArrayBuffer | Uint8Array,
  expected: string,
): Promise<{ ok: boolean; actual: string }> {
  const pin = expected.trim().toLowerCase();
  const actual = await sha256Hex(bytes);
  return { ok: /^[0-9a-f]{64}$/.test(pin) && actual === pin, actual };
}

/**
 * Finds the djs module bytes. Unless the user set a module path or download of their own, the
 * module built into main.js is used, after its bytes match the checksum recorded when it was
 * built. Otherwise: the file at the module path, or a download from the configured URL, which
 * must match the pinned sha256 before it is kept or used. A file is checked against the pin too
 * when one is set.
 * @param plugin - Plugin.
 * @param fetchBytes - Downloader.
 */
export async function obtainDjsBytes(
  plugin: PureChatLLM,
  fetchBytes: BytesFetcher = defaultFetcher,
): Promise<{ bytes?: ArrayBuffer; problem?: string }> {
  if (embedded.base64 && !hasOwnDjsSource(plugin)) {
    const bytes = fromBase64(embedded.base64);
    const check = await verifyDjsBytes(bytes, embedded.sha256);
    if (check.ok) return { bytes };
    return {
      problem: `the built-in djs module does not match its recorded sha256 (it has ${check.actual}); it was not loaded.`,
    };
  }
  const path = djsModulePath(plugin);
  const { url, sha256 } = djsSource(plugin);
  const adapter = plugin.app.vault.adapter;
  if (await adapter.exists(path)) {
    const bytes = await adapter.readBinary(path);
    if (sha256) {
      const check = await verifyDjsBytes(bytes, sha256);
      if (!check.ok) {
        return {
          problem: `${path} does not match the pinned sha256 (it has ${check.actual}); it was not loaded.`,
        };
      }
    }
    return { bytes };
  }
  if (!url) return { problem: `no djs module at ${path} and no download URL is set.` };
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return { problem: 'a djs download URL is set without a valid sha256 pin; it was not used.' };
  }
  if (!/^https:\/\//i.test(url)) return { problem: 'the djs download URL must use https.' };
  let bytes: ArrayBuffer;
  try {
    bytes = await fetchBytes(url);
  } catch (error) {
    return {
      problem: `downloading djs failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const check = await verifyDjsBytes(bytes, sha256);
  if (!check.ok) {
    return {
      problem: `the downloaded djs module does not match the pinned sha256 (it has ${check.actual}); it was discarded.`,
    };
  }
  try {
    await adapter.writeBinary(path, bytes);
  } catch (error) {
    plugin.console?.error('Could not cache the djs module', error);
  }
  return { bytes };
}

/**
 * Compiles the djs module once per path, URL and pin. Resolves to null when there is no module or
 * it fails its check; `djsProblem()` then says why.
 * @param plugin - Plugin.
 * @param fetchBytes - Downloader (tests pass a fake).
 */
export function loadDjsModule(
  plugin: PureChatLLM,
  fetchBytes?: BytesFetcher,
): Promise<WebAssembly.Module | null> {
  const { url, sha256 } = djsSource(plugin);
  const key = `${djsModulePath(plugin)}|${url}|${sha256}|${embedded.sha256}`;
  if (cached?.key === key) return cached.module;
  const module = (async () => {
    try {
      const { bytes, problem } = await obtainDjsBytes(plugin, fetchBytes);
      lastProblem = problem;
      if (!bytes) return null;
      return await WebAssembly.compile(bytes);
    } catch (error) {
      lastProblem = `the djs module could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
      plugin.console?.error('Could not load the djs module', error);
      return null;
    }
  })();
  cached = { key, module };
  void module.then(m => {
    if (!m && cached?.key === key) cached = null;
  });
  return module;
}

/** Why the last load found no usable djs module, if it didn't. */
export function djsProblem(): string | undefined {
  return lastProblem;
}

/** Forgets the compiled module, e.g. after the path setting changes. */
export function resetDjsModule(): void {
  cached = null;
  lastProblem = undefined;
}

/**
 * Runs a code mode script in a fresh djs sandbox. Each run gets its own wasm instance and heap,
 * a fuel budget and a memory cap; `stop` (the deadline or a cancellation) disposes it at once.
 * Scripts may be TypeScript.
 * @param module - Compiled djs module.
 * @param code - The model's script.
 * @param meta - Tool metadata and the persisted store.
 * @param meta.tools - Tools the script may call.
 * @param meta.store - Persisted values for `load()`.
 * @param host - Tool calls, store writes and streamed output.
 * @param stop - Aborts the run.
 * @param opts - Limits.
 * @param opts.maxFuel - Instruction budget.
 * @param opts.memoryLimitBytes - Heap cap.
 */
export async function runWithDjs(
  module: WebAssembly.Module,
  code: string,
  meta: { tools: unknown[]; store: Record<string, string> },
  host: CodeModeHost,
  stop: AbortSignal,
  opts: { maxFuel: number; memoryLimitBytes: number },
): Promise<CodeModeRunResult> {
  const sandbox = await Sandbox.create({
    module,
    typescript: true,
    maxFuel: opts.maxFuel,
    memoryLimit: opts.memoryLimitBytes,
    unhandledRejections: 'warn',
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    asyncFunctions: {
      // Failures come back as `{"error"}` so the guest throws a ToolError whatever djs does with
      // host exceptions.
      '__host.call': async (name: unknown, argsJson: unknown) => {
        try {
          const args = JSON.parse(typeof argsJson === 'string' ? argsJson : '{}') as Record<
            string,
            unknown
          >;
          return JSON.stringify({ value: (await host.call(String(name), args)) ?? null });
        } catch (error) {
          return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    functions: {
      '__host.store': (key: unknown, json: unknown) => {
        host.store(String(key), String(json));
        return undefined;
      },
      '__host.out': (kind: unknown, text: unknown) => {
        host.out?.(kind === 'console' ? 'console' : 'text', String(text));
        return undefined;
      },
    },
  });

  let onStop = () => {};
  const stopped = new Promise<CodeModeRunResult>(resolve => {
    onStop = () => resolve({ ok: false, error: 'Stopped.', outputs: [], console: [] });
    if (stop.aborted) onStop();
    else stop.addEventListener('abort', onStop, { once: true });
  });

  const run = (async (): Promise<CodeModeRunResult> => {
    try {
      const raw = await sandbox.runAsync(buildDjsScript(code), { __meta: meta });
      return JSON.parse(String(raw)) as CodeModeRunResult;
    } catch (error) {
      if (error instanceof SandboxError && (error.kind === 'fuel' || error.kind === 'memory')) {
        return {
          ok: false,
          limit: error.kind,
          error:
            error.kind === 'fuel'
              ? 'The script used its whole instruction budget.'
              : 'The script ran out of memory.',
          outputs: [],
          console: [],
        };
      }
      const message =
        error instanceof SandboxError
          ? `${error.kind}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      return { ok: false, error: message, outputs: [], console: [] };
    }
  })();

  try {
    return await Promise.race([run, stopped]);
  } finally {
    stop.removeEventListener('abort', onStop);
    sandbox.dispose();
  }
}
