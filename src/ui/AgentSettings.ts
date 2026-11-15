import { Notice, Setting } from 'obsidian';
import type PureChatLLM from '../main';
import { DEFAULT_MCP_SERVER } from '../mcp/McpManager';
import {
  LIVE_BACKEND_MODELS,
  OPENAI_TRANSCRIPTION_MODELS,
  VOICE_PROVIDERS,
  geminiSupportsScheduling,
  geminiSupportsThinking,
} from '../realtime/voiceCatalog';
import type { McpServerConfig, VoiceProviderId, VoiceToolExposure } from '../types';

/**
 * Settings sections for voice agents, the GPT-Live duplex agent, remote MCP servers,
 * Agent Skills and code mode. Every model and voice field is free text with suggestions,
 * so ids released after this version still work.
 */

type Save = () => Promise<void>;

let datalistSeq = 0;

/**
 * Adds a text input with suggestions from a datalist.
 * @param setting - Setting row.
 * @param value - Current value.
 * @param suggestions - Suggested values.
 * @param onChange - Called with the trimmed value (or the fallback when empty).
 * @param fallback - Value used when the input is cleared.
 */
function suggestText(
  setting: Setting,
  value: string,
  suggestions: string[],
  onChange: (value: string) => Promise<void>,
  fallback = '',
): Setting {
  return setting.addText(text => {
    const id = `pure-chat-llm-list-${++datalistSeq}`;
    const list = setting.controlEl.createEl('datalist', { attr: { id } });
    for (const s of suggestions) list.createEl('option', { attr: { value: s } });
    text.inputEl.setAttr('list', id);
    text
      .setPlaceholder(fallback || suggestions[0] || '')
      .setValue(value)
      .onChange(async v => onChange(v.trim() || fallback));
  });
}

/**
 * Adds a number input.
 * @param setting - Setting row.
 * @param value - Current value.
 * @param onChange - Called with the parsed value.
 * @param opts - Bounds and placeholder.
 * @param opts.min - Minimum.
 * @param opts.max - Maximum.
 * @param opts.fallback - Value when empty or invalid.
 */
function numberInput(
  setting: Setting,
  value: number,
  onChange: (value: number) => Promise<void>,
  opts: { min: number; max: number; fallback: number },
): Setting {
  return setting.addText(text => {
    text.inputEl.type = 'number';
    text
      .setPlaceholder(String(opts.fallback))
      .setValue(String(value))
      .onChange(async v => {
        const n = Number(v);
        await onChange(
          v === '' || !Number.isFinite(n)
            ? opts.fallback
            : Math.min(opts.max, Math.max(opts.min, n)),
        );
      });
  });
}

/**
 * Adds a dropdown from a list of options.
 * @param setting - Setting row.
 * @param options - Value → label pairs.
 * @param value - Current value.
 * @param onChange - Called with the selected value.
 */
function choose<T extends string>(
  setting: Setting,
  options: Record<T, string>,
  value: T,
  onChange: (value: T) => Promise<void>,
): Setting {
  return setting.addDropdown(d =>
    d
      .addOptions(options)
      .setValue(value)
      .onChange(async v => onChange(v as T)),
  );
}

/**
 * Voice agent settings: provider, tool exposure and per-provider options.
 * @param el - Container.
 * @param plugin - Plugin.
 * @param redraw - Re-renders the settings tab.
 */
