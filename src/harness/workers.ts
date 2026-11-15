// Background workers on the durable engine. `delegate_task` starts a worker task that is a
// background task of the orchestrator's conversation (so the orchestrator stays free to talk). The
// worker task owns a child conversation with the worker layer and the worker's tools, gives it the
// brief, waits for its answer, and posts the outcome back to the orchestrator as an
// `[Agent update]` input. Every message a worker sends carries a request ID, so a restart in the
// middle never sends a brief, a question or a report twice. The orchestrator's record of its
// workers (titles, status, results, a pending question) is one document of its conversation,
// written in the same commits as the work it describes.
import { configure, defineDoc, defineExtension, defineTask, defineTool, text } from './pi';
import type {
  AgentChange,
  ConversationId,
  EntryRecord,
  Extension,
  TaskId,
  ToolExecutionApi,
} from './pi';
import type { Context } from './pi';

/** Name of the orchestrator's orchestration extension. */
export const ORCHESTRATION_EXTENSION = 'voice-agent-orchestration';
/** Name of a worker's own extension (asking and progress notes). */
export const WORKER_AGENT_EXTENSION = 'voice-agent-worker';
/** The worker task's registered name. */
export const WORKER_TASK = 'voice-agent.worker';

export type WorkerStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/** One worker, as the orchestrator's conversation records it. */
export interface WorkerRecord {
  [key: string]: string | number | string[] | null;
  id: string;
  title: string;
  brief: string;
  status: WorkerStatus;
  taskId: number;
  /** The `delegate_task` call that started it, so a rerun of that call finds it. */
  callId: string;
  child: number | null;
  result: string | null;
  error: string | null;
  /** A question waiting for the orchestrator, and the `ask_orchestrator` call waiting on it. */
  question: string | null;
  askCallId: string | null;
  /** The orchestrator's answer to that call. */
  answer: string | null;
  steps: string[];
  createdAt: number;
}

interface WorkersState {
  [key: string]: number | Record<string, WorkerRecord>;
  next: number;
  tasks: Record<string, WorkerRecord>;
}

/** The orchestrator conversation's record of its workers. */
export const WorkersDoc = defineDoc<WorkersState>({
  kind: 'voice-agent.workers',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({ next: 1, tasks: {} }),
  checkpointWhen: () => false,
});

/**
 * Instructions of the orchestrator on the durable engine, naming only the tools it has there. The
 * voice bridge (stage 3) adds how its answers reach the user.
 */
export const DURABLE_ORCHESTRATOR_GUIDANCE = [
  "You are the orchestrator of the user's assistant in their Obsidian vault. You plan, write briefs, run background workers and decide what the user hears.",
  'Answer from what you know or with a quick read-only look yourself. Hand anything longer, any change to the vault, and independent parts that can run side by side to delegate_task, with a short title and a complete, self-contained brief (the worker cannot see this conversation), then say in a few words that it is under way.',
  'Messages marked [Agent update] come from your workers, not the user. On a finished task, call get_task_result, check it answers the brief, and give the user one or two plain sentences. On a question, answer it with message_task when the answer is clear; otherwise ask the user one clear question and pass the answer on. Use check_tasks when asked how things are going, and cancel_task when the user says stop.',
  'You never write to the vault yourself; workers do, under the vault write rules.',
].join('\n');

/** What the worker side needs from the plugin. */
export interface WorkerHost {
  /** The worker conversation's agent: worker layer model, its tools extension, its instructions. */
  workerAgent(workerAgentExtension: Extension): AgentChange;
  /** Longest result text a tool returns to the orchestrator. */
  maxResultChars?: number;
}

interface WorkerInput {
  [key: string]: string;
  id: string;
  title: string;
  brief: string;
}

type WorkerCheckpoint =
  | { phase: 'open' }
  | { phase: 'brief'; child: number }
  | { phase: 'report'; child: number; status: 'done' | 'failed'; text: string };

interface WorkerResult {
  [key: string]: string;
  status: 'done' | 'failed';
  text: string;
}

const MAX_STEPS = 20;

