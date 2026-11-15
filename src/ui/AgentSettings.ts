import { Notice, Setting } from 'obsidian';
import { layerProblem, resolveLayer } from '../agents/layers';
import type { LayerId } from '../agents/layers';
import { ChatGPTAuth } from '../auth/ChatGPTAuth';
import { persistentSecrets } from '../auth/secrets';
import type PureChatLLM from '../main';
import { DEFAULT_MCP_SERVER } from '../mcp/McpManager';
import { signIn } from '../mcp/McpOAuth';
import { djsModulePath, loadDjsModule, resetDjsModule } from '../tools/codemode/djsEngine';
import {
  LIVE_BACKEND_MODELS,
  OPENAI_TRANSCRIPTION_MODELS,
  VOICE_PROVIDERS,
  geminiSupportsScheduling,
  geminiSupportsThinking,
} from '../realtime/voiceCatalog';
import { CHATGPT_SIGN_IN } from '../types';
import type {
  LayerApi,
  McpServerConfig,
  OrchestratorSettings,
  ReasoningEffort,
  SubAgentWritePolicy,
  VoiceProviderId,
  VoiceToolExposure,
} from '../types';
import {
  AUTO_ROUTES,
  SUB_AGENT_EVENT_KINDS,
  type SubAgentEventKind,
  type SubAgentEventRoute,
} from '../agents/types';

