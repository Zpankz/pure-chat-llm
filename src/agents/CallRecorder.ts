import { normalizePath, TFile } from 'obsidian';
import type PureChatLLM from '../main';
import { diagnostics } from '../diagnostics/DiagnosticsLog';
import type { LibrarianLine } from '../memory/Librarian';
import { memoryWithModels } from '../memory/pluginModels';
import type { SubAgentTask } from './types';

/**
 * Saves each voice call as a small linked vault of its own (Hani's decisions 16 and 16a): the
 * conversation is stored as a branching tree of notes rather than one long page.
 *
 * - **Folder notes.** Every node that has children is a folder whose root note has the same
 *   name (`Name/Name.md`, the convention the Folder Notes community plugin uses); a node with no
 *   children is a plain note in its parent's folder. A node that gains its first child is moved
 *   into a folder of its own with `vault.rename`, which never asks anything (see `move`).
 * - **The tree.** The call is the root (its folder note holds the voice transcript). In the
 *   layered setup the orchestrator is its child, and each worker thread is a child of the
 *   orchestrator; with the voice delegating directly, threads hang off the call.
 * - **Links both ways, where they happened.** Each child links back to its parent, and each
 *   parent links to its children inline, at the point in its conversation where it handed off:
 *   the transcript links to the orchestrator entry for each relay (by block id), and the
 *   orchestrator's conversation links each thread where it started it. Lists of children sit in
 *   frontmatter and a "Threads" section as well, for the graph and for Dataview.
 *
 * - **Topics (Zettelkasten calls, decision 16b).** By default the voice layer splits the call into
 *   topic notes as it goes (`new_topic`): each new concept, step, idea, aspect or alternative gets
 *   its own note in the call folder, with the user's words that opened it, linked to the topics it
 *   follows from (several, for a branch that joins earlier ones) and to those that follow it. The
 *   call's folder note becomes an index that maps the topics as a tree. Relays to the orchestrator
 *   and threads started link back to the topic they came from. With topics off, the folder note
 *   holds the whole transcript.
 *
 * Calls go in the calls folder setting ("Voice Agent" by default), one folder per call. Work that
 * finishes after the call ends is still written to that call's notes, until the next call starts.
 */
export interface CallLine {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at?: number;
}

export interface OrchestratorEntry {
  at: number;
  kind: 'input' | 'reply' | 'tool' | 'result' | 'error' | 'spawn';
  text: string;
  /** Block id that links point at (relays from the user, and started threads). */
  anchor?: string;
  /** The voice call relayed this (as opposed to a worker event). */
  fromUser?: boolean;
  /** For `spawn`: the task started. */
  taskId?: string;
  /** Topic of the call this came from. */
  topicId?: number;
}

/** A point in the call transcript where it handed off to a child node. */
interface HandOff {
  at: number;
  /** `orchestrator` or a task id. */
  target: string;
  /** Block id in the child's note, if the link should land on that exact point. */
  anchor?: string;
  /** Topic the call was on. */
  topicId?: number;
}

/** One topic note of a call. */
export interface CallTopic {
  id: number;
  title: string;
  kind: string;
  /** Topics this one builds on (the first is its place in the index tree). */
  followsFrom: number[];
  /** When it opened: the user's words that started it. */
  at: number;
  path: string;
}

export interface TimingEntry {
  at: number;
  what: string;
  ms: number;
  outcome: string;
}

export interface CallRecord {
  /** Local date and time the call started, `YYYY-MM-DD HHmm`, plus a counter if needed. */
  stamp: string;
  /** The call's folder; its folder note is the root of the tree. */
  folder: string;
  callPath: string;
  /**
   * The orchestrator's note in the layered setup: a plain note in the call folder until it
   * starts a thread, then the folder note of its own folder.
   */
  orchestratorPath: string | null;
  startedAt: number;
  endedAt?: number;
  provider: string;
  voiceRole: string;
  orchestratorLog: OrchestratorEntry[];
  taskIds: string[];
  handOffs: HandOff[];
  timings: TimingEntry[];
  /** The diagnostics log the call was recorded in, when diagnostics are on. */
  diagnosticsLog?: string;
  /** `topics`: one note per topic plus an index; `transcript`: one transcript note. */
  structure: 'topics' | 'transcript';
  topics: CallTopic[];
  /** When the call moved to each topic, in order (a topic can be returned to). */
  topicSwitches: { at: number; id: number }[];
}

/** Title of the first topic until the voice names it. */
const OPENING = 'Start of the call';
/** A new topic takes the user's last words with it when they were said this recently. */
const OPENING_WORDS_MS = 60_000;

/** Characters of one tool output kept in the orchestrator note. */
const MAX_TOOL_OUTPUT = 4000;
/** Timing entries kept per call. */
const MAX_TIMINGS = 500;

