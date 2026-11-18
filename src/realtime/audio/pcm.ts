/**
 * PCM16 capture and playback helpers for WebSocket voice providers (Gemini Live, Grok Voice).
 * WebRTC providers (OpenAI Realtime, GPT-Live) use media tracks instead.
 */

const CAPTURE_WORKLET = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = (options.processorOptions && options.processorOptions.frame) || 960;
    this.buf = new Int16Array(this.frame);
    this.len = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.len === this.frame) {
          const out = this.buf;
          this.port.postMessage(out.buffer, [out.buffer]);
          this.buf = new Int16Array(this.frame);
          this.len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

/**
 * Encodes bytes to base64 without blowing the call stack on large buffers.
 * @param buffer - Bytes to encode.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Decodes base64 into bytes.
 * @param base64 - Base64 text.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Captures microphone audio as 16-bit mono PCM at a fixed sample rate.
 */
export class PcmCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;

  /**
   * @param sampleRate - Target sample rate (16000 for Gemini, 24000 for Grok).
   * @param onChunk - Receives each PCM16 frame.
   * @param frameMs - Frame length in milliseconds.
   */
  constructor(
    private sampleRate: number,
    private onChunk: (pcm16: ArrayBuffer) => void,
    private frameMs = 40,
  ) {}

  /**
   * Starts capturing from a stream.
   * @param stream - Microphone stream.
   */
  async start(stream: MediaStream): Promise<void> {
    this.context = new AudioContext({ sampleRate: this.sampleRate });
    const url = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
    );
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.source = this.context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-capture', {
      processorOptions: { frame: Math.round((this.sampleRate * this.frameMs) / 1000) },
    });
    this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => this.onChunk(event.data);
    // Keep the graph pulling without echoing the microphone to the speakers.
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.context.destination);
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /** Stops capturing and releases the audio graph. */
  async stop(): Promise<void> {
    this.source?.disconnect();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.sink?.disconnect();
    this.source = null;
    this.node = null;
    this.sink = null;
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}

/**
 * Plays streamed PCM16 audio gaplessly and supports instant barge-in (flush).
 */
export class PcmPlayer {
  private context: AudioContext | null = null;
  private nextStart = 0;
  private active = new Set<AudioBufferSourceNode>();

  /** Lazily creates the playback context. */
  private ensure(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext();
      this.nextStart = 0;
    }
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  /**
   * Queues a PCM16 chunk.
   * @param data - PCM16 little-endian bytes.
   * @param sampleRate - Sample rate of the chunk.
   */
  enqueue(data: ArrayBuffer, sampleRate: number): void {
    if (data.byteLength < 2) return;
    const ctx = this.ensure();
    const pcm = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;
    const buffer = ctx.createBuffer(1, floats.length, sampleRate);
    buffer.copyToChannel(floats, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.02, this.nextStart);
    node.start(start);
    this.nextStart = start + buffer.duration;
    this.active.add(node);
    node.onended = () => this.active.delete(node);
  }

  /** True while audio is scheduled or playing. */
  get isPlaying(): boolean {
    return this.active.size > 0;
  }

  /** Stops everything immediately (used when the user interrupts). */
  flush(): void {
    for (const node of this.active) {
      try {
        node.stop();
      } catch {
        // already stopped
      }
    }
    this.active.clear();
    this.nextStart = 0;
  }

  /** Stops playback and closes the context. */
  async close(): Promise<void> {
    this.flush();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}
