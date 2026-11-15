import { requestUrl } from 'obsidian';
import { nativeMcpToolDefinition } from '../../mcp/McpManager';
import { toResponsesFunctionTool } from '../toolAdapters';
import { BaseVoiceProvider } from './BaseVoiceProvider';
import type { VoiceCallConfig } from './IVoiceCallProvider';
import type { NoticeMode } from '../../agents/types';

const LIVE_SESSIONS_ENDPOINT = 'https://api.openai.com/v1/live/sessions';

/** Content appended to a live session is capped at 500 tokens; ~4 chars per token. */
const APPEND_LIMIT_CHARS = 1900;

interface LiveItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  server_label?: string;
}

interface LiveEvent {
  type: string;
  delta?: string;
  delegation_id?: string | null;
  delegation?: { id?: string; target?: string };
  event?: { type?: string; item?: LiveItem };
  error?: { message?: string; code?: string };
  usage?: unknown;
}

/**
 * OpenAI GPT-Live (gpt-live-1): a full-duplex voice model that listens and speaks at the same
 * time and delegates reasoning and tool use to a backend agent.
 *
 * Two duplex agent modes, chosen in settings:
 * - Responses delegation: OpenAI runs the backend model through the Responses API. Plugin tools
 *   are registered as function tools; calls arrive as `response.event` envelopes and are answered
 *   with `response.item.create` + `response.create`.
 * - Client delegation: the plugin runs the backend with the user's default chat provider and
 *   vault tools, and returns the result with `session.commentary.append`.
 *
 * Docs: https://developers.openai.com/api/docs/guides/live,
 * https://developers.openai.com/api/docs/guides/live-delegation,
 * https://developers.openai.com/api/docs/guides/live-conversations
 */
export class OpenAILiveProvider extends BaseVoiceProvider {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingCalls = new Map<string, Promise<{ call_id: string; output: string }>[]>();
  private submittedCalls = new Set<string>();
  private transcript: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  private closedResolver: (() => void) | null = null;
  private eventSeq = 0;

  /** Display name. */
  getName(): string {
    return 'OpenAI GPT-Live';
  }

  /**
   * Builds the GPT-Live session object.
   * @param config - Call config.
   */
  buildSession(config: VoiceCallConfig): Record<string, unknown> {
    const s = config.settings.live;
    let delegation: Record<string, unknown>;
    if (s.delegation === 'client') {
      delegation = {
        type: 'client',
        ...(s.acknowledgementDelayMs > 0
          ? { acknowledgement_delay_ms: s.acknowledgementDelayMs }
          : {}),
      };
    } else {
      const tools: Record<string, unknown>[] = [
        ...(this.toolExecutor ? config.tools.map(toResponsesFunctionTool) : []),
        ...config.nativeMcp.map(nativeMcpToolDefinition),
        ...(s.hostedWebSearch ? [{ type: 'web_search' }] : []),
      ];
      delegation = {
        type: 'responses',
        responses: {
          model: s.backendModel,
          instructions: s.backendInstructions,
          ...(tools.length
            ? { tools, tool_choice: s.toolChoice, parallel_tool_calls: s.parallelToolCalls }
            : {}),
          ...(s.backendReasoningEffort !== 'default'
            ? { reasoning: { effort: s.backendReasoningEffort } }
            : {}),
          ...(s.serviceTier === 'priority' ? { service_tier: 'priority' } : {}),
        },
      };
    }
    return {
      model: s.model,
      instructions: config.instructions,
      audio: { output: { voice: s.voice } },
      delegation,
      ...(s.store ? { store: true } : {}),
    };
  }

  /**
   * Starts the session: the HTTP request creates it and exchanges SDP in one step.
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
      // The data channel must exist before the offer is created.
      this.dataChannel = this.peerConnection.createDataChannel('oai-events');
      this.dataChannel.addEventListener('message', event => this.handleEvent(event.data as string));

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      const response = await requestUrl({
        url: LIVE_SESSIONS_ENDPOINT,
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: this.buildSession(config),
          transport: { type: 'webrtc', sdp: offer.sdp ?? '' },
        }),
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GPT-Live error ${response.status}: ${response.text}`);
      }
      const body = response.json as { transport?: { sdp?: string } };
      if (!body.transport?.sdp) throw new Error('GPT-Live did not return an SDP answer.');
      await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: body.transport.sdp });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Closes the session cleanly (session.close → session.closed), then the connection. */
  async disconnect(): Promise<void> {
    if (this.dataChannel?.readyState === 'open') {
      await new Promise<void>(resolve => {
        this.closedResolver = resolve;
        this.send({ type: 'session.close', event_id: this.nextEventId('close') });
        window.setTimeout(resolve, 2000);
      });
    }
    this.closedResolver = null;
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.dataChannel = null;
    this.peerConnection = null;
    this.pendingCalls.clear();
    this.submittedCalls.clear();
    this.transcript = [];
    this.clearNotices();
  }

  /**
   * GPT-Live times its own speech, so updates go out at once as session-wide appends
   * (`delegation_id: null`): `instructions` can interrupt current speech, `commentary` is
   * paraphrased aloud, and `thinking` is quiet context the model can use later.
   * @param text - Update text.
   * @param mode - How it should land.
   */
  protected deliverNotice(text: string, mode: NoticeMode): void {
    const type =
      mode === 'interrupt'
        ? 'session.instructions.append'
        : mode === 'silent'
          ? 'session.thinking.append'
          : 'session.commentary.append';
    this.send({
      type,
      event_id: this.nextEventId('update'),
      delegation_id: null,
      content: text.length > APPEND_LIMIT_CHARS ? `${text.slice(0, APPEND_LIMIT_CHARS)}…` : text,
    });
  }

