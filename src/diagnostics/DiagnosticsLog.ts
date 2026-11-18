// The diagnostics log: an opt-in record of what the plugin did, for auditing it afterwards. Every
// event is one JSON line in `<folder>/<YYYY-MM-DD>/<session>.jsonl`, one file per plugin session
// (a new part when a file reaches its size cap), and day folders older than the retention period
// are removed when the plugin starts. Lines are written a couple of seconds after they happen, in
// batches, so logging never slows a call. Everything goes through `redact.ts` first.
//
// Events, by `source` and `kind`:
// - session start/stop, with the plugin's version and setup
// - console log/info/warn/error from the plugin's own consoles; app-console warn/error and
//   app-error uncaught/rejection from the rest of the app, when that is switched on
// - tool call: name, role (voice, orchestrator, worker…), arguments, result, duration
// - model request/response/error: each layer request and each chat request, with duration
// - voice transcript/status, call start/end (with the call note's path), orchestrator lines
//
// The log is a module-level singleton, so code anywhere can record without a plugin reference;
// it does nothing until the plugin configures and enables it.
import { collectSecrets, redactValue } from './redact';

export interface DiagnosticsSettings {
  /** Writes the log. Off by default. */
  enabled: boolean;
  /** Vault folder for the logs. */
  folder: string;
  /** Size of one log file before a new part starts, in MB. */
  maxFileMB: number;
  /** Days of logs kept; older day folders are removed at startup. 0 keeps them all. */
  keepDays: number;
  /** Longest text kept in one field (prompts, tool results, console output). */
  maxFieldChars: number;
  /** Writes each model request's whole prompt and tool list, not only what is new in it. */
  fullPrompts: boolean;
  /** Also records warnings and errors from the rest of the app's console. */
  appConsole: boolean;
}

export const DEFAULT_DIAGNOSTICS: DiagnosticsSettings = {
  enabled: false,
  folder: 'Voice Agent/Diagnostics',
  maxFileMB: 5,
  keepDays: 14,
  maxFieldChars: 20_000,
  fullPrompts: false,
  appConsole: true,
};

