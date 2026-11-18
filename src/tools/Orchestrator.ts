import { defineToolParameters, InferArgs, Tool } from '../tools';
import type { SubAgentTask } from '../agents/types';
import { MEMORY_TOOL_NAMES } from './Memory';
import { layerProblem, resolveLayer } from '../agents/layers';

export { MEMORY_TOOL_NAMES };

/** Names of tools only an orchestrator gets. */
export const ORCHESTRATOR_TOOL_NAMES = [
  'new_topic',
  'delegate_task',
  'check_tasks',
  'get_task_result',
  'message_task',
  'cancel_task',
  'set_progress_updates',
];

/** Tools of the voice layer in the layered setup. */
export const VOICE_LAYER_TOOL_NAMES = [
  'new_topic',
  'relay_to_orchestrator',
  'orchestrator_activity',
  'check_tasks',
  'cancel_task',
  'set_progress_updates',
  ...MEMORY_TOOL_NAMES,
];

/** Tools only the layered orchestrator agent gets. */
export const ORCHESTRATOR_AGENT_TOOL_NAMES = [
  'tell_user',
  'read_task_thread',
  'request_evaluation',
];

/** Names of tools only a sub-agent gets. */
export const SUBAGENT_TOOL_NAMES = ['ask_orchestrator', 'report_progress'];

/** Instructions added to a voice model working as orchestrator. */
export const ORCHESTRATOR_GUIDANCE = [
  "You are the voice of the user's assistant in their Obsidian vault, and the interface between them and background agents. You do not research, read notes, search, plan or edit anything yourself.",
  "Small talk and questions about what was already said: answer at once, in a sentence or two. Anything that needs the vault, tools, the web or real thinking: call delegate_task straight away with a short title and a complete, self-contained brief in the user's own words (the agent cannot hear the conversation; include note names, folders and what to bring back), then say in a few words that it is under way. Do not guess the answer while it runs.",
  "Several independent jobs can run at once. When asked how things are going, call check_tasks and answer in a line per task. Use get_task_result to hear a finished result, message_task to answer an agent's question or steer it, and cancel_task when the user says stop or cancel.",
  'Updates arrive as messages marked [Agent update]; they come from your agents, not the user. Relay a result in one or two plain sentences and offer more. When an agent needs advice, ask the user one clear question unless the answer is already clear, then pass it on with message_task. When a task looks stuck or a check-in shows it drifting, steer or cancel it, and tell the user only if they need to decide.',
  'Timing: if an update is marked as bearing on what the user is saying, cut in briefly. Otherwise let them finish their thought, acknowledge it, then mention the update at a natural opening ("by the way, the search finished...") and, if there is an obvious next step, ask whether to do it. On yes, send it off with delegate_task or message_task and carry on with the conversation.',
  'Stay quiet between updates unless the user asks. If they say "keep me posted" or ask for updates every so often, call set_progress_updates; "stop the updates" sets it to 0.',
  'If you did not catch what the user said (noise, a cut-off sentence, or something that does not fit the conversation), say so and ask them to repeat it. Never act on a guess. If the user says you missed something, ask for it rather than inventing it.',
  'Ask one question at a time. Never read out markdown, code, links, file paths or long lists. If asked what you can do: you can hand any job in their vault, the web or connected tools to background agents, check on them, and relay what they find.',
].join('\n');

/**
 * Instructions for the voice layer of the layered setup: a fast translator and filter between the
 * user and the orchestrator agent, with light reasoning of its own.
 */
export const VOICE_LAYER_GUIDANCE = [
  "You are the voice of the user's assistant in their Obsidian vault. Behind you is an orchestrator agent that plans and runs background workers. You translate and filter: you keep the conversation natural and pass on what matters.",
  'Answer small talk, acknowledgements and questions about what was already said yourself, in a sentence or two. Anything that needs the vault, tools, the web, planning or real thinking, and every answer to a question the orchestrator asked: call relay_to_orchestrator with a self-contained request in the user’s own words (resolve "that" and "it"; drop filler and false starts), then say in a few words that you are on it. Do not guess the answer.',
  'Quiet [Orchestrator activity] notes list the tools the orchestrator used and the tasks it started; use them to answer "what are you doing?" (orchestrator_activity lists them on demand), but do not read them out unasked.',
  'Messages marked [Orchestrator] come from the orchestrator, not the user. Say them naturally and briefly in your own words. If one is marked as bearing on what the user is saying, cut in briefly; otherwise let them finish the thought, acknowledge it, then bring it up at a natural opening and ask about any next step it offers.',
  'Corrections and changes of mind ("no, the other folder", "actually stop") go to the orchestrator straight away; use cancel_task only when the user plainly wants a task stopped. check_tasks gives a one-line status per task when asked how things are going. If the user asks to be kept posted, call set_progress_updates; "stop the updates" sets it to 0.',
  'If you did not catch what the user said, say so and ask them to repeat it. Never act on a guess. Ask one question at a time. Never read out markdown, code, links, file paths or long lists.',
].join('\n');

