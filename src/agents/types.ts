import type { ChatRequestOptions, ChatResponse, ToolCall } from '../types';

/**
 * Background sub-agents run by an orchestrator (a voice model, or any chat with the orchestrator
 * role). The orchestrator only talks with the user, writes briefs and relays results; sub-agents do
 * the research, navigation, execution, planning and review with every enabled tool, skill and code
 * mode.
 *
 * The event and hook shapes are kept close to Pi Durable's (`beforeTool`, `afterTool`,
 * `afterResponse`, `onYield`; https://earendil.com/posts/pi-durable/) so a Pi Durable backend can
 * replace the local runner later without changing the orchestrator tools or the voice layer.
 */

export type SubAgentStatus =
  | 'queued'
  | 'running'
  | 'waiting' // waiting for the orchestrator's advice
  | 'done'
  | 'failed'
  | 'cancelled';

/** Lifecycle events a sub-agent reports to its orchestrator. */
export type SubAgentEventKind =
  | 'started'
  | 'progress' // a step finished or the agent reported progress
  | 'needs_advice' // the agent asked the orchestrator a question and is waiting
  | 'stuck' // deterministic checks think the agent is looping or failing repeatedly
  | 'checkpoint' // timed review: the orchestrator should check the direction
  | 'finished'
  | 'failed'
  | 'cancelled';

export const SUB_AGENT_EVENT_KINDS: SubAgentEventKind[] = [
  'started',
  'progress',
  'needs_advice',
  'stuck',
  'checkpoint',
  'finished',
  'failed',
  'cancelled',
];

export interface SubAgentEvent {
  kind: SubAgentEventKind;
  taskId: string;
  title: string;
  at: number;
  /** Short text for the orchestrator (a question, a result summary, a reason). */
  text: string;
}

/**
 * How an event reaches the voice orchestrator.
 * - `auto`: follow GPT-Live's documented hand-off pattern (see `AUTO_ROUTES`).
 * - `interrupt`: cut in now, even mid-sentence (GPT-Live `session.instructions.append`).
 * - `pause`: spoken at the next pause (GPT-Live `session.commentary.append`).
 * - `silent`: the model is told quietly and uses it when relevant (GPT-Live
 *   `session.thinking.append`). Providers without a quiet channel hold it for `check_tasks`.
 * - `queue`: held until the orchestrator calls `check_tasks`.
 * - `ignore`: logged only.
 */
export type SubAgentEventRoute = 'auto' | 'interrupt' | 'pause' | 'silent' | 'queue' | 'ignore';

/** A route after `auto` is resolved. */
export type ResolvedRoute = Exclude<SubAgentEventRoute, 'auto'>;

/** How a delivered update should be spoken. */
export type NoticeMode = 'interrupt' | 'pause' | 'silent';

/**
 * The `auto` routes, modelled on GPT-Live: results and questions are spoken at a pause like
 * commentary, a timed check-in is quiet context the model acts on without speaking (like
 * thinking), stuck tasks are spoken at a pause, routine progress stays quiet.
 */
export const AUTO_ROUTES: Record<SubAgentEventKind, ResolvedRoute> = {
  started: 'silent',
  progress: 'silent',
  needs_advice: 'pause',
  stuck: 'pause',
  checkpoint: 'silent',
  finished: 'pause',
  failed: 'pause',
  cancelled: 'silent',
};

export interface SubAgentStep {
  at: number;
  kind: 'response' | 'tool' | 'message' | 'advice' | 'note';
  text: string;
}

export interface SubAgentTask {
  id: string;
  title: string;
  /** The orchestrator's brief. */
  prompt: string;
  status: SubAgentStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Model the task runs on. */
  model: string;
  steps: SubAgentStep[];
  /** Full conversation, kept so follow-ups continue where the task stopped. */
  messages: ChatRequestOptions['messages'];
  result?: string;
  error?: string;
  /** Pending question while status is `waiting`. */
  question?: string;
  /** Vault path of the task's transcript note, when saved. */
  notePath?: string;
  /** Who started it (for example "voice" or "chat"). */
  origin: string;
}

/** Context handed to hooks. */
export interface SubAgentHookContext {
  task: Readonly<SubAgentTask>;
  step: number;
}

/**
 * Programmatic, deterministic hooks around a sub-agent's run. Return values let a hook steer
 * the run; hooks run in registration order and the first decisive answer wins.
 */
export interface SubAgentHooks {
  /** Before a tool runs. Return `{ block: reason }` to skip it; the model sees the reason. */
  beforeTool?(
    ctx: SubAgentHookContext,
    call: ToolCall,
  ): { block?: string } | void | Promise<{ block?: string } | void>;
  /** After a tool runs. Return a string to replace the output the model sees. */
  afterTool?(
    ctx: SubAgentHookContext,
    call: ToolCall,
    output: string,
  ): string | void | Promise<string | void>;
  /** After each model response. */
  afterResponse?(ctx: SubAgentHookContext, response: ChatResponse): void | Promise<void>;
  /**
   * When the agent stops with a final answer. Return `{ continueWith: message }` to keep it
   * going with one more user message (for example a review checklist).
   */
  onYield?(
    ctx: SubAgentHookContext,
    finalText: string,
  ): { continueWith?: string } | void | Promise<{ continueWith?: string } | void>;
  /** Every lifecycle event, after routing. */
  onEvent?(event: SubAgentEvent): void;
}

/** What a backend needs from the manager while it runs one task. */
export interface SubAgentRunContext {
  hooks: SubAgentHooks[];
  emit(kind: SubAgentEventKind, text: string): void;
  log(step: Omit<SubAgentStep, 'at'>): void;
  isCancelled(): boolean;
  /** Messages the orchestrator sent since the last call. */
  drainInbox(): string[];
  /** Asks the orchestrator and waits for its answer (or a timeout message). */
  askOrchestrator(question: string): Promise<string>;
}

/** Runs sub-agent tasks. The local backend runs them in Obsidian; Pi Durable can plug in here. */
export interface SubAgentBackend {
  readonly id: string;
  /** Runs (or continues) the task until it finishes; returns the final answer. */
  run(task: SubAgentTask, ctx: SubAgentRunContext): Promise<string>;
}
