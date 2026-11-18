import { nativeMcpToolDefinition } from '../../mcp/McpManager';
import { toRealtimeFunctionTool } from '../toolAdapters';
import { BaseVoiceProvider } from './BaseVoiceProvider';
import type { VoiceCallConfig } from './IVoiceCallProvider';
import type { NoticeMode } from '../../agents/types';

interface RealtimeItem {
  type: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
  response?: { status?: string; output?: RealtimeItem[] };
  [key: string]: unknown;
}

const CALLS_ENDPOINT = 'https://api.openai.com/v1/realtime/calls';

/**
 * OpenAI Realtime API (GA interface, gpt-realtime-2.1 family) over WebRTC.
 *
 * - Session config uses the GA shape: `type: "realtime"`, `audio.input.{turn_detection,
 *   noise_reduction, transcription}`, `audio.output.{voice, speed}`, optional `reasoning.effort`.
 * - Function calls are read from `response.done`, executed in parallel, answered with
 *   `function_call_output` items, and followed by a single `response.create`.
 * - Remote MCP servers set to native are passed as `type: "mcp"` tools.
 *
 * Docs: https://developers.openai.com/api/docs/guides/realtime-conversations
 */
export class OpenAIRealtimeProvider extends BaseVoiceProvider {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private handledCalls = new Set<string>();
  private assistantText = '';
  private responseActive = false;
  private modelSpeaking = false;
  private micTrack: MediaStreamTrack | null = null;
  private micSender: RTCRtpSender | null = null;

  /** Display name. */
  getName(): string {
    return this.toolExecutor ? 'OpenAI Realtime (tools)' : 'OpenAI Realtime';
  }

