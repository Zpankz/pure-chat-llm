// The voice bridge of the durable engine: the voice call talks to the orchestrator's durable
// conversation through the same `Orchestrator` surface as on the Classic engine. A relay becomes
// an input of the root conversation (it steers a run in progress, as a late relay joins the turn
// on Classic); `tell_user` speaks through `say`; worker events arrive in that conversation on
// their own (`workers.ts`). What the orchestrator does is read back from its conversation, for
// the voice's activity feed and the call notes, so a run that resumes after a reload is logged
// and spoken just the same.
import type { NoticeMode } from '../agents/types';
import type {
  Orchestrator,
  OrchestratorToolEvent,
  RelayOptions,
  SayListener,
} from '../agents/OrchestratorAgent';
import { relayLine } from '../agents/OrchestratorAgent';
import type { DurableSession } from './durable';
import { CTX } from './pi';
import type { Conversation, ConversationId, EntryRecord } from './pi';
import { answerText } from './workers';

type LogKind = 'input' | 'reply' | 'tool' | 'result' | 'error';

/** What the bridge needs from the plugin. */
export interface BridgeHost {
  /** The durable engine, opened on first use. */
  session(): Promise<DurableSession>;
  /** Whether the layered setup is on. */
  active(): boolean;
  /** Label of the orchestrator model. */
  label(): string;
  /** Why the orchestrator can't run (no sign-in or key), or null. */
  problem(): string | null;
  /** The voice conversation's settings. */
  voiceContext(): { mode: 'full' | 'recent'; recentLines: number };
  /** The voice sees the orchestrator's activity quietly. */
  voiceSeesActivity(): boolean;
  /** Call notes: a line of the orchestrator's log, and a save after a run. */
  log?(kind: LogKind, text: string, fromUser?: boolean): void;
  save?(): void;
  /** Time from a relay to its first spoken answer. */
  timing?(label: string, ms: number): void;
  /** Words for a failure the voice can say. */
  spokenError(message: string): string;
  error?(message: string, error: unknown): void;
}

const VOICE_PREFIX = '[Voice]';
const MAX_ACTIVITY = 100;

/** The text of one model message, for logs. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      const p = part as { type?: string; text?: unknown } | null;
      return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Short detail of a tool call's arguments for the activity feed, as on Classic. */
function callDetail(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const pick = a.title ?? a.query ?? a.path ?? a.note ?? a.id ?? a.question;
  return typeof pick === 'string' ? ` ${JSON.stringify(pick.slice(0, 60))}` : '';
}

export class DurableOrchestrator implements Orchestrator {
  state: 'idle' | 'thinking' = 'idle';
  lastError = '';
  readonly activity: { at: number; text: string }[] = [];
  private listeners = new Set<SayListener>();
  private changeListeners = new Set<() => void>();
  private undelivered: { text: string; urgency: NoticeMode }[] = [];
  private transcriptSource: (() => string[]) | null = null;
  private transcriptSent = 0;
  /** When the oldest unanswered relay arrived. */
  private relayAt: number | null = null;
  /** Relays not yet answered. */
  private pending = 0;
  /** Counts what the orchestrator said, so a relay answered without `tell_user` is still spoken. */
  private spoken = 0;
  private turnActivity: string[] = [];
  private opening: Promise<Conversation> | null = null;
  private stopWatch: (() => Promise<unknown>) | null = null;
  /** The newest entry of the root conversation already logged. */
  private seen: number | null = null;
  /** Tool call IDs to names, to label results in the log. */
  private callNames = new Map<string, string>();
  private disposed = false;

  constructor(private host: BridgeHost) {}

  get active(): boolean {
    return this.host.active();
  }

  get label(): string {
    return this.host.label();
  }

