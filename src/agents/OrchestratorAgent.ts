import { PureChatLLMChat } from '../core/Chat';
import type PureChatLLM from '../main';
import { ORCHESTRATOR_AGENT_TOOL_NAMES, ORCHESTRATOR_TOOL_NAMES } from '../tools/Orchestrator';
import type { ChatRequestOptions, ToolCall } from '../types';
import { isAbortError } from '../core/requestControl';
import { layerFetch, layerProblem, logTiming, resolveLayer } from './layers';
import type { NoticeMode, SubAgentEvent } from './types';

/**
 * The orchestrator layer: an asynchronous reasoning agent between the voice layer and the
 * workers.
 *
 * Context boundaries (Hani's design):
 * - The orchestrator has the voice conversation in full: each relay carries the transcript lines
 *   it has not seen yet, so nothing is sent twice.
 * - From workers it gets a high-level summary of each event; a worker's full thread is read only
 *   when the orchestrator chooses to, with `read_task_thread`.
 * - The voice layer gets a high-level overview of the orchestrator: what `tell_user` says, and
 *   quietly, which tools it used and which tasks it started, never their outputs.
 * - Each worker starts from its brief alone.
 *
 * Inputs are queued and handled one turn at a time, so a burst of events never runs two turns
 * at once. Routine events (started, progress, cancelled) are kept as notes for the next turn
 * instead of starting one.
 */
export const ORCHESTRATOR_AGENT_GUIDANCE = [
  "You are the orchestrator behind a voice assistant in the user's Obsidian vault. The voice model talks with the user and relays requests to you; you plan, write briefs, run background workers and decide what the user hears. Only tell_user reaches the user; your other text is private.",
  'For each request: if you can answer from what you already know or with a quick read-only look (read_file, search_vault, traverse_graph, vault_ontology, or a short codemode script), do it and tell_user the answer. Anything longer, any change to the vault, web or MCP work, or several independent parts: delegate_task with a short title and a complete, self-contained brief (goal, the user’s words, note names, folders, typed relations to follow, what to bring back). Workers cannot see this conversation. Then tell_user in a few words that it is under way.',
  'Task events arrive as [Task ...] messages. On a result: check it answers the brief (read_task_thread when you need detail; request_evaluation when the evaluator is on and the result matters), then tell_user one or two plain sentences and offer the obvious next step. On needs_advice: answer with message_task if the answer is clear from what the user said, otherwise ask the user one question with tell_user and pass the answer on when it is relayed. On stuck or a drifting check-in: steer or cancel with message_task or cancel_task; tell the user only if they need to decide.',
  'Timing: use urgency interrupt only when the news overrules or changes what the user is doing or saying; otherwise pause, and silent for background the voice may use if it comes up. Keep the user’s attention for what matters: do not narrate routine progress.',
  'You never write to the vault yourself; workers do, under the vault write rules. If a relayed request is unclear, ask through tell_user rather than guess.',
].join('\n');

/** Read-only tools the orchestrator may use itself (directly or from code mode). */
const ORCHESTRATOR_READ_TOOLS = [
  'codemode',
  'read_file',
  'read_note_section',
  'search_vault',
  'glob_vault_files',
  'list_vault_folders',
  'get_backlinks',
  'traverse_graph',
  'vault_ontology',
  'smart_connections_rag',
  'activate_skill',
  'read_skill_file',
];

/** Kinds that only become notes for the next turn. */
const NOTE_ONLY = new Set(['started', 'progress', 'cancelled', 'checkpoint']);

/** `answersUser`: this is the first answer to something the user asked, which they are waiting for. */
type SayListener = (text: string, urgency: NoticeMode, answersUser: boolean) => void;

interface Input {
  text: string;
  fromUser: boolean;
  /** The user is waiting for this answer (fast path: low effort, no extra hop). */
  waiting?: boolean;
  /** When the relay arrived, for the time-to-answer log. */
  at?: number;
}

/** Longest one orchestrator turn may take in all before it is stopped (system review A1). */
export const TURN_TIMEOUT_MS = 90_000;
/** Model steps in a turn started by a user relay, and by a worker event (system review A2). */
const USER_TURN_STEPS = 12;
const EVENT_TURN_STEPS = 3;

