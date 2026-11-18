import type { NoticeMode } from '../../agents/types';
import type { McpServerConfig, ToolDefinition, VoiceSettings } from '../../types';

/**
 * Configuration for one voice call session.
 */
export interface VoiceCallConfig {
  apiKey: string;
  /** System prompt for the voice model. */
  instructions: string;
  /** Function tools exposed to the model (already filtered for this provider). */
  tools: ToolDefinition[];
  /** Full voice settings; each provider reads its own section. */
  settings: VoiceSettings;
  /** Remote MCP servers handed to the provider natively (only for providers that support it). */
  nativeMcp: McpServerConfig[];
  /**
   * Runs one backend turn for GPT-Live client delegation and returns what the voice model
   * should know. Receives the recent conversation transcript.
   */
  runBackend?: (transcript: string) => Promise<string>;
  /**
   * Added to the instructions of a hosted backend that holds the tools (GPT-Live's Responses
   * delegation), which never sees `instructions`: in the layered setup, how to relay.
   */
  backendGuidance?: string;
}

/**
 * Interface for tool execution capability.
 */
export interface IToolExecutor {
  executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  getToolDefinitions(): ToolDefinition[];
}

/** Normalised events every provider reports to the UI. */
export type VoiceEvent =
  | { type: 'ready' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean }
  | {
      type: 'tool';
      name: string;
      phase: 'start' | 'end';
      error?: string;
      /** Pairs a start with its end. */
      id?: string;
      /** Arguments (on start). */
      args?: Record<string, unknown>;
      /** Result text, clipped (on end). */
      result?: string;
      /** How long it took (on end). */
      ms?: number;
    }
  | { type: 'speaking'; active: boolean }
  | { type: 'status'; text: string }
  | { type: 'raw'; event: unknown };

/**
 * Interface for voice call providers.
 * Decouples the transport (WebRTC vs WebSocket) from the application logic.
 */
export interface IVoiceCallProvider {
  /**
   * Starts a voice session.
   * @param localStream The microphone stream.
   * @param config Session configuration.
   */
  connect(localStream: MediaStream, config: VoiceCallConfig): Promise<void>;

  /** Ends the session and releases resources. */
  disconnect(): Promise<void>;

  /**
   * Sends a raw provider event.
   * @param event The event payload.
   */
  send(event: unknown): void;

  /**
   * Tells the provider the microphone was muted or unmuted.
   * @param muted Whether the microphone is muted.
   */
  setMuted?(muted: boolean): void;

  /**
   * Tells the voice model about something that happened in the background (a sub-agent
   * finished, got stuck or needs advice) so it can tell the user.
   * @param text Update text, already prefixed for the model.
   * @param mode `interrupt` cuts in now, `pause` speaks at the next pause, `silent` adds quiet
   * context without a spoken reply (where the provider has a way to).
   */
  notify?(text: string, mode: NoticeMode): void;

  /** Provider display name. */
  getName(): string;

  /** Called with the remote audio stream (WebRTC providers only). */
  onRemoteTrack(callback: (stream: MediaStream) => void): void;

  /** Called with normalised events. */
  onMessage(callback: (event: VoiceEvent) => void): void;

  /** Called on errors. */
  onError(callback: (error: Error) => void): void;
}
