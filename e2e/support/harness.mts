// Helpers shared by the specs: evidence capture, plugin setup against the fake services, and
// drivers for chats, sub-agents and the layered voice pipeline.
import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import fs from 'node:fs';
import path from 'node:path';
import { encodeScript } from '../fake-services/server.mjs';
import { REQUIREMENTS } from '../requirements.mjs';

export const OUT = process.env.E2E_OUT ?? path.resolve('e2e/.out');
export const FAKE_URL = process.env.FAKE_URL ?? 'http://127.0.0.1:8787';
const TRACE = path.join(OUT, 'traces', 'fake-services.jsonl');
const RESULTS = path.join(OUT, 'results.jsonl');

export interface ToolCallTrace {
  name: string;
  args: unknown;
  result: string;
}

export interface TraceEntry {
  service: string;
  kind?: string;
  script?: string;
  method?: string;
  messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
  reply?: { content?: string | null };
  [key: string]: unknown;
}

export interface Evidence {
  /** Saves a screenshot of the whole Obsidian window and lists it as evidence. */
  shot(name: string): Promise<string>;
  /** Saves JSON (tool-call trace, note contents, settings) and lists it as evidence. */
  save(name: string, data: unknown): string;
  /** A line for the report explaining what was observed. */
  note(text: string): void;
  /** Trace position at the start of the check. */
  mark: number;
}