export class OrchestratorAgent {
  private messages: ChatRequestOptions['messages'] = [];
  private inputs: Input[] = [];
  private notes: string[] = [];
  private undelivered: { text: string; urgency: NoticeMode }[] = [];
  private listeners = new Set<SayListener>();
  private changeListeners = new Set<() => void>();
  private running = false;
  private spokeThisTurn = false;
  private transcriptSource: (() => string[]) | null = null;
  private transcriptSent = 0;
  private stopHooks: () => void;
  /** Short state for the voice view. */
  state: 'idle' | 'thinking' = 'idle';
  lastError = '';
  /**
   * What the orchestrator did: each tool it called and each task it started, newest last. The
   * voice layer can see this feed (Hani: the voice should see the orchestrator's tools and the
   * threads it started), but not the tool outputs or the threads' contents.
   */
  readonly activity: { at: number; text: string }[] = [];
  private turnActivity: string[] = [];
  /** Cancels the turn in progress. */
  private turnAbort: AbortController | null = null;
  /** When the oldest unanswered relay arrived. */
  private relayAt: number | null = null;

  /** @param plugin - Plugin. */
  constructor(private plugin: PureChatLLM) {
    this.stopHooks = plugin.agents.registerHooks({ onEvent: e => this.onTaskEvent(e) });
  }

  /** Whether the layered setup is on. */
  get active(): boolean {
    return this.plugin.settings.orchestrator.voiceRole === 'layered';
  }

  /** Label of the orchestrator model. */
  get label(): string {
    return resolveLayer(this.plugin, 'orchestrator').label;
  }

  /**
   * Hears what the orchestrator wants said. Messages said while nobody listened are delivered
   * to the first listener. Returns an unsubscribe function.
   * @param listener - Receives text and urgency.
   */
  onSay(listener: SayListener): () => void {
    this.listeners.add(listener);
    const pending = this.undelivered.splice(0);
    for (const p of pending) listener(p.text, p.urgency, false);
    return () => this.listeners.delete(listener);
  }

  /** @param listener - Called when the state changes. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Where relayed requests get their recent transcript lines (set by the voice view).
   * @param source - Returns recent lines, oldest first.
   */
  setTranscriptSource(source: (() => string[]) | null): void {
    this.transcriptSource = source;
    this.transcriptSent = 0;
  }

  /**
   * Voice layer: a request from the user. Returns at once with an acknowledgement.
   * @param request - Self-contained request.
   * @param waiting - The user is waiting for the answer.
   */
  relay(request: string, waiting = false): string {
    const problem = layerProblem(this.plugin, resolveLayer(this.plugin, 'orchestrator'));
    if (problem) return `The orchestrator can't run: ${problem} Tell the user.`;
    const recent = this.voiceContext();
    this.push({
      text: [
        `[Voice] The user ${waiting ? 'is waiting for this' : 'asked this; they may keep talking'}: ${request}`,
        ...(recent.length ? ['Conversation since your last relay:', ...recent] : []),
      ].join('\n'),
      fromUser: true,
      waiting,
      at: Date.now(),
    });
    return 'Passed to the orchestrator. Tell the user briefly that you are on it; the answer comes back on its own.';
  }

  /**
   * The voice conversation the orchestrator has not seen yet. With `full` (the default) every
   * line reaches it once, so its own context holds the whole call; with `recent` only the last
   * few lines go with each request.
   */
  private voiceContext(): string[] {
    const o = this.plugin.settings.orchestrator;
    const lines = this.transcriptSource?.() ?? [];
    if (o.voiceContext === 'recent') {
      const n = Math.max(0, o.relayTranscriptLines ?? 6);
      return n ? lines.slice(-n) : [];
    }
    // A new call starts a new transcript.
    if (lines.length < this.transcriptSent) this.transcriptSent = 0;
    const fresh = lines.slice(this.transcriptSent);
    this.transcriptSent = lines.length;
    return fresh;
  }

