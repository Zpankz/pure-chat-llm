// The durable engine's background tasks, as the voice tools, the call panel and the call
// notes see them. The durable orchestrator keeps its own record of its workers; this list
// follows it through the task events the engine sends, so the parts of the plugin built for
// the Classic engine can show and stop durable workers too (review W1.2).
import type { SubAgentStatus, SubAgentTask } from '../agents/types';
import type { WorkerStatus } from './workers';

/** What the voice tools and the panel need from a list of background tasks. */
export interface TaskList {
  list(): SubAgentTask[];
  find(idOrTitle: string): SubAgentTask | undefined;
  cancel(id: string): string;
  onChange(listener: () => void): () => void;
}

export interface DurableTaskEvent {
  conversation: string;
  id: string;
  title: string;
  status: WorkerStatus;
  text?: string;
  taskId?: number;
}

interface Entry {
  task: SubAgentTask;
  taskId?: number;
}

const STATUS: Record<WorkerStatus, SubAgentStatus> = {
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export class DurableTaskList implements TaskList {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  /**
   * @param abort - Stops a worker's task by its id.
   * @param model - The worker layer's label, shown on each task.
   */
  constructor(
    private abort: (taskId: number) => Promise<unknown>,
    private model: () => string,
  ) {}

  /** @param event - A durable task started, finished, failed or was cancelled. */
  record(event: DurableTaskEvent): void {
    const now = Date.now();
    const key = `${event.conversation}:${event.id}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        task: {
          id: event.id,
          title: event.title,
          prompt: '',
          status: STATUS[event.status],
          createdAt: now,
          startedAt: now,
          model: this.model(),
          steps: [],
          messages: [],
          origin: 'voice',
        } as SubAgentTask,
      };
      this.entries.set(key, entry);
    }
    const task = entry.task;
    const wasRunning = task.status === 'running' || task.status === 'waiting';
    task.status = STATUS[event.status];
    if (event.taskId !== undefined) entry.taskId = event.taskId;
    if (event.status === 'running' && !wasRunning) {
      // A follow-up round on a finished task.
      task.startedAt = now;
      task.finishedAt = undefined;
      task.result = undefined;
      task.error = undefined;
    }
    if (event.status === 'done') task.result = event.text;
    if (event.status === 'failed') task.error = event.text;
    if (event.status !== 'running' && event.status !== 'waiting') task.finishedAt = now;
    if (event.text && event.status !== 'running')
      task.steps.push({ at: now, kind: 'response', text: event.text.slice(0, 300) });
    this.changed();
  }

  /** Newest first, like the Classic list. */
  list(): SubAgentTask[] {
    return [...this.entries.values()].map(e => e.task).sort((a, b) => b.createdAt - a.createdAt);
  }

  find(idOrTitle: string): SubAgentTask | undefined {
    const key = idOrTitle.trim().toLowerCase();
    const tasks = this.list();
    return (
      tasks.find(t => t.id.toLowerCase() === key) ??
      tasks.find(t => t.title.toLowerCase() === key) ??
      tasks.find(t => t.title.toLowerCase().includes(key))
    );
  }

  cancel(id: string): string {
    const task = this.find(id);
    if (!task) return `No task matches "${id}".`;
    if (task.status !== 'running' && task.status !== 'waiting')
      return `${task.id} is already ${task.status}.`;
    const entry = [...this.entries.values()].find(e => e.task === task);
    if (entry?.taskId === undefined) return `${task.id} can't be stopped from here yet.`;
    void this.abort(entry.taskId).catch(() => undefined);
    return `Stopping ${task.id} "${task.title}".`;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (error) {
        console.error('[voice-agent] task list listener failed', error);
      }
    }
  }
}