function slug(s: string) {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

function record(entry: Record<string, unknown>) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(RESULTS, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** Rejects when the promise takes longer than `ms` (a frozen Obsidian window never answers). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} got no answer from Obsidian in ${ms / 1000} s (the window looks frozen)`)), ms);
    }),
  ]);
}

/** Whether the Obsidian window still answers a trivial script within `ms`. */
export async function windowResponds(ms = 10_000): Promise<boolean> {
  try {
    await withTimeout(browser.execute(() => 1), ms, 'A responsiveness probe');
    return true;
  } catch {
    return false;
  }
}

/**
 * Captures the page's console (errors, warnings, the plugin's debug log and its `[timing]` lines)
 * so a failing check can print what happened inside Obsidian.
 */
export async function installConsoleCapture() {
  await browser.execute(() => {
    const w = window as unknown as { __e2eConsole?: string[]; __e2eConsolePatched?: boolean };
    if (w.__e2eConsolePatched) return;
    w.__e2eConsolePatched = true;
    w.__e2eConsole = [];
    const keep = (level: string, args: unknown[]) => {
      const text = args
        .map(a => {
          if (a instanceof Error) return `${a.name}: ${a.message}`;
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a)?.slice(0, 400) ?? String(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
      const list = w.__e2eConsole as string[];
      list.push(`${new Date().toISOString().slice(11, 23)} ${level} ${text.slice(0, 1200)}`);
      if (list.length > 800) list.splice(0, list.length - 800);
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        keep(level, args);
        original(...args);
      };
    }
    window.addEventListener('error', e => keep('uncaught', [e.message]));
    window.addEventListener('unhandledrejection', e => keep('unhandled-rejection', [String((e as PromiseRejectionEvent).reason)]));
  });
}

/** Console lines captured since the page loaded, optionally filtered. */
export async function consoleLines(pattern?: RegExp): Promise<string[]> {
  const lines = await withTimeout(
    browser.execute(() => (window as unknown as { __e2eConsole?: string[] }).__e2eConsole ?? []),
    10_000,
    'Reading the console',
  );
  return pattern ? lines.filter(l => pattern.test(l)) : lines;
}

/** What Obsidian shows and does right now: open modals, notices, the plugin's state, the console tail. */
export async function diagnose(): Promise<Record<string, unknown>> {
  if (!(await windowResponds(8_000))) return { frozen: true, note: 'The Obsidian window did not answer a trivial script within 8 s.' };
  try {
    return await withTimeout(
      browser.executeObsidian(({ app, plugins }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = plugins.voiceAgent as any;
        const text = (sel: string) => [...document.querySelectorAll(sel)].map(n => (n.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600));
        return {
          modals: text('.modal-container .modal'),
          notices: text('.notice'),
          activeFile: app.workspace.getActiveFile()?.path ?? null,
          responding: !!p?.isresponding,
          tasks: (p?.agents?.list?.() ?? []).map((t: { id: string; title: string; status: string; error?: string }) => ({ id: t.id, title: t.title, status: t.status, error: t.error })),
          console: ((window as unknown as { __e2eConsole?: string[] }).__e2eConsole ?? []).slice(-60),
        };
      }),
      15_000,
      'Diagnosis',
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function obsidianVersions() {
  try {
    return { app: browser.getObsidianVersion(), installer: browser.getObsidianInstallerVersion() };
  } catch {
    return null;
  }
}

export function traceMark(): number {
  return fs.existsSync(TRACE) ? fs.readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).length : 0;
}

export function traceSince(mark: number): TraceEntry[] {
  if (!fs.existsSync(TRACE)) return [];
  return fs
    .readFileSync(TRACE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(mark)
    .map(l => JSON.parse(l) as TraceEntry);
}

/**
 * Tool calls the plugin actually made for a scripted conversation, with the exact text each tool
 * returned, read from the request the plugin sent back to the fake model.
 */
export function toolCalls(scriptId: string, mark = 0): ToolCallTrace[] {
  const entries = traceSince(mark).filter(e => e.service === 'llm' && e.script === scriptId);
  const last = entries[entries.length - 1];
  if (!last?.messages) return [];
  const calls: ToolCallTrace[] = [];
  const byId = new Map<string, ToolCallTrace>();
  for (const m of last.messages) {
    for (const c of m.tool_calls ?? []) {
      let args: unknown = c.function.arguments;
      try {
        args = JSON.parse(c.function.arguments);
      } catch {
        // keep the raw string
      }
      const t = { name: c.function.name, args, result: '' };
      byId.set(c.id, t);
      calls.push(t);
    }
    if (m.role === 'tool' && m.tool_call_id && byId.has(m.tool_call_id)) {
      byId.get(m.tool_call_id)!.result = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    }
  }
  return calls;
}

/**
 * Declares one requirement check. Records pass or fail with its evidence in results.jsonl.
 * @param id - Requirement id from requirements.mjs.
 * @param scenario - What the check does, in one line.
 * @param fn - The check.
 */
export function check(id: string, scenario: string, fn: (ev: Evidence) => Promise<void>) {
  const req = REQUIREMENTS.find(r => r.id === id);
  if (!req) throw new Error(`Unknown requirement ${id}`);
  it(`${id}: ${req.title}`, async function () {
    const evidence: string[] = [];
    const notes: string[] = [];
    const ev: Evidence = {
      mark: traceMark(),
      async shot(name) {
        const rel = path.join('screenshots', `${slug(id)}--${slug(name)}.png`);
        await browser.saveScreenshot(path.join(OUT, rel));
        evidence.push(rel);
        return rel;
      },
      save(name, data) {
        const rel = path.join('traces', `${slug(id)}--${slug(name)}.json`);
        fs.mkdirSync(path.join(OUT, 'traces'), { recursive: true });
        fs.writeFileSync(path.join(OUT, rel), JSON.stringify(data, null, 2));
        evidence.push(rel);
        return rel;
      },
      note(text) {
        notes.push(text);
      },
    };
    const started = Date.now();
    try {
      await fn(ev);
      // Every check keeps the fake-service traffic it caused.
      const traffic = traceSince(ev.mark);
      if (traffic.length) ev.save('fake-service-traffic', traffic);
      record({ id, scenario, status: 'pass', evidence, notes, obsidian: obsidianVersions(), ms: Date.now() - started });
      console.log(`[e2e-result] ${id} PASS (${Date.now() - started} ms) ${notes.join(' ').slice(0, 300)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnosis = await diagnose();
      ev.save('diagnosis', diagnosis);
      if (!diagnosis.frozen) {
        try {
          await withTimeout(ev.shot('at-failure'), 15_000, 'The failure screenshot');
        } catch {
          // Obsidian may be gone; keep the error.
        }
      }
      const traffic = traceSince(ev.mark);
      if (traffic.length) ev.save('fake-service-traffic', traffic);
      record({ id, scenario, status: 'fail', evidence, notes, obsidian: obsidianVersions(), error: message, ms: Date.now() - started });
      console.log(`[e2e-result] ${id} FAIL (${Date.now() - started} ms) ${message.replace(/\s+/g, ' ').slice(0, 400)}`);
      console.log(`[e2e-diagnose] ${id} ${JSON.stringify(diagnosis).slice(0, 6000)}`);
      throw error;
    }
  });
}