/** The text of an assistant answer entry. */
export function answerText(entry: EntryRecord | undefined): string {
  const messages = entry?.model ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const parts = message.content.map(c => (c.type === 'text' ? c.text : '')).filter(Boolean);
    if (parts.length) return parts.join('\n').trim();
  }
  return '';
}

/** Short one-line state of a worker for the orchestrator. */
export function describeWorker(w: WorkerRecord, now = Date.now()): string {
  const age = Math.max(0, Math.round((now - w.createdAt) / 1000));
  const last = w.steps.length ? `, last: ${w.steps[w.steps.length - 1].slice(0, 160)}` : '';
  switch (w.status) {
    case 'waiting':
      return `${w.id} "${w.title}": waiting for advice: ${w.question ?? ''}`;
    case 'done':
      return `${w.id} "${w.title}": finished. Call get_task_result for the answer.`;
    case 'failed':
      return `${w.id} "${w.title}": failed: ${w.error ?? 'unknown error'}`;
    case 'cancelled':
      return `${w.id} "${w.title}": cancelled.`;
    default:
      return `${w.id} "${w.title}": running for ${age}s, ${w.steps.length} notes${last}.`;
  }
}

function findWorker(state: Readonly<WorkersState>, key: string): WorkerRecord | undefined {
  const k = key.trim().toLowerCase();
  const all = Object.values(state.tasks);
  return (
    all.find(w => w.id.toLowerCase() === k) ??
    all.find(w => w.title.toLowerCase() === k) ??
    all.find(w => w.title.toLowerCase().includes(k))
  );
}

/** Waits until a document of a conversation satisfies `done`, and returns what it returns. */
async function waitForDoc<T>(
  api: Pick<ToolExecutionApi, 'watchDoc'>,
  conversationId: ConversationId,
  done: (state: Readonly<WorkersState>) => T | undefined,
  context: Context,
): Promise<T> {
  const watch = await api.watchDoc(WorkersDoc, conversationId, context);
  if (!watch) throw new Error('The workers record is missing.');
  const first = done(watch.value);
  if (first !== undefined) {
    await watch.stop();
    return first;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      void watch.stop();
      reject(new Error('Stopped while waiting for an answer.'));
    };
    context.abortSignal?.addEventListener('abort', abort, { once: true });
    watch.start(async call => {
      if (call.kind !== 'value') return;
      const value = done(call.value);
      if (value === undefined) return;
      context.abortSignal?.removeEventListener('abort', abort);
      // Settle before stopping: stopping settles `closed`, whose rejection must come too late.
      resolve(value);
      await watch.stop();
    });
    void watch.closed.then(() => reject(new Error('The workers record closed.')));
  });
}

const str = (description: string) => ({ type: 'string', description });

/**
 * The worker task, the orchestrator's tools and the worker's own tools.
 * @param host - The worker conversation's agent.
 * @param abortTask - Aborts a task by ID (the Harness's `abortTask`, available once it is open).
 */