export function renderVoiceSettings(
  el: HTMLElement,
  plugin: PureChatLLM,
  redraw: () => void,
): void {
  const v = plugin.settings.voice;
  const save: Save = () => plugin.saveSettings();

  new Setting(el).setName('Voice agents').setHeading();

  choose(
    new Setting(el)
      .setName('Voice provider')
      .setDesc('Used by the voice call view. The API key comes from the matching model provider.'),
    Object.fromEntries(Object.values(VOICE_PROVIDERS).map(p => [p.id, p.label])) as Record<
      VoiceProviderId,
      string
    >,
    v.provider,
    async value => {
      v.provider = value;
      await save();
      redraw();
    },
  );

  choose(
    new Setting(el)
      .setName('Tools exposed to voice models')
      .setDesc(
        'All tools: every enabled tool is sent to the voice model. Code mode: only the code mode tool (plus skills), which can call every other tool from one script. Code mode keeps the voice model’s context small.',
      ),
    { all: 'All enabled tools', codemode: 'Code mode only' } as Record<VoiceToolExposure, string>,
    v.toolExposure,
    async value => {
      v.toolExposure = value;
      await save();
    },
  );

  numberInput(
    new Setting(el)
      .setName('Max tool output for voice')
      .setDesc(
        'Characters of a tool result sent back to a voice model. Longer results are trimmed in the middle.',
      ),
    v.maxToolOutputChars,
    async n => {
      v.maxToolOutputChars = n;
      await save();
    },
    { min: 500, max: 100000, fallback: 6000 },
  );

  switch (v.provider) {
    case 'openai-realtime':
      renderOpenAIRealtime(el, plugin, save);
      break;
    case 'openai-live':
      renderOpenAILive(el, plugin, save, redraw);
      break;
    case 'gemini-live':
      renderGeminiLive(el, plugin, save, redraw);
      break;
    case 'xai-voice':
      renderXai(el, plugin, save);
      break;
  }
}

/**
 * @param el - Container.
 * @param plugin - Plugin.
 * @param save - Saves settings.
 */
