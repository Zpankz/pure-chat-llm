import { Component, ItemView, WorkspaceLeaf, Setting, Notice, TFile, setIcon } from 'obsidian';
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
  MEMORY_TOOL_NAMES,
} from '../tools/Orchestrator';
import { voiceUnsupportedReason } from '../realtime/support';
import type { NoticeMode, SubAgentEvent } from '../agents/types';
import { TOPIC_GUIDANCE } from '../tools/TopicTool';
import { shouldInterrupt } from '../agents/relevance';
import {
  applyVoiceEvent,
  continuesTurn,
  liveLine,
  pushLine,
  settleSpeech,
  type TranscriptLine,
} from './conversationModel';
import type { OrchestratorToolEvent } from '../agents/OrchestratorAgent';
import {
  drawStatus,
  drawTaskCard,
  drawToolCard,
  drawTurnHeader,
  drawUpdate,
  renderMarkdown,
  tickElapsed,
  wireLinks,
} from './conversation';

/** Lines the pane keeps drawn; the whole call is kept for the saved notes. */
const VISIBLE_LINES = 80;

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
  /** The orchestrator's state while the layered setup is on. */
  private orchEl: HTMLElement | null = null;
  private stopAgentWatch: Array<() => void> = [];
  /** What is drawn in the transcript pane, so a change redraws only its own line. */
  private drawn = new Map<TranscriptLine, { el: HTMLElement; rev: number; continued: boolean }>();
  private drawnIn: HTMLElement | null = null;
  /** Owns what the Markdown renderer adds to the transcript; replaced on a full redraw. */
  private lineOwner: Component | null = null;
  /** Background agents whose steps the user opened. */
  private openSteps = new Set<string>();

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
    // Wikilinks anywhere in the pane open on click and preview on hover, like in a note.
    wireLinks(this.app, this, this.contentEl, VOICE_CALL_VIEW_TYPE, () => this.sourcePath());
    const tick = () => tickElapsed(this.contentEl);
    this.registerInterval(window.setInterval(tick, 1000));
    this.renderView();
  }

  /** The note links resolve from: the call's note while one is live. */
  private sourcePath(): string {
    return this.plugin.calls?.current?.callPath ?? this.app.workspace.getActiveFile()?.path ?? '';
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
    this.orchEl = contentEl.createDiv({ cls: 'va-orch' });
    this.renderOrchestrator();
    this.transcriptEl = contentEl.createDiv({ cls: 'va-conversation voice-call-transcript' });
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
            : void this.deliver(
                `[Orchestrator] ${text}`,
                'Orchestrator',
                urgency,
                !answersUser,
                text,
              ),
        ),
        () => orchestrator.setTranscriptSource(null),
        orchestrator.onTool?.(event => this.onOrchestratorTool(event)) ?? (() => {}),
        orchestrator.onChange(() => this.renderOrchestrator()),
      );
      this.renderOrchestrator();
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
      event.text,
    );
  }

  /**
   * Passes an update to the voice model, cutting in only when it bears on what the user is
   * saying right now (Hani's rule) and the timing is automatic.
   * @param text - Update for the model.
   * @param label - Line for the transcript.
   * @param mode - Delivery.
   * @param checkRelevance - Run the relevance check on `pause` updates.
   * @param detail - What the update said, shown on its card.
   */
  private async deliver(
    text: string,
    label: string,
    mode: NoticeMode,
    checkRelevance: boolean,
    detail?: string,
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
    pushLine(this.transcript, {
      role: 'tool',
      text: `${label}${finalMode === 'interrupt' ? ' (cutting in)' : ''}`,
      final: true,
      at: Date.now(),
      kind: 'update',
      urgent: finalMode === 'interrupt',
      detail,
      rev: 0,
      ...(label === 'Orchestrator' ? { by: 'orchestrator' as const } : {}),
    });
    this.renderTranscript();
    this.voiceCall?.notify(
      finalMode === 'interrupt'
        ? `${text} This bears directly on what the user is saying right now: cut in briefly and tell them.`
        : text,
      finalMode,
    );
  }

  /**
   * Shows one of the orchestrator's tool calls as a card under its own header.
   * @param event - Start or end of the call.
   */
  private onOrchestratorTool(event: OrchestratorToolEvent): void {
    const line = applyVoiceEvent(this.transcript, { type: 'tool', ...event }, Date.now());
    if (!line) return;
    line.by = 'orchestrator';
    this.renderTranscript();
  }

  /** The orchestrator's state: its model, whether it is working, and its last error. */
  private renderOrchestrator(): void {
    const el = this.orchEl;
    if (!el) return;
    el.empty();
    const orchestrator = this.plugin.orchestrator;
    if (!orchestrator?.active) {
      el.hide();
      return;
    }
    el.show();
    const thinking = orchestrator.state === 'thinking';
    el.toggleClass('is-thinking', thinking);
    el.toggleClass('is-failed', !thinking && !!orchestrator.lastError);
    setIcon(el.createSpan({ cls: 'va-orch__icon' }), 'workflow');
    el.createSpan({ cls: 'va-orch__name', text: `Orchestrator · ${orchestrator.label}` });
    if (thinking) {
      el.createSpan({ cls: 'va-orch__state', text: 'working' });
      el.createSpan({ cls: 'va-spinner' });
    } else if (orchestrator.lastError) {
      el.createSpan({ cls: 'va-orch__state', text: 'failed' });
      el.createDiv({ cls: 'va-orch__error', text: orchestrator.lastError });
    } else {
      el.createSpan({ cls: 'va-orch__state', text: 'ready' });
    }
  }

  /** Stops listening to sub-agent events. */
  private unwatchAgents(): void {
    for (const stop of this.stopAgentWatch) stop();
    this.stopAgentWatch = [];
    this.plugin.agents?.setProgressInterval(0);
  }

  /** Renders background agents as live cards: status, time, what each is doing, its result. */
  private renderTasks(): void {
    const el = this.tasksEl;
    if (!el) return;
    el.empty();
    const tasks = this.plugin.agents?.list().slice(0, 8) ?? [];
    if (!tasks.length) return;
    el.addClass('va-tasks');
    const live = tasks.filter(t => ['running', 'queued', 'waiting'].includes(t.status)).length;
    const head = el.createDiv({ cls: 'va-section-head' });
    setIcon(head.createSpan({ cls: 'va-section-head__icon' }), 'bot');
    head.createSpan({ text: 'Background agents' });
    head.createSpan({ cls: 'va-pill', text: live ? `${live} running` : `${tasks.length}` });
    for (const task of tasks) {
      const notePath = task.notePath;
      const card = drawTaskCard(this.app, this, el, task, {
        open: notePath
          ? () => void this.app.workspace.openLinkText(notePath, '', 'tab')
          : undefined,
        stop: () => this.plugin.agents.cancel(task.id),
      });
      card.setAttr('title', describeTask(task));
      const steps = card.querySelector<HTMLDetailsElement>('details.va-steps');
      if (steps) {
        if (this.openSteps.has(task.id)) steps.open = true;
        steps.addEventListener('toggle', () => {
          if (steps.open) this.openSteps.add(task.id);
          else this.openSteps.delete(task.id);
        });
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
          .filter(
            t =>
              ORCHESTRATOR_TOOL_NAMES.includes(t.function.name) ||
              MEMORY_TOOL_NAMES.includes(t.function.name),
          );
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
      // What the agents learned in earlier sessions, and how to use the shared memory.
      if (this.chat) {
        const memory = this.plugin.memory?.brief();
        if (memory) instructions += `\n\n${memory}`;
      }

      const config: VoiceCallConfig = {
        apiKey: providerEndpoint.apiKey,
        instructions,
        tools,
        settings: voice,
        nativeMcp,
        ...(layered ? { backendGuidance: VOICE_LAYER_GUIDANCE } : {}),
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
    if (!applyVoiceEvent(this.transcript, event, Date.now())) return;
    // The whole call is kept for the saved call note; the pane shows the last lines.
    if (this.transcript.length > 5000) this.transcript.splice(0, this.transcript.length - 5000);
    this.renderTranscript();
  }

  /**
   * Draws the transcript: the user's turns on the right, the agent's on the left with its tool,
   * skill and agent cards under them. Only lines that changed are redrawn.
   */
  private renderTranscript(): void {
    const el = this.transcriptEl;
    if (!el) return;
    if (el !== this.drawnIn) {
      el.empty();
      this.drawn.clear();
      this.drawnIn = el;
      if (this.lineOwner) this.removeChild(this.lineOwner);
      this.lineOwner = this.addChild(new Component());
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    const visible = this.transcript.slice(-VISIBLE_LINES);
    const keep = new Set(visible);
    for (const [line, entry] of this.drawn) {
      if (!keep.has(line)) {
        entry.el.remove();
        this.drawn.delete(line);
      }
    }
    if (!visible.length) {
      const empty =
        el.querySelector<HTMLElement>(':scope > .va-empty') ?? el.createDiv({ cls: 'va-empty' });
      empty.setText(
        this.callState.status === 'connected' ? 'Listening…' : 'The conversation shows here.',
      );
      return;
    }
    el.querySelector(':scope > .va-empty')?.remove();
    let prevEl: HTMLElement | null = null;
    visible.forEach((line, i) => {
      const continued = continuesTurn(visible[i - 1], line);
      const rev = line.rev ?? 0;
      const entry = this.drawn.get(line);
      if (entry && entry.rev === rev && entry.continued === continued) {
        prevEl = entry.el;
        return;
      }
      const row = this.drawLine(line, continued);
      if (entry) entry.el.replaceWith(row);
      else if (prevEl) prevEl.after(row);
      else el.prepend(row);
      this.drawn.set(line, { el: row, rev, continued });
      prevEl = row;
    });
    // The caret marks the one line still being spoken, never every unfinished line.
    const live = liveLine(this.transcript);
    for (const [line, entry] of this.drawn) entry.el.toggleClass('is-live', line === live);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  /**
   * One transcript line as a row.
   * @param line - Line.
   * @param continued - It continues the same speaker's turn.
   */
  private drawLine(line: TranscriptLine, continued: boolean): HTMLElement {
    const owner = this.lineOwner ?? this;
    const path = this.sourcePath();
    const row = this.contentEl.doc.createElement('div');
    if (line.kind === 'status') {
      row.addClass('va-row', 'va-row--status');
      drawStatus(row, line.text);
      return row;
    }
    const who = line.role === 'user' ? 'user' : 'agent';
    if (line.by === 'orchestrator') row.addClass('va-by-orchestrator');
    row.addClass('va-row', `va-row--${who}`);
    if (continued) row.addClass('is-continued');
    else if (line.by === 'orchestrator')
      drawTurnHeader(row, 'orchestrator', 'Orchestrator', line.at);
    else drawTurnHeader(row, who, who === 'user' ? 'You' : 'Voice Agent', line.at);
    if (line.kind === 'tool' && line.tool) {
      drawToolCard(this.app, owner, row, line.tool, path);
    } else if (line.kind === 'update' || (line.role === 'tool' && !line.kind)) {
      drawUpdate(
        this.app,
        owner,
        row,
        line.text.replace(/ \(cutting in\)$/, ''),
        line.detail,
        !!line.urgent,
        path,
      );
    } else {
      const bubble = row.createDiv({ cls: `va-bubble va-bubble--${who}` });
      if (line.final) renderMarkdown(this.app, owner, line.text, bubble, path);
      else {
        bubble.addClass('is-interim');
        bubble.createSpan({ text: line.text });
        bubble.createSpan({ cls: 'va-caret' });
      }
    }
    return row;
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
    if (state.status !== 'connected' && state.status !== 'connecting')
      settleSpeech(this.transcript);
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
