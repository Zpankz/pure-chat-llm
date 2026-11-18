import { layerFetch, layerProblem, resolveLayer } from '../agents/layers';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import type { NoticeMode } from '../agents/types';

/**
 * Tools that connect the layers of the layered setup:
 * - the voice layer passes requests to the orchestrator agent (`relay_to_orchestrator`);
 * - the orchestrator agent speaks through the voice layer (`tell_user`), looks into a worker's
 *   thread only when it needs to (`read_task_thread`), and can ask the optional evaluator
 *   (`request_evaluation`).
 */
abstract class LayerTool<T> extends Tool<T> {
  readonly classification = 'System';
  readonly agentCore = true;
  protected abstract role: string;
  isAvailable(): boolean {
    return this.chat.role === this.role && !!this.chat.plugin.orchestrator;
  }
}

const relayParams = defineToolParameters({
  type: 'object',
  properties: {
    request: {
      type: 'string',
      description:
        "What the user wants, in their own words, made self-contained (resolve 'that' and 'it' from the conversation).",
    },
    urgency: {
      type: 'string',
      description:
        '`now` when the user is waiting for the answer, `background` when they will carry on talking.',
      enum: ['now', 'background'],
    },
  },
  required: ['request'],
} as const);

/** Voice layer: hands a request to the orchestrator agent. */
export class RelayToOrchestratorTool extends LayerTool<InferArgs<typeof relayParams>> {
  readonly name = 'relay_to_orchestrator';
  protected role = 'voice';
  readonly description =
    'Pass a request, correction, answer or follow-up to the orchestrator, which plans and runs background agents. Returns at once; the orchestrator replies later with what to say.';
  readonly parameters = relayParams;
  execute(args: InferArgs<typeof relayParams>): Promise<string> {
    return Promise.resolve(
      this.chat.plugin.orchestrator.relay(args.request, args.urgency === 'now'),
    );
  }
}

const activityParams = defineToolParameters({
  type: 'object',
  properties: {
    limit: { type: 'integer', description: 'How many recent entries (default 15).' },
  },
  required: [],
} as const);

/** Voice layer: lists what the orchestrator did (tools used, tasks started), not the outputs. */
export class OrchestratorActivityTool extends LayerTool<InferArgs<typeof activityParams>> {
  readonly name = 'orchestrator_activity';
  protected role = 'voice';
  readonly description =
    'What the orchestrator has been doing: the tools it called and the background tasks it started, newest last.';
  readonly parameters = activityParams;
  execute(args: InferArgs<typeof activityParams>): Promise<string> {
    const o = this.chat.plugin.orchestrator;
    const lines = o.recentActivity(Math.min(50, Math.max(1, args.limit ?? 15)));
    const state = o.state === 'thinking' ? 'The orchestrator is working on something now.' : '';
    return Promise.resolve(
      [state, ...(lines.length ? lines : ['Nothing yet.'])].filter(Boolean).join('\n'),
    );
  }
}

const tellParams = defineToolParameters({
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        'What the voice should tell the user, in one to three short spoken sentences. No markdown, links or paths.',
    },
    urgency: {
      type: 'string',
      description:
        '`interrupt`: cut in now (only when it overrules or changes what the user is doing). `pause`: say it at the next pause (default). `silent`: background for the voice to use when relevant.',
      enum: ['interrupt', 'pause', 'silent'],
    },
  },
  required: ['message'],
} as const);

/** Orchestrator agent: speaks to the user through the voice layer. */
export class TellUserTool extends LayerTool<InferArgs<typeof tellParams>> {
  readonly name = 'tell_user';
  protected role = 'orchestrator-agent';
  readonly description =
    'Say something to the user through the voice. This is the only way your words reach the user.';
  readonly parameters = tellParams;
  execute(args: InferArgs<typeof tellParams>): Promise<string> {
    const urgency = (['interrupt', 'pause', 'silent'] as const).includes(args.urgency as NoticeMode)
      ? (args.urgency as NoticeMode)
      : 'pause';
    return Promise.resolve(this.chat.plugin.orchestrator.say(args.message, urgency));
  }
}

