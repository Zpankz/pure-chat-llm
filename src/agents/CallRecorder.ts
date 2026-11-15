import { normalizePath, TFile } from 'obsidian';
import type PureChatLLM from '../main';
import type { SubAgentTask } from './types';

/**
 * Saves each voice call as linked notes (Hani's decision 16):
 *
 * - a call note with both sides of the transcript and links to every thread;
 * - in the layered setup, an orchestrator note with the orchestrator's whole conversation
 *   during the call (inputs, replies, tool calls and their outputs), linking up to the call;
 * - each sub-agent thread as its own note, linking up to the orchestrator (or the call).
 *
 * The notes of one call share a folder named after the call, inside the calls folder setting
 * ("Voice Agent" by default). Work that finishes after the call ends is still written to that
 * call's notes, until the next call starts.
 */
export interface CallLine {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at?: number;
}

export interface OrchestratorEntry {
  at: number;
  kind: 'input' | 'reply' | 'tool' | 'result' | 'error';
  text: string;
}

export interface CallRecord {
  /** Local date and time the call started, `YYYY-MM-DD HHmm`, plus a counter if needed. */
  stamp: string;
  folder: string;
  callPath: string;
  /** Set in the layered setup, where an orchestrator agent runs between voice and workers. */
  orchestratorPath: string | null;
  startedAt: number;
  endedAt?: number;
  provider: string;
  voiceRole: string;
  orchestratorLog: OrchestratorEntry[];
  taskIds: string[];
}

/** Characters of one tool output kept in the orchestrator note. */
const MAX_TOOL_OUTPUT = 4000;

