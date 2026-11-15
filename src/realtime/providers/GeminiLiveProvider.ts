import { arrayBufferToBase64, base64ToArrayBuffer, PcmCapture, PcmPlayer } from '../audio/pcm';
import { geminiSupportsScheduling, geminiSupportsThinking } from '../voiceCatalog';
import { toGeminiFunctionDeclaration } from '../toolAdapters';
import { BaseVoiceProvider } from './BaseVoiceProvider';
import type { VoiceCallConfig } from './IVoiceCallProvider';

const LIVE_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiServerMessage {
  setupComplete?: Record<string, never>;
  serverContent?: {
    modelTurn?: { parts?: GeminiPart[] };
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
  };
  toolCall?: {
    functionCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
  };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  error?: { message?: string };
}

const SENSITIVITY: Record<string, Record<string, string>> = {
  start: { high: 'START_SENSITIVITY_HIGH', low: 'START_SENSITIVITY_LOW' },
  end: { high: 'END_SENSITIVITY_HIGH', low: 'END_SENSITIVITY_LOW' },
};

/**
 * Google Gemini Live API (v1beta) over WebSocket.
 *
 * - Models: gemini-3.8-live (default), gemini-3.8-live-extended-thinking, 2.5 native audio.
 * - Input: 16 kHz PCM via `realtimeInput.audio` (the old `mediaChunks` field is deprecated).
 * - Output: 24 kHz PCM, flushed instantly on `serverContent.interrupted` (barge-in).
 * - Tools: `functionDeclarations` with `parametersJsonSchema`, optional NON_BLOCKING behaviour and
 *   response `scheduling`; `toolCallCancellation` drops cancelled calls; optional Google Search.
 * - Long calls: context window compression and session resumption with automatic reconnect on
 *   `goAway`.
 *
 * Docs: https://ai.google.dev/api/live and https://ai.google.dev/gemini-api/docs/live-api/thinking
 */
export class GeminiLiveProvider extends BaseVoiceProvider {
  private ws: WebSocket | null = null;
  private capture: PcmCapture | null = null;
  private player = new PcmPlayer();
  private resumeHandle: string | null = null;
  private cancelled = new Set<string>();
  private closing = false;
  private muted = false;
  private reconnecting = false;
  private userText = '';
  private assistantText = '';

  /** Display name. */
  getName(): string {
    return this.toolExecutor ? 'Gemini Live (tools)' : 'Gemini Live';
  }

