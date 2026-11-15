import { ItemView, WorkspaceLeaf, Setting, Notice, TFile } from 'obsidian';
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

interface TranscriptLine {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  final: boolean;
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
            .onClick(() => {
              void this.startCall();
            }),
        );
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
    return this.plugin.settings.agentMode
      ? 'You are a helpful AI assistant with access to tools in Obsidian.'
      : 'You are a helpful assistant.';
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
    const chat = this.chat ?? new PureChatLLMChat(this.plugin);
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
   *
   */
  private async startCall(): Promise<void> {
    try {
      if (!this.remoteAudioElement) {
        this.createRemoteAudioElement(this.contentEl);
      }
      const voice = this.plugin.settings.voice;
      const info = VOICE_PROVIDERS[voice.provider] ?? VOICE_PROVIDERS['openai-realtime'];

      // 1. API key from the matching endpoint
      const providerEndpoint = this.plugin.settings.endpoints.find(
        ep => ep.name === info.keyEndpoint,
      );
      if (!providerEndpoint?.apiKey || providerEndpoint.apiKey === EmptyApiKey) {
        throw new Error(`No API key for ${info.keyEndpoint}. Add one in settings.`);
      }

      // 2. Tools (agent mode)
      let tools: ToolDefinition[] = [];
      let nativeMcp = this.plugin.mcp?.nativeServers() ?? [];
      if (this.plugin.settings.agentMode) {
        this.chat = new PureChatLLMChat(this.plugin);
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
      if (tools.length || nativeMcp.length) instructions += `\n\n${VOICE_TOOL_GUIDANCE}`;

      const config: VoiceCallConfig = {
        apiKey: providerEndpoint.apiKey,
        instructions,
        tools,
        settings: voice,
        nativeMcp,
        runBackend: transcript => this.runClientBackend(transcript),
      };

      this.transcript = [];
      this.voiceCall = new VoiceCall(
        this.createProvider(info.id),
        config,
        state => this.onCallStateChange(state),
        event => this.onVoiceEvent(event),
        stream => this.handleRemoteStream(stream),
      );

      await this.voiceCall.startCall();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to start call:', msg);
      new Notice(`Failed to start call: ${msg}`);
      this.callState.error = msg;
      this.renderView();
    }
  }

  /**
   * Updates the live transcript from provider events.
   * @param event - Normalised voice event.
   */
  private onVoiceEvent(event: VoiceEvent): void {
    if (event.type === 'transcript') {
      const last = this.transcript[this.transcript.length - 1];
      if (last && last.role === event.role && !last.final) {
        last.text = event.text;
        last.final = event.final;
      } else if (event.text.trim()) {
        this.transcript.push({ role: event.role, text: event.text, final: event.final });
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
      });
    } else if (event.type === 'status') {
      this.transcript.push({ role: 'tool', text: event.text, final: true });
    } else {
      return;
    }
    if (this.transcript.length > 200) this.transcript.splice(0, this.transcript.length - 200);
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
    if (this.voiceCall) {
      await this.voiceCall.endCall();
      this.voiceCall = null;
    }
  }

  /**
   *
   * @param state
   */
  private onCallStateChange(state: CallState): void {
    this.callState = state;
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
