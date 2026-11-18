// Opens the shared memory graph, keeps it saved in the vault and merges in copies that sync
// brings from other devices. Everything that reads or writes memory goes through here: the
// standing brief for system prompts, the per-turn context blocks, the harness's live state, the
// librarian's background passes and the embeddings that let recall find things by meaning.
import { diagnostics } from '../diagnostics/DiagnosticsLog';
import { MemoryGraph, mergeSnapshots, newKey } from './MemoryGraph';
import type { AgentName, Embedded, FactRow, MemorySnapshot } from './MemoryGraph';
import { loadRelate, relateAvailable } from './relateEngine';
import {
  applyLibrarianOps,
  librarianMessages,
  parseLibrarianOutput,
  summaryText,
} from './Librarian';
import type { LibrarianInput, LibrarianLine, LibrarianOutput } from './Librarian';
import { clipLine, fitBlock, localDate } from './text';

export interface MemorySettings {
  /** Off by default: nothing is loaded or written until it is turned on. */
  enabled: boolean;
  /** Vault folder that holds memory.json. */
  folder: string;
  /** Longest memory brief put in an agent's instructions, in characters (0 for none). */
  briefChars: number;
  /** Record calls, tasks, relays and live state in the graph by themselves. */
  autoRecord: boolean;
  /**
   * Run the librarian: after each call and each finished task (and during long calls) the worker
   * model reads what is new and files facts, confirmations and the call's summary.
   */
  consolidate: boolean;
  /** During a call, the librarian reads the new lines after this many things the user said (0: only at the end). */
  consolidateEveryTurns: number;
  /** Endpoint (by name) used for embeddings: '' picks one with a key, 'off' uses none. */
  embeddingEndpoint: string;
  /** Embedding model; '' uses the endpoint's usual one. */
  embeddingModel: string;
}

export const DEFAULT_MEMORY: MemorySettings = {
  enabled: false,
  folder: 'Voice Agent/Memory',
  briefChars: 2500,
  autoRecord: true,
  consolidate: true,
  consolidateEveryTurns: 8,
  embeddingEndpoint: '',
  embeddingModel: '',
};

/** Who an agent's memory text is for. */
export type MemoryRole = 'voice' | 'orchestrator' | 'worker' | 'chat';

/** Longest per-turn context block for each role (audit item 3). */
export const CONTEXT_CHARS: Record<MemoryRole, number> = {
  voice: 600,
  orchestrator: 1500,
  worker: 1500,
  chat: 1200,
};

/** The models the memory may use; the plugin supplies them (see pluginModels.ts). */
export interface MemoryModels {
  /** Runs one prompt on the worker model and returns its text. */
  complete?: (system: string, user: string) => Promise<string>;
  /** Why the worker model can't run now, or ''. */
  completeProblem?: () => string;
  /** Embeds texts, in order; null when no embeddings endpoint can be used now. */
  embed?: (texts: string[]) => Promise<Embedded[] | null>;
  /** The embedding model in use now, or '' when there is none. */
  embedModel?: () => string;
}

/** Something the memory learned that every agent should hear about now. */
export interface MemoryUpdate {
  kind: 'important';
  facts: { key: string; text: string }[];
}

/** The vault calls the service needs (Obsidian's DataAdapter has them). */
export interface MemoryStore {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

const FILE = 'memory.json';
const SAVE_DELAY_MS = 1500;
/** Longest wait for a query's embedding before a context block falls back to words. */
const EMBED_WAIT_MS = 1500;
/** After an embeddings request fails, how long before trying again. */
const EMBED_RETRY_MS = 10 * 60_000;
/** Nodes embedded per background batch. */
const BACKFILL_BATCH = 32;
/** Days between passes that close faded observations. */
const MAINTENANCE_DAYS = 7;

/**
 * Resolves with the promise's value, or with the fallback after `ms`.
 * @param promise - Work.
 * @param ms - Longest wait.
 * @param fallback - Value after the wait.
 */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Maps a chat role to the agent that holds it. */
export function agentForRole(role: string | undefined): AgentName {
  switch (role) {
    case 'subagent':
      return 'worker';
    case 'orchestrator-agent':
    case 'orchestrator':
      return 'orchestrator';
    case 'voice':
    case 'direct-voice':
      return 'voice';
    default:
      return 'chat';
  }
}

export class MemoryService {
  private graph: MemoryGraph | null = null;
  private opening: Promise<MemoryGraph> | null = null;
  /** The file's text as last read or written, so our own writes are not merged back in. */
  private lastText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** A file that could not be read is never overwritten. */
  private blocked: string | null = null;
  /** This load of the app, as a session. */
  readonly appSession: string;
  /** The open voice call's session, when there is one. */
  callSession: string | null = null;
  /** The models the librarian and embeddings use, once the plugin supplies them. */
  private models: MemoryModels = {};
  /** The librarian's passes, one at a time. */
  private jobs: Promise<void> = Promise.resolve();
  /** Passes queued or running. */
  private pendingJobs = 0;
  private embedCache = new Map<string, Embedded>();
  private embedBlockedUntil = 0;
  private backfilling = false;
  private updateListeners = new Set<(update: MemoryUpdate) => void>();
  private standingCache: { key: string; text: string } | null = null;
  /** The relay being worked on, so the tasks it starts link to it. */
  private currentRequest: { key: string; session: string; at: number } | null = null;