  /**
   * Orchestrator: speak through the voice layer.
   * @param text - What to say.
   * @param urgency - When.
   */
  say(text: string, urgency: NoticeMode): string {
    this.spokeThisTurn = true;
    const answersUser = this.relayAt !== null && urgency !== 'silent';
    if (answersUser) {
      logTiming(this.plugin, 'relay to first spoken answer', Date.now() - (this.relayAt as number));
      this.relayAt = null;
    }
    if (!this.listeners.size) {
      this.undelivered.push({ text, urgency });
      if (this.undelivered.length > 20) this.undelivered.shift();
      return 'No call is open; it will be said when the next call starts.';
    }
    for (const l of this.listeners) l(text, urgency, answersUser);
    return urgency === 'silent' ? 'Passed to the voice quietly.' : 'The voice will say it.';
  }

  /** Stops the turn in progress, if any. */
  cancelTurn(): void {
    this.turnAbort?.abort();
  }

  /** Forgets the orchestrator's conversation. */
  reset(): void {
    this.turnAbort?.abort();
    this.messages = [];
    this.notes = [];
    this.inputs = [];
    this.changed();
  }

  /** Stops listening (plugin unload). */
  dispose(): void {
    this.stopHooks();
    this.listeners.clear();
    this.changeListeners.clear();
    this.inputs = [];
    this.turnAbort?.abort();
  }

  /** @param event - Task event from the worker manager. */
  private onTaskEvent(event: SubAgentEvent): void {
    if (!this.active || event.tick) return;
    const hint = this.plugin.agents.routeFor(event.kind);
    if (hint === 'ignore') return;
    // Only a high-level summary of each worker; the full thread is read on demand.
    const max = this.plugin.settings.orchestrator.taskSummaryChars || 600;
    const text =
      event.text.length > max
        ? `${event.text.slice(0, max)}… (summary; read_task_thread for the full result and steps)`
        : event.text;
    const line = `[Task ${event.taskId} "${event.title}" ${event.kind.replace('_', ' ')}; suggested delivery: ${hint}] ${text}`;
    if (NOTE_ONLY.has(event.kind)) {
      this.notes.push(line.slice(0, 400));
      if (this.notes.length > 30) this.notes.shift();
      return;
    }
    this.push({ text: line, fromUser: false });
  }