/** Short one-line state of a task for voice. */
export function describeTask(task: SubAgentTask): string {
  const age = Math.round((Date.now() - (task.startedAt ?? task.createdAt)) / 1000);
  const lastStep = task.steps.length ? task.steps[task.steps.length - 1].text.slice(0, 160) : '';
  switch (task.status) {
    case 'waiting':
      return `${task.id} "${task.title}": waiting for advice: ${task.question ?? ''}`;
    case 'done':
      return `${task.id} "${task.title}": finished. Call get_task_result for the answer.`;
    case 'failed':
      return `${task.id} "${task.title}": failed: ${task.error ?? 'unknown error'}`;
    case 'cancelled':
      return `${task.id} "${task.title}": cancelled.`;
    case 'queued':
      return `${task.id} "${task.title}": queued.`;
    default:
      return `${task.id} "${task.title}": running for ${age}s, ${task.steps.length} steps${lastStep ? `, last: ${lastStep}` : ''}.`;
  }
}

abstract class OrchestratorTool<T> extends Tool<T> {
  readonly classification = 'System';
  readonly agentCore = true;
  /** Chat roles that get this tool. */
  protected roles: string[] = ['orchestrator', 'orchestrator-agent'];
  isAvailable(): boolean {
    return this.roles.includes(this.chat.role) && !!this.chat.plugin.agents;
  }
  protected get agents() {
    return this.chat.plugin.agents;
  }
  protected find(id: string): SubAgentTask | undefined {
    return this.agents.find(id);
  }
  /** The tasks the voice sees: the engine in use, which may be the durable one. */
  protected get voiceTasks() {
    return this.chat.role === 'voice' ? this.chat.plugin.taskList : this.agents;
  }
  /** The voice is talking to the durable engine's tasks. */
  protected get durableTasks(): boolean {
    return this.voiceTasks !== this.agents;
  }
}

const delegateParams = defineToolParameters({
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short title, three to six words, to refer to the task by.',
    },
    instructions: {
      type: 'string',
      description:
        "Complete, self-contained brief: the goal, the user's own words, relevant notes or names, and what to bring back. The agent cannot hear the conversation.",
    },
  },
  required: ['title', 'instructions'],
} as const);

/** Starts a background sub-agent. */
export class DelegateTaskTool extends OrchestratorTool<InferArgs<typeof delegateParams>> {
  readonly name = 'delegate_task';
  readonly description =
    'Hand work to a background agent that can use every vault tool, skill, MCP server and code mode. Returns at once with a task id; the agent works in the background and reports back.';
  readonly parameters = delegateParams;
  async execute(args: InferArgs<typeof delegateParams>): Promise<string> {
    // Check the worker model before starting, so a missing key is said at once rather than
    // showing up later as a failed task nobody hears about.
    const worker = resolveLayer(this.chat.plugin, 'worker');
    const problem = layerProblem(this.chat.plugin, worker);
    if (problem)
      return `Could not start "${args.title}": background agents can't run yet. ${problem} Tell the user this plainly.`;
    const task = this.agents.spawn(args.title, args.instructions, 'voice');
    if (worker.fallback)
      return `Started ${task.id} "${task.title}" (${task.status}) on ${worker.label}, because the worker model can't run: ${worker.fallback} Updates will arrive on their own.`;
    return `Started ${task.id} "${task.title}" (${task.status}). Updates will arrive on their own.`;
  }
}

const checkParams = defineToolParameters({
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Task id or title. Leave out to list every task.' },
  },
  required: [],
} as const);

/** Status of one or all tasks, plus updates waiting to be read. */
export class CheckTasksTool extends OrchestratorTool<InferArgs<typeof checkParams>> {
  readonly name = 'check_tasks';
  readonly description =
    'Status of background tasks, and any updates that were held for the next check.';
  readonly parameters = checkParams;
  protected roles = ['orchestrator', 'orchestrator-agent', 'voice'];
  async execute(args: InferArgs<typeof checkParams>): Promise<string> {
    const source = this.voiceTasks;
    const updates = this.durableTasks ? [] : this.agents.takeQueuedUpdates();
    const tasks = args.id ? [source.find(args.id)].filter(Boolean) : source.list().slice(0, 12);
    if (!tasks.length) return args.id ? `No task matches "${args.id}".` : 'No tasks yet.';
    const lines = (tasks as SubAgentTask[]).map(describeTask);
    if (updates.length)
      lines.push(
        'Held updates:',
        ...updates.map(u => `- ${u.title} ${u.kind}: ${u.text.slice(0, 300)}`),
      );
    return lines.join('\n');
  }
}

const idParams = defineToolParameters({
  type: 'object',
  properties: { id: { type: 'string', description: 'Task id or title.' } },
  required: ['id'],
} as const);

