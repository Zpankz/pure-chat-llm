import { normalizePath, TFile } from 'obsidian';
import type PureChatLLM from '../main';
import type { SubAgentTask } from './types';

/**
 * Saves each voice call as a small linked vault of its own (Hani's decisions 16 and 16a): the
 * conversation is stored as a branching tree of notes rather than one long page.
 *
 * - **Folder notes.** Every node that has children is a folder whose root note has the same
 *   name (`Name/Name.md`, the convention the Folder Notes community plugin uses); a node with no
 *   children is a plain note in its parent's folder. A node that gains its first child is moved
 *   into a folder of its own, with `fileManager.renameFile` so links elsewhere follow it.
 * - **The tree.** The call is the root (its folder note holds the voice transcript). In the
 *   layered setup the orchestrator is its child, and each worker thread is a child of the
 *   orchestrator; with the voice delegating directly, threads hang off the call.
 * - **Links both ways, where they happened.** Each child links back to its parent, and each
 *   parent links to its children inline, at the point in its conversation where it handed off:
 *   the transcript links to the orchestrator entry for each relay (by block id), and the
 *   orchestrator's conversation links each thread where it started it. Lists of children sit in
 *   frontmatter and a "Threads" section as well, for the graph and for Dataview.
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
}

/** A point in the call transcript where it handed off to a child node. */
interface HandOff {
  at: number;
  /** `orchestrator` or a task id. */
  target: string;
  /** Block id in the child's note, if the link should land on that exact point. */
  anchor?: string;
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
}

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
    };
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
    if (!record) return;
    record.endedAt = Date.now();
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
    if (record.orchestratorPath) {
      // The orchestrator now has a child, so it becomes a folder note.
      const orchestratorName = baseName(record.orchestratorPath);
      const target = normalizePath(`${record.folder}/${orchestratorName}/${orchestratorName}.md`);
      if (record.orchestratorPath !== target) this.move(record, record.orchestratorPath, target);
      task.notePath = normalizePath(`${record.folder}/${orchestratorName}/${name}.md`);
      task.parentNote = target;
      task.parentAnchor = anchor;
      record.orchestratorLog.push({
        at: Date.now(),
        kind: 'spawn',
        text: task.title,
        anchor,
        taskId: task.id,
      });
    } else {
      task.notePath = normalizePath(`${record.folder}/${name}.md`);
      task.parentNote = record.callPath;
      task.parentAnchor = anchor;
      record.handOffs.push({ at: Date.now(), target: task.id });
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
      record.handOffs.push({ at: entry.at, target: 'orchestrator', anchor: entry.anchor });
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

  private stopTimers(): void {
    if (this.autosave) window.clearInterval(this.autosave);
    this.autosave = null;
    if (this.orchestratorTimer) window.clearTimeout(this.orchestratorTimer);
    this.orchestratorTimer = null;
  }

  /**
   * Moves a node's note (it gained children), keeping links elsewhere in the vault working.
   * @param record - Call.
   * @param from - Old path.
   * @param to - New path.
   */
  private move(record: CallRecord, from: string, to: string): void {
    if (record.orchestratorPath === from) record.orchestratorPath = to;
    void this.enqueue(async () => {
      const file = this.plugin.app.vault.getAbstractFileByPath(from);
      if (!(file instanceof TFile)) return;
      await this.ensureFolder(dirOf(to));
      if (this.plugin.app.vault.getAbstractFileByPath(to)) return;
      await this.plugin.app.fileManager.renameFile(file, to);
    });
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch(error => {
      this.plugin.console?.error('Could not save the call notes', error);
    });
    return this.chain;
  }

  private tasks(record: CallRecord): SubAgentTask[] {
    return record.taskIds
      .map(id => this.plugin.agents?.find(id))
      .filter((t): t is SubAgentTask => !!t);
  }

  private taskLink(task: SubAgentTask, alias?: string): string {
    const label = alias ?? `${task.id} ${task.title}`;
    return task.notePath ? linkTo(task.notePath, label) : label;
  }

  /** Renders the call note: the root of the tree. */
  renderCall(record: CallRecord, lines: CallLine[]): string {
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
    ];
    // Hand-offs are linked inline, right after what was said before them.
    const handOffs = [...record.handOffs].sort((a, b) => a.at - b.at);
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
    if (record.timings.length) out.push(...this.renderTimings(record));
    return out.join('\n');
  }

  private renderHandOff(record: CallRecord, handOff: HandOff): string {
    const time = clock(handOff.at);
    if (handOff.target === 'orchestrator' && record.orchestratorPath) {
      return `> ${time} → Passed to the ${linkTo(record.orchestratorPath, 'orchestrator', handOff.anchor ? `#^${handOff.anchor}` : '')}`;
    }
    const task = this.plugin.agents?.find(handOff.target);
    return `> ${time} → Started ${task ? this.taskLink(task) : handOff.target}`;
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
        out.push(`Relayed from ${linkTo(record.callPath, 'the voice call')}. ^${e.anchor}`, '');
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
    return this.enqueue(() =>
      this.write(record.callPath, this.renderCall(record, this.transcriptSource?.() ?? [])),
    );
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