  /** @param event - Client event. */
  send(event: unknown): void {
    if (this.dataChannel?.readyState === 'open') this.dataChannel.send(JSON.stringify(event));
  }

  /**
   * GPT-Live keeps running while muted; tell the server too.
   * @param muted - Microphone state.
   */
  setMuted(muted: boolean): void {
    this.send({
      type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute',
      event_id: this.nextEventId(muted ? 'mute' : 'unmute'),
    });
  }

  /** @param prefix - Event id prefix. */
  private nextEventId(prefix: string): string {
    return `${prefix}_${Date.now()}_${++this.eventSeq}`;
  }

  /**
   * Appends to the running transcript (merging consecutive deltas from the same speaker).
   * @param role - Speaker.
   * @param delta - New text.
   */
  private appendTranscript(role: 'user' | 'assistant', delta: string): string {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === role) last.text += delta;
    else this.transcript.push({ role, text: delta });
    if (this.transcript.length > 40) this.transcript.shift();
    return this.transcript[this.transcript.length - 1].text;
  }

  /** @param raw - Server event JSON. */
  private handleEvent(raw: string): void {
    let event: LiveEvent;
    try {
      event = JSON.parse(raw) as LiveEvent;
    } catch {
      return;
    }
    this.emit({ type: 'raw', event });

    switch (event.type) {
      case 'session.started':
        this.emit({ type: 'ready' });
        break;
      case 'session.closed':
        this.closedResolver?.();
        break;
      case 'session.input_transcript.delta':
        this.emit({
          type: 'transcript',
          role: 'user',
          text: this.appendTranscript('user', event.delta ?? ''),
          final: false,
        });
        break;
      case 'session.output_transcript.delta':
        this.emit({
          type: 'transcript',
          role: 'assistant',
          text: this.appendTranscript('assistant', event.delta ?? ''),
          final: false,
        });
        break;
      case 'session.delegation.created':
        if (event.delegation?.target === 'client' && event.delegation.id) {
          void this.handleClientDelegation(event.delegation.id);
        }
        break;
      case 'response.event':
        this.handleResponsesEvent(event);
        break;
      case 'error':
        this.emit({ type: 'status', text: `GPT-Live: ${event.error?.message ?? 'unknown error'}` });
        break;
    }
  }

  /**
   * Handles nested Responses events in Responses delegation mode.
   * @param envelope - The `response.event` envelope.
   */
  private handleResponsesEvent(envelope: LiveEvent): void {
    const inner = envelope.event;
    const delegationId = envelope.delegation_id ?? 'default';
    if (!inner?.type) return;

    if (inner.type === 'response.output_item.done' && inner.item) {
      const item = inner.item;
      if (item.type === 'function_call' && item.call_id && !this.submittedCalls.has(item.call_id)) {
        const callId = item.call_id;
        this.submittedCalls.add(callId);
        const list = this.pendingCalls.get(delegationId) ?? [];
        list.push(
          this.runTool(item.name ?? '', this.parseArgs(item.arguments)).then(output => ({
            call_id: callId,
            output,
          })),
        );
        this.pendingCalls.set(delegationId, list);
      } else if (item.type === 'mcp_approval_request' && item.id) {
        // Native MCP servers are configured with require_approval "never"; approve any stragglers
        // only for servers the user configured.
        const known = this.config?.nativeMcp.some(
          s => s.name.replace(/[^A-Za-z0-9_-]/g, '_') === item.server_label,
        );
        this.send({
          type: 'response.item.create',
          event_id: this.nextEventId('mcp_approval'),
          item: { type: 'mcp_approval_response', approval_request_id: item.id, approve: !!known },
        });
        this.send({ type: 'response.create', event_id: this.nextEventId('resume') });
      }
      return;
    }

    if (inner.type === 'response.completed' || inner.type === 'response.done') {
      const pending = this.pendingCalls.get(delegationId);
      if (!pending?.length) return;
      this.pendingCalls.delete(delegationId);
      void Promise.all(pending).then(results => {
        for (const { call_id, output } of results) {
          this.send({
            type: 'response.item.create',
            event_id: this.nextEventId('tool_output'),
            item: { type: 'function_call_output', call_id, output },
          });
        }
        this.send({ type: 'response.create', event_id: this.nextEventId('continue') });
      });
    }
  }

  /**
   * Client delegation: run the plugin's own agent and hand the result back to the voice model.
   * @param delegationId - Id from `session.delegation.created`.
   */
  private async handleClientDelegation(delegationId: string): Promise<void> {
    const runBackend = this.config?.runBackend;
    let content: string;
    if (!runBackend) {
      content = 'The backend agent is not available.';
    } else {
      try {
        this.emit({ type: 'tool', name: 'backend agent', phase: 'start' });
        const transcript = this.transcript
          .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.trim()}`)
          .join('\n');
        content = (await runBackend(transcript)).trim() || 'Done.';
        this.emit({ type: 'tool', name: 'backend agent', phase: 'end' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ type: 'tool', name: 'backend agent', phase: 'end', error: message });
        content = `The request failed: ${message}`;
      }
    }
    this.send({
      type: 'session.commentary.append',
      event_id: this.nextEventId('commentary'),
      delegation_id: delegationId,
      content:
        content.length > APPEND_LIMIT_CHARS ? `${content.slice(0, APPEND_LIMIT_CHARS)}…` : content,
    });
  }
}
