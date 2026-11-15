import { normalizePath, TFile } from 'obsidian';
import type PureChatLLM from '../main';
import { linkTo } from './CallRecorder';
import { LocalSubAgentBackend } from './LocalSubAgentBackend';
import { resolveLayer } from './layers';
import { AUTO_ROUTES } from './types';
import type {
  NoticeMode,
  ResolvedRoute,
  SubAgentBackend,
  SubAgentEvent,
  SubAgentEventKind,
  SubAgentHooks,
  SubAgentRunContext,
  SubAgentStep,
  SubAgentTask,
} from './types';

interface Runtime {
  inbox: string[];
  cancelled: boolean;
  /** Aborts the task's in-flight requests and tool calls on cancel or time-out. */
  abort: AbortController;
  /** Wall-clock limit timer. */
  limit: number | null;
  advice: ((answer: string) => void) | null;
  checkIn: number | null;
}

type Listener = (event: SubAgentEvent, mode: NoticeMode) => void;

/**
 * Owns background sub-agent tasks for orchestrators.
 *
 * Every lifecycle event is logged on its task and routed by the settings: `interrupt` events go
 * to listeners at once (the voice view speaks them), `queue` events wait for `check_tasks`, and
 * `ignore` events stay in the log. Timed check-ins, stuck detection and advice requests are all
 * deterministic, so the orchestrator never has to poll to stay on top of its sub-agents.
 */
export class SubAgentManager {
  readonly tasks = new Map<string, SubAgentTask>();
  private runtime = new Map<string, Runtime>();
  private queue: string[] = [];
  private queuedUpdates: SubAgentEvent[] = [];
  private listeners = new Set<Listener>();
  private changeListeners = new Set<() => void>();
  private hooks: SubAgentHooks[] = [];
  private seq = 0;
  private lastProgress = new Map<string, number>();
  private progressTimer: number | null = null;
  private progressSeconds = 0;
  backend: SubAgentBackend;

  /** @param plugin - Plugin. */
  constructor(private plugin: PureChatLLM) {
    this.backend = new LocalSubAgentBackend(plugin);
  }

  private get settings() {
    return this.plugin.settings.orchestrator;
  }

  /**
   * Registers hooks around every sub-agent run. Returns a function that removes them.
   * @param hooks - Hook set.
   */
  registerHooks(hooks: SubAgentHooks): () => void {
    this.hooks.push(hooks);
    return () => {
      this.hooks = this.hooks.filter(h => h !== hooks);
    };
  }