  /**
   * Builds the GA session object.
   * @param config - Call config.
   */
  buildSession(config: VoiceCallConfig): Record<string, unknown> {
    const s = config.settings.openai;
    const turnDetection =
      s.turnDetection === 'none'
        ? null
        : s.turnDetection === 'semantic_vad'
          ? {
              type: 'semantic_vad',
              eagerness: s.eagerness,
              create_response: true,
              interrupt_response: config.settings.fullDuplex,
            }
          : {
              type: 'server_vad',
              create_response: true,
              interrupt_response: config.settings.fullDuplex,
              ...(s.idleTimeoutMs > 0 ? { idle_timeout_ms: s.idleTimeoutMs } : {}),
            };

    const tools = [
      ...(this.toolExecutor ? config.tools.map(toRealtimeFunctionTool) : []),
      ...config.nativeMcp.map(nativeMcpToolDefinition),
    ];

    return {
      type: 'realtime',
      model: s.model,
      instructions: config.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          turn_detection: turnDetection,
          noise_reduction: s.noiseReduction === 'none' ? null : { type: s.noiseReduction },
          transcription: s.transcriptionModel ? { model: s.transcriptionModel } : null,
        },
        output: { voice: s.voice, speed: s.speed },
      },
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(s.reasoningEffort !== 'default' && /^gpt-realtime-2/.test(s.model)
        ? { reasoning: { effort: s.reasoningEffort } }
        : {}),
    };
  }

  /**
   * Connects over WebRTC using the unified `/v1/realtime/calls` interface.
   * @param localStream - Microphone stream.
   * @param config - Call config.
   */
  async connect(localStream: MediaStream, config: VoiceCallConfig): Promise<void> {
    this.config = config;
    try {
      this.peerConnection = new RTCPeerConnection();
      for (const track of localStream.getTracks()) {
        const sender = this.peerConnection.addTrack(track, localStream);
        if (track.kind === 'audio' && !this.micSender) {
          this.micSender = sender;
          this.micTrack = track;
        }
      }
      this.peerConnection.ontrack = event => {
        if (event.streams?.[0]) this.onRemoteTrackCallback?.(event.streams[0]);
      };

      this.dataChannel = this.peerConnection.createDataChannel('oai-events');
      this.dataChannel.addEventListener('message', event => this.handleEvent(event.data as string));

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      const form = new FormData();
      form.append('sdp', offer.sdp ?? '');
      form.append('session', JSON.stringify(this.buildSession(config)));

      // eslint-disable-next-line no-restricted-globals
      const response = await fetch(CALLS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
      });
      if (!response.ok) {
        throw new Error(`OpenAI Realtime error ${response.status}: ${await response.text()}`);
      }
      await this.peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: await response.text(),
      });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Closes the connection. */
  disconnect(): Promise<void> {
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.dataChannel = null;
    this.peerConnection = null;
    this.handledCalls.clear();
    this.clearNotices();
    this.micTrack = null;
    this.micSender = null;
    this.responseActive = false;
    this.modelSpeaking = false;
    return Promise.resolve();
  }

  /** @param event - Client event. */
  send(event: unknown): void {
    if (this.dataChannel?.readyState === 'open') this.dataChannel.send(JSON.stringify(event));
  }

  /** @param raw - Server event JSON. */
  private handleEvent(raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }
    this.emit({ type: 'raw', event });

    switch (event.type) {
      case 'session.created':
        this.emit({ type: 'ready' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript)
          this.emit({ type: 'transcript', role: 'user', text: event.transcript, final: true });
        break;
      case 'response.output_audio_transcript.delta':
        this.assistantText += event.delta ?? '';
        this.emit({
          type: 'transcript',
          role: 'assistant',
          text: this.assistantText,
          final: false,
        });
        break;
      case 'response.output_audio_transcript.done':
        this.emit({
          type: 'transcript',
          role: 'assistant',
          text: event.transcript ?? this.assistantText,
          final: true,
        });
        this.assistantText = '';
        break;
      case 'output_audio_buffer.started':
        this.setSpeaking(true);
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.setSpeaking(false);
        break;
      case 'response.created':
        this.responseActive = true;
        // An interrupted response may never send its transcript's "done": close what it said,
        // so the new answer doesn't continue the old one's text.
        if (this.assistantText.trim())
          this.emit({
            type: 'transcript',
            role: 'assistant',
            text: this.assistantText,
            final: true,
          });
        this.assistantText = '';
        break;
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        this.lastUserSpeech = Date.now();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this.lastUserSpeech = Date.now();
        break;
      case 'response.done':
        this.responseActive = false;
        void this.handleResponseDone(event);
        break;
      case 'mcp_list_tools.failed':
      case 'response.mcp_call.failed':
        this.emit({ type: 'status', text: 'A remote MCP call failed.' });
        break;
      case 'error':
        this.emit({ type: 'status', text: `OpenAI: ${event.error?.message ?? 'unknown error'}` });
        break;
    }
  }

  /**
   * Tracks model speech; in half duplex the microphone is not sent while the model speaks.
   * @param active - Whether the model's audio is playing.
   */
  private setSpeaking(active: boolean): void {
    this.modelSpeaking = active;
    this.emit({ type: 'speaking', active });
    if (this.fullDuplex || !this.micSender) return;
    void this.micSender.replaceTrack(active ? null : this.micTrack).catch(() => undefined);
  }

  /** Busy while a response is generating or audio is playing. */
  protected isBusy(): boolean {
    return this.responseActive || this.modelSpeaking;
  }

  /** Cancels the response in progress and clears audio not yet played. */
  protected interruptSpeech(): void {
    if (this.responseActive) this.send({ type: 'response.cancel' });
    if (this.modelSpeaking) this.send({ type: 'output_audio_buffer.clear' });
  }

  /**
   * Adds the update as a system message; asks for a spoken response unless it is quiet context.
   * @param text - Update text.
   * @param mode - How it should land.
   */
  protected deliverNotice(text: string, mode: NoticeMode): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
    if (mode !== 'silent') this.send({ type: 'response.create' });
  }

  /**
   * Executes every function call in a finished response, then asks for one follow-up response.
   * @param event - The `response.done` event.
   */
  private async handleResponseDone(event: RealtimeEvent): Promise<void> {
    const calls = (event.response?.output ?? []).filter(
      item => item.type === 'function_call' && item.call_id && !this.handledCalls.has(item.call_id),
    );
    if (calls.length === 0) return;
    calls.forEach(c => this.handledCalls.add(c.call_id as string));

    const outputs = await Promise.all(
      calls.map(async call => ({
        call_id: call.call_id,
        output: await this.runTool(call.name ?? '', this.parseArgs(call.arguments)),
      })),
    );
    for (const { call_id, output } of outputs) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id, output },
      });
    }
    this.send({ type: 'response.create' });
  }
}