const EVENT_LABELS: Record<SubAgentEventKind, string> = {
  started: 'Task started',
  progress: 'Progress',
  needs_advice: 'Needs advice',
  stuck: 'Looks stuck',
  checkpoint: 'Timed check-in',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const ROUTE_LABELS: Record<SubAgentEventRoute, string> = {
  auto: 'Automatic',
  interrupt: 'Cut in now',
  pause: 'Say at the next pause',
  silent: 'Tell quietly',
  queue: 'Wait until asked',
  ignore: 'Ignore',
};

/**
 * The voice model's role, part of the duplex agent's voice group.
 * @param el - Container.
 * @param plugin - Plugin.
 * @param redraw - Re-renders the settings tab.
 */
function renderVoiceRole(el: HTMLElement, plugin: PureChatLLM, redraw: () => void): void {
  const o = plugin.settings.orchestrator;
  const save: Save = () => plugin.saveSettings();
  choose(
    new Setting(el)
      .setName('Voice model role')
      .setDesc(
        'Layered: the voice model translates and filters, and passes requests to a separate orchestrator agent that plans and runs background workers (each layer keeps its own context). Orchestrator: the voice model hands work to background agents itself. Direct: the voice model calls tools itself.',
      ),
    { layered: 'Layered', orchestrator: 'Orchestrator', direct: 'Direct' } as Record<
      OrchestratorSettings['voiceRole'],
      string
    >,
    o.voiceRole,
    async value => {
      o.voiceRole = value;
      await save();
      redraw();
    },
  );
}

/**
 * Orchestrator and sub-agent settings.
 * @param el - Container.
 * @param plugin - Plugin.
 * @param redraw - Re-renders the settings tab.
 */
export function renderOrchestratorSettings(
  el: HTMLElement,
  plugin: PureChatLLM,
  redraw: () => void,
): void {
  const o = plugin.settings.orchestrator;
  const save: Save = () => plugin.saveSettings();
  // Decision 15: the duplex agent's settings in six groups. Voice (with the voice model's role)
  // is rendered by renderVoiceSettings; orchestrator, workers, evaluator, interruptions and
  // check-ins follow here.
  if (o.voiceRole === 'direct') return;

  if (o.voiceRole === 'layered') {
    renderLayer(el, plugin, 'orchestrator', redraw);
    choose(
      new Setting(el)
        .setName('Orchestrator sees the call')
        .setDesc(
          'Whole conversation: every line of the call reaches the orchestrator once, with the requests. Recent lines only: just the last few lines go with each request.',
        ),
      { full: 'Whole conversation', recent: 'Recent lines only' } as Record<
        OrchestratorSettings['voiceContext'],
        string
      >,
      o.voiceContext,
      async v => {
        o.voiceContext = v;
        await save();
        redraw();
      },
    );
    if (o.voiceContext === 'recent') {
      numberInput(
        new Setting(el).setName('Lines per request'),
        o.relayTranscriptLines,
        async n => {
          o.relayTranscriptLines = n;
          await save();
        },
        { min: 0, max: 40, fallback: 6 },
      );
    }
    numberInput(
      new Setting(el)
        .setName('Worker summary length')
        .setDesc(
          'Characters of each worker update the orchestrator gets. It opens the full thread only when it needs to.',
        ),
      o.taskSummaryChars,
      async n => {
        o.taskSummaryChars = n;
        await save();
      },
      { min: 100, max: 5000, fallback: 600 },
    );
    numberInput(
      new Setting(el)
        .setName('Orchestrator memory (messages)')
        .setDesc('Older turns of the orchestrator’s own conversation are dropped after this.'),
      o.orchestratorMaxMessages,
      async n => {
        o.orchestratorMaxMessages = n;
        await save();
      },
      { min: 20, max: 400, fallback: 80 },
    );
    new Setting(el)
      .setName('Voice sees the orchestrator’s activity')
      .setDesc(
        'The voice model is told quietly which tools the orchestrator used and which tasks it started, so it can say what is going on. It never gets their outputs or the tasks’ threads.',
      )
      .addToggle(t =>
        t.setValue(o.voiceSeesActivity).onChange(async v => {
          o.voiceSeesActivity = v;
          await save();
        }),
      );
    new Setting(el)
      .setName('Clear orchestrator memory')
      .setDesc('Starts the orchestrator’s conversation afresh. Running tasks continue.')
      .addButton(b =>
        b.setButtonText('Clear').onClick(() => {
          plugin.orchestrator.reset();
          new Notice('Orchestrator memory cleared.');
        }),
      );
  }
  renderLayer(el, plugin, 'worker', redraw);
  numberInput(
    new Setting(el).setName('Tasks at once').setDesc('The rest wait in a queue.'),
    o.maxConcurrent,
    async n => {
      o.maxConcurrent = n;
      await save();
    },
    { min: 1, max: 10, fallback: 3 },
  );
  numberInput(
    new Setting(el).setName('Steps per task').setDesc('Model responses before a task stops.'),
    o.maxSteps,
    async n => {
      o.maxSteps = n;
      await save();
    },
    { min: 1, max: 500, fallback: 40 },
  );
  new Setting(el)
    .setName('Sub-agent instructions')
    .setDesc('System prompt every background agent starts with.')
    .addTextArea(t =>
      t.setValue(o.subAgentInstructions).onChange(async value => {
        o.subAgentInstructions = value;
        await save();
      }),
    );
  new Setting(el)
    .setName('Task notes folder')
    .setDesc('Each task’s brief, steps and result are saved here. Empty saves nothing.')
    .addText(t =>
      t.setValue(o.taskFolder).onChange(async value => {
        o.taskFolder = value.trim();
        await save();
      }),
    );

  if (o.voiceRole === 'layered') renderLayer(el, plugin, 'evaluator', redraw);

  new Setting(el)
    .setName('Interruptions')
    .setDesc('How readily the voice cuts in with what the workers find.')
    .setHeading();
  choose(
    new Setting(el)
      .setName('Cut in when it matters')
      .setDesc(
        'A result or question that arrives while you are talking waits until you finish your thought, unless it would overrule or change what you are saying. Model asks the sub-agent model to judge that; keywords compares words; off always waits.',
      ),
    { model: 'Model', keywords: 'Keywords', off: 'Off' } as Record<
      'model' | 'keywords' | 'off',
      string
    >,
    o.relevanceCheck,
    async value => {
      o.relevanceCheck = value;
      await save();
    },
  );
  numberInput(
    new Setting(el)
      .setName('Spoken progress every (seconds)')
      .setDesc(
        'From the start of each call. 0 keeps the voice model quiet until something happens; you can still say "keep me posted".',
      ),
    o.progressUpdateSeconds,
    async n => {
      o.progressUpdateSeconds = n;
      await save();
    },
    { min: 0, max: 3600, fallback: 0 },
  );
  new Setting(el)
    .setName('When the voice model hears about tasks')
    .setDesc(
      'Automatic follows GPT-Live’s pattern: results, questions and stuck tasks are said at the next pause; check-ins and progress are told quietly. Override any event below.',
    );
  for (const kind of SUB_AGENT_EVENT_KINDS) {
    choose(
      new Setting(el)
        .setName(EVENT_LABELS[kind])
        .setDesc(`Automatic here means: ${ROUTE_LABELS[AUTO_ROUTES[kind]].toLowerCase()}.`),
      ROUTE_LABELS,
      o.routes[kind] ?? 'auto',
      async value => {
        o.routes[kind] = value;
        await save();
      },
    );
  }

  new Setting(el)
    .setName('Check-ins')
    .setDesc('How the orchestrator keeps an eye on quiet or stuck workers.')
    .setHeading();
  numberInput(
    new Setting(el)
      .setName('Check-in every (minutes)')
      .setDesc(
        'A running task reports what it has done so far, so the orchestrator can check it is on track. 0 turns check-ins off.',
      ),
    o.checkInMinutes,
    async n => {
      o.checkInMinutes = n;
      await save();
    },
    { min: 0, max: 240, fallback: 5 },
  );
  numberInput(
    new Setting(el)
      .setName('Stuck after')
      .setDesc(
        'Identical tool calls, or failed tool calls, in a row before a task counts as stuck.',
      ),
    o.stuckThreshold,
    async n => {
      o.stuckThreshold = n;
      await save();
    },
    { min: 2, max: 20, fallback: 3 },
  );
  numberInput(
    new Setting(el)
      .setName('Advice timeout (seconds)')
      .setDesc('How long a task waits for an answer to its question before it carries on alone.'),
    o.adviceTimeoutSeconds,
    async n => {
      o.adviceTimeoutSeconds = n;
      await save();
    },
    { min: 10, max: 3600, fallback: 300 },
  );
  renderChatGPTSignIn(el, plugin, redraw);

  new Setting(el)
    .setName('Sub-agent vault writes')
    .setDesc(
      'Two reviewers: two separate reviewer agents each see only the proposed change and decide alone; it is made only if both approve. Deleted notes go to the trash.',
    )
    .setHeading();
  const policies: Record<SubAgentWritePolicy, string> = {
    allow: 'Go ahead',
    peer: 'Two reviewers must agree',
    review: 'Ask me (edit review window)',
    deny: 'Not allowed',
  };
  const writeLabels = {
    create: 'New notes',
    edit: 'Edits to existing notes',
    delete: 'Deleting notes',
  };
  for (const action of ['create', 'edit', 'delete'] as const) {
    choose(
      new Setting(el).setName(writeLabels[action]),
      policies,
      o.writes[action],
      async value => {
        o.writes[action] = value;
        await save();
      },
    );
  }
  suggestText(
    new Setting(el)
      .setName('Reviewer models')
      .setDesc(
        'Two models, comma separated, on your default provider. Empty uses the sub-agent model for both; two different models make the verdicts more independent.',
      ),
    o.reviewerModels,
    [],
    async value => {
      o.reviewerModels = value;
      await save();
    },
  );
  new Setting(el)
    .setName('Back up notes before reviewed edits')
    .setDesc('Saves a copy in the task notes folder, in a backups folder, before an approved edit.')
    .addToggle(t =>
      t.setValue(o.backupEdits).onChange(async value => {
        o.backupEdits = value;
        await save();
      }),
    );
}

/**
 * Typed graph settings: where the ontology lives and where saved graph commands are kept.
 * @param el - Container.
 * @param plugin - Plugin.
 */
export function renderGraphSettings(el: HTMLElement, plugin: PureChatLLM): void {
  const g = plugin.settings.graph;
  const save: Save = () => plugin.saveSettings();
  new Setting(el).setName('Typed graph').setHeading();
  new Setting(el)
    .setName('Schema folder')
    .setDesc(
      'Folder of schema notes for the typed graph plugin (frontmatter with tgs, such as _types). Empty reads every note that has tgs in its frontmatter.',
    )
    .addText(t =>
      t
        .setPlaceholder('_types')
        .setValue(g.typesFolder)
        .onChange(async value => {
          g.typesFolder = value.trim();
          await save();
        }),
    );
  new Setting(el)
    .setName('Give sub-agents the ontology')
    .setDesc('Adds a short map of node and edge types to every sub-agent’s instructions.')
    .addToggle(t =>
      t.setValue(g.ontologyInPrompt).onChange(async value => {
        g.ontologyInPrompt = value;
        await save();
      }),
    );
  new Setting(el)
    .setName('Saved graph commands folder')
    .setDesc('Scripts promoted into graph commands are kept here as notes, one command per note.')
    .addText(t =>
      t.setValue(g.commandsFolder).onChange(async value => {
        g.commandsFolder = value.trim();
        await save();
      }),
    );
}

/**
 * Settings sections for voice agents, the GPT-Live duplex agent, remote MCP servers,
 * Agent Skills and code mode. Every model and voice field is free text with suggestions,
 * so ids released after this version still work.
 */

type Save = () => Promise<void>;

const LAYER_TEXT: Record<LayerId, { name: string; desc: string }> = {
  orchestrator: {
    name: 'Orchestrator',
    desc: 'Plans, writes briefs for workers and decides what you hear. Needs strong reasoning and tool calls.',
  },
  worker: {
    name: 'Workers',
    desc: 'Background sub-agents, and the two write reviewers unless reviewer models are set. A cheap, efficient model fits.',
  },
  evaluator: {
    name: 'Evaluator',
    desc: 'Optional advisor the orchestrator asks to check plans and results. It sees only what it is sent.',
  },
};

const EFFORTS: Record<ReasoningEffort, string> = {
  '': 'Provider default',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * Endpoint, model, reasoning effort and API for one layer.
 * @param el - Container.
 * @param plugin - Plugin.
 * @param id - Layer.
 * @param redraw - Re-renders the tab.
 */
function renderLayer(el: HTMLElement, plugin: PureChatLLM, id: LayerId, redraw: () => void): void {
  const layer = plugin.settings.orchestrator.layers[id];
  const save: Save = () => plugin.saveSettings();
  const text = LAYER_TEXT[id];
  const resolved = resolveLayer(plugin, id);
  const problem = layerProblem(plugin, resolved);
  new Setting(el).setName(text.name).setHeading();
  if (id === 'evaluator') {
    const ev = plugin.settings.orchestrator.layers.evaluator;
    new Setting(el)
      .setName('Use an evaluator')
      .setDesc(text.desc)
      .addToggle(t =>
        t.setValue(ev.enabled).onChange(async v => {
          ev.enabled = v;
          await save();
          redraw();
        }),
      );
    if (!ev.enabled) return;
  }
  const endpoints: Record<string, string> = { '': 'Default endpoint' };
  for (const e of plugin.settings.endpoints) endpoints[e.name] = e.name;
  endpoints[CHATGPT_SIGN_IN] = 'ChatGPT sign-in (your ChatGPT plan)';
  choose(
    new Setting(el)
      .setName('Provider')
      .setDesc(
        `${id === 'evaluator' ? '' : `${text.desc} `}Now: ${resolved.label}.${problem ? ` ${problem}` : ''}`,
      ),
    endpoints,
    layer.endpoint in endpoints ? layer.endpoint : '',
    async v => {
      layer.endpoint = v;
      await save();
      redraw();
    },
  );
  const known = resolved.endpoint
    ? (plugin.settings.ModelsOnEndpoint[resolved.endpoint.name] ?? [])
    : ['gpt-6.1-sol'];
  suggestText(
    new Setting(el).setName('Model').setDesc('Empty uses the provider’s default model.'),
    layer.model,
    known,
    async v => {
      layer.model = v;
      await save();
    },
  );
  choose(
    new Setting(el)
      .setName('Reasoning effort')
      .setDesc('Sent as the reasoning effort. Not every model accepts every level.'),
    EFFORTS,
    layer.effort,
    async v => {
      layer.effort = v;
      await save();
    },
  );
  if (layer.endpoint !== CHATGPT_SIGN_IN) {
    choose(
      new Setting(el)
        .setName('API')
        .setDesc(
          'Automatic uses the responses API for OpenAI (newer models need it for tool calls) and chat completions elsewhere.',
        ),
      { auto: 'Automatic', chat: 'Chat completions', responses: 'Responses' } as Record<
        LayerApi,
        string
      >,
      layer.api,
      async v => {
        layer.api = v;
        await save();
      },
    );
  }
}

/**
 * Sign in with ChatGPT (desktop only).
 * @param el - Container.
 * @param plugin - Plugin.
 * @param redraw - Re-renders the tab.
 */
function renderChatGPTSignIn(el: HTMLElement, plugin: PureChatLLM, redraw: () => void): void {
  const auth = plugin.chatgpt;
  const setting = new Setting(el).setName('Sign in with ChatGPT');
  if (!ChatGPTAuth.supported) {
    setting.setDesc(
      'Needs the desktop app, because sign-in uses a local page on this computer. On this device, set those layers to an API key provider.',
    );
    return;
  }
  const where = persistentSecrets(plugin.app)
    ? 'Tokens are kept in Obsidian’s secret storage, not in the vault.'
    : 'This Obsidian version has no secret storage, so the sign-in lasts until Obsidian closes.';
  if (auth.signedIn) {
    setting.setDesc(`Signed in${auth.email ? ` as ${auth.email}` : ''}. ${where}`).addButton(b =>
      b.setButtonText('Sign out').onClick(async () => {
        new Notice(await auth.signOut());
        redraw();
      }),
    );
  } else {
    setting
      .setDesc(
        `Runs layers set to ChatGPT sign-in on your ChatGPT plan, through OpenAI’s official sign-in for local apps. Your browser opens; approve, then come back. ${where}`,
      )
      .addButton(b =>
        b
          .setButtonText('Sign in')
          .setCta()
          .onClick(async () => {
            try {
              await auth.signIn();
              new Notice('Signed in with ChatGPT.');
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
            }
            redraw();
          }),
      );
  }
}

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

  new Setting(el)
    .setName('Duplex agent')
    .setDesc(
      'Six groups: voice, orchestrator, workers, evaluator, interruptions and check-ins. The voice talks with you; the orchestrator plans and runs workers in the background.',
    )
    .setHeading();
  new Setting(el).setName('Voice').setHeading();

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
  renderVoiceRole(el, plugin, redraw);

  new Setting(el)
    .setName('Full duplex')
    .setDesc(
      'On: you can talk over the voice model and cut it off. Off: your microphone is closed while the model speaks, which avoids it hearing itself on speakers. GPT-Live is always full duplex.',
    )
    .addToggle(t =>
      t.setValue(v.fullDuplex).onChange(async value => {
        v.fullDuplex = value;
        await save();
      }),
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

  new Setting(el)
    .setName('Save calls as notes')
    .setDesc(
      'When a call ends, its transcript, the orchestrator’s conversation and every background task are saved as linked notes, one folder per call.',
    )
    .addToggle(t =>
      t.setValue(v.saveCalls).onChange(async value => {
        v.saveCalls = value;
        await save();
        redraw();
      }),
    );
  if (v.saveCalls) {
    new Setting(el)
      .setName('Calls folder')
      .setDesc('Each call gets its own folder in here.')
      .addText(t =>
        t
          .setPlaceholder('Voice Agent')
          .setValue(v.callsFolder)
          .onChange(async value => {
            v.callsFolder = value.trim() || 'Voice Agent';
            await save();
          }),
      );
  }

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
  choose(
    new Setting(box)
      .setName('Authentication')
      .setDesc(
        'Use a bearer token if the server needs one, or sign in through your browser. Sign-in registers the plugin with the server and renews the token.',
      ),
    { token: 'Token or none', oauth: 'OAuth sign-in' } as Record<'token' | 'oauth', string>,
    server.auth ?? 'token',
    async x => {
      server.auth = x;
      await save();
      redraw();
    },
  );
  if ((server.auth ?? 'token') === 'token') {
    new Setting(box).setName('Bearer token').addText(t => {
      t.inputEl.type = 'password';
      t.setValue(server.bearerToken).onChange(async x => {
        server.bearerToken = x.trim();
        await save();
      });
    });
  } else {
    const signedIn = !!server.oauth?.accessToken;
    new Setting(box)
      .setName(signedIn ? 'Signed in' : 'Not signed in')
      .setDesc(
        signedIn
          ? `Through ${server.oauth?.issuer ?? 'the server'}.${server.oauth?.expiresAt ? ` Token renews automatically.` : ''}`
          : 'Opens the server’s sign-in page in your browser, then returns to Obsidian.',
      )
      .addButton(b =>
        b
          .setButtonText(signedIn ? 'Sign in again' : 'Sign in')
          .setCta()
          .onClick(async () => {
            if (!server.url) {
              new Notice('Add the server address first.');
              return;
            }
            try {
              await signIn(plugin, server);
              await plugin.mcp.refresh(server);
            } catch (error) {
              new Notice(
                `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            redraw();
          }),
      )
      .addExtraButton(b =>
        b
          .setIcon('log-out')
          .setTooltip('Sign out')
          .onClick(async () => {
            if (server.oauth) {
              server.oauth = { ...server.oauth, accessToken: '', refreshToken: '', expiresAt: 0 };
            }
            await save();
            redraw();
          }),
      );
    new Setting(box)
      .setName('Client id')
      .setDesc('Leave empty to register automatically. Some servers need one you create with them.')
      .addText(t =>
        t.setValue(server.oauth?.clientId ?? '').onChange(async x => {
          server.oauth = {
            ...(server.oauth ?? {
              scope: '',
              resource: '',
              issuer: '',
              tokenEndpoint: '',
              accessToken: '',
              refreshToken: '',
              expiresAt: 0,
            }),
            clientId: x.trim(),
          };
          await save();
        }),
      );
  }
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
      `Each skill is a folder whose main note is named after it (for example review/review.md), or SKILL.md as in the agentskills.io format. Found ${skills.length} skill${skills.length === 1 ? '' : 's'}${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`,
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
  choose(
    new Setting(el)
      .setName('Script engine')
      .setDesc(
        'djs is the WebAssembly engine built to replace QuickJS in pi’s code mode (github.com/earendil-works/djs). It runs each script in its own wasm instance with an instruction and memory budget, and accepts TypeScript. Auto uses djs when its module is found, otherwise the built-in Web Worker.',
      ),
    { auto: 'Auto', djs: 'djs only', worker: 'Web Worker only' },
    c.engine,
    async x => {
      c.engine = x;
      await save();
      redraw();
    },
  );
  if (c.engine !== 'worker') {
    const pathSetting = new Setting(el)
      .setName('djs module')
      .setDesc(`Vault path of djs.wasm. Leave empty to use ${djsModulePath(plugin)}. Checking…`)
      .addText(t =>
        t
          .setPlaceholder('djs.wasm in the plugin folder')
          .setValue(c.djsModulePath)
          .onChange(async x => {
            c.djsModulePath = x.trim();
            resetDjsModule();
            await save();
          }),
      )
      .addButton(b =>
        b
          .setIcon('refresh-cw')
          .setTooltip('Check the module again')
          .onClick(() => {
            resetDjsModule();
            redraw();
          }),
      );
    void loadDjsModule(plugin).then(module =>
      pathSetting.setDesc(
        `Vault path of djs.wasm. Leave empty to use ${djsModulePath(plugin)}. ${
          module
            ? 'Module loaded: scripts run in djs.'
            : 'Module not found: scripts run in the Web Worker. Build it with scripts/build-wasm.sh in the djs repository and copy it here.'
        }`,
      ),
    );
    numberInput(
      new Setting(el)
        .setName('djs instruction budget')
        .setDesc('Fuel per script before it is stopped.'),
      c.djsMaxFuel,
      async n => {
        c.djsMaxFuel = n;
        await save();
      },
      { min: 1_000_000, max: 100_000_000_000, fallback: 2_000_000_000 },
    );
    numberInput(
      new Setting(el).setName('djs memory limit in megabytes'),
      c.djsMemoryLimitMb,
      async n => {
        c.djsMemoryLimitMb = n;
        await save();
      },
      { min: 8, max: 2048, fallback: 64 },
    );
  }
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