  onSay(listener: SayListener): () => void {
    this.listeners.add(listener);
    const pending = this.undelivered.splice(0);
    for (const p of pending) listener(p.text, p.urgency, false);
    return () => this.listeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private toolListeners = new Set<(event: OrchestratorToolEvent) => void>();

  onTool(listener: (event: OrchestratorToolEvent) => void): () => void {
    this.toolListeners.add(listener);
    return () => this.toolListeners.delete(listener);
  }

  private emitTool(event: OrchestratorToolEvent): void {
    for (const l of this.toolListeners) {
      try {
        l(event);
      } catch (error) {
        console.error('[voice-agent] orchestrator tool listener failed', error);
      }
    }
  }

  setTranscriptSource(source: (() => string[]) | null): void {
    this.transcriptSource = source;
    this.transcriptSent = 0;
  }

  /**
   * The root conversation, set up as the orchestrator, and watched for the log and the activity
   * feed. Its agent is set again on each open, so the instructions and tools follow the plugin.
   */
  private root(): Promise<Conversation> {
    this.opening ??= (async () => {
      const session = await this.host.session();
      const root = await session.root();
      await root.configure(session.orchestratorAgent(), CTX);
      await this.watch(root);
      return root;
    })().catch(error => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  private async watch(root: Conversation): Promise<void> {
    const watch = await root.watch(CTX, { min: 20 });
    const entries = watch.value.entries;
    // Only what happens from now on is logged; the conversation's history is already in notes.
    this.seen = entries.length ? entries[entries.length - 1].id : null;
    watch.start(async call => {
      if (call.kind === 'value') this.take(call.value.entries);
    });
    this.stopWatch = () => watch.stop();
  }

  /** Logs and records new entries of the root conversation. */
  private take(entries: readonly EntryRecord[]): void {
    let ranEnd = false;
    for (const entry of entries) {
      if (this.seen !== null && entry.id <= this.seen) continue;
      this.seen = entry.id;
      for (const message of entry.model ?? []) {
        if (message.role === 'user') {
          const text = messageText(message.content).trim();
          if (text) this.host.log?.('input', text, text.startsWith(VOICE_PREFIX));
        } else if (message.role === 'assistant') {
          const text = messageText(message.content).trim();
          if (text) this.host.log?.('reply', text);
          let calls = 0;
          for (const part of message.content) {
            if (part.type !== 'toolCall') continue;
            calls++;
            this.callNames.set(part.id, part.name);
            this.host.log?.('tool', `${part.name} ${JSON.stringify(part.arguments ?? {})}`);
            if (part.name !== 'tell_user') {
              this.emitTool({
                phase: 'start',
                id: part.id,
                name: part.name,
                args: (part.arguments ?? {}) as Record<string, unknown>,
              });
            }
            if (part.name !== 'tell_user') {
              const line = `${part.name}${callDetail(part.arguments)}`;
              this.record(
                part.name === 'delegate_task'
                  ? `started a task${callDetail(part.arguments)}`
                  : line,
              );
            }
          }
          if (!calls) ranEnd = true;
        } else if (message.role === 'toolResult') {
          const name = this.callNames.get(message.toolCallId) ?? message.toolName;
          this.callNames.delete(message.toolCallId);
          if (name !== 'tell_user') {
            const result = messageText(message.content);
            this.host.log?.('result', result);
            this.emitTool({
              phase: 'end',
              id: message.toolCallId,
              name,
              result: result.slice(0, 4000),
            });
          }
        }
      }
    }
    if (ranEnd) {
      this.shareActivity();
      this.host.save?.();
    }
  }

  private record(text: string): void {
    this.activity.push({ at: Date.now(), text });
    if (this.activity.length > MAX_ACTIVITY) this.activity.shift();
    this.turnActivity.push(text);
  }

  /** Tells the voice layer quietly what the orchestrator just did, when that is switched on. */
  private shareActivity(): void {
    if (!this.turnActivity.length || !this.host.voiceSeesActivity()) {
      this.turnActivity = [];
      return;
    }
    if (!this.listeners.size) return;
    const text = `[Orchestrator activity] ${this.turnActivity.join('; ')}`;
    for (const l of this.listeners) l(text, 'silent', false);
    this.turnActivity = [];
  }

  recentActivity(limit = 15): string[] {
    return this.activity
      .slice(-limit)
      .map(a => `${new Date(a.at).toTimeString().slice(0, 5)} ${a.text}`);
  }

  /** The voice conversation the orchestrator has not seen yet, as on Classic. */
  private voiceContext(): string[] {
    const { mode, recentLines } = this.host.voiceContext();
    const lines = this.transcriptSource?.() ?? [];
    if (mode === 'recent') {
      const n = Math.max(0, recentLines);
      return n ? lines.slice(-n) : [];
    }
    if (lines.length < this.transcriptSent) this.transcriptSent = 0;
    const fresh = lines.slice(this.transcriptSent);
    this.transcriptSent = lines.length;
    return fresh;
  }

  relay(request: string, waiting = false, options: RelayOptions = {}): string {
    const problem = this.host.problem();
    if (problem) return `The orchestrator can't run: ${problem} Tell the user.`;
    const recent = this.voiceContext();
    // Images reach the durable engine by their vault path, which the request names.
    const content = [
      relayLine(VOICE_PREFIX, request, waiting || !!options.typed, options.typed),
      ...(recent.length ? ['Conversation since your last relay:', ...recent] : []),
    ].join('\n');
    this.relayAt ??= Date.now();
    this.pending++;
    this.state = 'thinking';
    this.changed();
    void this.send(content).finally(() => {
      this.pending--;
      if (!this.pending) this.state = 'idle';
      this.changed();
    });
    return 'Passed to the orchestrator. Tell the user briefly that you are on it; the answer comes back on its own.';
  }

  /** Submits a relay and makes sure the user hears an answer to it. */
  private async send(content: string): Promise<void> {
    const spokenBefore = this.spoken;
    try {
      const root = await this.root();
      // A relay that arrives during a run joins it after the current tool round.
      const submission = await root.submit({ type: 'input', content, whenBusy: 'steer' }, CTX);
      const settled = await submission.wait(CTX);
      if (settled.status === 'done' && settled.type === 'input') {
        this.lastError = '';
        if (this.spoken !== spokenBefore) return;
        const answerId = settled.answer;
        const answer = answerText(await root.commit(tx => tx.entry(answerId), CTX));
        if (answer) this.say(answer, 'pause');
        return;
      }
      // The reason is a code (`model_error`); the detail carries the provider's message.
      const detail = settled.status === 'unanswered' ? settled.detail : undefined;
      throw new Error(
        typeof detail === 'string' && detail
          ? detail
          : settled.status === 'unanswered'
            ? settled.reason
            : 'no answer',
      );
    } catch (error) {
      if (this.disposed) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.host.error?.('Durable orchestrator turn failed', error);
      this.host.log?.('error', this.lastError);
      this.host.save?.();
      this.say(`I couldn't work on that: ${this.host.spokenError(this.lastError)}`, 'pause');
    }
  }

  say(text: string, urgency: NoticeMode): string {
    this.spoken++;
    const answersUser = this.relayAt !== null && urgency !== 'silent';
    if (answersUser) {
      this.host.timing?.('relay to first spoken answer', Date.now() - (this.relayAt as number));
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

  /** Stops the orchestrator's run in progress; background workers carry on. */
  cancelTurn(): void {
    void this.opening?.then(root => root.abort(CTX)).catch(() => undefined);
  }

  /** Starts the orchestrator's conversation afresh. Workers in flight still report to it. */
  reset(): void {
    void this.root()
      .then(async root => {
        await root.abort(CTX);
        await root.reset(undefined, CTX);
      })
      .catch(error => this.host.error?.('Could not reset the durable orchestrator', error))
      .finally(() => this.changed());
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.changeListeners.clear();
    void this.stopWatch?.().catch(() => undefined);
    this.stopWatch = null;
    this.opening = null;
  }

  /** The root conversation's ID, once open (tests and the side panel). */
  async conversationId(): Promise<ConversationId> {
    return (await this.root()).id;
  }

  private changed(): void {
    for (const l of this.changeListeners) l();
  }
}