  private push(input: Input): void {
    this.inputs.push(input);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.inputs.length) {
        // The user's requests go first; worker events wait for the next turn.
        const user = this.inputs.filter(i => i.fromUser);
        const batch = user.length ? user : this.inputs.splice(0);
        if (user.length) this.inputs = this.inputs.filter(i => !i.fromUser);
        await this.turn(batch);
      }
    } finally {
      this.running = false;
      this.state = 'idle';
      this.changed();
    }
  }

  private ensureChat(): PureChatLLMChat {
    // Built each turn so newly discovered MCP tools and skills are included.
    const chat = new PureChatLLMChat(this.plugin);
    chat.role = 'orchestrator-agent';
    chat.registerAvailableTools();
    // Only the orchestrator's own tools and read-only vault tools; code mode sees the same set.
    // Spoken progress updates are the voice layer's business.
    const allowed = new Set([
      ...ORCHESTRATOR_TOOL_NAMES.filter(n => n !== 'set_progress_updates'),
      ...ORCHESTRATOR_AGENT_TOOL_NAMES,
      ...ORCHESTRATOR_READ_TOOLS,
    ]);
    const registry = chat.toolregistry;
    // Remote MCP tools too (Hani: the orchestrator and workers use skills and MCP; voice does not).
    for (const tool of registry.getAllDefinitions()) {
      const name = tool.function.name;
      if (!allowed.has(name) && registry.classificationForTool(name) !== 'MCP')
        registry.disable(name);
    }
    return chat;
  }

  /** @param batch - Inputs handled in this turn. */
  private async turn(batch: Input[]): Promise<void> {
    const chat = this.ensureChat();
    const resolved = resolveLayer(this.plugin, 'orchestrator');
    // Fast path: a question the user is waiting on runs at low effort.
    const waiting = batch.some(b => b.waiting);
    const layer = waiting && resolved.effort ? { ...resolved, effort: 'low' as const } : resolved;
    const firstRelay = batch.find(b => b.at)?.at;
    if (firstRelay && this.relayAt === null) this.relayAt = firstRelay;
    const abort = new AbortController();
    this.turnAbort = abort;
    chat.abortSignal = abort.signal;
    const turnTimer = window.setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
    const turnStarted = Date.now();
    const tools = chat.toolregistry.getEnabledDefinitions();
    const allowed = new Set(tools.map(t => t.function.name));
    const fromUser = batch.some(b => b.fromUser);
    const notes = this.notes.splice(0);
    const content = [
      ...(notes.length ? ['Background since your last turn:', ...notes, ''] : []),
      ...batch.map(b => b.text),
    ].join('\n');

    this.trim();
    this.messages.push({ role: 'user', content });
    const calls = this.plugin.calls;
    calls?.logOrchestrator('input', content, fromUser);
    this.state = 'thinking';
    this.spokeThisTurn = false;
    this.turnActivity = [];
    this.changed();

    let finalText = '';
    let userTurn = fromUser;
    try {
      for (let step = 0; step < (userTurn ? USER_TURN_STEPS : EVENT_TURN_STEPS); step++) {
        // A request the user makes mid-turn joins this turn at the next step.
        if (step > 0) {
          const late = this.inputs.filter(i => i.fromUser);
          if (late.length) {
            this.inputs = this.inputs.filter(i => !i.fromUser);
            const text = late.map(l => l.text).join('\n');
            this.messages.push({ role: 'user', content: text });
            calls?.logOrchestrator('input', text, true);
            userTurn = true;
            if (this.relayAt === null) this.relayAt = late[0].at ?? Date.now();
          }
        }
        const response = await layerFetch(
          this.plugin,
          layer,
          {
            messages: [{ role: 'system', content: this.systemPrompt() }, ...this.messages],
            max_completion_tokens: this.plugin.settings.defaultmaxTokens,
            ...(tools.length ? { tools } : {}),
          },
          { signal: abort.signal, label: "The orchestrator's model request" },
        );
        const toolCalls = (response.tool_calls ?? []).filter(c => c.function?.name);
        if (response.content?.trim()) calls?.logOrchestrator('reply', response.content.trim());
        if (!toolCalls.length) {
          finalText = (response.content ?? '').trim();
          this.messages.push({ role: 'assistant', content: finalText });
          break;
        }
        this.messages.push({
          role: 'assistant',
          content: response.content ?? null,
          tool_calls: toolCalls,
        });
        for (const call of toolCalls) {
          calls?.logOrchestrator(
            'tool',
            `${call.function.name} ${call.function.arguments || '{}'}`,
          );
          const output = await this.runCall(chat, call, allowed);
          calls?.logOrchestrator('result', output);
          this.record(call, output);
          this.messages.push({ role: 'tool', content: output, tool_call_id: call.id });
        }
        // Fast path: when the step only spoke to the user, the turn is done; asking the model
        // again would only add a hop before the next request can start.
        if (
          toolCalls.every(c => c.function.name === 'tell_user') &&
          !this.inputs.some(i => i.fromUser)
        )
          break;
      }
      this.lastError = '';
    } catch (error) {
      const timedOut = abort.signal.aborted;
      this.lastError = timedOut
        ? `The turn took longer than ${Math.round(TURN_TIMEOUT_MS / 1000)} s and was stopped.`
        : error instanceof Error
          ? error.message
          : String(error);
      this.plugin.console?.error('Orchestrator turn failed', error);
      calls?.logOrchestrator('error', this.lastError);
      calls?.scheduleOrchestratorSave();
      // Keep the history valid: a tool call without its result would break the next turn.
      this.repairHistory();
      if (userTurn)
        this.say(
          isAbortError(error) || timedOut
            ? "That's taking longer than expected, so I stopped it. Ask again, or I can hand it to a background task."
            : `I couldn't work on that: ${spokenError(this.lastError)}`,
          'pause',
        );
      return;
    } finally {
      window.clearTimeout(turnTimer);
      if (this.turnAbort === abort) this.turnAbort = null;
      logTiming(
        this.plugin,
        `orchestrator turn (${userTurn ? 'user' : 'event'})`,
        Date.now() - turnStarted,
      );
    }
    // A relayed request must never go unanswered.
    if (userTurn && !this.spokeThisTurn && finalText) this.say(finalText, 'pause');
    this.shareActivity();
    calls?.scheduleOrchestratorSave();
  }

  /** After a failed turn, answers any tool call left without a result. */
  private repairHistory(): void {
    const last = this.messages[this.messages.length - 1] as
      | { role: string; tool_calls?: ToolCall[] }
      | undefined;
    if (last?.role !== 'assistant' || !last.tool_calls?.length) return;
    for (const call of last.tool_calls)
      this.messages.push({
        role: 'tool',
        content: 'Error: Cancelled: the turn stopped before this ran.',
        tool_call_id: call.id,
      });
  }

  private async runCall(
    chat: PureChatLLMChat,
    call: ToolCall,
    allowed: Set<string>,
  ): Promise<string> {
    const name = call.function.name;
    if (!allowed.has(name)) return `Error: ${name} is not available to the orchestrator.`;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      return `Error: the arguments for ${name} were not valid JSON.`;
    }
    const output = await chat.toolregistry.executeTool(name, args);
    const max = 12000;
    return output.length > max ? `${output.slice(0, max)}\n…[truncated]` : output;
  }

  /**
   * Notes one tool call in the activity feed: its name, a short form of its input, and for
   * delegate_task the task it started.
   * @param call - Tool call.
   * @param output - Its output (only the started task id is taken from it).
   */
  private record(call: ToolCall, output: string): void {
    const name = call.function.name;
    if (name === 'tell_user') return;
    let detail = '';
    try {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const pick = args.title ?? args.query ?? args.path ?? args.note ?? args.id ?? args.question;
      if (typeof pick === 'string') detail = ` ${JSON.stringify(pick.slice(0, 60))}`;
    } catch {
      // Keep the name only.
    }
    const started = name === 'delegate_task' ? /^Started (t\d+)/.exec(output)?.[1] : undefined;
    const text = started ? `started task ${started}${detail}` : `${name}${detail}`;
    this.activity.push({ at: Date.now(), text });
    if (this.activity.length > 100) this.activity.shift();
    this.turnActivity.push(text);
  }

  /** Tells the voice layer quietly what the orchestrator just did, when that is switched on. */
  private shareActivity(): void {
    if (!this.turnActivity.length || !this.plugin.settings.orchestrator.voiceSeesActivity) return;
    if (!this.listeners.size) return;
    const text = `[Orchestrator activity] ${this.turnActivity.join('; ')}`;
    for (const l of this.listeners) l(text, 'silent', false);
    this.turnActivity = [];
  }

  /**
   * Recent activity lines for the voice layer.
   * @param limit - Lines.
   */
  recentActivity(limit = 15): string[] {
    return this.activity
      .slice(-limit)
      .map(a => `${new Date(a.at).toTimeString().slice(0, 5)} ${a.text}`);
  }

  private systemPrompt(): string {
    const s = this.plugin.settings.orchestrator;
    const evaluator = s.layers.evaluator.enabled
      ? 'The evaluator is on: use request_evaluation on plans and results that matter.'
      : 'The evaluator is off.';
    return `${ORCHESTRATOR_AGENT_GUIDANCE}\n${evaluator}\nWorkers run on ${resolveLayer(this.plugin, 'worker').label}.`;
  }

  /** Drops the oldest turns, cutting at a relayed input so tool calls stay paired. */
  private trim(): void {
    const max = Math.max(20, this.plugin.settings.orchestrator.orchestratorMaxMessages || 80);
    if (this.messages.length <= max) return;
    let cut = this.messages.length - max;
    while (cut < this.messages.length && this.messages[cut].role !== 'user') cut++;
    this.messages.splice(0, cut);
  }

  private changed(): void {
    for (const l of this.changeListeners) l();
  }
}

/**
 * A failure in words the voice can say: no status codes or stack text.
 * @param message - Error message.
 */
export function spokenError(message: string): string {
  if (/401|unauthori[sz]ed|sign in/i.test(message))
    return 'the sign-in for the orchestrator needs renewing in settings.';
  if (/429|rate limit/i.test(message))
    return 'the model provider is rate-limiting us; try again in a minute.';
  if (/5\d\d|server error|overloaded/i.test(message))
    return 'the model provider is having trouble right now.';
  if (/Network|fetch failed|ECONN/i.test(message))
    return "I can't reach the model provider; check the connection.";
  if (/API key/i.test(message)) return message;
  return message.replace(/\s+/g, ' ').slice(0, 160);
}