function renderOpenAIRealtime(el: HTMLElement, plugin: PureChatLLM, save: Save): void {
  const s = plugin.settings.voice.openai;
  const info = VOICE_PROVIDERS['openai-realtime'];
  new Setting(el).setName('OpenAI realtime').setHeading();
  suggestText(
    new Setting(el).setName('Model'),
    s.model,
    info.models,
    async x => {
      s.model = x;
      await save();
    },
    info.models[0],
  );
  suggestText(
    new Setting(el).setName('Voice'),
    s.voice,
    info.voices,
    async x => {
      s.voice = x;
      await save();
    },
    'marin',
  );
  numberInput(
    new Setting(el).setName('Speech speed').setDesc('0.25 to 1.5.'),
    s.speed,
    async n => {
      s.speed = n;
      await save();
    },
    { min: 0.25, max: 1.5, fallback: 1 },
  );
  choose(
    new Setting(el)
      .setName('Turn detection')
      .setDesc('Semantic VAD waits until the user sounds finished; server VAD uses silence.'),
    { semantic_vad: 'Semantic VAD', server_vad: 'Server VAD', none: 'Off (push to talk)' },
    s.turnDetection,
    async x => {
      s.turnDetection = x;
      await save();
    },
  );
  choose(
    new Setting(el)
      .setName('Eagerness')
      .setDesc('Semantic VAD only: how quickly the model answers.'),
    { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' },
    s.eagerness,
    async x => {
      s.eagerness = x;
      await save();
    },
  );
  numberInput(
    new Setting(el)
      .setName('Idle timeout (ms)')
      .setDesc('Server VAD only: prompt the user after this much silence. 0 turns it off.'),
    s.idleTimeoutMs,
    async n => {
      s.idleTimeoutMs = n;
      await save();
    },
    { min: 0, max: 30000, fallback: 0 },
  );
  choose(
    new Setting(el).setName('Noise reduction'),
    { near_field: 'Near field (headset)', far_field: 'Far field (laptop mic)', none: 'Off' },
    s.noiseReduction,
    async x => {
      s.noiseReduction = x;
      await save();
    },
  );
  suggestText(
    new Setting(el)
      .setName('Input transcription model')
      .setDesc('Shows what you said. Leave empty to turn off.'),
    s.transcriptionModel,
    OPENAI_TRANSCRIPTION_MODELS,
    async x => {
      s.transcriptionModel = x;
      await save();
    },
  );
  choose(
    new Setting(el).setName('Reasoning effort').setDesc('Used only by the gpt-realtime-2 models.'),
    { default: 'Model default', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High' },
    s.reasoningEffort,
    async x => {
      s.reasoningEffort = x;
      await save();
    },
  );
}

/**
 * GPT-Live (gpt-live-1) and its full-duplex agent.
 * @param el - Container.
 * @param plugin - Plugin.
 * @param save - Saves settings.
 * @param redraw - Re-renders the settings tab.
 */
function renderOpenAILive(
  el: HTMLElement,
  plugin: PureChatLLM,
  save: Save,
  redraw: () => void,
): void {
  const s = plugin.settings.voice.live;
  const info = VOICE_PROVIDERS['openai-live'];
  new Setting(el).setName('OpenAI GPT-Live').setHeading();
  suggestText(
    new Setting(el).setName('Model'),
    s.model,
    info.models,
    async x => {
      s.model = x;
      await save();
    },
    'gpt-live-1',
  );
  suggestText(
    new Setting(el).setName('Voice'),
    s.voice,
    info.voices,
    async x => {
      s.voice = x;
      await save();
    },
    'marin',
  );
  new Setting(el)
    .setName('Store session')
    .setDesc('Keep the session in your OpenAI account’s logs.')
    .addToggle(t =>
      t.setValue(s.store).onChange(async x => {
        s.store = x;
        await save();
      }),
    );

  new Setting(el)
    .setName('Duplex agent')
    .setDesc(
      'GPT-Live keeps talking while a backend agent reasons and uses tools, then speaks the result.',
    )
    .setHeading();
  choose(
    new Setting(el)
      .setName('Agent backend')
      .setDesc(
        'Choose OpenAI to run the backend model on OpenAI with your tools, or this plugin to run it here with your default chat model and vault tools.',
      ),
    { responses: 'OpenAI Responses', client: 'This plugin (default chat model)' },
    s.delegation,
    async x => {
      s.delegation = x;
      await save();
      redraw();
    },
  );

  if (s.delegation === 'client') {
    numberInput(
      new Setting(el)
        .setName('Acknowledgement delay (ms)')
        .setDesc(
          'How long GPT-Live waits before saying it is working on it. 0 uses the model default.',
        ),
      s.acknowledgementDelayMs,
      async n => {
        s.acknowledgementDelayMs = n;
        await save();
      },
      { min: 0, max: 10000, fallback: 800 },
    );
  } else {
    suggestText(
      new Setting(el).setName('Backend model'),
      s.backendModel,
      LIVE_BACKEND_MODELS,
      async x => {
        s.backendModel = x;
        await save();
      },
      LIVE_BACKEND_MODELS[0],
    );
    choose(
      new Setting(el)
        .setName('Backend reasoning effort')
        .setDesc('Sent only when set; leave on model default if the backend rejects it.'),
      {
        default: 'Model default',
        none: 'None',
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
      },
      s.backendReasoningEffort,
      async x => {
        s.backendReasoningEffort = x;
        await save();
      },
    );
    choose(
      new Setting(el).setName('Tool choice'),
      { auto: 'Auto', required: 'Required', none: 'None' },
      s.toolChoice,
      async x => {
        s.toolChoice = x;
        await save();
      },
    );
    new Setting(el).setName('Parallel tool calls').addToggle(t =>
      t.setValue(s.parallelToolCalls).onChange(async x => {
        s.parallelToolCalls = x;
        await save();
      }),
    );
    choose(
      new Setting(el).setName('Service tier').setDesc('Priority is faster and costs more.'),
      { auto: 'Auto', priority: 'Priority' },
      s.serviceTier,
      async x => {
        s.serviceTier = x;
        await save();
      },
    );
    new Setting(el)
      .setName('Hosted web search')
      .setDesc('Let the backend use OpenAI’s web search tool.')
      .addToggle(t =>
        t.setValue(s.hostedWebSearch).onChange(async x => {
          s.hostedWebSearch = x;
          await save();
        }),
      );
  }
  new Setting(el)
    .setName('Backend instructions')
    .setDesc('System instructions for the backend agent.')
    .addTextArea(t =>
      t.setValue(s.backendInstructions).onChange(async x => {
        s.backendInstructions = x;
        await save();
      }),
    );
}

/**
 * @param el - Container.
 * @param plugin - Plugin.
 * @param save - Saves settings.
 * @param redraw - Re-renders the settings tab.
 */
function renderGeminiLive(
  el: HTMLElement,
  plugin: PureChatLLM,
  save: Save,
  redraw: () => void,
): void {
  const s = plugin.settings.voice.gemini;
  const info = VOICE_PROVIDERS['gemini-live'];
  new Setting(el).setName('Gemini live').setHeading();
  suggestText(
    new Setting(el).setName('Model'),
    s.model,
    info.models,
    async x => {
      s.model = x;
      await save();
      redraw();
    },
    info.models[0],
  );
  suggestText(
    new Setting(el).setName('Voice'),
    s.voice,
    info.voices,
    async x => {
      s.voice = x;
      await save();
    },
    'Puck',
  );
  new Setting(el)
    .setName('Language code')
    .setDesc('Leave empty to let the model choose. Uses BCP-47 tags.')
    .addText(t =>
      t.setValue(s.languageCode).onChange(async x => {
        s.languageCode = x.trim();
        await save();
      }),
    );
  if (geminiSupportsThinking(s.model)) {
    choose(
      new Setting(el).setName('Thinking level'),
      { default: 'Model default', low: 'Low', medium: 'Medium', high: 'High' },
      s.thinkingLevel,
      async x => {
        s.thinkingLevel = x;
        await save();
      },
    );
  }
  const sens = { default: 'Default', high: 'High', low: 'Low' } as const;
  choose(new Setting(el).setName('Speech start sensitivity'), sens, s.startSensitivity, async x => {
    s.startSensitivity = x;
    await save();
  });
  choose(new Setting(el).setName('Speech end sensitivity'), sens, s.endSensitivity, async x => {
    s.endSensitivity = x;
    await save();
  });
  numberInput(
    new Setting(el).setName('Silence before end of turn (ms)').setDesc('0 uses the default.'),
    s.silenceDurationMs,
    async n => {
      s.silenceDurationMs = n;
      await save();
    },
    { min: 0, max: 10000, fallback: 0 },
  );
  const toggles: Array<[keyof typeof s, string, string]> = [
    ['transcription', 'Transcripts', 'Show what you and the model said.'],
    [
      'contextCompression',
      'Context compression',
      'Sliding window so calls can run longer than the context limit.',
    ],
    [
      'sessionResumption',
      'Session resumption',
      'Reconnect without losing the conversation when the server asks.',
    ],
    [
      'proactiveAudio',
      'Proactive audio',
      'Let the model stay silent when speech is not addressed to it.',
    ],
    ['nonBlockingTools', 'Non-blocking tools', 'Keep talking while tools run.'],
    ['googleSearch', 'Google Search', 'Ground answers with Google Search.'],
  ];
  for (const [key, name, desc] of toggles) {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addToggle(t =>
        t.setValue(s[key] as boolean).onChange(async x => {
          (s[key] as boolean) = x;
          await save();
        }),
      );
  }
  if (geminiSupportsScheduling(s.model)) {
    choose(
      new Setting(el)
        .setName('Tool result timing')
        .setDesc('Non-blocking tools only: when the model speaks a finished result.'),
      { WHEN_IDLE: 'When idle', INTERRUPT: 'Interrupt', SILENT: 'Silently' },
      s.toolScheduling,
      async x => {
        s.toolScheduling = x;
        await save();
      },
    );
  }
}

/**
 * @param el - Container.
 * @param plugin - Plugin.
 * @param save - Saves settings.
 */
function renderXai(el: HTMLElement, plugin: PureChatLLM, save: Save): void {
  const s = plugin.settings.voice.xai;
  const info = VOICE_PROVIDERS['xai-voice'];
  new Setting(el).setName('Grok voice').setHeading();
  suggestText(
    new Setting(el).setName('Model'),
    s.model,
    info.models,
    async x => {
      s.model = x;
      await save();
    },
    info.models[0],
  );
  suggestText(
    new Setting(el).setName('Voice'),
    s.voice,
    info.voices,
    async x => {
      s.voice = x;
      await save();
    },
    'eve',
  );
  numberInput(
    new Setting(el).setName('Speech speed').setDesc('0.7 to 1.5.'),
    s.speed,
    async n => {
      s.speed = n;
      await save();
    },
    { min: 0.7, max: 1.5, fallback: 1 },
  );
  choose(
    new Setting(el).setName('Reasoning'),
    { high: 'High', none: 'Off (faster)' },
    s.reasoningEffort,
    async x => {
      s.reasoningEffort = x;
      await save();
    },
  );
  choose(
    new Setting(el).setName('Turn detection'),
    { server_vad: 'Server VAD', none: 'Off (push to talk)' },
    s.turnDetection,
    async x => {
      s.turnDetection = x;
      await save();
    },
  );
  new Setting(el).setName('Web search').addToggle(t =>
    t.setValue(s.webSearch).onChange(async x => {
      s.webSearch = x;
      await save();
    }),
  );
  new Setting(el).setName('X search').addToggle(t =>
    t.setValue(s.xSearch).onChange(async x => {
      s.xSearch = x;
      await save();
    }),
  );
}

/**
 * Remote MCP servers (Streamable HTTP, spec 2026-07-28 with fallback to 2025-11-25).
 * @param el - Container.
 * @param plugin - Plugin.
 * @param redraw - Re-renders the settings tab.
 */
export function renderMcpSettings(el: HTMLElement, plugin: PureChatLLM, redraw: () => void): void {
  const save: Save = () => plugin.saveSettings();
  new Setting(el)
    .setName('Remote MCP servers')
    .setDesc(
      'Streamable HTTP servers. Their tools appear under the MCP category, prefixed with the server name. Tokens are stored in this plugin’s data file.',
    )
    .setHeading()
    .addButton(b =>
      b
        .setIcon('refresh-cw')
        .setTooltip('Reconnect and list tools')
        .onClick(async () => {
          await plugin.mcp.refreshAll(true);
          redraw();
        }),
    )
    .addButton(b =>
      b
        .setButtonText('Add server')
        .setCta()
        .onClick(async () => {
          plugin.settings.mcpServers.push({
            ...DEFAULT_MCP_SERVER,
            name: `server${plugin.settings.mcpServers.length + 1}`,
          });
          await save();
          redraw();
        }),
    );

  plugin.settings.mcpServers.forEach((server, index) =>
    renderMcpServer(el, plugin, server, index, save, redraw),
  );
}

/**
 * One MCP server's settings.
 * @param el - Container.
 * @param plugin - Plugin.
 * @param server - Server config (edited in place).
 * @param index - Position in the list.
 * @param save - Saves settings.
 * @param redraw - Re-renders the settings tab.
 */
function renderMcpServer(
  el: HTMLElement,
  plugin: PureChatLLM,
  server: McpServerConfig,
  index: number,
  save: Save,
  redraw: () => void,
): void {
  const box = el.createDiv({ cls: 'pure-chat-llm-mcp-server' });
  const error = plugin.mcp.errors.get(server.name);
  const tools = plugin.mcp.toolNames(server.name);
  const status = !server.enabled
    ? 'Off'
    : error
      ? `Error: ${error.slice(0, 200)}`
      : tools.length
        ? `${tools.length} tools: ${tools.slice(0, 8).join(', ')}${tools.length > 8 ? '…' : ''}`
        : 'Not connected yet. Press refresh.';

  new Setting(box)
    .setName(server.name || `Server ${index + 1}`)
    .setDesc(status)
    .addToggle(t =>
      t.setValue(server.enabled).onChange(async x => {
        server.enabled = x;
        await save();
      }),
    )
    .addButton(b =>
      b
        .setIcon('plug-zap')
        .setTooltip('Test connection')
        .onClick(async () => {
          const list = await plugin.mcp.refresh(server);
          const err = plugin.mcp.errors.get(server.name);
          new Notice(
            err ? `MCP ${server.name}: ${err}` : `MCP ${server.name}: ${list.length} tools`,
          );
          redraw();
        }),
    )
    .addExtraButton(b =>
      b
        .setIcon('trash')
        .setTooltip('Remove')
        .onClick(async () => {
          plugin.settings.mcpServers.splice(index, 1);
          await save();
          redraw();
        }),
    );

  new Setting(box)
    .setName('Name')
    .setDesc('Letters, numbers, - and _. Used in tool names.')
    .addText(t =>
      t.setValue(server.name).onChange(async x => {
        server.name = x.trim().replace(/[^A-Za-z0-9_-]/g, '_');
        await save();
      }),
    );
  new Setting(box).setName('URL').addText(t =>
    t
      .setPlaceholder('https://example.com/mcp')
      .setValue(server.url)
      .onChange(async x => {
        server.url = x.trim();
        await save();
      }),
  );
  new Setting(box).setName('Bearer token').addText(t => {
    t.inputEl.type = 'password';
    t.setValue(server.bearerToken).onChange(async x => {
      server.bearerToken = x.trim();
      await save();
    });
  });
  new Setting(box)
    .setName('Extra headers')
    .setDesc('One header per line, written as name: value.')
    .addTextArea(t =>
      t.setValue(server.headers).onChange(async x => {
        server.headers = x;
        await save();
      }),
    );
  choose(
    new Setting(box)
      .setName('Connection')
      .setDesc(
        'Bridge: this plugin calls the server, so every model can use it. Native: OpenAI and Grok voice models call the server directly, and receive its token and headers to do so (other models still use the bridge).',
      ),
    { bridge: 'Bridge', native: 'Native where supported' },
    server.mode,
    async x => {
      server.mode = x;
      await save();
    },
  );
  new Setting(box)
    .setName('Allowed tools')
    .setDesc('Comma-separated tool names. Empty allows all.')
    .addText(t =>
      t.setValue(server.allowedTools).onChange(async x => {
        server.allowedTools = x;
        await save();
      }),
    );
}

/**
 * Agent Skills folder and code mode.
 * @param el - Container.
 * @param plugin - Plugin.
 * @param redraw - Re-renders the settings tab.
 */
export function renderSkillsAndCodeMode(
  el: HTMLElement,
  plugin: PureChatLLM,
  redraw: () => void,
): void {
  const save: Save = () => plugin.saveSettings();
  const skills = plugin.skills?.skills ?? [];
  const warnings = skills.reduce((n, s) => n + s.warnings.length, 0);

  new Setting(el).setName('Agent skills').setHeading();
  new Setting(el)
    .setName('Skills folder')
    .setDesc(
      `Each skill is a folder with a SKILL.md file (agentskills.io format). Found ${skills.length} skill${skills.length === 1 ? '' : 's'}${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`,
    )
    .addText(t =>
      t
        .setPlaceholder('Skills')
        .setValue(plugin.settings.skillsFolder)
        .onChange(async x => {
          plugin.settings.skillsFolder = x.trim() || 'Skills';
          await save();
        }),
    )
    .addButton(b =>
      b
        .setIcon('refresh-cw')
        .setTooltip('Rescan skills')
        .onClick(async () => {
          await plugin.skills.refresh();
          redraw();
        }),
    );

  const c = plugin.settings.codeMode;
  new Setting(el).setName('Code mode').setHeading();
  new Setting(el)
    .setName('Enable code mode tool')
    .setDesc(
      'Lets the model write one JavaScript script that calls several tools, in a sandboxed worker with no network access.',
    )
    .addToggle(t =>
      t.setValue(c.enabled).onChange(async x => {
        c.enabled = x;
        await save();
      }),
    );
  numberInput(
    new Setting(el).setName('Script timeout (ms)'),
    c.timeoutMs,
    async n => {
      c.timeoutMs = n;
      await save();
    },
    { min: 1000, max: 600000, fallback: 60000 },
  );
  numberInput(
    new Setting(el).setName('Max script output (characters)'),
    c.maxOutputChars,
    async n => {
      c.maxOutputChars = n;
      await save();
    },
    { min: 1000, max: 500000, fallback: 40000 },
  );
}
