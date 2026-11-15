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
  | { type: 'tool'; name: string; phase: 'start' | 'end'; error?: string }
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

  /** Provider display name. */
  getName(): string;

  /** Called with the remote audio stream (WebRTC providers only). */
  onRemoteTrack(callback: (stream: MediaStream) => void): void;

  /** Called with normalised events. */
  onMessage(callback: (event: VoiceEvent) => void): void;

  /** Called on errors. */
  onError(callback: (error: Error) => void): void;
}