  /**
   * Listens for events routed as `interrupt`. Returns an unsubscribe function.
   * @param listener - Receives each event.
   */
  onInterrupt(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Listens for any change to the task list (for views).
   * @param listener - Called after each change.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Tasks, newest first. */
  list(): SubAgentTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Finds a task by id or by a unique title prefix (voice models often say the title).
   * @param idOrTitle - Id or title.
   */
  find(idOrTitle: string): SubAgentTask | undefined {
    const direct = this.tasks.get(idOrTitle.trim());
    if (direct) return direct;
    const key = idOrTitle.trim().toLowerCase();
    const matches = this.list().filter(t => t.title.toLowerCase().startsWith(key));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Updates queued for the next `check_tasks`, then clears them. */
  takeQueuedUpdates(): SubAgentEvent[] {
    const updates = this.queuedUpdates;
    this.queuedUpdates = [];
    return updates;
  }

  /**
   * Starts a background task.
   * @param title - Short title.
   * @param prompt - Self-contained brief.
   * @param origin - Who started it.
   */
  spawn(title: string, prompt: string, origin: string): SubAgentTask {
    const id = `t${++this.seq}`;
    const task: SubAgentTask = {
      id,
      title: title.trim().slice(0, 80) || `Task ${this.seq}`,
      prompt,
      status: 'queued',
      createdAt: Date.now(),
      model: resolveLayer(this.plugin, 'worker').model,
      steps: [],
      messages: [],
      origin,
    };
    // The user's own words, verbatim from the call, for the write reviewers.
    if (origin === 'voice') {
      const words = this.plugin.calls?.recentUserWords?.();
      if (words) task.userRequest = words;
    }
    // Tasks started during a voice call are saved with the call's notes, linked to their parent.
    this.plugin.calls?.attachTask(task);
    this.tasks.set(id, task);
    this.runtime.set(id, {
      inbox: [],
      cancelled: false,
      abort: new AbortController(),
      limit: null,
      advice: null,
      checkIn: null,
    });
    this.queue.push(id);
    this.changed();
    this.pump();
    return task;
  }

  /**
   * Sends a message to a task: answers its question, steers it while it runs, or starts a
   * follow-up turn when it has finished.
   * @param id - Task id.
   * @param message - Message from the orchestrator.
   */
  message(id: string, message: string): string {
    const task = this.tasks.get(id);
    const rt = this.runtime.get(id);
    if (!task || !rt) return `No task ${id}.`;
    if (task.status === 'waiting' && rt.advice) {
      rt.advice(message);
      return `Answered ${task.title}.`;
    }
    if (task.status === 'running' || task.status === 'queued') {
      rt.inbox.push(message);
      return `Sent to ${task.title}; it will read it before its next step.`;
    }
    // Finished, failed or cancelled: continue the same conversation.
    task.messages.push({ role: 'user', content: `Follow-up from the orchestrator: ${message}` });
    task.status = 'queued';
    task.result = undefined;
    task.error = undefined;
    rt.cancelled = false;
    this.queue.push(id);
    this.changed();
    this.pump();
    return `Restarted ${task.title} with the follow-up.`;
  }

  /**
   * Cancels a task.
   * @param id - Task id.
   */
  cancel(id: string): string {
    const task = this.tasks.get(id);
    const rt = this.runtime.get(id);
    if (!task || !rt) return `No task ${id}.`;
    if (['done', 'failed', 'cancelled'].includes(task.status))
      return `${task.title} already ended.`;
    rt.cancelled = true;
    // Stops the request or tool call in flight, not just the next step.
    rt.abort.abort();
    rt.advice?.('The task was cancelled.');
    if (task.status === 'queued') {
      this.queue = this.queue.filter(q => q !== id);
      this.finish(task, 'cancelled', undefined, 'Cancelled before it started.');
    }
    return `Cancelling ${task.title}.`;
  }

  /**
   * A sub-agent asks the orchestrator something and waits.
   * @param id - Task id.
   * @param question - Question.
   */
  ask(id: string, question: string): Promise<string> {
    const task = this.tasks.get(id);
    const rt = this.runtime.get(id);
    if (!task || !rt) return Promise.resolve('No orchestrator is listening; use your judgment.');
    task.status = 'waiting';
    task.question = question;
    this.log(task, { kind: 'advice', text: `Asked: ${question}` });
    this.emit(task, 'needs_advice', question);
    const timeoutMs = Math.max(10, this.settings.adviceTimeoutSeconds || 300) * 1000;
    return new Promise<string>(resolve => {
      const timer = window.setTimeout(
        () => done('No answer came in time. Use your best judgment and say what you assumed.'),
        timeoutMs,
      );
      const done = (answer: string) => {
        window.clearTimeout(timer);
        rt.advice = null;
        task.question = undefined;
        if (task.status === 'waiting') task.status = 'running';
        this.log(task, { kind: 'advice', text: `Answer: ${answer}` });
        this.changed();
        resolve(answer);
      };
      rt.advice = done;
    });
  }

  /**
   * A sub-agent reports progress.
   * @param id - Task id.
   * @param note - Progress note.
   */
  report(id: string, note: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.log(task, { kind: 'note', text: note });
    this.emit(task, 'progress', note);
  }

  /**
   * Periodic spoken progress, as the user asks for it ("keep me posted"). Each tick sends one
   * summary of the running tasks straight to the listeners, whatever the routes say, because
   * the user asked for it. Returns the interval now in force (0 = off).
   * @param seconds - Seconds between updates; 0 turns them off.
   */
  setProgressInterval(seconds: number): number {
    if (this.progressTimer) window.clearInterval(this.progressTimer);
    this.progressTimer = null;
    this.progressSeconds = seconds > 0 ? Math.max(10, Math.round(seconds)) : 0;
    if (this.progressSeconds) {
      this.progressTimer = window.setInterval(
        () => this.progressTick(),
        this.progressSeconds * 1000,
      );
    }
    return this.progressSeconds;
  }

  /** Current progress interval in seconds (0 = off). */
  get progressInterval(): number {
    return this.progressSeconds;
  }

  private progressTick(): void {
    const active = this.list().filter(t => t.status === 'running' || t.status === 'waiting');
    if (!active.length || !this.listeners.size) return;
    const text = active
      .map(t => {
        const last = t.steps.length ? t.steps[t.steps.length - 1].text.slice(0, 120) : 'starting';
        return `${t.title}: ${t.status === 'waiting' ? 'waiting for advice' : last}`;
      })
      .join('; ');
    const event: SubAgentEvent = {
      kind: 'progress',
      taskId: active[0].id,
      title: active.length === 1 ? active[0].title : `${active.length} tasks`,
      at: Date.now(),
      text,
      tick: true,
    };
    for (const listener of this.listeners) listener(event, 'pause');
  }

  /** Stops every task (plugin unload). */
  dispose(): void {
    this.setProgressInterval(0);
    for (const [id, rt] of this.runtime) {
      rt.cancelled = true;
      rt.abort.abort();
      rt.advice?.('The plugin is shutting down.');
      if (rt.checkIn) window.clearInterval(rt.checkIn);
      if (rt.limit) window.clearTimeout(rt.limit);
      this.runtime.delete(id);
    }
    this.listeners.clear();
    this.changeListeners.clear();
  }

  private running(): number {
    return this.list().filter(t => t.status === 'running' || t.status === 'waiting').length;
  }

  /** Starts queued tasks up to the concurrency limit. */
  private pump(): void {
    while (this.queue.length && this.running() < Math.max(1, this.settings.maxConcurrent || 3)) {
      const id = this.queue.shift() as string;
      const task = this.tasks.get(id);
      if (task) void this.start(task);
    }
  }

  private async start(task: SubAgentTask): Promise<void> {
    const rt = this.runtime.get(task.id);
    if (!rt) return;
    task.status = 'running';
    task.startedAt = task.startedAt ?? Date.now();
    this.emit(task, 'started', task.prompt.slice(0, 200));
    const minutes = this.settings.checkInMinutes;
    if (minutes > 0) {
      rt.checkIn = window.setInterval(() => this.checkIn(task), minutes * 60_000);
    }
    // A task that runs past its time limit is stopped, which frees its slot.
    const limitMinutes = this.settings.taskTimeoutMinutes ?? 20;
    let timedOut = false;
    if (limitMinutes > 0 && !rt.limit) {
      rt.limit = window.setTimeout(() => {
        timedOut = true;
        rt.abort.abort();
        rt.advice?.('The task ran out of time.');
      }, limitMinutes * 60_000);
    }
    await this.saveNote(task);

    const ctx: SubAgentRunContext = {
      hooks: this.hooks,
      emit: (kind, text) => this.emit(task, kind, text),
      log: step => this.log(task, step),
      isCancelled: () => rt.cancelled || rt.abort.signal.aborted,
      signal: rt.abort.signal,
      drainInbox: () => rt.inbox.splice(0),
      askOrchestrator: question => this.ask(task.id, question),
    };
    try {
      const result = await this.backend.run(task, ctx);
      this.finish(task, rt.cancelled ? 'cancelled' : 'done', result);
    } catch (error) {
      const message = timedOut
        ? `Stopped after ${limitMinutes} minutes, the time limit for one task.`
        : error instanceof Error
          ? error.message
          : String(error);
      this.finish(task, rt.cancelled ? 'cancelled' : 'failed', undefined, message);
    }
  }

  private finish(
    task: SubAgentTask,
    status: 'done' | 'failed' | 'cancelled',
    result?: string,
    error?: string,
  ): void {
    const rt = this.runtime.get(task.id);
    if (rt?.checkIn) window.clearInterval(rt.checkIn);
    if (rt?.limit) window.clearTimeout(rt.limit);
    if (rt) {
      rt.checkIn = null;
      rt.limit = null;
      // A follow-up turn gets a fresh controller.
      if (rt.abort.signal.aborted && status !== 'cancelled') rt.abort = new AbortController();
    }
    task.status = status;
    task.finishedAt = Date.now();
    task.result = result;
    task.error = status === 'done' ? undefined : error;
    const kind: SubAgentEventKind =
      status === 'done' ? 'finished' : status === 'failed' ? 'failed' : 'cancelled';
    this.emit(task, kind, status === 'done' ? (result ?? '') : (error ?? status));
    void this.saveNote(task);
    this.pump();
  }

  /**
   * Timed review. A routine check-in is only a background note for the orchestrator; a task
   * that has made no step since the last check-in is reported as stuck, which starts a turn
   * (system review C2: routine check-ins no longer cost an orchestrator turn each).
   */
  private checkIn(task: SubAgentTask): void {
    if (task.status !== 'running') return;
    const lastStep = task.steps.length ? task.steps[task.steps.length - 1].at : task.startedAt;
    const quietMinutes = (Date.now() - (lastStep ?? Date.now())) / 60000;
    const interval = Math.max(1, this.settings.checkInMinutes || 5);
    if (quietMinutes >= interval) {
      this.emit(
        task,
        'stuck',
        `No step for ${Math.round(quietMinutes)} min. It may be waiting on a slow request; message or cancel it if it should move on.`,
      );
      return;
    }
    const recent = task.steps
      .slice(-5)
      .map(s => s.text)
      .join('; ');
    const minutes = Math.round((Date.now() - (task.startedAt ?? Date.now())) / 60000);
    this.emit(
      task,
      'checkpoint',
      `Running for ${minutes} min, ${task.steps.length} steps. Recent: ${recent || 'nothing yet'}. Check it is still heading the right way.`,
    );
  }

  private log(task: SubAgentTask, step: Omit<SubAgentStep, 'at'>): void {
    task.steps.push({ at: Date.now(), ...step });
    if (task.steps.length > 500) task.steps.splice(0, task.steps.length - 500);
    this.changed();
  }

  private emit(task: SubAgentTask, kind: SubAgentEventKind, text: string): void {
    const event: SubAgentEvent = { kind, taskId: task.id, title: task.title, at: Date.now(), text };
    let route = this.routeFor(kind);
    // Step-level progress is frequent: pass on at most one per task per minute.
    if (kind === 'progress' && route !== 'ignore') {
      const last = this.lastProgress.get(task.id) ?? 0;
      if (event.at - last < 60_000) route = 'ignore';
      else this.lastProgress.set(task.id, event.at);
    }
    const live = this.listeners.size > 0;
    if (live && (route === 'interrupt' || route === 'pause' || route === 'silent')) {
      for (const listener of this.listeners) listener(event, route);
    }
    // Held for check_tasks: queued events, spoken ones nobody heard, and quiet ones (some
    // providers have no quiet channel).
    if (route === 'queue' || route === 'silent' || (!live && route !== 'ignore')) {
      this.queuedUpdates.push(event);
      if (this.queuedUpdates.length > 100) this.queuedUpdates.shift();
    }
    for (const hook of this.hooks) hook.onEvent?.(event);
    this.changed();
  }

  /**
   * The route in force for an event kind, with `auto` resolved.
   * @param kind - Event kind.
   */
  routeFor(kind: SubAgentEventKind): ResolvedRoute {
    const route = this.settings.routes[kind] ?? 'auto';
    return route === 'auto' ? AUTO_ROUTES[kind] : route;
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  /** Writes the task's transcript note when a task folder is set. */
  private async saveNote(task: SubAgentTask): Promise<void> {
    const folder = this.settings.taskFolder.trim();
    if (!folder && !task.notePath) return;
    try {
      const vault = this.plugin.app.vault;
      const dir = normalizePath(task.notePath ? task.notePath.replace(/\/[^/]*$/, '') : folder);
      await this.plugin.calls?.ensureFolder(dir);
      if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
      if (!task.notePath) {
        const date = new Date(task.createdAt).toISOString().slice(0, 10);
        const safe = task.title.replace(/[\\/:*?"<>|#^[\]]/g, '').slice(0, 60) || task.id;
        let path = normalizePath(`${dir}/${date} ${safe}.md`);
        for (let n = 2; vault.getAbstractFileByPath(path); n++) {
          path = normalizePath(`${dir}/${date} ${safe} ${n}.md`);
        }
        task.notePath = path;
      }
      const body = this.renderNote(task);
      const file = vault.getAbstractFileByPath(task.notePath);
      if (file instanceof TFile) await vault.modify(file, body);
      else await vault.create(task.notePath, body);
    } catch (error) {
      this.plugin.console?.error('Could not save the agent task note', error);
    }
  }

  private renderNote(task: SubAgentTask): string {
    const time = (t?: number) => (t ? new Date(t).toISOString() : '');
    const lines = [
      '---',
      `task: ${task.id}`,
      `status: ${task.status}`,
      `model: ${JSON.stringify(task.model)}`,
      `origin: ${task.origin}`,
      `created: ${time(task.createdAt)}`,
      ...(task.finishedAt ? [`finished: ${time(task.finishedAt)}`] : []),
      ...(task.parentNote ? [`parent: ${JSON.stringify(linkTo(task.parentNote))}`] : []),
      ...(task.callNote ? [`call: ${JSON.stringify(linkTo(task.callNote))}`] : []),
      ...(task.topicNote ? [`topic: ${JSON.stringify(linkTo(task.topicNote))}`] : []),
      '---',
      '',
      `# ${task.title}`,
      '',
      ...(task.parentNote
        ? [
            `Started by ${linkTo(
              task.parentNote,
              task.parentNote === task.callNote
                ? 'the voice call'
                : task.parentNote === task.topicNote
                  ? 'the voice call'
                  : 'the orchestrator',
              task.parentAnchor ? `#^${task.parentAnchor}` : '',
            )}${
              task.topicNote && task.topicNote !== task.parentNote
                ? `, on ${linkTo(task.topicNote, 'this topic of the call')}`
                : ''
            }${
              task.callNote && task.callNote !== task.parentNote
                ? ` during ${linkTo(task.callNote, 'the voice call')}`
                : ''
            }.`,
            '',
          ]
        : []),
      '## Brief',
      '',
      task.prompt,
      '',
      '## Steps',
      '',
      ...task.steps.map(
        s => `- ${time(s.at).slice(11, 19)} ${s.kind}: ${s.text.replace(/\n+/g, ' ')}`,
      ),
      '',
    ];
    if (task.result) lines.push('## Result', '', task.result, '');
    if (task.error) lines.push('## Error', '', task.error, '');
    return lines.join('\n');
  }
}