/** @param path - Vault path of a note. */
export function linkTo(path: string, alias?: string, subpath = ''): string {
  const target = path.replace(/\.md$/, '') + subpath;
  return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
}

/** @param at - Time. */
function clock(at?: number): string {
  if (!at) return '';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** @param at - Time. */
function localStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** @param text - Text for a YAML double-quoted string. */
function yaml(text: string): string {
  return JSON.stringify(text);
}

/** @param title - Task title. */
function safeName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .trim()
    .slice(0, 60);
}

/** @param path - File path. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** @param path - File path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

export class CallRecorder {
  /** The call being recorded, or the last one, which keeps collecting late results. */
  current: CallRecord | null = null;
  private live = false;
  private transcriptSource: (() => CallLine[]) | null = null;
  private autosave: number | null = null;
  private orchestratorTimer: number | null = null;
  private anchorSeq = 0;
  private usedFolders = new Set<string>();
  /** Serialises moves and writes so a move never races a save. */
  private chain: Promise<void> = Promise.resolve();
  /** Looks for enough new lines for the librarian during a call. */
  private memoryTimer: number | null = null;
  /** Transcript lines the librarian has been given so far. */
  private consolidatedLines = 0;

  constructor(private plugin: PureChatLLM) {}

  private get enabled(): boolean {
    const v = this.plugin.settings.voice;
    return v.saveCalls && !!v.callsFolder.trim();
  }

  /** Whether a call is open now. */
  get isLive(): boolean {
    return this.live;
  }

  /**
   * Starts recording a call.
   * @param provider - Voice provider label.
   * @param transcript - Returns the call's transcript so far.
   */
  start(provider: string, transcript: () => CallLine[]): CallRecord | null {
    this.stopTimers();
    this.live = true;
    this.transcriptSource = transcript;
    // The call is a session in the shared memory: what is learned in it links back to it.
    const memory = memoryWithModels(this.plugin);
    this.consolidatedLines = 0;
    if (memory?.enabled) {
      const key = `call-${Date.now().toString(36)}`;
      memory.callSession = key;
      memory.quietly(g => g.startSession(key, 'call', `Voice call ${localStamp(Date.now())}`));
      // During a long call, the librarian reads each stretch of new lines in the background.
      this.memoryTimer = window.setInterval(() => this.consolidateTurns(), 30_000);
    }
    this.anchorSeq = 0;
    if (!this.enabled) {
      this.current = null;
      return null;
    }
    const at = Date.now();
    const vault = this.plugin.app.vault;
    const root = normalizePath(this.plugin.settings.voice.callsFolder.trim());
    let stamp = localStamp(at);
    // Folders are written a moment later, so names handed out this session count as taken too.
    const taken = (name: string) =>
      this.usedFolders.has(`${root}/${name}`) || !!vault.getAbstractFileByPath(`${root}/${name}`);
    for (let n = 2; taken(stamp); n++) stamp = `${localStamp(at)} ${n}`;
    const folder = normalizePath(`${root}/${stamp}`);
    this.usedFolders.add(folder);
    const role = this.plugin.settings.orchestrator.voiceRole;
    this.current = {
      stamp,
      folder,
      // The call is the root node: always a folder note.
      callPath: normalizePath(`${folder}/${stamp}.md`),
      orchestratorPath:
        role === 'layered' ? normalizePath(`${folder}/${stamp} orchestrator.md`) : null,
      startedAt: at,
      provider,
      voiceRole: role,
      orchestratorLog: [],
      taskIds: [],
      handOffs: [],
      timings: [],
      structure:
        (this.plugin.settings.voice.callNotes ?? 'topics') === 'topics' ? 'topics' : 'transcript',
      topics: [],
      topicSwitches: [],
    };
    diagnostics.setCall({ id: stamp, note: this.current.callPath });
    this.current.diagnosticsLog = diagnostics.currentPath() ?? undefined;
    if (this.current.structure === 'topics') {
      const first: CallTopic = {
        id: 1,
        title: OPENING,
        kind: 'opening',
        followsFrom: [],
        at,
        path: this.topicPath(this.current, 1, OPENING),
      };
      this.current.topics.push(first);
      this.current.topicSwitches.push({ at, id: 1 });
    }
    // Save now and then while the call runs, so a crash loses little.
    this.autosave = window.setInterval(() => void this.saveCall(), 60_000);
    void this.saveCall();
    return this.current;
  }

  /** Ends the call and writes its notes. */
  async finish(): Promise<void> {
    if (!this.live) return;
    this.stopTimers();
    const record = this.current;
    this.live = false;
    const memory = memoryWithModels(this.plugin);
    const session = memory?.callSession;
    if (memory && session) {
      // The list of topics stands until the librarian's summary replaces it.
      const summary = callSummary(record);
      memory.quietly(g => g.endSession(session, summary));
      memory.callSession = null;
      const transcript = this.transcriptSource?.() ?? [];
      const all = this.librarianLines(transcript);
      memory.consolidateCall(session, {
        lines: all,
        newFrom: this.consolidatedLines + 1,
        context: this.callContext(record),
        sourceFor: n => this.sourceFor(record, transcript, n),
      });
      if (all.length) this.consolidatedLines = all[all.length - 1].n;
    }
    if (!record) return;
    record.endedAt = Date.now();
    diagnostics.setCall(null);
    await this.saveCall();
    await this.saveOrchestrator();
    // The transcript is final; later work only updates the orchestrator and task notes.
    const lines = this.transcriptSource?.() ?? [];
    this.transcriptSource = () => lines;
  }

  /**
   * The user's last few things said in the call, verbatim, for write reviewers.
   * @param count - Lines.
   */
  recentUserWords(count = 3): string {
    if (!this.live) return '';
    const lines = (this.transcriptSource?.() ?? [])
      .filter(l => l.role === 'user' && l.text.trim())
      .slice(-count)
      .map(l => l.text.trim());
    return lines.join(' / ').slice(0, 1000);
  }

  /**
   * Records how long something took, for the call note's timings.
   * @param what - What was timed.
   * @param ms - Milliseconds.
   * @param outcome - How it ended.
   */
  logTiming(what: string, ms: number, outcome = 'ok'): void {
    const record = this.current;
    if (!record || !this.live) return;
    record.timings.push({ at: Date.now(), what, ms, outcome });
    if (record.timings.length > MAX_TIMINGS) record.timings.shift();
  }

  /** The topic the call is on now, if the call is split into topics. */
  currentTopic(): CallTopic | undefined {
    const record = this.current;
    if (!record || record.structure !== 'topics') return undefined;
    return this.topicAt(record, Number.MAX_SAFE_INTEGER);
  }

  /**
   * Starts a new topic note (the voice's `new_topic`).
   * @param title - Short title.
   * @param kind - Concept, step, idea, aspect, alternative, question or decision.
   * @param followsFrom - Earlier topics it builds on, by title or number; empty means the current one.
   */
  newTopic(title: string, kind: string, followsFrom: string[] = []): string {
    const record = this.current;
    if (!record || !this.live || record.structure !== 'topics') {
      return 'Error: NoCall: this call is not being split into topics.';
    }
    const current = this.currentTopic() as CallTopic;
    const parents: number[] = [];
    const unknown: string[] = [];
    for (const ref of followsFrom) {
      const found = this.findTopic(record, ref);
      if (found) {
        if (!parents.includes(found.id)) parents.push(found.id);
      } else unknown.push(ref);
    }
    if (!parents.length) parents.push(current.id);
    const at = this.openingAt(record);
    const clean = safeName(title) || 'Untitled';
    // The opening topic takes the first real title if nothing was said under it yet.
    if (current.kind === 'opening' && !this.userLinesIn(record, current.id, at)) {
      const path = this.topicPath(record, current.id, clean);
      if (path !== current.path) this.move(current.path, path, p => (current.path = p));
      current.title = clean;
      current.kind = kind;
      this.plugin.memory?.setTopic(clean, current.path);
      void this.saveCall();
      return `Topic 1 is now "${clean}". Carry on; do not mention this.`;
    }
    const id = record.topics.length + 1;
    record.topics.push({
      id,
      title: clean,
      kind,
      followsFrom: parents.filter(p => p !== id),
      at,
      path: this.topicPath(record, id, clean),
    });
    record.topicSwitches.push({ at, id });
    this.plugin.memory?.setTopic(clean, record.topics[id - 1].path);
    void this.saveCall();
    const from = parents.map(p => `${p} "${record.topics[p - 1].title}"`).join(' and ');
    return `Topic ${id} "${clean}" started, following ${from}.${
      unknown.length ? ` No earlier topic matched ${unknown.map(u => `"${u}"`).join(', ')}.` : ''
    } Carry on; do not mention this.`;
  }

  /**
   * Carries on in an earlier topic.
   * @param ref - Its title or number.
   */
  returnToTopic(ref: string): string {
    const record = this.current;
    if (!record || !this.live || record.structure !== 'topics') {
      return 'Error: NoCall: this call is not being split into topics.';
    }
    const topic = this.findTopic(record, ref);
    if (!topic) {
      const titles = record.topics.map(t => `${t.id} "${t.title}"`).join(', ');
      return `Error: NotFound: no topic matches "${ref}".\nTry: one of ${titles}, or start a new topic.`;
    }
    record.topicSwitches.push({ at: this.openingAt(record), id: topic.id });
    this.plugin.memory?.setTopic(topic.title, topic.path);
    void this.saveCall();
    return `Back on topic ${topic.id} "${topic.title}". Carry on; do not mention this.`;
  }

  /** @param record - Call. @param ref - Title or number. */
  private findTopic(record: CallRecord, ref: string): CallTopic | undefined {
    const n = Number(ref.replace(/^#/, ''));
    if (Number.isInteger(n) && n >= 1) return record.topics[n - 1];
    const key = ref
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!key) return undefined;
    const norm = (t: CallTopic) =>
      t.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    return (
      [...record.topics].reverse().find(t => norm(t) === key) ??
      [...record.topics].reverse().find(t => norm(t).includes(key) || key.includes(norm(t)))
    );
  }

  /**
   * When a new topic opens: at the user's last words, if they came after the last switch and
   * recently, so the words that raised the topic open its note.
   */
  private openingAt(record: CallRecord): number {
    const now = Date.now();
    const lastSwitch = record.topicSwitches[record.topicSwitches.length - 1]?.at ?? 0;
    const lines = this.transcriptSource?.() ?? [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.role !== 'user' || !l.at || !l.text.trim()) continue;
      const at = l.at > lastSwitch && now - l.at <= OPENING_WORDS_MS ? l.at : now;
      // Switches never go back in time, so each line belongs to exactly one topic.
      return Math.max(at, lastSwitch + 1);
    }
    return Math.max(now, lastSwitch + 1);
  }

  /** Whether the user said anything under a topic before a time. */
  private userLinesIn(record: CallRecord, id: number, before: number): boolean {
    return (this.transcriptSource?.() ?? []).some(
      l =>
        l.role === 'user' &&
        !!l.text.trim() &&
        (l.at ?? 0) < before &&
        this.topicAt(record, l.at ?? 0)?.id === id,
    );
  }

  /** The topic the call was on at a time. */
  private topicAt(record: CallRecord, at: number): CallTopic | undefined {
    let id = record.topicSwitches[0]?.id;
    for (const s of record.topicSwitches) if (s.at <= at) id = s.id;
    return id ? record.topics[id - 1] : undefined;
  }

  private topicPath(record: CallRecord, id: number, title: string): string {
    return normalizePath(
      `${record.folder}/${record.stamp} ${String(id).padStart(2, '0')} ${title}.md`,
    );
  }

  /**
   * Places a new sub-agent task's note in the call's tree.
   * @param task - New task.
   */
  attachTask(task: SubAgentTask): void {
    const record = this.current;
    if (!record || task.origin !== 'voice') return;
    record.taskIds.push(task.id);
    const name = `${record.stamp} ${task.id}${safeName(task.title) ? ` ${safeName(task.title)}` : ''}`;
    const anchor = `spawn-${task.id}`;
    const topic = this.currentTopic();
    if (topic) task.topicNote = topic.path;
    if (record.orchestratorPath) {
      // The orchestrator now has a child, so it becomes a folder note.
      const orchestratorName = baseName(record.orchestratorPath);
      const target = normalizePath(`${record.folder}/${orchestratorName}/${orchestratorName}.md`);
      if (record.orchestratorPath !== target) {
        this.move(record.orchestratorPath, target, p => (record.orchestratorPath = p));
      }
      task.notePath = normalizePath(`${record.folder}/${orchestratorName}/${name}.md`);
      task.parentNote = target;
      task.parentAnchor = anchor;
      record.orchestratorLog.push({
        at: Date.now(),
        kind: 'spawn',
        text: task.title,
        anchor,
        taskId: task.id,
        topicId: topic?.id,
      });
    } else {
      // The voice started it directly: its parent is the topic it came from, or the call.
      task.notePath = normalizePath(`${record.folder}/${name}.md`);
      task.parentNote = topic?.path ?? record.callPath;
      task.parentAnchor = anchor;
      record.handOffs.push({ at: Date.now(), target: task.id, anchor, topicId: topic?.id });
    }
    task.callNote = record.callPath;
    void this.saveCall();
    this.scheduleOrchestratorSave();
  }

  /**
   * Adds a line to the orchestrator's log for the current call.
   * @param kind - Entry kind.
   * @param text - Text.
   * @param fromUser - For `input`: relayed from the voice call.
   */
  logOrchestrator(kind: OrchestratorEntry['kind'], text: string, fromUser = false): void {
    diagnostics.record('orchestrator', kind, { text, ...(fromUser ? { fromUser } : {}) });
    const record = this.current;
    if (!record?.orchestratorPath) return;
    const clipped =
      kind === 'result' && text.length > MAX_TOOL_OUTPUT
        ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[${text.length - MAX_TOOL_OUTPUT} more characters]`
        : text;
    const entry: OrchestratorEntry = { at: Date.now(), kind, text: clipped };
    if (kind === 'input' && fromUser) {
      entry.fromUser = true;
      entry.anchor = `relay-${++this.anchorSeq}`;
      entry.topicId = this.currentTopic()?.id;
      record.handOffs.push({
        at: entry.at,
        target: 'orchestrator',
        anchor: entry.anchor,
        topicId: entry.topicId,
      });
    }
    record.orchestratorLog.push(entry);
  }

  /** Writes the orchestrator note soon (after a turn). */
  scheduleOrchestratorSave(): void {
    if (!this.current?.orchestratorPath) return;
    if (this.orchestratorTimer) window.clearTimeout(this.orchestratorTimer);
    this.orchestratorTimer = window.setTimeout(() => {
      this.orchestratorTimer = null;
      void this.saveOrchestrator();
    }, 500);
  }

  /** The transcript as the librarian reads it: numbered from 1, in the call's order. */
  private librarianLines(lines: CallLine[]): LibrarianLine[] {
    return lines.flatMap((l, i) =>
      l.text.trim()
        ? [
            {
              n: i + 1,
              who:
                l.role === 'user'
                  ? ('You' as const)
                  : l.role === 'tool'
                    ? ('Tool' as const)
                    : ('Agent' as const),
              at: l.at,
              text: l.text,
            },
          ]
        : [],
    );
  }

  /**
   * Where a transcript line is in the call notes: its topic note (or the call note) and time,
   * so a fact the librarian files links back to where it was said.
   * @param record - The call, when it is saved as notes.
   * @param lines - Its transcript.
   * @param n - L-number.
   */
  private sourceFor(
    record: CallRecord | null,
    lines: CallLine[],
    n: number | undefined,
  ): string | undefined {
    const line = n ? lines[n - 1] : undefined;
    const time = clock(line?.at);
    if (!record) return time ? `voice call, ${time}` : undefined;
    const topic =
      record.structure === 'topics' && line?.at ? this.topicAt(record, line.at) : undefined;
    return `${linkTo(topic?.path ?? record.callPath)}${time ? ` ${time}` : ''}`;
  }

  /** What else happened in a call, for its summary: its topics and its tasks with their outcome. */
  private callContext(record: CallRecord | null): string[] {
    if (!record) return [];
    const topics = record.topics.filter(t => t.kind !== 'opening').map(t => t.title);
    return [
      ...(topics.length ? [`Topics: ${topics.join(', ')}`] : []),
      ...this.tasks(record).map(
        t =>
          `Task "${t.title}": ${t.status}${
            t.result ? ` — ${t.result.replace(/\s+/g, ' ').slice(0, 300)}` : ''
          }`,
      ),
    ];
  }

  /**
   * During a call: once the user has said enough since the librarian's last pass, hands it the
   * new lines (in the background; nothing waits for it).
   */
  private consolidateTurns(): void {
    const memory = this.plugin.memory;
    const session = memory?.callSession;
    const every = memory?.settings.consolidateEveryTurns ?? 0;
    if (!memory || !session || !this.live || every <= 0) return;
    const transcript = this.transcriptSource?.() ?? [];
    const all = this.librarianLines(transcript);
    const fresh = all.filter(l => l.n > this.consolidatedLines);
    if (fresh.filter(l => l.who === 'You').length < every) return;
    const record = this.current;
    const lines = transcript.slice();
    memory.consolidateTurns(session, fresh, n => this.sourceFor(record, lines, n));
    this.consolidatedLines = all.length ? all[all.length - 1].n : 0;
  }

  private stopTimers(): void {
    if (this.autosave) window.clearInterval(this.autosave);
    this.autosave = null;
    if (this.memoryTimer) window.clearInterval(this.memoryTimer);
    this.memoryTimer = null;
    if (this.orchestratorTimer) window.clearTimeout(this.orchestratorTimer);
    this.orchestratorTimer = null;
  }

  /**
   * Moves a node's note (it gained children, or was renamed).
   *
   * Uses `vault.rename`, not `fileManager.renameFile`: with Obsidian's "Automatically update
   * internal links" off, the latter opens an "Update links?" prompt and waits for an answer, and
   * every later save of the call would wait behind it (validation run 2). Nothing is lost: the
   * call's own notes are rewritten from the recorded paths on every save, an orchestrator note
   * keeps its name when it moves into its folder (so links by name still resolve), and a topic is
   * only renamed while nothing has been said under it yet.
   * @param from - Old path.
   * @param to - New path.
   * @param apply - Records the new path at once, so later writes go there.
   */
  private move(from: string, to: string, apply: (path: string) => void): void {
    apply(to);
    void this.enqueue(async () => {
      const vault = this.plugin.app.vault;
      const file = vault.getAbstractFileByPath(from);
      if (!(file instanceof TFile)) return;
      await this.ensureFolder(dirOf(to));
      if (vault.getAbstractFileByPath(to)) return;
      await vault.rename(file, to);
    });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch(error => {
      this.plugin.console?.error('Could not save the call notes', error);
    });
    return this.chain;
  }

  private tasks(record: CallRecord): SubAgentTask[] {
    const classic = record.taskIds
      .map(id => this.plugin.agents?.find(id))
      .filter((t): t is SubAgentTask => !!t);
    // Durable workers have no notes of their own yet; the call note lists them by name.
    const source = this.plugin.taskList;
    if (!source || source === this.plugin.agents) return classic;
    const durable = source
      .list()
      .filter(
        t => t.createdAt >= record.startedAt && (!record.endedAt || t.createdAt <= record.endedAt),
      )
      .reverse();
    return [...classic, ...durable];
  }

  private taskLink(task: SubAgentTask, alias?: string): string {
    const label = alias ?? `${task.id} ${task.title}`;
    return task.notePath ? linkTo(task.notePath, label) : label;
  }

  /** Renders the call note: the root of the tree (the index, when the call has topics). */
  renderCall(record: CallRecord, lines: CallLine[]): string {
    if (record.structure === 'topics') return this.renderIndex(record);
    const started = new Date(record.startedAt);
    const tasks = this.tasks(record);
    const orch = record.orchestratorPath;
    const out = [
      '---',
      'type: voice-call',
      `started: ${started.toISOString()}`,
      ...(record.endedAt ? [`ended: ${new Date(record.endedAt).toISOString()}`] : []),
      `provider: ${yaml(record.provider)}`,
      `voice_role: ${record.voiceRole}`,
      ...(record.diagnosticsLog ? [`diagnostics: ${yaml(record.diagnosticsLog)}`] : []),
      ...(orch ? [`orchestrator: ${yaml(linkTo(orch))}`] : []),
      ...(tasks.some(t => t.notePath)
        ? [
            'threads:',
            ...tasks.filter(t => t.notePath).map(t => `  - ${yaml(linkTo(t.notePath as string))}`),
          ]
        : []),
      '---',
      '',
      `# Voice call ${record.stamp}`,
      '',
      ...(record.endedAt ? [] : ['_Call in progress._', '']),
      '## Threads',
      '',
      ...(orch ? [`- ${linkTo(orch, 'Orchestrator')}`] : []),
      ...tasks.map(t => `${orch ? '  ' : ''}- ${this.taskLink(t)}`),
      ...(!orch && !tasks.length ? ['None.'] : []),
      '',
      '## Transcript',
      '',
      ...this.renderLines(record, lines, record.handOffs),
    ];
    if (record.timings.length) out.push(...this.renderTimings(record));
    return out.join('\n');
  }

  /**
   * A transcript with hand-offs linked inline, right after what was said before them.
   * @param record - Call.
   * @param lines - Lines to render.
   * @param handOffs - Hand-offs among them.
   */
  private renderLines(record: CallRecord, lines: CallLine[], handOffs: HandOff[]): string[] {
    const out: string[] = [];
    handOffs = [...handOffs].sort((a, b) => a.at - b.at);
    let h = 0;
    const flush = (until: number) => {
      while (h < handOffs.length && handOffs[h].at <= until) {
        out.push(this.renderHandOff(record, handOffs[h++]), '');
      }
    };
    let said = false;
    for (const line of lines) {
      const text = line.text.trim();
      if (!text) continue;
      said = true;
      const time = clock(line.at);
      if (line.role === 'tool') out.push(`> ${time ? `${time} ` : ''}_${text}_`, '');
      else
        out.push(
          `**${line.role === 'user' ? 'You' : 'Agent'}**${time ? ` ${time}` : ''}: ${text}`,
          '',
        );
      // Hand-offs made before the next line was said follow this one.
      const next = lines[lines.indexOf(line) + 1];
      flush(next?.at ?? line.at ?? 0);
    }
    flush(Number.MAX_SAFE_INTEGER);
    if (!said) out.push('Nothing was said.', '');
    return out;
  }

  private topicLink(topic: CallTopic, alias?: string): string {
    return linkTo(topic.path, alias ?? topic.title);
  }

  /** Topics that follow from one. */
  private children(record: CallRecord, id: number): CallTopic[] {
    return record.topics.filter(t => t.followsFrom.includes(id));
  }

  /** Renders the index note: the call's folder note when it has topics. */
  renderIndex(record: CallRecord): string {
    const tasks = this.tasks(record);
    const orch = record.orchestratorPath;
    const out = [
      '---',
      'type: voice-call',
      `started: ${new Date(record.startedAt).toISOString()}`,
      ...(record.endedAt ? [`ended: ${new Date(record.endedAt).toISOString()}`] : []),
      `provider: ${yaml(record.provider)}`,
      `voice_role: ${record.voiceRole}`,
      ...(record.diagnosticsLog ? [`diagnostics: ${yaml(record.diagnosticsLog)}`] : []),
      ...(orch ? [`orchestrator: ${yaml(linkTo(orch))}`] : []),
      'topics:',
      ...record.topics.map(t => `  - ${yaml(linkTo(t.path))}`),
      ...(tasks.some(t => t.notePath)
        ? [
            'threads:',
            ...tasks.filter(t => t.notePath).map(t => `  - ${yaml(linkTo(t.notePath as string))}`),
          ]
        : []),
      '---',
      '',
      `# Voice call ${record.stamp}`,
      '',
      ...(record.endedAt ? [] : ['_Call in progress._', '']),
      '## Map',
      '',
    ];
    // A tree by each topic's first parent; a topic with more parents notes the others.
    const placed = new Set<number>();
    const walk = (topic: CallTopic, depth: number) => {
      if (placed.has(topic.id)) return;
      placed.add(topic.id);
      const also = topic.followsFrom.slice(1).map(p => record.topics[p - 1]);
      out.push(
        `${'  '.repeat(depth)}- ${this.topicLink(topic)} _${topic.kind}_${
          also.length ? `, also from ${also.map(a => this.topicLink(a)).join(', ')}` : ''
        }`,
      );
      for (const child of record.topics.filter(t => t.followsFrom[0] === topic.id)) {
        walk(child, depth + 1);
      }
    };
    for (const root of record.topics.filter(t => !t.followsFrom.length)) walk(root, 0);
    for (const t of record.topics) walk(t, 0);
    const flow = record.topicSwitches.map(s => this.topicLink(record.topics[s.id - 1]));
    out.push('', '## Flow', '', flow.join(' → '), '', '## Threads', '');
    out.push(
      ...(orch ? [`- ${linkTo(orch, 'Orchestrator')}`] : []),
      ...tasks.map(t => `${orch ? '  ' : ''}- ${this.taskLink(t)}`),
      ...(!orch && !tasks.length ? ['None.'] : []),
      '',
    );
    if (record.timings.length) out.push(...this.renderTimings(record));
    return out.join('\n');
  }

  /** Renders one topic note: the user's words on it, linked to the topics around it. */
  renderTopic(record: CallRecord, topic: CallTopic, lines: CallLine[]): string {
    const parents = topic.followsFrom.map(p => record.topics[p - 1]);
    const next = this.children(record, topic.id);
    const tasks = this.tasks(record).filter(t => t.topicNote === topic.path && t.notePath);
    const mine = lines.filter(l => this.topicAt(record, l.at ?? 0)?.id === topic.id);
    const handOffs = record.handOffs.filter(h => h.topicId === topic.id);
    const out = [
      '---',
      'type: voice-topic',
      `kind: ${topic.kind}`,
      `call: ${yaml(linkTo(record.callPath))}`,
      `started: ${new Date(topic.at).toISOString()}`,
      ...(parents.length
        ? ['follows_from:', ...parents.map(p => `  - ${yaml(linkTo(p.path))}`)]
        : []),
      ...(next.length ? ['leads_to:', ...next.map(n => `  - ${yaml(linkTo(n.path))}`)] : []),
      ...(tasks.length
        ? ['threads:', ...tasks.map(t => `  - ${yaml(linkTo(t.notePath as string))}`)]
        : []),
      '---',
      '',
      `# ${topic.title}`,
      '',
      `Part of ${linkTo(record.callPath, `Voice call ${record.stamp}`)}.${
        parents.length ? ` Follows from ${parents.map(p => this.topicLink(p)).join(' and ')}.` : ''
      }`,
      '',
      ...this.renderLines(record, mine, handOffs),
    ];
    if (next.length) {
      out.push('## Leads to', '', ...next.map(n => `- ${this.topicLink(n)} _${n.kind}_`), '');
    }
    return out.join('\n');
  }

  private renderHandOff(record: CallRecord, handOff: HandOff): string {
    const time = clock(handOff.at);
    if (handOff.target === 'orchestrator' && record.orchestratorPath) {
      return `> ${time} → Passed to the ${linkTo(record.orchestratorPath, 'orchestrator', handOff.anchor ? `#^${handOff.anchor}` : '')}`;
    }
    const task = this.plugin.agents?.find(handOff.target);
    const started = `${time} → Started ${task ? this.taskLink(task) : handOff.target}`;
    // The thread note links back here at #^spawn-<id>, so this line carries that block id. A plain
    // paragraph, because a block id on a quote line is not picked up (validation run 4, CALL-7).
    return handOff.anchor ? `${started} ^${handOff.anchor}` : `> ${started}`;
  }

  private renderTimings(record: CallRecord): string[] {
    const rows = record.timings.map(
      t => `| ${clock(t.at)} | ${t.what.replace(/\|/g, '/')} | ${t.ms} | ${t.outcome} |`,
    );
    return [
      '## Timings',
      '',
      '| Time | What | ms | Outcome |',
      '| --- | --- | ---: | --- |',
      ...rows,
      '',
    ];
  }

  /** Renders the orchestrator note: the call's child and the threads' parent. */
  renderOrchestrator(record: CallRecord): string {
    const tasks = this.tasks(record);
    const out = [
      '---',
      'type: voice-orchestrator',
      `call: ${yaml(linkTo(record.callPath))}`,
      `parent: ${yaml(linkTo(record.callPath))}`,
      `model: ${yaml(this.plugin.orchestrator?.label ?? '')}`,
      ...(tasks.some(t => t.notePath)
        ? [
            'threads:',
            ...tasks.filter(t => t.notePath).map(t => `  - ${yaml(linkTo(t.notePath as string))}`),
          ]
        : []),
      '---',
      '',
      `# Orchestrator, call ${record.stamp}`,
      '',
      `Part of ${linkTo(record.callPath, `Voice call ${record.stamp}`)}.`,
      '',
      '## Threads',
      '',
      ...(tasks.length ? tasks.map(t => `- ${this.taskLink(t)}`) : ['None.']),
      '',
      '## Conversation',
      '',
    ];
    const heads: Record<OrchestratorEntry['kind'], string> = {
      input: 'Input',
      reply: 'Orchestrator',
      tool: 'Tool call',
      result: 'Tool output',
      error: 'Error',
      spawn: 'Started a thread',
    };
    for (const e of record.orchestratorLog) {
      out.push(`### ${clock(e.at)} ${e.fromUser ? 'From the call' : heads[e.kind]}`, '');
      if (e.kind === 'input' && e.fromUser && e.anchor) {
        const topic = e.topicId ? record.topics[e.topicId - 1] : undefined;
        out.push(
          `Relayed from ${topic ? `${this.topicLink(topic)} in ` : ''}${linkTo(record.callPath, 'the voice call')}. ^${e.anchor}`,
          '',
        );
      }
      if (e.kind === 'spawn') {
        const task = e.taskId ? this.plugin.agents?.find(e.taskId) : undefined;
        out.push(`${task ? this.taskLink(task) : e.text}${e.anchor ? ` ^${e.anchor}` : ''}`, '');
        continue;
      }
      out.push(e.kind === 'tool' || e.kind === 'result' ? '```\n' + e.text + '\n```' : e.text, '');
    }
    if (!record.orchestratorLog.length) out.push('Nothing yet.', '');
    return out.join('\n');
  }

  private async write(path: string, body: string): Promise<void> {
    const vault = this.plugin.app.vault;
    const dir = dirOf(path);
    if (dir) await this.ensureFolder(dir);
    const file = vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await vault.modify(file, body);
    else await vault.create(path, body);
  }

  /** @param dir - Folder to create, with its parents. */
  async ensureFolder(dir: string): Promise<void> {
    const vault = this.plugin.app.vault;
    let path = '';
    for (const part of dir.split('/')) {
      path = path ? `${path}/${part}` : part;
      if (!vault.getAbstractFileByPath(path)) {
        try {
          await vault.createFolder(path);
        } catch {
          // Created meanwhile.
        }
      }
    }
  }

  /** Writes the call note. */
  saveCall(): Promise<void> {
    const record = this.current;
    if (!record) return Promise.resolve();
    return this.enqueue(async () => {
      const lines = this.transcriptSource?.() ?? [];
      await this.write(record.callPath, this.renderCall(record, lines));
      for (const topic of record.topics) {
        await this.write(topic.path, this.renderTopic(record, topic, lines));
      }
    });
  }

  /** Writes the orchestrator note. */
  saveOrchestrator(): Promise<void> {
    const record = this.current;
    if (!record?.orchestratorPath) return Promise.resolve();
    return this.enqueue(() =>
      this.write(record.orchestratorPath as string, this.renderOrchestrator(record)),
    );
  }

  /** Waits for pending moves and writes (tests, and before the plugin unloads). */
  flush(): Promise<void> {
    return this.chain;
  }

  /** Stops timers (plugin unload). */
  dispose(): void {
    this.stopTimers();
  }
}

/**
 * A one-line summary of a call for the shared memory: its topics, background tasks and notes.
 * @param record - The call, or null when calls are not saved.
 */
function callSummary(record: CallRecord | null): string {
  if (!record) return 'Voice call (not saved as notes).';
  const topics = record.topics.filter(t => t.kind !== 'opening').map(t => t.title);
  const parts = [
    topics.length ? `Topics: ${topics.slice(0, 8).join(', ')}` : '',
    record.taskIds.length ? `${record.taskIds.length} background task(s)` : '',
    `Notes: [[${record.callPath.replace(/\.md$/, '')}]]`,
  ];
  return parts.filter(Boolean).join('. ');
}
