import { ItemView, WorkspaceLeaf, Setting, Notice, TFile } from 'obsidian';
import { diagnostics } from '../diagnostics/DiagnosticsLog';
import { VoiceCall } from '../realtime/VoiceCall';
import {
  GeminiLiveProvider,
  OpenAILiveProvider,
  OpenAIRealtimeProvider,
  XaiVoiceProvider,
} from '../realtime/providers';
import { PureChatLLMChat } from '../core/Chat';
import {
  CallState,
  ChatRequestOptions,
  PURE_CHAT_LLM_ICON_NAME,
  ToolDefinition,
  VOICE_CALL_VIEW_TYPE,
  VoiceProviderId,
} from '../types';
import type {
  IVoiceCallProvider,
  VoiceCallConfig,
  VoiceEvent,
} from '../realtime/providers/IVoiceCallProvider';
import PureChatLLM from '../main';
import { EmptyApiKey } from 'src/assets/constants';
import { ChatToolExecutor } from '../realtime/ChatToolExecutor';
import { VOICE_PROVIDERS } from '../realtime/voiceCatalog';
import { selectVoiceTools, VOICE_TOOL_GUIDANCE } from '../realtime/toolAdapters';
import {
  describeTask,
  ORCHESTRATOR_GUIDANCE,
  VOICE_LAYER_GUIDANCE,
  VOICE_LAYER_TOOL_NAMES,
  ORCHESTRATOR_TOOL_NAMES,
} from '../tools/Orchestrator';
import { voiceUnsupportedReason } from '../realtime/support';
import type { NoticeMode, SubAgentEvent } from '../agents/types';
import { TOPIC_GUIDANCE } from '../tools/TopicTool';
import { shouldInterrupt } from '../agents/relevance';

/**
 * Turns a sub-agent event into the message the voice model receives.
 * @param event - Event.
 */
export function formatAgentUpdate(event: SubAgentEvent): string {
  const head = `[Agent update] ${event.title} (${event.taskId})`;
  const text = event.text.replace(/\s+/g, ' ').trim();
  switch (event.kind) {
    case 'finished':
      return `${head} finished. Result: ${text.slice(0, 700)}${text.length > 700 ? '… (call get_task_result for the rest)' : ''}`;
    case 'needs_advice':
      return `${head} needs advice: ${text} Ask the user unless the answer is already clear, then reply with message_task.`;
    case 'stuck':
      return `${head} looks stuck: ${text} Decide whether to steer it with message_task, cancel it, or ask the user.`;
    case 'checkpoint':
      return `${head} check-in: ${text} If it is heading the wrong way, steer it with message_task.`;
    case 'failed':
      return `${head} failed: ${text}`;
    case 'cancelled':
      return `${head} was cancelled.`;
    case 'started':
      return `${head} started.`;
    default:
      return `${head} progress: ${text}`;
  }
}

interface TranscriptLine {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  final: boolean;
  at?: number;
}

/**
 * Side panel view for managing voice calls in Obsidian.
 */
export class VoiceCallSideView extends ItemView {
  private voiceCall: VoiceCall | null = null;
  private chat: PureChatLLMChat | null = null;
  private toolExecutor: ChatToolExecutor | null = null;
  private transcript: TranscriptLine[] = [];
  private transcriptEl: HTMLElement | null = null;
  private callState: CallState = {
    status: 'idle',
    isMuted: false,
    isLocalAudioEnabled: false,
    remoteParticipants: [],
  };
  private remoteAudioElement: HTMLAudioElement | null = null;
  private tasksEl: HTMLElement | null = null;
  private stopAgentWatch: Array<() => void> = [];