export function createWorkers(host: WorkerHost, abortTask: (taskId: TaskId) => Promise<unknown>) {
  const maxChars = host.maxResultChars ?? 6000;

  // eslint-disable-next-line prefer-const -- referenced by the task before it is assigned
  let workerAgentExtension: Extension;

  const WorkerTask = defineTask<WorkerInput, WorkerCheckpoint, WorkerResult, object>({
    name: WORKER_TASK,
    version: 1,
    initial: () => ({ phase: 'open' }),
    phases: {
      // Create the worker's own conversation, with the worker layer and tools.
      open: async (task, runtime, context) => {
        await runtime.commit(async tx => {
          const child = await tx.createConversation({
            ownership: { kind: 'task', taskId: runtime.taskId },
          });
          await configure(tx, child.id, host.workerAgent(workerAgentExtension));
          const doc = await tx.doc(WorkersDoc, runtime.conversationId);
          const record = doc.tasks[task.input.id];
          if (record) record.child = child.id;
          return { status: 'running', checkpoint: { phase: 'brief', child: child.id } };
        }, context);
      },
      // Give it the brief (once: the request ID) and wait for its answer.
      brief: async (task, runtime, context) => {
        const { child } = task.state.checkpoint;
        const handle = await runtime.conversation(child as ConversationId, context);
        if (!handle) throw new Error(`The worker's conversation ${child} is missing.`);
        const submission = await handle.submit(
          {
            type: 'input',
            content: task.input.brief,
            requestId: `worker:${task.input.id}:brief`,
          },
          context,
        );
        const settled = await submission.wait(context);
        await runtime.commit(async tx => {
          if (settled.status === 'done' && settled.type === 'input') {
            const answer = answerText(await tx.entry(settled.answer));
            return {
              status: 'running',
              checkpoint: { phase: 'report', child, status: 'done', text: answer || '(no text)' },
            };
          }
          const reason = settled.status === 'unanswered' ? settled.reason : 'no answer';
          return {
            status: 'running',
            checkpoint: { phase: 'report', child, status: 'failed', text: reason },
          };
        }, context);
      },
      // Record the outcome and tell the orchestrator, in one commit.
      report: async (task, runtime, context) => {
        const { status, text: outcome } = task.state.checkpoint;
        const parent = await runtime.conversation(runtime.conversationId, context);
        if (!parent) throw new Error('The orchestrator conversation is missing.');
        const { id, title } = task.input;
        await runtime.commit(async tx => {
          const requestId = `report:${id}:done`;
          if (!(await tx.submissionByRequest(runtime.conversationId, requestId))) {
            await parent.submit(tx, {
              type: 'input',
              requestId,
              content:
                status === 'done'
                  ? `[Agent update] ${id} "${title}" finished. Call get_task_result for the answer.`
                  : `[Agent update] ${id} "${title}" failed: ${outcome}`,
            });
          }
          const doc = await tx.doc(WorkersDoc, runtime.conversationId);
          const record = doc.tasks[id];
          if (record) {
            record.status = status;
            if (status === 'done') record.result = outcome;
            else record.error = outcome;
            record.question = null;
            record.askCallId = null;
          }
          return status === 'done'
            ? {
                status: 'terminal',
                outcome: { status: 'completed', result: { status, text: outcome } },
              }
            : { status: 'terminal', outcome: { status: 'failed', error: { message: outcome } } };
        }, context);
      },
    },
    // The child conversation is aborted first (it is owned by this task); then mark it cancelled.
    abort: async (task, runtime, context) => {
      await runtime.commit(async tx => {
        const doc = await tx.doc(WorkersDoc, runtime.conversationId);
        const record = doc.tasks[task.input.id];
        if (record && (record.status === 'running' || record.status === 'waiting')) {
          record.status = 'cancelled';
          record.question = null;
          record.askCallId = null;
        }
        return { status: 'terminal', outcome: { status: 'aborted', reason: 'cancelled' } };
      }, context);
    },
  });

  const snapshot = async (api: ToolExecutionApi, context: Context) =>
    (await api.snapshot(WorkersDoc, api.conversationId, context)) ??
    WorkersDoc.definition.initial();

  const orchestration = defineExtension({
    name: ORCHESTRATION_EXTENSION,
    tasks: [WorkerTask],
    tools: [
      defineTool({
        name: 'delegate_task',
        description:
          'Hand work to a background agent that can use the vault tools. Returns at once with a task id; the agent works in the background and reports back.',
        parameters: {
          type: 'object',
          properties: {
            title: str('Short title, three to six words, to refer to the task by.'),
            instructions: str(
              "Complete, self-contained brief: the goal, the user's own words, relevant notes or names, and what to bring back. The agent cannot hear the conversation.",
            ),
          },
          required: ['title', 'instructions'],
        },
        // A rerun after a restart finds the worker this call already started.
        replay: 'safe',
        execute: async (args, api, context) => {
          const { title, instructions } = args as { title: string; instructions: string };
          const record = await api.commit(async tx => {
            const doc = await tx.doc(WorkersDoc, api.conversationId);
            const existing = Object.values(doc.tasks).find(w => w.callId === api.callId);
            if (existing) return { id: existing.id, title: existing.title };
            const id = `t${doc.next}`;
            doc.next += 1;
            const taskId = await tx.createTask(
              WorkerTask,
              { id, title, brief: instructions },
              {
                ownership: { kind: 'conversation' },
                conversationId: api.conversationId,
                background: true,
              },
            );
            doc.tasks[id] = {
              id,
              title,
              brief: instructions,
              status: 'running',
              taskId,
              callId: api.callId,
              child: null,
              result: null,
              error: null,
              question: null,
              askCallId: null,
              answer: null,
              steps: [],
              createdAt: api.now(),
            };
            return { id, title };
          }, context);
          return text(`Started ${record.id} "${record.title}". Updates will arrive on their own.`);
        },
      }),
      defineTool({
        name: 'check_tasks',
        description: 'Status of background tasks.',
        parameters: {
          type: 'object',
          properties: { id: str('Task id or title. Leave out to list every task.') },
          required: [],
        },
        replay: 'safe',
        executionMode: 'parallel',
        execute: async (args, api, context) => {
          const state = await snapshot(api, context);
          const id = (args as { id?: string }).id;
          const workers = id
            ? [findWorker(state, id)].filter((w): w is WorkerRecord => !!w)
            : Object.values(state.tasks).slice(-12);
          if (!workers.length) return text(id ? `No task matches "${id}".` : 'No tasks yet.');
          return text(workers.map(w => describeWorker(w, api.now())).join('\n'));
        },
      }),
      defineTool({
        name: 'get_task_result',
        description: "A task's final answer, or its error. Summarise it for the user.",
        parameters: {
          type: 'object',
          properties: { id: str('Task id or title.') },
          required: ['id'],
        },
        replay: 'safe',
        executionMode: 'parallel',
        execute: async (args, api, context) => {
          const key = (args as { id: string }).id;
          const worker = findWorker(await snapshot(api, context), key);
          if (!worker) return text(`No task matches "${key}".`);
          if (worker.status !== 'done') return text(describeWorker(worker, api.now()));
          const result = worker.result ?? '(no text)';
          return text(
            result.length > maxChars ? `${result.slice(0, maxChars)}\n…[truncated]` : result,
          );
        },
      }),
      defineTool({
        name: 'message_task',
        description:
          'Send a message to a background task: answer its question, or steer it while it runs.',
        parameters: {
          type: 'object',
          properties: {
            id: str('Task id or title.'),
            message: str('Answer to its question, or a correction while it runs.'),
          },
          required: ['id', 'message'],
        },
        replay: 'safe',
        execute: async (args, api, context) => {
          const { id: key, message } = args as { id: string; message: string };
          const worker = findWorker(await snapshot(api, context), key);
          if (!worker) return text(`No task matches "${key}".`);
          if (worker.status === 'waiting' && worker.askCallId) {
            await api.commit(async tx => {
              const doc = await tx.doc(WorkersDoc, api.conversationId);
              const record = doc.tasks[worker.id];
              if (record?.askCallId === worker.askCallId) record.answer = message;
            }, context);
            return text(`Passed your answer to ${worker.id}.`);
          }
          if (worker.status !== 'running' || !worker.child) {
            return text(
              `${worker.id} is ${worker.status}; it can't take messages. Start a new task with delegate_task for a follow-up.`,
            );
          }
          const child = await api.conversation(worker.child as ConversationId, context);
          if (!child) return text(`${worker.id}'s conversation is missing.`);
          await child.submit(
            {
              type: 'input',
              content: message,
              whenBusy: 'steer',
              requestId: `steer:${api.callId}`,
            },
            context,
          );
          return text(`Sent to ${worker.id}.`);
        },
      }),
      defineTool({
        name: 'cancel_task',
        description: 'Stop a background task.',
        parameters: {
          type: 'object',
          properties: { id: str('Task id or title.') },
          required: ['id'],
        },
        replay: 'safe',
        execute: async (args, api, context) => {
          const key = (args as { id: string }).id;
          const worker = findWorker(await snapshot(api, context), key);
          if (!worker) return text(`No task matches "${key}".`);
          if (worker.status !== 'running' && worker.status !== 'waiting') {
            return text(`${worker.id} is already ${worker.status}.`);
          }
          // Not awaited: the abort runs on the Session line after this call's commit.
          void abortTask(worker.taskId as TaskId).catch(() => undefined);
          return text(`Stopping ${worker.id} "${worker.title}".`);
        },
      }),
    ],
  });

  /** The orchestrator conversation and the worker record of the worker running a tool. */
  async function workerOf(api: ToolExecutionApi, context: Context) {
    const found = await api.commit(async tx => {
      const conversation = await tx.conversation(api.conversationId);
      const owner = conversation?.owner;
      if (!owner) return undefined;
      const doc = await tx.doc(WorkersDoc, owner.conversationId);
      const record = Object.values(doc.tasks).find(w => w.taskId === owner.taskId);
      return record
        ? { parent: owner.conversationId, id: record.id, title: record.title }
        : undefined;
    }, context);
    if (!found) throw new Error('This conversation is not a background task.');
    return found;
  }

  workerAgentExtension = defineExtension({
    name: WORKER_AGENT_EXTENSION,
    tools: [
      defineTool({
        name: 'ask_orchestrator',
        description:
          'Ask the person you work for a question and wait for the answer. Use it only when a wrong guess would waste the task or change something they care about.',
        parameters: {
          type: 'object',
          properties: {
            question: str(
              'One clear question, with the options you see and the one you would pick.',
            ),
          },
          required: ['question'],
        },
        // A rerun after a restart finds the question already asked and waits for its answer.
        replay: 'safe',
        execute: async (args, api, context) => {
          const question = (args as { question: string }).question;
          const worker = await workerOf(api, context);
          const parent = await api.conversation(worker.parent, context);
          if (!parent) throw new Error('The orchestrator conversation is missing.');
          await api.commit(async tx => {
            const requestId = `ask:${worker.id}:${api.callId}`;
            if (!(await tx.submissionByRequest(worker.parent, requestId))) {
              await parent.submit(tx, {
                type: 'input',
                requestId,
                content: `[Agent update] ${worker.id} "${worker.title}" needs advice: ${question} Answer with message_task.`,
              });
            }
            const record = (await tx.doc(WorkersDoc, worker.parent)).tasks[worker.id];
            if (record && record.askCallId !== api.callId) {
              record.status = 'waiting';
              record.question = question;
              record.askCallId = api.callId;
              record.answer = null;
            }
          }, context);
          const answer = await waitForDoc(
            api,
            worker.parent,
            state => {
              const record = state.tasks[worker.id];
              if (!record || record.status === 'cancelled') return null;
              return record.askCallId === api.callId && record.answer !== null
                ? record.answer
                : undefined;
            },
            context,
          );
          await api.commit(async tx => {
            const record = (await tx.doc(WorkersDoc, worker.parent)).tasks[worker.id];
            if (record?.askCallId === api.callId) {
              record.status = 'running';
              record.question = null;
              record.askCallId = null;
              record.answer = null;
            }
          }, context);
          return answer === null
            ? { ...text('Error: Cancelled: the task was stopped.'), isError: true }
            : text(answer);
        },
      }),
      defineTool({
        name: 'report_progress',
        description: 'Post a one-sentence progress note for the person you work for.',
        parameters: {
          type: 'object',
          properties: { note: str('One sentence on what you have done or found.') },
          required: ['note'],
        },
        replay: 'safe',
        execute: async (args, api, context) => {
          const note = (args as { note: string }).note;
          const worker = await workerOf(api, context);
          await api.commit(async tx => {
            const record = (await tx.doc(WorkersDoc, worker.parent)).tasks[worker.id];
            if (!record) return;
            record.steps.push(note);
            if (record.steps.length > MAX_STEPS)
              record.steps.splice(0, record.steps.length - MAX_STEPS);
          }, context);
          return text('Noted.');
        },
      }),
    ],
  });

  return { WorkerTask, orchestration, workerAgent: workerAgentExtension };
}
