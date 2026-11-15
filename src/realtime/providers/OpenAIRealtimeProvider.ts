import { nativeMcpToolDefinition } from '../../mcp/McpManager';
import { toRealtimeFunctionTool } from '../toolAdapters';
import { BaseVoiceProvider } from './BaseVoiceProvider';
import type { VoiceCallConfig } from './IVoiceCallProvider';

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
              interrupt_response: true,
            }
          : {
              type: 'server_vad',
              create_response: true,
              interrupt_response: true,
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
      localStream.getTracks().forEach(track => this.peerConnection?.addTrack(track, localStream));
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
        this.emit({ type: 'speaking', active: true });
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.emit({ type: 'speaking', active: false });
        break;
      case 'response.done':
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
