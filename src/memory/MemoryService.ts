// Opens the shared memory graph, keeps it saved in the vault and merges in copies that sync
// brings from other devices. Everything that reads or writes memory goes through here.
import { diagnostics } from '../diagnostics/DiagnosticsLog';
import { MemoryGraph, mergeSnapshots } from './MemoryGraph';
import type { AgentName, MemorySnapshot } from './MemoryGraph';
import { loadRelate, relateAvailable } from './relateEngine';

export interface MemorySettings {
  /** Off by default: nothing is loaded or written until it is turned on. */
  enabled: boolean;
  /** Vault folder that holds memory.json. */
  folder: string;
  /** Longest memory brief put in an agent's instructions, in characters (0 for none). */
  briefChars: number;
  /** Record calls, tasks and app sessions in the graph by themselves. */
  autoRecord: boolean;
}

export const DEFAULT_MEMORY: MemorySettings = {
  enabled: false,
  folder: 'Voice Agent/Memory',
  briefChars: 2500,
  autoRecord: true,
};

/** The vault calls the service needs (Obsidian's DataAdapter has them). */
export interface MemoryStore {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

const FILE = 'memory.json';
const SAVE_DELAY_MS = 1500;

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

  constructor(
    private options: {
      settings: () => MemorySettings;
      store: MemoryStore;
      now?: () => number;
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
      const text = (await this.options.store.exists(this.path))
        ? await this.options.store.read(this.path)
        : '';
      if (text.trim()) {
        try {
          graph.load(JSON.parse(text) as MemorySnapshot);
        } catch (error) {
          // Never replace a file we could not read: keep working in memory, save nothing.
          this.blocked = `${this.path} could not be read (${(error as Error).message}), so memory is not saved until it is fixed or moved.`;
          diagnostics.record('memory', 'blocked', { path: this.path, error: String(error) });
        }
      }
      this.lastText = text;
      this.graph = graph;
      if (this.settings.autoRecord) graph.startSession(this.appSession, 'app', 'Obsidian session');
      this.scheduleSave();
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
   * The memory brief for an agent's instructions, with how to use the memory tools, or '' when
   * memory is off. Synchronous, so instructions can be built on the spot; before the graph has
   * opened it gives the guidance alone and starts opening it.
   * @param intro - Line put before the brief.
   */
  brief(intro = MEMORY_BRIEF_INTRO): string {
    if (!this.enabled) return '';
    let text = '';
    if (this.graph && this.settings.briefChars > 0) {
      try {
        text = this.graph.brief({ session: this.session, maxChars: this.settings.briefChars });
      } catch (error) {
        diagnostics.record('memory', 'brief-failed', { error: String(error) });
      }
    } else if (!this.graph) {
      void this.open().catch(() => undefined);
    }
    return text ? `${MEMORY_GUIDANCE}\n\n${intro}\n${text}` : MEMORY_GUIDANCE;
  }

  /**
   * The graph key of a Classic engine task (its ids restart with each app session).
   * @param id - Task id, like t3.
   */
  taskKey(id: string): string {
    return `${this.appSession}-${id}`;
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
      if (!graph || !graph.dirty || this.blocked) return;
      try {
        const store = this.options.store;
        const onDisk = (await store.exists(this.path)) ? await store.read(this.path) : '';
        if (onDisk && onDisk !== this.lastText) this.mergeText(graph, onDisk);
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
      const other = JSON.parse(text) as MemorySnapshot;
      graph.load(mergeSnapshots(graph.snapshot(), other));
      graph.dirty = true;
      this.lastText = text;
    } catch (error) {
      this.blocked = `${this.path} changed and could not be read (${(error as Error).message}), so memory is not saved until it is fixed or moved.`;
    }
  }

  /**
   * Called when a vault file changed: merges in a copy of the memory that sync brought.
   * @param path - Changed file.
   */
  async onFileChanged(path: string): Promise<void> {
    if (path !== this.path || !this.graph) return;
    await this.saving;
    const text = await this.options.store.read(this.path);
    if (text === this.lastText) return;
    this.mergeText(this.graph, text);
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

  /** Forgets the open graph so the next use reads the file again (after settings change). */
  async reset(): Promise<void> {
    await this.close();
    this.blocked = null;
    this.lastText = '';
  }
}

export const MEMORY_BRIEF_INTRO =
  'Shared memory (what you and the other agents learned in earlier sessions; ids in brackets):';

/** How agents use the memory, for their instructions. */
export const MEMORY_GUIDANCE = [
  'Shared memory: the voice agent, the orchestrator, workers and note chats share one memory graph that lasts across sessions.',
  '- memory_recall before asking the user something they may have told you before, and when a request names a person, project or note you may know about.',
  '- memory_remember when the user states a preference, an instruction, a decision or a fact worth keeping, and when a task learns something the next session needs. One fact per call, in plain words. Use `slot` for things that have one current value (it closes the old one), `supersedes` to correct a fact by id, and `about` for the people, projects and [[notes]] it concerns.',
  '- memory_state for values the other agents should see now (a focus, a plan step, a handoff); session scope ends with the call.',
  '- memory_forget when the user says something is wrong or no longer true. Nothing is deleted; it stops being current.',
  "- memory_query runs your own read-only Cypher on the graph when recall isn't enough.",
  'Never store passwords, keys, card or ID numbers, or anything the user asks you not to keep.',
].join('\n');