/** Result of a finished task. */
export class GetTaskResultTool extends OrchestratorTool<InferArgs<typeof idParams>> {
  readonly name = 'get_task_result';
  readonly description = "A task's final answer, or its error. Summarise it for the user.";
  readonly parameters = idParams;
  async execute(args: InferArgs<typeof idParams>): Promise<string> {
    const task = this.find(args.id);
    if (!task) return `No task matches "${args.id}".`;
    if (task.status === 'done') {
      const max = this.chat.plugin.settings.voice.maxToolOutputChars || 6000;
      const result = task.result ?? '(no text)';
      return result.length > max ? `${result.slice(0, max)}\n…[truncated]` : result;
    }
    return describeTask(task);
  }
}

const messageParams = defineToolParameters({
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Task id or title.' },
    message: {
      type: 'string',
      description:
        'Answer to its question, a correction, or a follow-up request (a finished task continues with it).',
    },
  },
  required: ['id', 'message'],
} as const);

/** Answers, steers or continues a task. */
export class MessageTaskTool extends OrchestratorTool<InferArgs<typeof messageParams>> {
  readonly name = 'message_task';
  readonly description =
    'Send a message to a background task: answer its question, steer it while it runs, or give a finished task a follow-up.';
  readonly parameters = messageParams;
  async execute(args: InferArgs<typeof messageParams>): Promise<string> {
    const task = this.find(args.id);
    if (!task) return `No task matches "${args.id}".`;
    return this.agents.message(task.id, args.message);
  }
}

/** Cancels a task. */
export class CancelTaskTool extends OrchestratorTool<InferArgs<typeof idParams>> {
  readonly name = 'cancel_task';
  readonly description = 'Stop a background task.';
  readonly parameters = idParams;
  protected roles = ['orchestrator', 'orchestrator-agent', 'voice'];
  async execute(args: InferArgs<typeof idParams>): Promise<string> {
    const source = this.voiceTasks;
    const task = source.find(args.id);
    if (!task) return `No task matches "${args.id}".`;
    return source.cancel(task.id);
  }
}

const updatesParams = defineToolParameters({
  type: 'object',
  properties: {
    interval_seconds: {
      type: 'integer',
      description: 'Seconds between spoken progress updates while tasks run. 0 turns them off.',
    },
  },
  required: ['interval_seconds'],
} as const);

/** Turns periodic progress updates on or off, as the user asks. */
export class SetProgressUpdatesTool extends OrchestratorTool<InferArgs<typeof updatesParams>> {
  readonly name = 'set_progress_updates';
  readonly description =
    'Turn spoken progress updates on ("keep me posted", every 30 seconds unless the user says otherwise) or off (0).';
  readonly parameters = updatesParams;
  protected roles = ['orchestrator', 'orchestrator-agent', 'voice'];
  async execute(args: InferArgs<typeof updatesParams>): Promise<string> {
    if (this.durableTasks)
      return 'Timed progress updates are not available on the durable engine yet; the orchestrator tells the user when a task finishes or needs them. Say so.';
    const seconds = this.agents.setProgressInterval(args.interval_seconds);
    return seconds ? `Progress updates every ${seconds} seconds.` : 'Progress updates are off.';
  }
}

abstract class SubAgentTool<T> extends Tool<T> {
  readonly classification = 'System';
  readonly agentCore = true;
  isAvailable(): boolean {
    return this.chat.role === 'subagent' && !!this.chat.subAgentTaskId && !!this.chat.plugin.agents;
  }
}

const askParams = defineToolParameters({
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'One clear question, with the options you see and the one you would pick.',
    },
  },
  required: ['question'],
} as const);

/** A sub-agent asks the orchestrator (and through it, the user) and waits for the answer. */
export class AskOrchestratorTool extends SubAgentTool<InferArgs<typeof askParams>> {
  readonly name = 'ask_orchestrator';
  readonly description =
    'Ask the person you work for a question and wait for the answer. Use it only when a wrong guess would waste the task or change something they care about.';
  readonly parameters = askParams;
  async execute(args: InferArgs<typeof askParams>): Promise<string> {
    return this.chat.plugin.agents.ask(this.chat.subAgentTaskId as string, args.question);
  }
}

const reportParams = defineToolParameters({
  type: 'object',
  properties: {
    note: { type: 'string', description: 'One sentence on what you have done or found.' },
  },
  required: ['note'],
} as const);

/** A sub-agent posts a progress note. */
export class ReportProgressTool extends SubAgentTool<InferArgs<typeof reportParams>> {
  readonly name = 'report_progress';
  readonly description = 'Post a one-sentence progress note for the person you work for.';
  readonly parameters = reportParams;
  async execute(args: InferArgs<typeof reportParams>): Promise<string> {
    this.chat.plugin.agents.report(this.chat.subAgentTaskId as string, args.note);
    return 'Noted.';
  }
}

/** Every orchestrator and sub-agent tool class. */
export const AGENT_TOOLS = [
  DelegateTaskTool,
  CheckTasksTool,
  GetTaskResultTool,
  MessageTaskTool,
  CancelTaskTool,
  SetProgressUpdatesTool,
  AskOrchestratorTool,
  ReportProgressTool,
];