/** Points every model layer and MCP server at the fake services. */
export async function useFakeServices() {
  await browser.executeObsidian(
    async ({ plugins }, url: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = plugins.voiceAgent as any;
      const s = p.settings;
      let i = s.endpoints.findIndex((e: { name: string }) => e.name === 'Fake LLM');
      if (i < 0) {
        s.endpoints.push({ name: 'Fake LLM', apiKey: 'fake-key-not-a-secret', endpoint: `${url}/v1`, defaultmodel: 'fake-model', getapiKey: '' });
        i = s.endpoints.length - 1;
      }
      s.endpoint = i;
      s.agentMode = true;
      s.AutogenerateTitle = 0;
      for (const layer of ['orchestrator', 'worker']) {
        Object.assign(s.orchestrator.layers[layer], { endpoint: 'Fake LLM', model: 'fake-model', api: 'chat', effort: '' });
      }
      s.orchestrator.layers.evaluator.enabled = false;
      s.orchestrator.relevanceCheck = 'keywords';
      s.orchestrator.checkInMinutes = 60;
      s.voice.saveCalls = true;
      s.voice.callsFolder = 'Voice Agent';
      const base = { enabled: true, bearerToken: '', headers: '', mode: 'bridge', allowedTools: '', auth: 'token' };
      s.mcpServers = [
        { ...base, name: 'fake-modern', url: `${url}/mcp` },
        { ...base, name: 'fake-legacy', url: `${url}/mcp-legacy` },
      ];
      // The plugin's debug log carries the [timing] lines (system review, latency).
      s.debug = true;
      if (p.console) p.console.enabled = true;
      await p.saveSettings();
      await p.mcp.refreshAll(false);
    },
    FAKE_URL,
  );
  await installConsoleCapture();
}

/** Runs a chat note through the plugin's "Complete chat response" command. */
export async function runChat(
  id: string,
  text: string,
  script: { rounds: Array<Array<{ name: string; args?: unknown }>>; final?: string },
  opts: { onModal?: (title: string) => Promise<void>; timeout?: number } = {},
): Promise<{ file: string; final: string; text: string }> {
  const file = `Chats/${slug(id)}.md`;
  const final = script.final ?? `FINAL-${slug(id)}`;
  const body = `# role: user\n${text}\n\n${encodeScript({ id, ...script, final })}\n`;
  await browser.executeObsidian(
    async ({ app }, file: string, body: string) => {
      if (!app.vault.getAbstractFileByPath('Chats')) await app.vault.createFolder('Chats');
      const existing = app.vault.getFileByPath(file);
      if (existing) await app.vault.modify(existing, body);
      else await app.vault.create(file, body);
    },
    file,
    body,
  );
  await obsidianPage.openFile(file);
  await browser.executeObsidianCommand('voice-agent:complete-chat-response');
  const seen = new Set<string>();
  let last = '';
  await browser.waitUntil(
    async () => {
      const title = await openModalTitle();
      if (title && opts.onModal && !seen.has(title)) {
        await opts.onModal(title);
        seen.add(title);
      }
      const state = await browser.executeObsidian(async ({ app, plugins }, file: string) => {
        // Read the chat's own editor (a tool may have opened another note), else the file on disk.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const leaf = app.workspace.getLeavesOfType('markdown').find(l => (l.view as any).file?.path === file);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fromEditor = (leaf?.view as any)?.editor?.getValue?.() as string | undefined;
        const f = app.vault.getFileByPath(file);
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          responding: !!(plugins.voiceAgent as any).isresponding,
          text: fromEditor ?? (f ? await app.vault.read(f) : ''),
        };
      }, file);
      last = state.text;
      return !state.responding && state.text.includes(final);
    },
    { timeout: opts.timeout ?? 60_000, interval: 500, timeoutMsg: `Chat ${id} did not finish with ${final} within ${(opts.timeout ?? 60_000) / 1000} s` },
  );
  return { file, final, text: last };
}

/** Title (h2) of the open modal, or ''. */
export async function openModalTitle(): Promise<string> {
  return browser.execute(() => document.querySelector('.modal-container .modal h2, .modal-container .modal-title')?.textContent?.trim() ?? '');
}