/** The vault adapter calls the log needs (Obsidian's `DataAdapter`). */
export interface DiagnosticsStore {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface DiagnosticsSetup {
  settings: () => DiagnosticsSettings;
  store: DiagnosticsStore;
  /** The plugin's settings, for the secret values to remove. */
  secretsFrom: () => unknown;
  /** Facts about the setup written at the start of each session. */
  about?: () => Record<string, unknown>;
  now?: () => number;
}

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

const FLUSH_MS = 2_000;
const FLUSH_LINES = 200;
const MAX_BUFFER = 5_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function day(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function trimSlashes(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}

export class DiagnosticsLog {
  private setup: DiagnosticsSetup | null = null;
  private session = '';
  private sessionDay = '';
  private startedAt = 0;
  private part = 1;
  private bytes = 0;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private secrets: string[] = [];
  private call: { id: string; note: string } | null = null;
  private seq = 0;
  private seen = new Set<string>();
  private dropped = 0;
  private recording = false;
  private unhook: (() => void) | null = null;
  /** Set while a plugin console forwards to the app console, so the line is not logged twice. */
  forwarding = false;

  /** Whether each model request is written whole. */
  get fullPrompts(): boolean {
    return !!this.setup?.settings().fullPrompts;
  }

  /** Whether events are being recorded. */
  get enabled(): boolean {
    return !!this.setup && this.setup.settings().enabled && !!this.session;
  }

  /** The file events are written to now, or null when the log is off. */
  currentPath(): string | null {
    if (!this.enabled || !this.setup) return null;
    const folder = trimSlashes(this.setup.settings().folder) || DEFAULT_DIAGNOSTICS.folder;
    const suffix = this.part > 1 ? `-${this.part}` : '';
    return `${folder}/${this.sessionDay}/${this.session}${suffix}.jsonl`;
  }

  /** Connects the log to the vault. It records nothing until `start`, and only while enabled. */
  configure(setup: DiagnosticsSetup): void {
    this.setup = setup;
  }

  private now(): number {
    return this.setup?.now?.() ?? Date.now();
  }

  /**
   * Starts a session when the setting is on (at plugin load, and when it is switched on), or
   * stops it when the setting is off.
   */
  async start(): Promise<void> {
    const setup = this.setup;
    if (!setup) return;
    const settings = setup.settings();
    if (!settings.enabled) {
      await this.stop();
      return;
    }
    this.refreshSecrets();
    if (!this.session) {
      this.startedAt = this.now();
      this.sessionDay = day(this.startedAt);
      this.session = `${clock(this.startedAt)}-${Math.random().toString(36).slice(2, 6)}`;
      this.part = 1;
      this.bytes = 0;
      this.seen.clear();
      this.record('session', 'start', { ...(setup.about?.() ?? {}), settings });
      void this.prune().catch(() => undefined);
    }
    this.hookAppConsole(settings.appConsole);
  }

  /** Writes what is left and stops recording. */
  async stop(): Promise<void> {
    if (this.session) this.record('session', 'stop', { ms: this.now() - this.startedAt });
    this.hookAppConsole(false);
    await this.flush();
    this.session = '';
    this.call = null;
  }

  /** Reads the secret values from settings again (after a key changes). */
  refreshSecrets(): void {
    try {
      this.secrets = collectSecrets(this.setup?.secretsFrom());
    } catch {
      this.secrets = [];
    }
  }

  /** The voice call that later events belong to, or null when it ends. */
  setCall(call: { id: string; note: string } | null): void {
    if (call) this.record('call', 'start', { call: call.id, note: call.note });
    else if (this.call) this.record('call', 'end', { call: this.call.id, note: this.call.note });
    this.call = call;
  }

  /** True the first time a key is seen in this session (for text written once per file). */
  firstTime(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** A short ID to tie a request to its response. */
  nextId(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  /**
   * Records one event. Does nothing while the log is off, and never throws.
   * @param source - Where it happened (`tool`, `model`, `voice`…).
   * @param kind - What happened (`call`, `request`…).
   * @param data - Details; secrets are removed and long text cut before writing.
   */
  record(source: string, kind: string, data: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.setup || this.recording) return;
    this.recording = true;
    try {
      const settings = this.setup.settings();
      const at = this.now();
      const event = {
        ts: new Date(at).toISOString(),
        t: at - this.startedAt,
        source,
        kind,
        ...(this.call ? { call: this.call.id } : {}),
        ...(redactValue(data, {
          known: this.secrets,
          maxChars: Math.max(500, settings.maxFieldChars),
        }) as Record<string, unknown>),
      };
      if (this.buffer.length >= MAX_BUFFER) {
        this.buffer.shift();
        this.dropped++;
      }
      this.buffer.push(JSON.stringify(event));
      if (this.buffer.length >= FLUSH_LINES) void this.flush();
      else this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
    } catch {
      // A log line that can't be written is dropped; logging never breaks the plugin.
      this.dropped++;
    } finally {
      this.recording = false;
    }
  }

  /** A console line from one of the plugin's consoles. */
  console(name: string, level: ConsoleLevel, args: unknown[]): void {
    this.record('console', level, { name, args });
  }

  /** Writes the buffered events to the current file. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = this.writing.then(() => this.write()).catch(() => undefined);
    return this.writing;
  }

  private async write(): Promise<void> {
    const setup = this.setup;
    if (!setup || !this.buffer.length || !this.session) return;
    const lines = this.buffer.splice(0);
    if (this.dropped) {
      lines.push(
        JSON.stringify({
          ts: new Date(this.now()).toISOString(),
          source: 'diagnostics',
          kind: 'dropped',
          lines: this.dropped,
        }),
      );
      this.dropped = 0;
    }
    const cap = Math.max(0.1, setup.settings().maxFileMB) * 1024 * 1024;
    let chunk = '';
    const writeChunk = async () => {
      if (!chunk) return;
      const path = this.currentPath();
      if (!path) return;
      const folder = path.slice(0, path.lastIndexOf('/'));
      await this.ensureFolder(folder);
      await setup.store.append(path, chunk);
      this.bytes += chunk.length;
      chunk = '';
    };
    for (const line of lines) {
      if (this.bytes + chunk.length + line.length + 1 > cap && this.bytes + chunk.length > 0) {
        await writeChunk();
        this.part++;
        this.bytes = 0;
      }
      chunk += `${line}\n`;
    }
    await writeChunk();
  }

  private async ensureFolder(path: string): Promise<void> {
    const store = this.setup?.store;
    if (!store) return;
    let at = '';
    for (const part of path.split('/')) {
      at = at ? `${at}/${part}` : part;
      if (!(await store.exists(at))) await store.mkdir(at);
    }
  }

  /** Removes day folders older than the retention period. */
  async prune(): Promise<void> {
    const setup = this.setup;
    if (!setup) return;
    const { keepDays, folder } = setup.settings();
    if (!(keepDays > 0)) return;
    const root = trimSlashes(folder) || DEFAULT_DIAGNOSTICS.folder;
    if (!(await setup.store.exists(root))) return;
    const oldest = day(this.now() - keepDays * 86_400_000);
    const { folders } = await setup.store.list(root);
    for (const path of folders) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      // Only the log's own day folders are touched.
      if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < oldest) {
        await setup.store.rmdir(path, true);
      }
    }
  }

  /** Records warnings and errors from the whole app's console, and uncaught errors. */
  private hookAppConsole(on: boolean): void {
    if (!on) {
      this.unhook?.();
      this.unhook = null;
      return;
    }
    if (this.unhook) return;
    const target = console as unknown as Record<'warn' | 'error', (...args: unknown[]) => void>;
    const original = { warn: target.warn, error: target.error };
    for (const level of ['warn', 'error'] as const) {
      const wrapped = (...args: unknown[]) => {
        if (!this.forwarding) this.record('app-console', level, { args });
        original[level].apply(console, args);
      };
      target[level] = wrapped;
    }
    const scope = globalThis as unknown as {
      addEventListener?: (type: string, listener: (event: unknown) => void) => void;
      removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
    };
    const onError = (event: unknown) => {
      const e = event as { message?: string; error?: unknown; filename?: string; lineno?: number };
      this.record('app-error', 'uncaught', {
        message: e.message,
        error: e.error,
        at: e.filename ? `${e.filename}:${e.lineno ?? 0}` : undefined,
      });
    };
    const onRejection = (event: unknown) =>
      this.record('app-error', 'rejection', { reason: (event as { reason?: unknown }).reason });
    scope.addEventListener?.('error', onError);
    scope.addEventListener?.('unhandledrejection', onRejection);
    this.unhook = () => {
      target.warn = original.warn;
      target.error = original.error;
      scope.removeEventListener?.('error', onError);
      scope.removeEventListener?.('unhandledrejection', onRejection);
    };
  }
}

/** The plugin's diagnostics log. */
export const diagnostics = new DiagnosticsLog();

/**
 * Times an async step and records it, with its result or error.
 * @param source - Event source.
 * @param kind - Event kind.
 * @param data - Details written with it.
 * @param run - The step.
 * @param describe - What of the result to write.
 */
export async function traced<T>(
  source: string,
  kind: string,
  data: Record<string, unknown>,
  run: () => Promise<T>,
  describe: (result: T) => Record<string, unknown>,
): Promise<T> {
  if (!diagnostics.enabled) return run();
  const started = Date.now();
  try {
    const result = await run();
    diagnostics.record(source, kind, { ...data, ...describe(result), ms: Date.now() - started });
    return result;
  } catch (error) {
    diagnostics.record(source, kind, { ...data, ok: false, error, ms: Date.now() - started });
    throw error;
  }
}

/**
 * What to write about a model request: the whole prompt when full prompts are on, otherwise the
 * size of the prompt and the messages added since the model last answered (the new user turn or
 * tool results), since the rest was written with the earlier requests.
 * @param request - A Chat Completions request.
 */
export function requestDetail(request: {
  model?: string;
  messages?: readonly { role?: string; [key: string]: unknown }[];
  tools?: readonly unknown[];
}): Record<string, unknown> {
  const messages = request.messages ?? [];
  const tools = request.tools ?? [];
  if (diagnostics.fullPrompts) return { model: request.model, messages, tools };
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      last = i;
      break;
    }
  }
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const systemId = system ? hash(JSON.stringify(system)) : undefined;
  // Instructions repeat in every request, so each version is written once and named after.
  const firstSeen = systemId !== undefined && diagnostics.firstTime(`system:${systemId}`);
  return {
    model: request.model,
    messageCount: messages.length,
    toolCount: tools.length,
    systemId,
    ...(firstSeen ? { system } : {}),
    newMessages: messages.slice(last + 1).filter(m => m.role !== 'system'),
  };
}

/** A short, stable fingerprint of a text. */
export function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