  /**
   *
   * @param leaf
   * @param plugin
   */
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PureChatLLM,
  ) {
    super(leaf);
    this.icon = 'phone';
    this.navigation = false;
  }

  /**
   *
   */
  getViewType(): string {
    return VOICE_CALL_VIEW_TYPE;
  }

  /**
   *
   */
  getDisplayText(): string {
    return 'Voice call';
  }

  /**
   *
   */
  async onOpen(): Promise<void> {
    this.renderView();
  }

  /**
   *
   */
  private renderView(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('voice-call-view');

    this.renderHeader(contentEl);
    this.renderStatus(contentEl);
    this.renderControls(contentEl);
    this.createRemoteAudioElement(contentEl);
    this.transcriptEl = contentEl.createDiv({ cls: 'voice-call-transcript' });
    this.renderTranscript();
    this.tasksEl = contentEl.createDiv({ cls: 'voice-call-tasks' });
    this.renderTasks();

    if (this.callState.status === 'idle') {
      this.renderInstructions(contentEl);
    }
  }

  /**
   *
   * @param container
   */
  private renderHeader(container: HTMLElement): void {
    new Setting(container)
      .setName('Voice call')
      .setClass('PUREfloattop')
      .setHeading()
      .addExtraButton(btn =>
        btn
          .setIcon('settings')
          .setTooltip('Open settings')
          .onClick(() => this.plugin.openSettings()),
      )
      .addExtraButton(btn =>
        btn
          .setIcon(PURE_CHAT_LLM_ICON_NAME)
          .setTooltip('Open conversation view')
          .onClick(() => this.plugin.activateChatView()),
      )
      .addExtraButton(btn =>
        btn
          .setIcon('list-tree')
          .setTooltip('Open resolution tree view')
          .onClick(() => this.plugin.activateBlueResolutView()),
      );
  }

  /**
   *
   * @param container
   */
  private renderStatus(container: HTMLElement): void {
    const statusContainer = container.createDiv({ cls: 'voice-call-status' });
    const statusText = this.getStatusText(this.callState.status);

    statusContainer.createEl('div', { cls: 'status-indicator' }, el => {
      const statusIndicator = el.createEl('span', {
        cls: `status-icon status-icon-${this.callState.status}`,
      });

      // Add spinner for connecting state
      if (this.callState.status === 'connecting') {
        statusIndicator.addClass('status-spinner');
      }

      el.createEl('span', { cls: 'status-text', text: statusText });
    });

    if (this.callState.error) {
      statusContainer.createEl('div', {
        cls: 'status-error',
        text: `Error: ${this.callState.error}`,
      });
    }
  }

  /**
   *
   * @param container
   */
  private renderControls(container: HTMLElement): void {
    const controlsContainer = container.createDiv({ cls: 'voice-call-controls' });

    if (this.callState.status === 'idle' || this.callState.status === 'disconnected') {
      const unsupported = voiceUnsupportedReason(this.plugin.settings.voice.provider);
      new Setting(controlsContainer)
        .addDropdown(dropdown => {
          for (const info of Object.values(VOICE_PROVIDERS))
            dropdown.addOption(info.id, info.label);
          dropdown.setValue(this.plugin.settings.voice.provider).onChange(async value => {
            this.plugin.settings.voice.provider = value as VoiceProviderId;
            await this.plugin.saveSettings();
            this.renderView();
          });
        })
        .addButton(btn =>
          btn
            .setButtonText('Start call')
            .setCta()
            .setDisabled(!!unsupported)
            .onClick(() => {
              void this.startCall();
            }),
        );
      if (unsupported)
        controlsContainer.createEl('p', { cls: 'setting-item-description', text: unsupported });
    }

    if (this.callState.status === 'error') {
      new Setting(controlsContainer).addButton(btn =>
        btn
          .setButtonText('Try again')
          .setCta()
          .setIcon('refresh-cw')
          .onClick(() => {
            this.resetCallState();
          }),
      );
    }

    if (this.callState.status === 'connected' || this.callState.status === 'connecting') {
      new Setting(controlsContainer)
        .addButton(btn =>
          btn
            .setButtonText(this.callState.isMuted ? 'Unmute' : 'Mute')
            .setIcon(this.callState.isMuted ? 'mic-off' : 'mic')
            .onClick(() => this.toggleMute()),
        )
        .addButton(btn =>
          btn
            .setButtonText('End call')
            .setWarning()
            .setIcon('phone-off')
            .onClick(() => {
              void this.endCall();
            }),
        );
    }
  }

  /**
   *
   * @param container
   */
  private renderInstructions(container: HTMLElement): void {
    const instructionsEl = container.createDiv({ cls: 'voice-call-instructions' });
    new Setting(instructionsEl).setName('How to use').setHeading();
    instructionsEl.createEl('p', { text: '1. Click "start call" to initiate a new voice call' });
    instructionsEl.createEl('p', { text: '2. Use "mute" to toggle your microphone' });
    instructionsEl.createEl('p', { text: '3. Click "end call" to disconnect' });

    if (this.plugin.settings.agentMode) {
      instructionsEl.createEl('p', {
        cls: 'tool-info',
        text: 'Agent mode enabled: AI can access tools.',
      });
    }
  }

  /**
   *
   * @param container
   */
  private createRemoteAudioElement(container: HTMLElement): void {
    if (!this.remoteAudioElement) {
      this.remoteAudioElement = container.createEl('audio', {
        attr: {
          autoplay: 'true',
          playsinline: 'true',
        },
      });
      this.remoteAudioElement.setCssProps({ display: 'none' });
      this.remoteAudioElement.addEventListener('error', e => {
        console.error('Audio playback error:', e);
      });
    }
  }

  /**
   * Get default system prompt based on agent mode
   */
  private getDefaultSystemPrompt(): string {
    return this.plugin.settings.agentMode ||
      this.plugin.settings.orchestrator.voiceRole !== 'direct'
      ? "You are a voice assistant for the user's Obsidian vault, a personal knowledge base of linked Markdown notes. Talk naturally and briefly."
      : 'You are a helpful voice assistant. Talk naturally and briefly.';
  }

  /**
   * Read system prompt from configured file or return default
   */
  private async getRealtimeSystemPrompt(): Promise<string> {
    const filePath = this.plugin.settings.realtimeSystemPromptFile;

    // If no file path configured, use default based on agent mode
    if (!filePath || filePath.trim() === '') {
      return this.getDefaultSystemPrompt();
    }

    // Try to read the file
    try {
      const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile)) {
        // File not found - use default and notify user
        new Notice(`Realtime prompt file not found: ${filePath}. Using default.`);
        return this.getDefaultSystemPrompt();
      }

      const content = await this.plugin.app.vault.cachedRead(file);

      // If file is empty, use default
      if (!content || content.trim() === '') {
        new Notice(`Realtime prompt file is empty: ${filePath}. Using default.`);
        return this.getDefaultSystemPrompt();
      }

      return content.trim();
    } catch (error) {
      // Error reading file - use default and notify user
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`Error reading realtime prompt file: ${msg}. Using default.`);
      return this.getDefaultSystemPrompt();
    }
  }

  /**
   * Creates the provider object for the selected provider.
   * @param id - Provider id.
   */
  private createProvider(id: VoiceProviderId): IVoiceCallProvider {
    const executor = this.toolExecutor ?? undefined;
    switch (id) {
      case 'openai-live':
        return new OpenAILiveProvider(executor);
      case 'gemini-live':
        return new GeminiLiveProvider(executor);
      case 'xai-voice':
        return new XaiVoiceProvider(executor);
      default:
        return new OpenAIRealtimeProvider(executor);
    }
  }

  /**
   * Runs one backend turn for GPT-Live client delegation with the default chat provider.
   * @param transcript - Recent conversation.
   */
  private async runClientBackend(transcript: string): Promise<string> {
    const chat =
      this.chat ??
      Object.assign(new PureChatLLMChat(this.plugin), { role: 'direct-voice' as const });
    const tools: ToolDefinition[] = this.plugin.settings.agentMode
      ? chat.toolregistry.getEnabledDefinitions()
      : [];
    const options: ChatRequestOptions = {
      model: chat.endpoint.defaultmodel,
      max_completion_tokens: this.plugin.settings.defaultmaxTokens,
      stream: false,
      messages: [
        { role: 'system', content: this.plugin.settings.voice.live.backendInstructions },
        {
          role: 'user',
          content:
            `Conversation so far (speech transcript):\n${transcript || '(empty)'}\n\n` +
            'The voice assistant handed the latest request to you. Do the work, using tools if needed, ' +
            'then reply with what the assistant should tell the user, in plain spoken language and under 120 words.',
        },
      ],
      ...(tools.length ? { tools } : {}),
    };
    const response = await chat.sendChatRequest(options);
    return response.content ?? '';
  }

  /**
   * GPT-Live client delegation in orchestrator mode: the hand-off becomes a background task, and
   * the voice model hears back when it finishes.
   * @param transcript - Recent conversation.
   */
  private delegateFromTranscript(transcript: string): Promise<string> {
    const lines = transcript.split('\n').filter(Boolean);
    const lastUser =
      [...lines].reverse().find(l => l.startsWith('User:')) ?? lines[lines.length - 1] ?? '';
    const title =
      lastUser
        .replace(/^User:\s*/, '')
        .split(/\s+/)
        .slice(0, 6)
        .join(' ') || 'Voice request';
    const task = this.plugin.agents.spawn(
      title,
      `The user asked this in a voice conversation. Do what the latest request asks.\n\nConversation so far:\n${transcript || '(empty)'}`,
      'voice',
    );
    return Promise.resolve(
      `I've handed that to a background agent (${task.id}, "${task.title}"). I'll tell you when it's done.`,
    );
  }

  /**
   * GPT-Live client delegation in the layered setup: the hand-off goes to the orchestrator agent.
   * @param transcript - Recent conversation.
   */
  private relayFromTranscript(transcript: string): Promise<string> {
    const lines = transcript.split('\n').filter(Boolean);
    const lastUser =
      [...lines].reverse().find(l => l.startsWith('User:')) ?? lines[lines.length - 1] ?? '';
    return Promise.resolve(
      this.plugin.orchestrator.relay(lastUser.replace(/^User:\s*/, '') || transcript, true),
    );
  }

  /**
   * Speaks sub-agent events routed as interrupts and keeps the task list current. In the layered
   * setup task events go to the orchestrator agent instead; the voice hears what the orchestrator
   * says, plus the periodic progress summaries the user asked for.
   * @param layered - Layered setup.
   */
  private watchAgents(layered = false): void {
    this.unwatchAgents();
    const agents = this.plugin.agents;
    this.stopAgentWatch.push(
      agents.onInterrupt((event, mode) => {
        if (!layered || event.tick) void this.relayAgentEvent(event, mode);
      }),
      agents.onChange(() => this.renderTasks()),
    );
    agents.setProgressInterval(this.plugin.settings.orchestrator.progressUpdateSeconds);
    if (layered) {
      const orchestrator = this.plugin.orchestrator;
      orchestrator.setTranscriptSource(() =>
        this.transcript
          .filter(l => l.final && (l.role === 'user' || l.role === 'assistant'))
          .map(l => `${l.role === 'user' ? 'User' : 'Assistant'}: ${l.text}`),
      );
      this.stopAgentWatch.push(
        // The answer to what the user just asked skips the relevance check: they are waiting
        // for it, and the check would only add a model round trip (system review D1).
        orchestrator.onSay((text, urgency, answersUser) =>
          text.startsWith('[Orchestrator activity]')
            ? this.voiceCall?.notify(text, 'silent')
            : void this.deliver(`[Orchestrator] ${text}`, 'Orchestrator', urgency, !answersUser),
        ),
        () => orchestrator.setTranscriptSource(null),
      );
      return;
    }
    // Tell the model about anything that happened while no call was open.
    const held = agents.takeQueuedUpdates();
    if (held.length) this.voiceCall?.notify(held.map(formatAgentUpdate).join('\n'), 'pause');
  }

  /**
   * Passes an event to the voice model. A result or question that would be said at the next
   * pause is checked against what the user is saying right now: if it would overrule or change
   * their point, it cuts in; otherwise it waits until they finish the thought.
   * @param event - Sub-agent event.
   * @param mode - Delivery the routes chose.
   */
  private relayAgentEvent(event: SubAgentEvent, mode: NoticeMode): Promise<void> {
    const auto = (this.plugin.settings.orchestrator.routes[event.kind] ?? 'auto') === 'auto';
    return this.deliver(
      formatAgentUpdate(event),
      `${event.title}: ${event.kind.replace('_', ' ')}`,
      mode,
      auto && !event.tick,
    );
  }

  /**
   * Passes an update to the voice model, cutting in only when it bears on what the user is
   * saying right now (Hani's rule) and the timing is automatic.
   * @param text - Update for the model.
   * @param label - Line for the transcript.
   * @param mode - Delivery.
   * @param checkRelevance - Run the relevance check on `pause` updates.
   */
  private async deliver(
    text: string,
    label: string,
    mode: NoticeMode,
    checkRelevance: boolean,
  ): Promise<void> {
    const o = this.plugin.settings.orchestrator;
    let finalMode = mode;
    if (mode === 'pause' && checkRelevance) {
      const recent = this.transcript
        .filter(l => l.role === 'user' && (l.at ?? 0) > Date.now() - 10_000)
        .map(l => l.text)
        .join(' ');
      if (recent && (await shouldInterrupt(this.plugin, text, recent, o.relevanceCheck))) {
        finalMode = 'interrupt';
      }
    }
    this.transcript.push({
      role: 'tool',
      text: `${label}${finalMode === 'interrupt' ? ' (cutting in)' : ''}`,
      final: true,
      at: Date.now(),
    });
    this.renderTranscript();
    this.voiceCall?.notify(
      finalMode === 'interrupt'
        ? `${text} This bears directly on what the user is saying right now: cut in briefly and tell them.`
        : text,
      finalMode,
    );
  }

  /** Stops listening to sub-agent events. */
  private unwatchAgents(): void {
    for (const stop of this.stopAgentWatch) stop();
    this.stopAgentWatch = [];
    this.plugin.agents?.setProgressInterval(0);
  }

  /** Renders background tasks with links to their notes. */
  private renderTasks(): void {
    const el = this.tasksEl;
    if (!el) return;
    el.empty();
    const tasks = this.plugin.agents?.list().slice(0, 8) ?? [];
    if (!tasks.length) return;
    new Setting(el).setName('Background tasks').setHeading();
    for (const task of tasks) {
      const row = el.createDiv({ cls: `voice-call-task voice-call-task-${task.status}` });
      row.createSpan({ cls: 'voice-call-task-status', text: task.status });
      const name = row.createSpan({ cls: 'voice-call-task-title', text: task.title });
      if (task.notePath) {
        name.addClass('is-clickable');
        name.setAttr('title', describeTask(task));
        name.onclick = () =>
          void this.app.workspace.openLinkText(task.notePath as string, '', 'tab');
      }
      if (task.status === 'running' || task.status === 'queued' || task.status === 'waiting') {
        const stop = row.createEl('button', { text: 'Stop', cls: 'voice-call-task-stop' });
        stop.onclick = () => this.plugin.agents.cancel(task.id);
      }
    }
  }

  /**
   *
   */
  private async startCall(): Promise<void> {
    try {
      if (!this.remoteAudioElement) {
        this.createRemoteAudioElement(this.contentEl);
      }
      const voice = this.plugin.settings.voice;
      const info = VOICE_PROVIDERS[voice.provider] ?? VOICE_PROVIDERS['openai-realtime'];

      // 0. Can this device make the call at all? (Obsidian on phones may lack the APIs.)
      const unsupported = voiceUnsupportedReason(info.id);
      if (unsupported) throw new Error(unsupported);

      // 1. API key from the matching endpoint
      const providerEndpoint = this.plugin.settings.endpoints.find(
        ep => ep.name === info.keyEndpoint,
      );
      if (!providerEndpoint?.apiKey || providerEndpoint.apiKey === EmptyApiKey) {
        throw new Error(`No API key for ${info.keyEndpoint}. Add one in settings.`);
      }

      await this.plugin.mcp?.freshenNativeTokens();

      // 2. Tools: the layered voice only relays; an orchestrator voice only delegates.
      const role = this.plugin.settings.orchestrator.voiceRole;
      const layered = role === 'layered';
      const orchestrator = role === 'orchestrator';
      let tools: ToolDefinition[] = [];
      let nativeMcp = this.plugin.mcp?.nativeServers() ?? [];
      if (layered) {
        this.chat = new PureChatLLMChat(this.plugin);
        this.chat.role = 'voice';
        this.chat.registerAvailableTools();
        this.toolExecutor = new ChatToolExecutor(this.chat);
        tools = this.chat.toolregistry
          .getEnabledDefinitions()
          .filter(t => VOICE_LAYER_TOOL_NAMES.includes(t.function.name));
        nativeMcp = [];
      } else if (orchestrator) {
        this.chat = new PureChatLLMChat(this.plugin);
        this.chat.role = 'orchestrator';
        this.chat.registerAvailableTools();
        this.toolExecutor = new ChatToolExecutor(this.chat);
        tools = this.chat.toolregistry
          .getEnabledDefinitions()
          .filter(t => ORCHESTRATOR_TOOL_NAMES.includes(t.function.name));
        nativeMcp = [];
      } else if (this.plugin.settings.agentMode) {
        this.chat = new PureChatLLMChat(this.plugin);
        // A voice model calling tools itself: confirmations are asked aloud, never in a modal.
        this.chat.role = 'direct-voice';
        this.toolExecutor = new ChatToolExecutor(this.chat);
        const selected = selectVoiceTools(
          this.chat.toolregistry,
          voice,
          info.id,
          this.plugin.mcp?.servers ?? [],
        );
        tools = selected.tools;
        nativeMcp = selected.nativeMcp;
      } else {
        this.chat = null;
        this.toolExecutor = null;
        nativeMcp = [];
      }

      // 3. Instructions
      let instructions = await this.getRealtimeSystemPrompt();
      if (layered) instructions += `\n\n${VOICE_LAYER_GUIDANCE}`;
      else if (orchestrator) instructions += `\n\n${ORCHESTRATOR_GUIDANCE}`;
      else if (tools.length || nativeMcp.length) instructions += `\n\n${VOICE_TOOL_GUIDANCE}`;
      if (tools.some(t => t.function.name === 'new_topic')) instructions += `\n\n${TOPIC_GUIDANCE}`;

      const config: VoiceCallConfig = {
        apiKey: providerEndpoint.apiKey,
        instructions,
        tools,
        settings: voice,
        nativeMcp,
        runBackend: transcript =>
          layered
            ? this.relayFromTranscript(transcript)
            : orchestrator
              ? this.delegateFromTranscript(transcript)
              : this.runClientBackend(transcript),
      };

      this.transcript = [];
      this.voiceCall = new VoiceCall(
        this.createProvider(info.id),
        config,
        state => this.onCallStateChange(state),
        event => this.onVoiceEvent(event),
        stream => this.handleRemoteStream(stream),
      );

      if (!(await this.voiceCall.startCall())) return;
      this.plugin.calls?.start(info.label, () => this.transcript);
      if (layered || orchestrator) this.watchAgents(layered);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to start call:', msg);
      new Notice(msg, 10000);
      this.callState.error = msg;
      this.renderView();
    }
  }

  /**
   * Updates the live transcript from provider events.
   * @param event - Normalised voice event.
   */
  private onVoiceEvent(event: VoiceEvent): void {
    if (event.type === 'transcript' && event.final && event.text.trim()) {
      diagnostics.record('voice', 'transcript', { role: event.role, text: event.text });
    } else if (event.type === 'status') {
      diagnostics.record('voice', 'status', { text: event.text });
    } else if (event.type === 'tool' && event.error) {
      diagnostics.record('voice', 'tool-error', { name: event.name, error: event.error });
    }
    if (event.type === 'transcript') {
      const last = this.transcript[this.transcript.length - 1];
      if (last && last.role === event.role && !last.final) {
        last.text = event.text;
        last.final = event.final;
        last.at = Date.now();
      } else if (event.text.trim()) {
        this.transcript.push({
          role: event.role,
          text: event.text,
          final: event.final,
          at: Date.now(),
        });
      }
    } else if (event.type === 'tool') {
      this.transcript.push({
        role: 'tool',
        text:
          event.phase === 'start'
            ? `Running ${event.name}…`
            : event.error
              ? `${event.name} failed: ${event.error}`
              : `${event.name} finished`,
        final: true,
        at: Date.now(),
      });
    } else if (event.type === 'status') {
      this.transcript.push({ role: 'tool', text: event.text, final: true, at: Date.now() });
    } else {
      return;
    }
    // The whole call is kept for the saved call note; the pane shows the last lines.
    if (this.transcript.length > 5000) this.transcript.splice(0, this.transcript.length - 5000);
    this.renderTranscript();
  }

  /** Renders the transcript pane. */
  private renderTranscript(): void {
    const el = this.transcriptEl;
    if (!el) return;
    el.empty();
    for (const line of this.transcript.slice(-60)) {
      el.createDiv({
        cls: `voice-call-line voice-call-line-${line.role}`,
        text:
          line.role === 'tool' ? line.text : `${line.role === 'user' ? 'You' : 'AI'}: ${line.text}`,
      });
    }
    el.scrollTop = el.scrollHeight;
  }

  /**
   *
   * @param stream
   */
  private handleRemoteStream(stream: MediaStream): void {
    if (this.remoteAudioElement) {
      this.remoteAudioElement.srcObject = stream;
      this.remoteAudioElement.play().catch(err => {
        console.error('Auto-play failed:', err);
        new Notice('Click to enable audio.');
      });
    }
  }

  /**
   *
   */
  private toggleMute(): void {
    this.voiceCall?.toggleMute();
  }

  /**
   *
   */
  private async endCall(): Promise<void> {
    this.unwatchAgents();
    // Tool calls still running for the call are stopped, so nothing lands after hang-up.
    this.toolExecutor?.cancel();
    if (this.voiceCall) {
      await this.voiceCall.endCall();
      this.voiceCall = null;
    }
    await this.saveCallNotes();
  }

  /** Writes the call's notes (transcript, orchestrator and sub-threads) once the call ends. */
  private async saveCallNotes(): Promise<void> {
    const calls = this.plugin.calls;
    if (!calls?.isLive) return;
    await calls.finish();
    if (calls.current) new Notice(`Call saved to ${calls.current.callPath}`);
  }

  /**
   *
   * @param state
   */
  private onCallStateChange(state: CallState): void {
    this.callState = state;
    // A call that drops on its own is saved too.
    if (state.status === 'disconnected' || state.status === 'error') void this.saveCallNotes();
    this.renderView();
  }

  /**
   *
   */
  private resetCallState(): void {
    if (this.voiceCall) {
      void this.voiceCall.endCall();
      this.voiceCall = null;
    }
    this.callState = {
      status: 'idle',
      isMuted: false,
      isLocalAudioEnabled: false,
      remoteParticipants: [],
    };
    this.renderView();
  }

  /**
   *
   */
  async onClose(): Promise<void> {
    await this.endCall();
    if (this.remoteAudioElement) {
      this.remoteAudioElement.srcObject = null;
      this.remoteAudioElement = null;
    }
  }

  /**
   *
   * @param status
   */
  private getStatusText(status: CallState['status']): string {
    switch (status) {
      case 'idle':
        return 'Ready to call';
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Call active';
      case 'disconnected':
        return 'Disconnected';
      case 'error':
        return 'Connection error';
      default:
        return 'Unknown';
    }
  }
}