/** Clicks a button with this label in the open modal. */
export async function clickModalButton(label: string) {
  // WebdriverIO's `tag=text` selector only works on its own, not after a CSS ancestor, so find the
  // modal first and the button inside it. (The first CI run used `.modal-container button=…`,
  // which matched nothing, so every modal stayed open until the chat timed out.)
  const modal = await browser.$('.modal-container');
  await modal.waitForExist({ timeout: 10_000 });
  const button = await modal.$(`button=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
}

type WorkerScript = { rounds: Array<Array<{ name: string; args?: unknown }>>; final?: string; delays?: number[]; finalDelayMs?: number; drop?: boolean };

/** Starts a background sub-agent (worker layer) with a scripted brief; returns at once. */
export async function startWorker(title: string, brief: string, script: WorkerScript, origin = 'test') {
  const id = slug(title);
  const prompt = `${brief}\n\n${encodeScript({ id, ...script, final: script.final ?? `FINAL-${id}` })}`;
  const taskId = await browser.executeObsidian(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ plugins }, title: string, prompt: string, origin: string) => (plugins.voiceAgent as any).agents.spawn(title, prompt, origin).id as string,
    title,
    prompt,
    origin,
  );
  return { scriptId: id, taskId };
}

/** Reads a task's state. */
export async function readTask(taskId: string): Promise<Record<string, unknown>> {
  return browser.executeObsidian(({ plugins }, taskId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (plugins.voiceAgent as any).agents.find(taskId);
    return t
      ? JSON.parse(JSON.stringify({ id: t.id, status: t.status, result: t.result, error: t.error, steps: t.steps, notePath: t.notePath, parentNote: t.parentNote, topicNote: t.topicNote, callNote: t.callNote }))
      : {};
  }, taskId);
}

/** Waits for a task to end. */
export async function waitTask(taskId: string, timeout = 120_000): Promise<Record<string, unknown>> {
  let task: Record<string, unknown> = {};
  await browser.waitUntil(
    async () => {
      task = await readTask(taskId);
      return ['done', 'failed', 'cancelled'].includes(String(task.status));
    },
    { timeout, interval: 500, timeoutMsg: `Task ${taskId} did not end within ${timeout / 1000} s` },
  );
  return task;
}

/** Sets plugin settings by dotted path (null deletes the key) and saves them. */
export async function setSettings(values: Record<string, unknown>) {
  await browser.executeObsidian(async ({ plugins }, values: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plugins.voiceAgent as any;
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.');
      let o = p.settings;
      for (const k of parts.slice(0, -1)) o = o[k] ??= {};
      if (value === null) delete o[parts[parts.length - 1]];
      else o[parts[parts.length - 1]] = value;
    }
    await p.saveSettings();
  }, values);
}

/** Starts a background sub-agent (worker layer) with a scripted brief and waits for it to end. */
export async function runWorker(title: string, brief: string, script: WorkerScript, timeout = 120_000) {
  const id = slug(title);
  const prompt = `${brief}\n\n${encodeScript({ id, ...script, final: script.final ?? `FINAL-${id}` })}`;
  const taskId = await browser.executeObsidian(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ plugins }, title: string, prompt: string) => (plugins.voiceAgent as any).agents.spawn(title, prompt, 'test').id as string,
    title,
    prompt,
  );
  let task: Record<string, unknown> = {};
  await browser.waitUntil(
    async () => {
      task = await browser.executeObsidian(({ plugins }, taskId: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = (plugins.voiceAgent as any).agents.find(taskId);
        return t ? { id: t.id, status: t.status, result: t.result, error: t.error, steps: t.steps, notePath: t.notePath } : {};
      }, taskId);
      return ['done', 'failed', 'cancelled'].includes(String(task.status));
    },
    { timeout, interval: 500, timeoutMsg: `Worker ${title} did not finish` },
  );
  return { scriptId: id, task };
}

export async function readNote(p: string): Promise<string | null> {
  return browser.executeObsidian(async ({ app }, p: string) => {
    const f = app.vault.getFileByPath(p);
    return f ? app.vault.read(f) : null;
  }, p);
}

export async function listFiles(prefix: string): Promise<string[]> {
  return browser.executeObsidian(async ({ app }, prefix: string) => {
    const all = await app.vault.adapter.list(prefix).catch(() => ({ files: [] as string[], folders: [] as string[] }));
    return [...all.files, ...all.folders];
  }, prefix);
}

export { encodeScript, expect };
