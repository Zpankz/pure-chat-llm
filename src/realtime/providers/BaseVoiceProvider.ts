import { Notice } from 'obsidian';
import { clipToolOutput } from '../toolAdapters';
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

  /** @param event - Event to report. */
  protected emit(event: VoiceEvent): void {
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