  /**
   * Builds the BidiGenerateContentSetup message.
   * @param config - Call config.
   */
  buildSetup(config: VoiceCallConfig): Record<string, unknown> {
    const g = config.settings.gemini;
    const model = g.model.startsWith('models/') ? g.model : `models/${g.model}`;

    const speechConfig: Record<string, unknown> = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: g.voice } },
      ...(g.languageCode ? { languageCode: g.languageCode } : {}),
    };
    const generationConfig: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      speechConfig,
      ...(g.thinkingLevel !== 'default' && geminiSupportsThinking(g.model)
        ? { thinkingConfig: { thinkingLevel: g.thinkingLevel.toUpperCase() } }
        : {}),
    };

    const activityDetection: Record<string, unknown> = {};
    if (SENSITIVITY.start[g.startSensitivity]) {
      activityDetection.startOfSpeechSensitivity = SENSITIVITY.start[g.startSensitivity];
    }
    if (SENSITIVITY.end[g.endSensitivity]) {
      activityDetection.endOfSpeechSensitivity = SENSITIVITY.end[g.endSensitivity];
    }
    if (g.silenceDurationMs > 0) activityDetection.silenceDurationMs = g.silenceDurationMs;

    const tools: Record<string, unknown>[] = [];
    if (this.toolExecutor && config.tools.length) {
      const nonBlocking = g.nonBlockingTools || !geminiSupportsScheduling(g.model);
      tools.push({
        functionDeclarations: config.tools.map(t => toGeminiFunctionDeclaration(t, nonBlocking)),
      });
    }
    if (g.googleSearch) tools.push({ googleSearch: {} });

    return {
      setup: {
        model,
        generationConfig,
        systemInstruction: { parts: [{ text: config.instructions }] },
        ...(tools.length ? { tools } : {}),
        ...(Object.keys(activityDetection).length
          ? { realtimeInputConfig: { automaticActivityDetection: activityDetection } }
          : {}),
        ...(g.transcription ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
        ...(g.contextCompression ? { contextWindowCompression: { slidingWindow: {} } } : {}),
        ...(g.sessionResumption
          ? { sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {} }
          : {}),
        ...(g.proactiveAudio ? { proactivity: { proactiveAudio: true } } : {}),
      },
    };
  }

  /**
   * Connects, sends setup and starts streaming the microphone.
   * @param localStream - Microphone stream.
   * @param config - Call config.
   */
  async connect(localStream: MediaStream, config: VoiceCallConfig): Promise<void> {
    this.config = config;
    this.closing = false;
    try {
      await this.openSocket(config);
      this.capture = new PcmCapture(16000, pcm => this.sendAudio(pcm));
      await this.capture.start(localStream);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /**
   * Opens the WebSocket and waits for `setupComplete`.
   * @param config - Call config.
   */
  private openSocket(config: VoiceCallConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${LIVE_ENDPOINT}?key=${encodeURIComponent(config.apiKey)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ready = false;
      const timer = window.setTimeout(() => {
        if (!ready) reject(new Error('Gemini Live setup timed out'));
      }, 15000);

      ws.onopen = () => ws.send(JSON.stringify(this.buildSetup(config)));
      ws.onerror = () => {
        if (!ready) {
          window.clearTimeout(timer);
          reject(new Error('Gemini Live connection failed'));
        }
      };
      ws.onclose = event => {
        if (!ready) {
          window.clearTimeout(timer);
          reject(new Error(`Gemini Live closed: ${event.reason || event.code}`));
          return;
        }
        if (ws === this.ws && !this.closing && !this.reconnecting) {
          if (this.resumeHandle) void this.reconnect();
          else this.fail(new Error(`Gemini Live disconnected: ${event.reason || event.code}`));
        }
      };
      ws.onmessage = event => {
        const msg = this.parse(event.data);
        if (!msg) return;
        if (msg.setupComplete && !ready) {
          ready = true;
          window.clearTimeout(timer);
          this.emit({ type: 'ready' });
          resolve();
        }
        this.handleMessage(msg);
      };
    });
  }

  /** Reconnects with the latest resumption handle (after goAway or a dropped socket). */
  private async reconnect(): Promise<void> {
    if (!this.config || this.reconnecting || this.closing) return;
    this.reconnecting = true;
    const old = this.ws;
    try {
      this.emit({ type: 'status', text: 'Resuming Gemini session…' });
      await this.openSocket(this.config);
      old?.close();
    } catch (error) {
      this.fail(error);
    } finally {
      this.reconnecting = false;
    }
  }

  /** Ends the session. */
  async disconnect(): Promise<void> {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
    await this.capture?.stop();
    this.capture = null;
    await this.player.close();
    this.resumeHandle = null;
    this.cancelled.clear();
  }

  /** @param event - Client message. */
  send(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  /**
   * On mute, tell the server the audio stream paused so VAD can close the turn.
   * @param muted - Microphone state.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** @param pcm - 16 kHz PCM16 frame. */
  private sendAudio(pcm: ArrayBuffer): void {
    if (this.muted || this.reconnecting) return;
    this.send({
      realtimeInput: {
        audio: { data: arrayBufferToBase64(pcm), mimeType: 'audio/pcm;rate=16000' },
      },
    });
  }

  /** @param data - Raw socket payload. */
  private parse(data: unknown): GeminiServerMessage | null {
    try {
      const text = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
      return JSON.parse(text) as GeminiServerMessage;
    } catch {
      return null;
    }
  }

  /** @param msg - Server message. */
  private handleMessage(msg: GeminiServerMessage): void {
    this.emit({ type: 'raw', event: msg });
    const content = msg.serverContent;
    if (content) {
      if (content.interrupted) {
        this.player.flush();
        this.emit({ type: 'speaking', active: false });
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType.startsWith('audio/pcm')) {
          const rate = Number(/rate=(\d+)/.exec(inline.mimeType)?.[1] ?? 24000);
          this.player.enqueue(base64ToArrayBuffer(inline.data), rate);
          this.emit({ type: 'speaking', active: true });
        }
      }
      if (content.inputTranscription?.text) {
        this.userText += content.inputTranscription.text;
        this.emit({ type: 'transcript', role: 'user', text: this.userText, final: false });
      }
      if (content.outputTranscription?.text) {
        if (this.userText) {
          this.emit({ type: 'transcript', role: 'user', text: this.userText, final: true });
          this.userText = '';
        }
        this.assistantText += content.outputTranscription.text;
        this.emit({
          type: 'transcript',
          role: 'assistant',
          text: this.assistantText,
          final: false,
        });
      }
      if (content.turnComplete) {
        if (this.assistantText) {
          this.emit({
            type: 'transcript',
            role: 'assistant',
            text: this.assistantText,
            final: true,
          });
        }
        this.assistantText = '';
      }
    }

    if (msg.toolCall?.functionCalls?.length) void this.handleToolCall(msg.toolCall.functionCalls);
    for (const id of msg.toolCallCancellation?.ids ?? []) this.cancelled.add(id);

    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.goAway) {
      if (this.resumeHandle) void this.reconnect();
      else this.emit({ type: 'status', text: 'Gemini will end this session shortly.' });
    }
    if (msg.error?.message) this.emit({ type: 'status', text: `Gemini: ${msg.error.message}` });
  }

  /**
   * Runs function calls and returns their results, skipping cancelled ones.
   * @param calls - Function calls from the server.
   */
  private async handleToolCall(
    calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>,
  ): Promise<void> {
    const g = this.config?.settings.gemini;
    const scheduling =
      g && geminiSupportsScheduling(g.model) && g.nonBlockingTools ? g.toolScheduling : undefined;

    const responses = await Promise.all(
      calls.map(async call => {
        const output = await this.runTool(call.name, call.args ?? {});
        const isError = output.startsWith('Error:');
        return {
          id: call.id,
          name: call.name,
          response: isError ? { error: output } : { output },
          ...(scheduling ? { scheduling } : {}),
        };
      }),
    );
    const live = responses.filter(r => !this.cancelled.has(r.id));
    if (live.length) this.send({ toolResponse: { functionResponses: live } });
  }
}
