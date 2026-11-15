import { requestUrl } from 'obsidian';
import { nativeMcpToolDefinition } from '../../mcp/McpManager';
import { arrayBufferToBase64, base64ToArrayBuffer, PcmCapture, PcmPlayer } from '../audio/pcm';
import { toRealtimeFunctionTool } from '../toolAdapters';
import { BaseVoiceProvider } from './BaseVoiceProvider';
import type { VoiceCallConfig } from './IVoiceCallProvider';

const XAI_REALTIME = 'wss://api.x.ai/v1/realtime';
const XAI_CLIENT_SECRETS = 'https://api.x.ai/v1/realtime/client_secrets';
const SAMPLE_RATE = 24000;

interface XaiItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface XaiEvent {
  type: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response?: { output?: XaiItem[] };
  error?: { message?: string };
}

/**
 * xAI Grok Voice Agent API (grok-voice-latest / grok-voice-3.0) over WebSocket.
 *
 * Browsers cannot set WebSocket headers, so the plugin mints a short-lived client secret with the
 * API key (POST /v1/realtime/client_secrets) and passes it as the `xai-client-secret.<token>`
 * subprotocol, as xAI's docs describe. Audio is 24 kHz PCM both ways; function calls follow the
 * Realtime pattern (`function_call_output` + `response.create`); `web_search`, `x_search` and
 * native remote MCP tools are passed through.
 *
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/voice-agent
 */
export class XaiVoiceProvider extends BaseVoiceProvider {
  private ws: WebSocket | null = null;
  private capture: PcmCapture | null = null;
  private player = new PcmPlayer();
  private muted = false;
  private handledCalls = new Set<string>();
  private pendingCalls: Promise<{ call_id: string; output: string }>[] = [];
  private assistantText = '';

  /** Display name. */
  getName(): string {
    return this.toolExecutor ? 'Grok Voice (tools)' : 'Grok Voice';
  }

  /**
   * Builds the `session.update` payload.
   * @param config - Call config.
   */
  buildSession(config: VoiceCallConfig): Record<string, unknown> {
    const x = config.settings.xai;
    const tools: Record<string, unknown>[] = [
      ...(this.toolExecutor ? config.tools.map(toRealtimeFunctionTool) : []),
      ...config.nativeMcp.map(nativeMcpToolDefinition),
      ...(x.webSearch ? [{ type: 'web_search' }] : []),
      ...(x.xSearch ? [{ type: 'x_search' }] : []),
    ];
    return {
      instructions: config.instructions,
      voice: x.voice,
      reasoning: { effort: x.reasoningEffort },
      turn_detection: x.turnDetection === 'none' ? null : { type: 'server_vad' },
      audio: {
        input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
        output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, speed: x.speed },
      },
      ...(tools.length ? { tools } : {}),
    };
  }

  /**
   * Mints an ephemeral client secret.
   * @param apiKey - xAI API key.
   */
  private async mintClientSecret(apiKey: string): Promise<string> {
    const res = await requestUrl({
      url: XAI_CLIENT_SECRETS,
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { seconds: 300 } }),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`xAI client secret error ${res.status}: ${res.text}`);
    }
    const body = res.json as {
      value?: string;
      token?: string;
      client_secret?: { value?: string } | string;
    };
    const secret =
      body.value ??
      body.token ??
      (typeof body.client_secret === 'string' ? body.client_secret : body.client_secret?.value);
    if (!secret) throw new Error('xAI did not return a client secret.');
    return secret;
  }

  /**
   * Connects and starts streaming audio.
   * @param localStream - Microphone stream.
   * @param config - Call config.
   */
  async connect(localStream: MediaStream, config: VoiceCallConfig): Promise<void> {
    this.config = config;
    try {
      const secret = await this.mintClientSecret(config.apiKey);
      const model = encodeURIComponent(config.settings.xai.model);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${XAI_REALTIME}?model=${model}`, [`xai-client-secret.${secret}`]);
        this.ws = ws;
        let open = false;
        const timer = window.setTimeout(
          () => !open && reject(new Error('Grok Voice timed out')),
          15000,
        );
        ws.onopen = () => {
          open = true;
          window.clearTimeout(timer);
          this.send({ type: 'session.update', session: this.buildSession(config) });
          resolve();
        };
        ws.onerror = () => {
          if (!open) {
            window.clearTimeout(timer);
            reject(new Error('Grok Voice connection failed'));
          }
        };
        ws.onclose = event => {
          if (open && ws === this.ws)
            this.fail(new Error(`Grok Voice closed: ${event.reason || event.code}`));
        };
        ws.onmessage = event => this.handleEvent(event.data as string);
      });

      this.capture = new PcmCapture(SAMPLE_RATE, pcm => {
        if (!this.muted)
          this.send({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(pcm) });
      });
      await this.capture.start(localStream);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Ends the session. */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    await this.capture?.stop();
    this.capture = null;
    await this.player.close();
    this.handledCalls.clear();
    this.pendingCalls = [];
  }

  /** @param event - Client event. */
  send(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  /** @param muted - Microphone state. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** @param raw - Server event JSON. */
  private handleEvent(raw: string): void {
    let event: XaiEvent;
    try {
      event = JSON.parse(raw) as XaiEvent;
    } catch {
      return;
    }
    this.emit({ type: 'raw', event });

    switch (event.type) {
      case 'session.updated':
        this.emit({ type: 'ready' });
        break;
      case 'input_audio_buffer.speech_started':
        // Barge-in: stop the assistant as soon as the user talks.
        this.player.flush();
        this.emit({ type: 'speaking', active: false });
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (event.delta) {
          this.player.enqueue(base64ToArrayBuffer(event.delta), SAMPLE_RATE);
          this.emit({ type: 'speaking', active: true });
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.updated':
        if (event.transcript) {
          this.emit({ type: 'transcript', role: 'user', text: event.transcript, final: true });
        }
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.assistantText += event.delta ?? '';
        this.emit({
          type: 'transcript',
          role: 'assistant',
          text: this.assistantText,
          final: false,
        });
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.emit({
          type: 'transcript',
          role: 'assistant',
          text: event.transcript ?? this.assistantText,
          final: true,
        });
        this.assistantText = '';
        break;
      case 'response.function_call_arguments.done':
        this.queueCall(event.call_id, event.name, event.arguments);
        break;
      case 'response.done':
        for (const item of event.response?.output ?? []) {
          if (item.type === 'function_call')
            this.queueCall(item.call_id, item.name, item.arguments);
        }
        void this.flushCalls();
        break;
      case 'error':
        this.emit({ type: 'status', text: `Grok: ${event.error?.message ?? 'unknown error'}` });
        break;
    }
  }

  /**
   * Starts a function call once, as soon as its arguments are complete.
   * @param callId - Call id.
   * @param name - Function name.
   * @param args - JSON arguments.
   */
  private queueCall(callId?: string, name?: string, args?: string): void {
    if (!callId || !name || this.handledCalls.has(callId)) return;
    this.handledCalls.add(callId);
    this.pendingCalls.push(
      this.runTool(name, this.parseArgs(args)).then(output => ({ call_id: callId, output })),
    );
  }

  /** Sends every finished call's output, then asks for one follow-up response. */
  private async flushCalls(): Promise<void> {
    if (this.pendingCalls.length === 0) return;
    const pending = this.pendingCalls;
    this.pendingCalls = [];
    const results = await Promise.all(pending);
    for (const { call_id, output } of results) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id, output },
      });
    }
    this.send({ type: 'response.create' });
  }
}
