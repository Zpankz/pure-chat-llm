import { Notice } from 'obsidian';
import { clipToolOutput } from '../toolAdapters';
import type { NoticeMode } from '../../agents/types';
import type {
  IToolExecutor,
  IVoiceCallProvider,
  VoiceCallConfig,
  VoiceEvent,
} from './IVoiceCallProvider';

/**
 * Shared callback plumbing and tool execution for voice providers.
 */
export abstract class BaseVoiceProvider implements IVoiceCallProvider {
  protected onRemoteTrackCallback?: (stream: MediaStream) => void;
  protected onMessageCallback?: (event: VoiceEvent) => void;
  protected onErrorCallback?: (error: Error) => void;
  protected config: VoiceCallConfig | null = null;
  private notices: Array<{ text: string; mode: NoticeMode }> = [];
  private noticeTimer: number | null = null;
  /** True while the user is talking (from the provider's speech events). */
  protected userSpeaking = false;
  /** Last time the user's speech or transcript was seen. */
  protected lastUserSpeech = 0;

  /**
   * @param toolExecutor - Executes plugin tools; absent when agent mode is off.
   */
  constructor(protected toolExecutor?: IToolExecutor) {}

  abstract connect(localStream: MediaStream, config: VoiceCallConfig): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(event: unknown): void;
  abstract getName(): string;

  /** @param callback - Remote track callback. */
  onRemoteTrack(callback: (stream: MediaStream) => void): void {
    this.onRemoteTrackCallback = callback;
  }

  /** @param callback - Event callback. */
  onMessage(callback: (event: VoiceEvent) => void): void {
    this.onMessageCallback = callback;
  }

  /** @param callback - Error callback. */
  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Delivers a background update. `interrupt` goes out at once (stopping current speech);
   * `pause` and `silent` wait until the model is idle and go out together.
   * @param text - Update for the model.
   * @param mode - How it should land.
   */
  notify(text: string, mode: NoticeMode = 'pause'): void {
    if (mode === 'interrupt') {
      this.emit({ type: 'status', text: 'Update sent to the voice model (interrupting).' });
      this.interruptSpeech();
      this.deliverNotice(text, 'interrupt');
      return;
    }
    if (mode === 'silent' && !this.supportsSilentNotices) return;
    this.notices.push({ text, mode });
    this.pumpNotices();
  }

  /** Whether the provider can add context without making the model speak. */
  protected get supportsSilentNotices(): boolean {
    return true;
  }

  /** True while the model is speaking or generating; updates wait until it is false. */
  protected isBusy(): boolean {
    return false;
  }

  /** Stops the model's current speech so an urgent update can go first. */
  protected interruptSpeech(): void {
    // Providers override.
  }

  /**
   * Sends one update to the model. Providers override this.
   * @param text - Update text.
   * @param mode - How it should land.
   */
  protected deliverNotice(text: string, mode: NoticeMode): void {
    void text;
    void mode;
  }

  /** Delivers queued updates as one message when the model is idle. */
  protected pumpNotices(): void {
    if (this.noticeTimer !== null || this.notices.length === 0) return;
    const tick = () => {
      this.noticeTimer = null;
      if (!this.config || this.notices.length === 0) return;
      // Wait for the model to stop and for the user to finish their thought.
      const userTalking = this.userSpeaking || Date.now() - this.lastUserSpeech < 1200;
      if (this.isBusy() || userTalking) {
        this.noticeTimer = window.setTimeout(tick, 400);
        return;
      }
      const batch = this.notices.splice(0);
      const spoken = batch.some(n => n.mode === 'pause');
      if (spoken) this.emit({ type: 'status', text: 'Update sent to the voice model.' });
      this.deliverNotice(batch.map(n => n.text).join('\n'), spoken ? 'pause' : 'silent');
    };
    this.noticeTimer = window.setTimeout(tick, 50);
  }

  /** Clears pending updates (on disconnect). */
  protected clearNotices(): void {
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notices = [];
  }

  /** True when the user may talk over the model (barge-in). */
  protected get fullDuplex(): boolean {
    return this.config?.settings.fullDuplex ?? true;
  }

  /** @param event - Event to report. */
  protected emit(event: VoiceEvent): void {
    if (event.type === 'transcript' && event.role === 'user') this.lastUserSpeech = Date.now();
    this.onMessageCallback?.(event);
  }

  /** @param error - Error to report. */
  protected fail(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.onErrorCallback?.(err);
  }

  /**
   * Runs a tool and returns a string sized for a voice model's context.
   * @param name - Tool name.
   * @param args - Parsed arguments.
   */
  protected async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.toolExecutor) return 'Error: tools are disabled (agent mode is off).';
    this.emit({ type: 'tool', name, phase: 'start' });
    new Notice(`Running tool: ${name}`, 2000);
    try {
      const result = await this.toolExecutor.executeTool(name, args ?? {});
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      this.emit({ type: 'tool', name, phase: 'end' });
      return clipToolOutput(text, this.config?.settings.maxToolOutputChars ?? 6000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'tool', name, phase: 'end', error: message });
      return `Error: ${message}`;
    }
  }

  /**
   * Parses tool-call arguments that arrive as JSON text.
   * @param raw - JSON text or object.
   */
  protected parseArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    if (typeof raw !== 'string' || !raw.trim()) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