  constructor(
    private options: {
      settings: () => MemorySettings;
      store: MemoryStore;
      now?: () => number;
      /** Told when the file stops or starts being saved, so the user can hear about it. */
      onProblem?: (problem: string | null) => void;
      /** Waits between reads of a file that sync may still be writing. */
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    const now = this.now();
    this.appSession = `app-${now.toString(36)}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get settings(): MemorySettings {
    return this.options.settings();
  }

  /** On in settings and carried by this build. */
  get enabled(): boolean {
    return !!this.settings.enabled && relateAvailable();
  }

  /** The session new memories belong to: the open call, or else this app session. */
  get session(): string {
    return this.callSession ?? this.appSession;
  }

  get folder(): string {
    return (this.settings.folder || DEFAULT_MEMORY.folder).trim().replace(/^\/+|\/+$/g, '');
  }

  get path(): string {
    return `${this.folder}/${FILE}`;
  }

  /**
   * Sets or clears the reason the file isn't saved, and says so when it changes.
   * @param problem - Reason, or null when saving can go on.
   */
  private setBlocked(problem: string | null): void {
    if (problem === this.blocked) return;
    this.blocked = problem;
    diagnostics.record('memory', problem ? 'blocked' : 'unblocked', { path: this.path });
    try {
      this.options.onProblem?.(problem);
    } catch {
      // A listener's failure must not stop memory.
    }
  }

  /**
   * Reads the file, trying again when it is empty or half-written (sync may be mid-write).
   * Returns the text and its snapshot, or the text and the parse error after the last try.
   */
  private async readFile(): Promise<{ text: string; snapshot?: MemorySnapshot; error?: Error }> {
    const store = this.options.store;
    const sleep = this.options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    let last: { text: string; snapshot?: MemorySnapshot; error?: Error } = { text: '' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(400 * attempt);
      const text = (await store.exists(this.path)) ? await store.read(this.path) : '';
      if (!text.trim()) {
        last = { text };
        continue;
      }
      try {
        return { text, snapshot: JSON.parse(text) as MemorySnapshot };
      } catch (error) {
        last = { text, error: error as Error };
      }
    }
    return last;
  }

  /** Why the memory file is not being written, if it is not. */
  get problem(): string | null {
    return this.blocked;
  }

  /** Opens the graph from the vault file (once). */
  open(): Promise<MemoryGraph> {
    if (!this.enabled) return Promise.reject(new Error('Memory is off in settings.'));
    this.opening ??= (async () => {
      await loadRelate();
      const graph = new MemoryGraph({ now: () => this.now() });
      const read = await this.readFile();
      if (read.snapshot) graph.load(read.snapshot);
      else if (read.error) {
        // Never replace a file we could not read: keep working in memory, save nothing until
        // a later read of it succeeds.
        this.setBlocked(
          `${this.path} could not be read (${read.error.message}), so memory is not saved until it is fixed or moved.`,
        );
      }
      const text = read.text;
      this.lastText = text;
      this.graph = graph;
      if (this.settings.autoRecord) graph.startSession(this.appSession, 'app', 'Obsidian session');
      try {
        graph.closeStaleTasks(this.appSession);
      } catch (error) {
        diagnostics.record('memory', 'close-stale-failed', { error: String(error) });
      }
      try {
        this.maintain(graph);
      } catch (error) {
        diagnostics.record('memory', 'maintenance-failed', { error: String(error) });
      }
      const model = this.models.embedModel?.() ?? '';
      if (model) graph.ensureVectorIndex(graph.embeddingDims(model));
      this.scheduleSave();
      this.scheduleBackfill();
      return graph;
    })().catch(error => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  /**
   * Runs work on the graph and saves afterwards if it changed anything.
   * @param work - Reads or writes.
   */
  async use<T>(work: (graph: MemoryGraph) => T): Promise<T> {
    const graph = await this.open();
    try {
      return work(graph);
    } finally {
      if (graph.dirty) this.scheduleSave();
    }
  }

  /**
   * Like `use`, but does nothing (and never throws) when memory is off or fails: for the
   * automatic records the harness makes.
   * @param work - Writes.
   */
  quietly(work: (graph: MemoryGraph) => void): void {
    if (!this.enabled || !this.settings.autoRecord) return;
    void this.use(work).catch(error =>
      diagnostics.record('memory', 'auto-record-failed', { error: String(error) }),
    );
  }

  /**
   * The memory brief for an agent's instructions, or '' when memory is off. The voice agent's
   * (the default) holds how to use the memory, the standing preferences, instructions and pinned
   * facts, the last session's summary and what is happening now; other roles get the standing
   * brief alone (`standingBrief`), and what matters for each request comes in its context block.
   * Synchronous, so instructions can be built on the spot; before the graph has opened it gives
   * the guidance alone and starts opening it.
   * @param role - Whose instructions.
   */
  brief(role: MemoryRole = 'voice'): string {
    if (role !== 'voice') return this.standingBrief(role);
    if (!this.enabled) return '';
    const guidance = guidanceFor('voice');
    const graph = this.graph;
    if (!graph) {
      void this.open().catch(() => undefined);
      return guidance;
    }
    if (this.settings.briefChars <= 0) return guidance;
    try {
      const max = this.settings.briefChars;
      const parts = [
        graph.standingBrief(Math.round(max * 0.6)),
        clipLine(graph.lastSessionLine(this.session), Math.round(max * 0.25)),
        graph.nowSummary(this.session, CONTEXT_CHARS.voice),
      ].filter(Boolean);
      let text = parts.join('\n');
      if (text.length > max) text = `${text.slice(0, max - 1)}…`;
      return text ? `${guidance}\n\n${MEMORY_BRIEF_INTRO}\n${text}` : guidance;
    } catch (error) {
      diagnostics.record('memory', 'brief-failed', { error: String(error) });
      return guidance;
    }
  }

  /**
   * The part of the memory that belongs in a system prompt: how this role uses the memory, and
   * the standing preferences, instructions and pinned facts. It is rebuilt only when a fact
   * changes, and its text changes only when one of those facts does, so prompt caching holds
   * (M9). '' when memory is off.
   * @param role - Whose instructions.
   */
  standingBrief(role: MemoryRole): string {
    if (!this.enabled) return '';
    const guidance = guidanceFor(role);
    const graph = this.graph;
    if (!graph) {
      void this.open().catch(() => undefined);
      return guidance;
    }
    const max = this.settings.briefChars;
    if (max <= 0) return guidance;
    const key = `${role}|${graph.factVersion}|${max}`;
    if (this.standingCache?.key !== key) {
      let text = '';
      try {
        text = graph.standingBrief(max);
      } catch (error) {
        diagnostics.record('memory', 'brief-failed', { error: String(error) });
      }
      this.standingCache = { key, text };
    }
    const text = this.standingCache.text;
    return text ? `${guidance}\n\n${MEMORY_BRIEF_INTRO}\n${text}` : guidance;
  }

  /**
   * The context block for one turn: what is happening now (for the voice and the orchestrator)
   * and the facts, task results and call summaries that match the request, sized for the role.
   * Goes in the user message, not the system prompt. Never throws; '' when memory is off or
   * nothing matches. Waits at most a moment for the request's embedding.
   * @param role - Who reads it.
   * @param request - The request's text (a relay, a worker's brief, a chat turn).
   * @param options - What it names, and the size.
   * @param options.about - Notes or entities it names (the active note, as [[path]]).
   * @param options.maxChars - Longest block (default by role).
   */
  async context(
    role: MemoryRole,
    request: string,
    options: { about?: string[]; maxChars?: number } = {},
  ): Promise<string> {
    if (!this.enabled) return '';
    try {
      if (!this.graph) {
        await within(this.open(), EMBED_WAIT_MS, null);
        if (!this.graph) return '';
      }
      const embedding = await within(this.embedOne(request), EMBED_WAIT_MS, null);
      return this.contextBlock(role, request, { ...options, embedding: embedding ?? undefined });
    } catch (error) {
      diagnostics.record('memory', 'context-failed', { role, error: String(error) });
      return '';
    }
  }

  /**
   * The context block by words alone, at once (for a place that can't wait, like a durable
   * worker's set-up). Never throws.
   * @param role - Who reads it.
   * @param request - The request's text.
   * @param options - What it names, and the size.
   * @param options.about - Notes or entities it names.
   * @param options.maxChars - Longest block.
   */
  contextSync(
    role: MemoryRole,
    request: string,
    options: { about?: string[]; maxChars?: number } = {},
  ): string {
    if (!this.enabled || !this.graph) return '';
    try {
      return this.contextBlock(role, request, options);
    } catch (error) {
      diagnostics.record('memory', 'context-failed', { role, error: String(error) });
      return '';
    }
  }

  private contextBlock(
    role: MemoryRole,
    request: string,
    options: { about?: string[]; maxChars?: number; embedding?: Embedded },
  ): string {
    const graph = this.graph;
    if (!graph) return '';
    const max = options.maxChars ?? CONTEXT_CHARS[role];
    const header = MEMORY_CONTEXT_HEADER;
    const now =
      role === 'voice' || role === 'orchestrator'
        ? graph.nowSummary(this.session, Math.round(max * 0.4))
        : '';
    const lines = graph.contextFacts(request, {
      embedding: options.embedding,
      about: options.about,
      limit: role === 'voice' ? 5 : 8,
      exclude: graph.standingKeys(),
    });
    const facts = fitBlock(
      'Recalled:',
      lines,
      max - header.length - (now ? now.length + 1 : 0) - 1,
    );
    if (!now && !facts) return '';
    return [header, now, facts].filter(Boolean).join('\n');
  }

  /**
   * Hears what the librarian or a worker filed as important, for a mid-call notice to the voice.
   * @param listener - Told each time.
   */
  onUpdate(listener: (update: MemoryUpdate) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  private announce(update: MemoryUpdate): void {
    if (!update.facts.length) return;
    for (const l of this.updateListeners) {
      try {
        l(update);
      } catch (error) {
        diagnostics.record('memory', 'update-listener-failed', { error: String(error) });
      }
    }
  }

  /**
   * The graph key of a Classic engine task (its ids restart with each app session).
   * @param id - Task id, like t3.
   */
  taskKey(id: string): string {
    return `${this.appSession}-${id}`;
  }

  // ── Models: the librarian's and the embeddings' ──

  /**
   * Supplies the models (the plugin's worker layer and an embeddings endpoint). Without them the
   * librarian does nothing and recall is by words.
   * @param models - Model functions.
   */
  setModels(models: MemoryModels): void {
    this.models = models;
    this.embedBlockedUntil = 0;
    this.embedCache.clear();
    this.scheduleBackfill();
  }

  /** Whether models have been supplied. */
  get hasModels(): boolean {
    return !!this.models.complete || !!this.models.embed;
  }

  /** The embedding model in use now, or '' when there is none. */
  private embedModel(): string {
    if (!this.models.embed || this.now() < this.embedBlockedUntil) return '';
    try {
      return this.models.embedModel?.() ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Embeds texts, or null when no embeddings endpoint can be used. Never throws; a failure stops
   * further tries for a while.
   * @param texts - Texts.
   */
  async embed(texts: string[]): Promise<Embedded[] | null> {
    const model = this.embedModel();
    if (!model || !texts.length || !this.models.embed) return null;
    try {
      const vectors = await this.models.embed(texts.map(t => t.slice(0, 6000)));
      if (!vectors || vectors.length !== texts.length) return null;
      return vectors;
    } catch (error) {
      this.embedBlockedUntil = this.now() + EMBED_RETRY_MS;
      diagnostics.record('memory', 'embed-failed', { error: String(error) });
      return null;
    }
  }

  /**
   * One text's embedding, from the cache when it was made recently.
   * @param text - Text.
   */
  async embedOne(text: string): Promise<Embedded | null> {
    const clean = text.trim().slice(0, 4000);
    if (!clean) return null;
    const model = this.embedModel();
    if (!model) return null;
    const cacheKey = `${model}|${clean}`;
    const cached = this.embedCache.get(cacheKey);
    if (cached) return cached;
    const [vector] = (await this.embed([clean])) ?? [];
    if (!vector) return null;
    this.embedCache.set(cacheKey, vector);
    if (this.embedCache.size > 200) {
      const oldest: string | undefined = [...this.embedCache.keys()][0];
      if (oldest !== undefined) this.embedCache.delete(oldest);
    }
    return vector;
  }

  /**
   * Embeds facts, task results and call summaries that have none yet (or one from another model),
   * a batch at a time in the background, so they can be found by meaning.
   */
  scheduleBackfill(): void {
    if (this.backfilling || !this.graph || !this.embedModel()) return;
    this.backfilling = true;
    void (async () => {
      try {
        for (let round = 0; round < 50; round++) {
          const graph = this.graph;
          const model = this.embedModel();
          if (!graph || !model) break;
          const missing = graph.missingEmbeddings(model, BACKFILL_BATCH);
          if (!missing.length) break;
          const vectors = await this.embed(missing.map(m => m.text));
          if (!vectors || this.graph !== graph) break;
          missing.forEach((m, i) => graph.setEmbedding(m.label, m.key, vectors[i]));
          this.scheduleSave();
        }
      } catch (error) {
        diagnostics.record('memory', 'backfill-failed', { error: String(error) });
      } finally {
        this.backfilling = false;
      }
    })();
  }

  /**
   * Saves a fact with its embedding (made first, when an endpoint is set up), so a near-copy of
   * a current fact is caught by meaning too. What `memory_remember` uses.
   * @param input - The fact.
   */
  async remember(input: Parameters<MemoryGraph['remember']>[0]) {
    const embedding = input.embedding ?? (await within(this.embedOne(input.text), 4000, null));
    return this.use(g => g.remember({ ...input, ...(embedding ? { embedding } : {}) }));
  }

  /**
   * Searches facts, task results and call summaries, by meaning when embeddings are set up.
   * @param input - Query and filters.
   */
  async search(input: Parameters<MemoryGraph['search']>[0]) {
    const embedding = input.query
      ? await within(this.embedOne(input.query), EMBED_WAIT_MS * 2, null)
      : null;
    return this.use(g => g.search({ ...input, ...(embedding ? { embedding } : {}) }));
  }

  /**
   * Closes faded observations, once a week (audit item 4).
   * @param graph - Open graph.
   */
  private maintain(graph: MemoryGraph): void {
    const last = graph.getState(['system']).find(s => s.name === 'maintenance');
    const at = Number(last?.value ?? 0);
    if (at && this.now() - at < MAINTENANCE_DAYS * 86_400_000) return;
    const faded = graph.fadeObservations();
    graph.setState('system', 'maintenance', String(this.now()), 'librarian');
    if (faded) diagnostics.record('memory', 'faded', { count: faded });
  }

  // ── Live state the harness writes (audit item 5) ──

  /**
   * Records a relay from the user to the agents as a Request in the session; tasks started while
   * it is being worked on link to it.
   * @param text - What the user asked.
   * @param agent - Who passed it on.
   * @param typed - Typed in the panel rather than said.
   */
  recordRequest(text: string, agent: AgentName, typed = false): string | null {
    if (!this.enabled || !this.settings.autoRecord || !text.trim()) return null;
    const key = newKey('r', this.now());
    const session = this.session;
    this.currentRequest = { key, session, at: this.now() };
    this.quietly(g => g.recordRequest({ key, text, session, agent, typed }));
    return key;
  }

  /**
   * Links a task to the relay it was started for (the newest one of this session, within ten
   * minutes).
   * @param taskKey - Task key.
   */
  linkTaskToRequest(taskKey: string): void {
    const request = this.currentRequest;
    if (!request || request.session !== this.session || this.now() - request.at > 10 * 60_000)
      return;
    this.quietly(g => g.linkSpawn(request.key, taskKey));
  }

  /**
   * A task's live state: status, last progress line, a question it waits on.
   * @param taskKey - Task key.
   * @param update - What changed.
   */
  taskProgress(
    taskKey: string,
    update: { status?: string; progress?: string; question?: string },
  ): void {
    this.quietly(g => g.taskProgress(taskKey, update));
  }

  /**
   * The call's current topic, linked to its note, as session state every agent sees.
   * @param title - Topic title.
   * @param note - Topic note's path.
   */
  setTopic(title: string, note?: string): void {
    const session = this.callSession;
    if (!session) return;
    this.quietly(g => g.setState(session, 'topic', title, 'voice', note));
  }

  // ── The librarian (audit item 1) ──

  /** Why the librarian can't run now, or ''. */
  librarianProblem(): string {
    if (!this.enabled) return 'Memory is off.';
    if (!this.settings.consolidate) return 'The librarian is off in settings.';
    if (!this.models.complete) return 'No model is set up for the librarian.';
    try {
      return this.models.completeProblem?.() ?? '';
    } catch (error) {
      return String(error);
    }
  }

  /** Waits for the librarian's queued passes (tests, and before the plugin unloads). */
  async idle(): Promise<void> {
    while (this.pendingJobs) await this.jobs;
  }

  /**
   * Queues a pass; it runs after the ones before it, in the background, and never throws.
   * @param name - For the log.
   * @param job - The pass.
   */
  private enqueue(name: string, job: () => Promise<void>): void {
    const problem = this.librarianProblem();
    if (problem) {
      diagnostics.record('memory', 'librarian-skipped', { job: name, reason: problem });
      return;
    }
    this.pendingJobs++;
    this.jobs = this.jobs
      .then(job)
      .catch(error =>
        diagnostics.record('memory', 'librarian-failed', { job: name, error: String(error) }),
      )
      .finally(() => {
        this.pendingJobs--;
      });
  }

  /**
   * The facts a pass may repeat or change: those that match the new text by meaning and by
   * words, those from the same session, and the standing ones.
   * @param graph - Open graph.
   * @param text - New text.
   * @param queries - Shorter texts to match too (the user's lines).
   * @param session - Session the text belongs to.
   */
  private async candidateFacts(
    text: string,
    queries: string[],
    session?: string,
  ): Promise<FactRow[]> {
    const embedding = await within(this.embedOne(text.slice(-3000)), 4000, null);
    return this.use(graph => {
      const byKey = new Map<string, FactRow>();
      const add = (rows: FactRow[]) => rows.forEach(r => byKey.set(r.key, r));
      if (embedding) add(graph.recall({ query: text.slice(-2000), embedding, limit: 12 }));
      for (const q of queries.slice(-10)) add(graph.recall({ query: q, limit: 3 }));
      if (session) {
        add(
          graph
            .recall({ limit: 30 })
            .filter(f => f.session === session)
            .slice(0, 8),
        );
      }
      add(graph.recall({ kinds: ['preference', 'instruction'], limit: 8 }));
      return [...byKey.values()].slice(0, 24);
    });
  }

  /**
   * Runs one pass: asks the worker model, then applies its operations.
   * @param input - What is new (the facts are found here).
   * @param ctx - Session, task and the source of each line.
   * @param ctx.session - Session it belongs to.
   * @param ctx.task - Task it belongs to.
   * @param ctx.sourceFor - Note link and time of an L-number.
   * @param ctx.queries - Short texts to find candidate facts with.
   * @param ctx.text - The new text, to find candidate facts with.
   */
  private async pass(
    input: Omit<LibrarianInput, 'facts'>,
    ctx: {
      session?: string;
      task?: string;
      sourceFor?: (line: number | undefined) => string | undefined;
      queries: string[];
      text: string;
    },
  ): Promise<LibrarianOutput | null> {
    const complete = this.models.complete;
    if (!complete) return null;
    const facts = await this.candidateFacts(ctx.text, ctx.queries, ctx.session);
    const { system, user } = librarianMessages({
      ...input,
      facts,
      today: localDate(this.now()),
    });
    const started = this.now();
    const output = parseLibrarianOutput(await complete(system, user));
    const texts = output.ops.filter(o => o.text).map(o => o.text as string);
    const vectors = texts.length ? await this.embed(texts) : null;
    const embeddings = new Map<string, Embedded>();
    texts.forEach((t, i) => vectors?.[i] && embeddings.set(t, vectors[i]));
    const applied = await this.use(graph =>
      applyLibrarianOps(graph, output, {
        candidates: new Set(facts.map(f => f.key)),
        session: ctx.session,
        task: ctx.task,
        sourceFor: ctx.sourceFor,
        embeddings,
        notUserWords: input.kind === 'task',
      }),
    );
    diagnostics.record('memory', 'librarian', {
      kind: input.kind,
      ms: this.now() - started,
      added: applied.added.length,
      updated: applied.updated.length,
      confirmed: applied.confirmed.length,
      closed: applied.closed.length,
      skipped: applied.skipped.map(s => `${s.op.op}: ${s.why}`),
    });
    this.announce({ kind: 'important', facts: applied.important });
    this.scheduleBackfill();
    return output;
  }

  /**
   * During a call: the librarian reads the lines since its last pass.
   * @param session - The call's session.
   * @param lines - New lines, numbered as in the whole call.
   * @param sourceFor - Note link and time of an L-number.
   */
  consolidateTurns(
    session: string,
    lines: LibrarianLine[],
    sourceFor?: (line: number | undefined) => string | undefined,
  ): void {
    if (!lines.some(l => l.who === 'You')) return;
    this.enqueue('turns', async () => {
      await this.pass(
        { kind: 'turns', lines },
        {
          session,
          sourceFor,
          queries: lines.filter(l => l.who === 'You').map(l => l.text),
          text: lines.map(l => l.text).join('\n'),
        },
      );
    });
  }

  /**
   * At the end of a call: the librarian reads what it hasn't read yet and writes the call's
   * summary (3 to 5 sentences, decisions, loose ends), which replaces the list of topics.
   * @param session - The call's session.
   * @param call - The whole transcript, where its new part starts, and what else happened.
   * @param call.lines - All lines, numbered from 1.
   * @param call.newFrom - First L-number not read by an earlier pass.
   * @param call.context - Topics and tasks, one per line.
   * @param call.sourceFor - Note link and time of an L-number.
   */
  consolidateCall(
    session: string,
    call: {
      lines: LibrarianLine[];
      newFrom: number;
      context: string[];
      sourceFor?: (line: number | undefined) => string | undefined;
    },
  ): void {
    if (!call.lines.some(l => l.who === 'You')) return;
    this.enqueue('call', async () => {
      const fresh = call.lines.filter(l => l.n >= call.newFrom);
      const output = await this.pass(
        { kind: 'call', lines: call.lines, newFrom: call.newFrom, callContext: call.context },
        {
          session,
          sourceFor: call.sourceFor,
          queries: fresh.filter(l => l.who === 'You').map(l => l.text),
          text: fresh.map(l => l.text).join('\n'),
        },
      );
      const summary = output ? summaryText(output) : '';
      if (summary) await this.use(g => g.setSessionSummary(session, summary));
    });
  }

  /**
   * After a task: the librarian keeps its findings, linked to the task.
   * @param task - The task.
   * @param task.key - Its key in the graph.
   * @param task.title - Title.
   * @param task.brief - What it was asked.
   * @param task.result - What it found.
   * @param task.status - done or failed.
   * @param task.session - Session it ran in.
   */
  consolidateTask(task: {
    key: string;
    title: string;
    brief?: string;
    result: string;
    status?: string;
    session?: string;
  }): void {
    if (!task.result.trim()) return;
    this.enqueue('task', async () => {
      const digest = `${task.result.length}:${task.result.slice(0, 80)}:${task.result.slice(-80)}`;
      if (!(await this.use(g => g.markConsolidated(task.key, digest)))) return;
      await this.pass(
        {
          kind: 'task',
          task: { title: task.title, brief: task.brief, result: task.result, status: task.status },
        },
        {
          session: task.session,
          task: task.key,
          sourceFor: () => `task ${task.title}`,
          queries: [task.title, ...(task.brief ? [task.brief.slice(0, 300)] : [])],
          text: `${task.title}\n${task.brief ?? ''}\n${task.result}`.slice(0, 6000),
        },
      );
    });
  }

  /**
   * An agent's read-only Cypher. Unsaved changes are saved first; if the statement changed
   * anything despite the checks, the graph is restored from that save.
   * @param cypher - One read statement.
   * @param params - Parameters.
   * @param maxRows - Rows at most.
   */
  async query(cypher: string, params: Record<string, unknown>, maxRows: number) {
    const graph = await this.open();
    if (graph.dirty) {
      this.scheduleSave(0);
      await this.flush();
    }
    const before = graph.dirty ? null : graph.snapshot();
    const result = graph.query(cypher, params, maxRows);
    if (result.changed) {
      if (before) graph.load(before);
      diagnostics.record('memory', 'query-restored', { cypher });
      throw new Error('Refused: the statement changed the graph, so the change was undone.');
    }
    return result;
  }

  private scheduleSave(delay = SAVE_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Writes unsaved changes now, merging in any newer copy that sync brought. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saving = this.saving.then(async () => {
      const graph = this.graph;
      if (!graph || !graph.dirty) return;
      try {
        const store = this.options.store;
        // While blocked, look again: a sync that has finished leaves a readable file.
        if (this.blocked) {
          const read = await this.readFile();
          if (!read.snapshot) return;
          this.mergeSnapshot(graph, read.snapshot, read.text);
          this.setBlocked(null);
        }
        const onDisk = (await store.exists(this.path)) ? await store.read(this.path) : '';
        if (onDisk.trim() && onDisk !== this.lastText) this.mergeText(graph, onDisk);
        if (this.blocked) return;
        if (!(await store.exists(this.folder))) await store.mkdir(this.folder);
        const text = JSON.stringify(graph.snapshot());
        await store.write(this.path, text);
        this.lastText = text;
        graph.dirty = false;
      } catch (error) {
        diagnostics.record('memory', 'save-failed', { error: String(error) });
      }
    });
    return this.saving;
  }

  private mergeText(graph: MemoryGraph, text: string): void {
    try {
      this.mergeSnapshot(graph, JSON.parse(text) as MemorySnapshot, text);
    } catch (error) {
      this.setBlocked(
        `${this.path} changed and could not be read (${(error as Error).message}), so memory is not saved until it is fixed or moved.`,
      );
    }
  }

  private mergeSnapshot(graph: MemoryGraph, other: MemorySnapshot, text: string): void {
    graph.load(mergeSnapshots(graph.snapshot(), other));
    graph.dirty = true;
    this.lastText = text;
  }

  /**
   * Called when a vault file changed: merges in a copy of the memory that sync brought.
   * @param path - Changed file.
   */
  async onFileChanged(path: string): Promise<void> {
    if (path !== this.path || !this.graph) return;
    await this.saving;
    // Sync can write the file in pieces; read until it parses (or give up for now).
    const read = await this.readFile();
    if (!read.text.trim()) return;
    if (read.text === this.lastText) {
      // Back to what we last wrote: nothing to merge, and saving can go on.
      if (read.snapshot) this.setBlocked(null);
      return;
    }
    if (!read.snapshot) {
      this.setBlocked(
        `${this.path} changed and could not be read (${read.error?.message ?? 'empty'}), so memory is not saved until it is fixed or moved.`,
      );
      return;
    }
    this.mergeSnapshot(this.graph, read.snapshot, read.text);
    this.setBlocked(null);
    diagnostics.record('memory', 'merged-synced-copy', { path });
    this.scheduleSave();
  }

  /** Ends this app session and saves. */
  async close(): Promise<void> {
    if (this.graph && this.settings.autoRecord) {
      try {
        this.graph.endSession(this.appSession);
      } catch {
        // Closing anyway.
      }
    }
    await this.flush();
    this.graph?.dispose();
    this.graph = null;
    this.opening = null;
  }

  /**
   * Moves the memory to another folder. Everything is saved in the old folder first; then the
   * file is copied to the new one, or merged into the file already there. The old file is left
   * where it was.
   * @param apply - Changes the folder setting (and saves settings).
   */
  async changeFolder(apply: () => Promise<void>): Promise<void> {
    const oldPath = this.path;
    await this.reset();
    await apply();
    if (this.path === oldPath) return;
    const store = this.options.store;
    if (!(await store.exists(oldPath))) return;
    const text = await store.read(oldPath);
    if (!(await store.exists(this.path))) {
      if (!(await store.exists(this.folder))) await store.mkdir(this.folder);
      await store.write(this.path, text);
      diagnostics.record('memory', 'moved', { from: oldPath, to: this.path });
      return;
    }
    if (!this.enabled || !text.trim()) return;
    let other: MemorySnapshot;
    try {
      other = JSON.parse(text) as MemorySnapshot;
    } catch (error) {
      diagnostics.record('memory', 'move-skipped', { from: oldPath, error: String(error) });
      return;
    }
    const graph = await this.open();
    graph.load(mergeSnapshots(graph.snapshot(), other));
    graph.dirty = true;
    this.scheduleSave();
    diagnostics.record('memory', 'moved-and-merged', { from: oldPath, to: this.path });
  }

  /** Forgets the open graph so the next use reads the file again (after settings change). */
  async reset(): Promise<void> {
    await this.close();
    this.setBlocked(null);
    this.lastText = '';
  }
}

export const MEMORY_BRIEF_INTRO =
  'Shared memory (what you and the other agents learned in earlier sessions; ids in brackets):';

/** First line of a per-turn context block. */
export const MEMORY_CONTEXT_HEADER =
  '[Memory] Recalled for this message from the shared memory (ids in brackets); use it if it helps, and say nothing about it otherwise.';

/** Short guidance for the voice agent, workers and note chats (audit item 10). */
export const MEMORY_GUIDANCE_SHORT = [
  'Shared memory: all agents share one memory graph across sessions, and a librarian files what calls and tasks learn after each one. A [Memory] block in a message holds what was recalled for it.',
  '- memory_recall when the user refers to something from before; memory_remember when the user asks you to remember something or states a lasting preference or instruction. Never store passwords, keys, card or ID numbers.',
].join('\n');

/**
 * How a role uses the memory: the full guidance for the orchestrator, two lines for the rest.
 * @param role - Whose instructions.
 */
export function guidanceFor(role: MemoryRole): string {
  return role === 'orchestrator' ? MEMORY_GUIDANCE : MEMORY_GUIDANCE_SHORT;
}

/** How agents use the memory, for their instructions. */
export const MEMORY_GUIDANCE = [
  'Shared memory: the voice agent, the orchestrator, workers and note chats share one memory graph that lasts across sessions. A librarian reads each call and each finished task afterwards and files what they learned, so save only what must be kept now. Each relay carries a [Memory] block: what is happening now and the facts recalled for it.',
  '- memory_recall before asking the user something they may have told you before, and when a request names a person, project or note you may know about.',
  '- memory_remember when the user states a preference, an instruction, a decision or a fact worth keeping, and when a task learns something the next session needs. One fact per call, in plain words. Use `slot` for things that have one current value (it closes the old one), `supersedes` to correct a fact by id, and `about` for the people, projects and [[notes]] it concerns.',
  '- memory_state for values the other agents should see now (a focus, a plan step, a handoff); session scope ends with the call.',
  '- memory_forget when the user says something is wrong or no longer true. Nothing is deleted; it stops being current.',
  '- memory_relate links two people, projects or notes (`kind` like "part of"; "alias" gives an entity another name).',
  "- memory_query runs your own read-only Cypher on the graph when recall isn't enough.",
  'Never store passwords, keys, card or ID numbers, or anything the user asks you not to keep.',
].join('\n');