/** @param path - Vault path of a note. */
export function linkTo(path: string, alias?: string): string {
  const target = path.replace(/\.md$/, '');
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

export class CallRecorder {
  /** The call being recorded, or the last one, which keeps collecting late results. */
  current: CallRecord | null = null;
  private live = false;
  private transcriptSource: (() => CallLine[]) | null = null;
  private autosave: number | null = null;
  private orchestratorTimer: number | null = null;

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
    if (!this.enabled) {
      this.current = null;
      return null;
    }
    const at = Date.now();
    const vault = this.plugin.app.vault;
    const root = normalizePath(this.plugin.settings.voice.callsFolder.trim());
    let stamp = localStamp(at);
    for (let n = 2; vault.getAbstractFileByPath(`${root}/${stamp}`); n++) {
      stamp = `${localStamp(at)} ${n}`;
    }
    const folder = normalizePath(`${root}/${stamp}`);
    const role = this.plugin.settings.orchestrator.voiceRole;
    this.current = {
      stamp,
      folder,
      callPath: normalizePath(`${folder}/${stamp} call.md`),
      orchestratorPath:
        role === 'layered' ? normalizePath(`${folder}/${stamp} orchestrator.md`) : null,
      startedAt: at,
      provider,
      voiceRole: role,
      orchestratorLog: [],
      taskIds: [],
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
   * Where a new sub-agent task's note goes, when it belongs to a call.
   * @param task - New task.
   */
  attachTask(task: SubAgentTask): void {
    const record = this.current;
    if (!record || task.origin !== 'voice') return;
    record.taskIds.push(task.id);
    const safe = task.title.replace(/[\\/:*?"<>|#^[\]]/g, '').slice(0, 60) || task.id;
    task.notePath = normalizePath(`${record.folder}/${record.stamp} ${task.id} ${safe}.md`);
    task.parentNote = record.orchestratorPath ?? record.callPath;
    task.callNote = record.callPath;
    void this.saveCall();
    this.scheduleOrchestratorSave();
  }

  /**
   * Adds a line to the orchestrator's log for the current call.
   * @param kind - Entry kind.
   * @param text - Text.
   */
  logOrchestrator(kind: OrchestratorEntry['kind'], text: string): void {
    const record = this.current;
    if (!record?.orchestratorPath) return;
    const clipped =
      kind === 'result' && text.length > MAX_TOOL_OUTPUT
        ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[${text.length - MAX_TOOL_OUTPUT} more characters]`
        : text;
    record.orchestratorLog.push({ at: Date.now(), kind, text: clipped });
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

  private tasks(record: CallRecord): SubAgentTask[] {
    return record.taskIds
      .map(id => this.plugin.agents?.find(id))
      .filter((t): t is SubAgentTask => !!t);
  }

  private taskLinks(record: CallRecord): string[] {
    return this.tasks(record).map(
      t => `- ${t.notePath ? linkTo(t.notePath, `${t.id} ${t.title}`) : `${t.id} ${t.title}`}`,
    );
  }

  /** Renders the call note. */
  renderCall(record: CallRecord, lines: CallLine[]): string {
    const started = new Date(record.startedAt);
    const tasks = this.tasks(record);
    const out = [
      '---',
      'type: voice-call',
      `started: ${started.toISOString()}`,
      ...(record.endedAt ? [`ended: ${new Date(record.endedAt).toISOString()}`] : []),
      `provider: ${yaml(record.provider)}`,
      `voice_role: ${record.voiceRole}`,
      ...(record.orchestratorPath
        ? [`orchestrator: ${yaml(linkTo(record.orchestratorPath))}`]
        : []),
      ...(tasks.length
        ? [
            'threads:',
            ...tasks.filter(t => t.notePath).map(t => `  - ${yaml(linkTo(t.notePath as string))}`),
          ]
        : []),
      '---',
      '',
      `# Voice call ${record.stamp}`,
      '',
      record.endedAt ? '' : '_Call in progress._',
      '',
      '## Threads',
      '',
      ...(record.orchestratorPath ? [`- ${linkTo(record.orchestratorPath, 'Orchestrator')}`] : []),
      ...(record.orchestratorPath
        ? this.taskLinks(record).map(l => `  ${l}`)
        : this.taskLinks(record)),
      ...(!record.orchestratorPath && !tasks.length ? ['None.'] : []),
      '',
      '## Transcript',
      '',
    ];
    for (const line of lines) {
      const text = line.text.trim();
      if (!text) continue;
      const time = clock(line.at);
      if (line.role === 'tool') out.push(`> ${time ? `${time} ` : ''}_${text}_`, '');
      else
        out.push(
          `**${line.role === 'user' ? 'You' : 'Agent'}**${time ? ` ${time}` : ''}: ${text}`,
          '',
        );
    }
    if (!lines.some(l => l.text.trim())) out.push('Nothing was said.', '');
    return out.join('\n');
  }

  /** Renders the orchestrator note. */
  renderOrchestrator(record: CallRecord): string {
    const out = [
      '---',
      'type: voice-orchestrator',
      `call: ${yaml(linkTo(record.callPath))}`,
      `model: ${yaml(this.plugin.orchestrator?.label ?? '')}`,
      '---',
      '',
      `# Orchestrator, call ${record.stamp}`,
      '',
      `Call: ${linkTo(record.callPath, `Voice call ${record.stamp}`)}`,
      '',
      '## Sub-threads',
      '',
      ...(record.taskIds.length ? this.taskLinks(record) : ['None.']),
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
    };
    for (const e of record.orchestratorLog) {
      out.push(`### ${clock(e.at)} ${heads[e.kind]}`, '');
      out.push(e.kind === 'tool' || e.kind === 'result' ? '```\n' + e.text + '\n```' : e.text, '');
    }
    if (!record.orchestratorLog.length) out.push('Nothing yet.', '');
    return out.join('\n');
  }

  private async write(path: string, body: string): Promise<void> {
    const vault = this.plugin.app.vault;
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await this.ensureFolder(dir);
    const file = vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await vault.modify(file, body);
    else await vault.create(path, body);
  }

  private async ensureFolder(dir: string): Promise<void> {
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
  async saveCall(): Promise<void> {
    const record = this.current;
    if (!record) return;
    try {
      await this.write(record.callPath, this.renderCall(record, this.transcriptSource?.() ?? []));
    } catch (error) {
      this.plugin.console?.error('Could not save the call note', error);
    }
  }

  /** Writes the orchestrator note. */
  async saveOrchestrator(): Promise<void> {
    const record = this.current;
    if (!record?.orchestratorPath) return;
    try {
      await this.write(record.orchestratorPath, this.renderOrchestrator(record));
    } catch (error) {
      this.plugin.console?.error('Could not save the orchestrator note', error);
    }
  }

  /** Stops timers (plugin unload). */
  dispose(): void {
    this.stopTimers();
  }
}