const threadParams = defineToolParameters({
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Task id or title.' },
    last_steps: {
      type: 'integer',
      description: 'How many of the latest steps to include (default 15, up to 100).',
    },
    include_conversation: {
      type: 'boolean',
      description:
        "Also include the worker's last messages (model replies and tool outputs), clipped. Default false.",
    },
  },
  required: ['id'],
} as const);

/** Orchestrator agent: reads a worker's thread on demand (threads are not preloaded). */
export class ReadTaskThreadTool extends LayerTool<InferArgs<typeof threadParams>> {
  readonly name = 'read_task_thread';
  protected role = 'orchestrator-agent';
  readonly description =
    "Look into a background task's thread: its brief, latest steps and result. Workers' threads are not in your context until you read them.";
  readonly parameters = threadParams;
  execute(args: InferArgs<typeof threadParams>): Promise<string> {
    const task = this.chat.plugin.agents.find(args.id);
    if (!task) return Promise.resolve(`No task matches "${args.id}".`);
    const n = Math.min(100, Math.max(1, args.last_steps ?? 15));
    const lines = [
      `${task.id} "${task.title}" (${task.status}, model ${task.model}, ${task.steps.length} steps)`,
      '',
      'Brief:',
      task.prompt.slice(0, 4000),
      '',
      `Latest ${Math.min(n, task.steps.length)} steps:`,
      ...task.steps.slice(-n).map(s => `- ${s.kind}: ${s.text.replace(/\s+/g, ' ').slice(0, 400)}`),
    ];
    if (task.question) lines.push('', `Waiting on: ${task.question}`);
    if (args.include_conversation) {
      lines.push('', 'Last messages:');
      for (const m of task.messages.slice(-8)) {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        lines.push(`[${m.role}] ${text.slice(0, 1200)}`);
      }
    }
    if (task.result) lines.push('', 'Result:', task.result.slice(0, 8000));
    if (task.error) lines.push('', `Error: ${task.error}`);
    return Promise.resolve(lines.join('\n'));
  }
}

const EVALUATOR_PROMPT =
  'You are an independent evaluator. You see a plan, brief or result and the question asked about it, nothing else. Check it for errors, gaps, unsupported claims and whether it answers what was asked. Answer with a first line of PASS, REVISE or FAIL, then up to five short points, most important first.';

const evalParams = defineToolParameters({
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'What to check, for example "Does this result answer the brief?"',
    },
    material: {
      type: 'string',
      description:
        'Everything the evaluator needs, self-contained: the brief, plan or result, and any criteria.',
    },
  },
  required: ['question', 'material'],
} as const);

/** Orchestrator agent: asks the optional evaluator layer. */
export class RequestEvaluationTool extends LayerTool<InferArgs<typeof evalParams>> {
  readonly name = 'request_evaluation';
  protected role = 'orchestrator-agent';
  readonly description =
    'Ask the independent evaluator model to check a plan, brief or result before you act on it or tell the user. It sees only what you send.';
  readonly parameters = evalParams;
  isAvailable(): boolean {
    return super.isAvailable() && !!this.chat.plugin.settings.orchestrator.layers.evaluator.enabled;
  }
  async execute(args: InferArgs<typeof evalParams>): Promise<string> {
    const plugin = this.chat.plugin;
    const layer = resolveLayer(plugin, 'evaluator');
    const problem = layerProblem(plugin, layer);
    if (problem) return `Evaluator unavailable: ${problem}`;
    const response = await layerFetch(plugin, layer, {
      max_completion_tokens: 1200,
      messages: [
        { role: 'system', content: EVALUATOR_PROMPT },
        {
          role: 'user',
          content: `Question: ${args.question}\n\nMaterial:\n${args.material.slice(0, 30000)}`,
        },
      ],
    });
    return `Evaluator (${layer.label}):\n${(response.content ?? '').trim() || '(no answer)'}`;
  }
}

export const LAYER_TOOLS = [
  RelayToOrchestratorTool,
  OrchestratorActivityTool,
  TellUserTool,
  ReadTaskThreadTool,
  RequestEvaluationTool,
];
