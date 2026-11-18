import { requestUrl, Modal, App, Setting } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { EmptyApiKey } from '../assets/constants';
import { FORMAT_PARAMETER, jsonResult, layerForRole, toolError, wantsJson } from './toolContract';

const BASE_URL = 'https://api.sunoapi.org/api/v1';
/** Approximate price of one Suno API credit, in US dollars. */
const USD_PER_CREDIT = 0.005;
/** How long the confirmation window waits before it counts as "no". */
const CONFIRM_TIMEOUT_MS = 180_000;
const MODELS = ['V4', 'V4_5', 'V4_5PLUS', 'V4_5ALL', 'V5'];

const sunoParameters = defineToolParameters({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description:
        'What to do. Paid: "generate_music" (needs prompt), "generate_lyrics" (needs prompt), "extend_music" (needs audioId, prompt, continueAt), "separate_vocals" and "create_music_video" (need taskId and audioId). Free: "check_status" (needs taskId), "get_credits".',
      enum: [
        'generate_music',
        'generate_lyrics',
        'check_status',
        'extend_music',
        'separate_vocals',
        'create_music_video',
        'get_credits',
      ],
    },
    prompt: {
      type: 'string',
      description:
        'Song description, lyrics topic, or what the extension should sound like. In custom mode, the lyrics.',
    },
    model: {
      type: 'string',
      description: 'Suno model. Defaults to "V5".',
      enum: MODELS,
    },
    customMode: {
      type: 'boolean',
      description: '"generate_music" only: true makes prompt the lyrics and needs style and title.',
    },
    instrumental: {
      type: 'boolean',
      description: '"generate_music" only: true for no vocals.',
    },
    style: {
      type: 'string',
      description: 'Musical style or genre. Required in custom mode.',
    },
    title: {
      type: 'string',
      description: 'Song title. Required in custom mode.',
    },
    taskId: {
      type: 'string',
      description: 'Task id returned by a paid action.',
    },
    audioId: {
      type: 'string',
      description: 'Track id from a "check_status" result.',
    },
    continueAt: {
      type: 'number',
      description: '"extend_music" only: second of the track where the extension starts.',
    },
    author: {
      type: 'string',
      description: '"create_music_video" only: author name to show.',
    },
    domainName: {
      type: 'string',
      description: '"create_music_video" only: brand or site name to show.',
    },
    confirm: {
      type: 'boolean',
      description:
        'Voice calls only: set true only after you told the user what it will do and its cost, and they said yes. Ignored in a note chat, where a confirmation window asks the user.',
    },
    // Spread with an inline enum: FORMAT_PARAMETER's readonly enum doesn't fit ToolParameter.
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['action'],
} as const);

export type SunoArgs = InferArgs<typeof sunoParameters>;

export interface SunoApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

interface SunoTaskResult {
  taskId: string;
}

interface SunoTrack {
  id: string;
  audio_url?: string;
  title?: string;
  duration?: number;
  text?: string;
}

interface SunoStatusData {
  status: string;
  response?: {
    data: SunoTrack[];
  };
  vocal_removal_info?: {
    instrumental_url: string;
    vocal_url: string;
  };
}

interface SunoCreditsData {
  credits: number;
}

/** What one action produced, before it is written as text or JSON. */
interface SunoOutcome {
  summary: string;
  details: string[];
  task_id: string | null;
  status: string | null;
  credits: number | null;
  tracks: { id: string; title: string; audio_url: string; duration: number }[];
  lyrics: string[];
  stems: { instrumental_url: string; vocal_url: string } | null;
}

/**
 * Credits an action costs (Suno API price list as the plugin knows it).
 * @param action - Action.
 */
export function sunoCost(action: string): number {
  switch (action) {
    case 'generate_music':
    case 'extend_music':
      return 12;
    case 'separate_vocals':
      return 10;
    case 'create_music_video':
      return 2;
    case 'generate_lyrics':
      return 0.4;
    default:
      return 0;
  }
}

/** @param credits - Credits. */
function spokenCost(credits: number): string {
  return `${credits} credits, about $${(credits * USD_PER_CREDIT).toFixed(3)}`;
}

/**
 * Suno music generation. Paid actions need the user's yes: the confirmation window in a note
 * chat, or `confirm: true` after a spoken yes in a voice call.
 */
export class SunoTool extends Tool<SunoArgs> {
  readonly name = 'suno_music_gen';
  readonly classification = 'AI';
  readonly description =
    'Makes music with the Suno API: songs, lyrics, longer versions of a track, separated vocals or a music video. ' +
    "It also checks a task's result and the remaining credits. " +
    'Use it only when the user asks for music. Generation runs in the background; call "check_status" with the task id after a minute or two. ' +
    'Paid actions cost Suno credits (a song is 12 credits, about 6 US cents). In a note chat a confirmation window asks the user. In a voice call, first tell the user what you will make and the cost, ask, and only after they say yes call with confirm: true. "check_status" and "get_credits" are free.';
  readonly parameters = sunoParameters;

  /** The Suno API key from the endpoint named "Suno". */
  private get apiKey(): string | undefined {
    const sunoEndpoint = this.chat.plugin.settings.endpoints.find(e => e.name === 'Suno');
    const key = sunoEndpoint?.apiKey?.trim();
    return key && key !== EmptyApiKey && key !== 'EMPTY' ? key : undefined;
  }

  /** Offered only with a Suno API key. */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /** @param args - Action, its arguments, confirm and format. */
  async execute(args: SunoArgs): Promise<string> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      return toolError('NotConfigured', 'No Suno API key is set.', [
        'Ask the user to add an endpoint named "Suno" with their API key in the plugin settings.',
      ]);
    }

    const problem = this.validateArgs(args);
    if (problem) return toolError('InvalidArgument', problem);

    const cost = sunoCost(args.action);
    if (cost > 0) {
      const layer = layerForRole(this.chat.role);
      if (layer === 'voice') {
        if (args.confirm !== true) {
          return toolError(
            'ConfirmationNeeded',
            `Not started: "${args.action}" costs ${spokenCost(cost)}.`,
            [
              'Tell the user what you will make and that cost, and ask if they want it.',
              'Only after they say yes, call again with the same arguments and confirm: true.',
            ],
          );
        }
      } else if (layer === 'chat') {
        // Note chat: the user confirms in a window; `confirm` is ignored here.
        const details: Record<string, unknown> = { ...args };
        for (const k of ['action', 'confirm', 'format']) delete details[k];
        Object.keys(details).forEach(k => details[k] === undefined && delete details[k]);
        const confirmed = await new Promise<boolean>(resolve => {
          new SunoConfirmationModal(
            this.chat.plugin.app,
            args.action,
            cost,
            details,
            resolve,
          ).open();
        });
        if (!confirmed) {
          return toolError(
            'Declined',
            `The user didn't approve "${args.action}"; nothing was spent.`,
            ['Ask the user what they want instead.'],
          );
        }
      } else {
        return toolError(
          'NotAllowed',
          'Paid Suno actions need the user present to approve the cost.',
          ['Report what you would make to the user instead.'],
        );
      }
    }

    let outcome: SunoOutcome;
    try {
      outcome = await this.run(args, apiKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('SunoApiError', message, [
        'Check the Suno API key and remaining credits ("get_credits").',
        'Try again in a moment.',
      ]);
    }

    if (wantsJson(args)) {
      return jsonResult({
        action: args.action,
        cost_credits: cost,
        summary: outcome.summary,
        task_id: outcome.task_id,
        status: outcome.status,
        credits: outcome.credits,
        tracks: outcome.tracks,
        lyrics: outcome.lyrics,
        stems: outcome.stems,
      });
    }
    return [outcome.summary, ...outcome.details].join('\n');
  }

  /** @param args - Arguments to check before anything is spent. */
  private validateArgs(args: SunoArgs): string | null {
    const { action, prompt, customMode, style, title, taskId, audioId, continueAt, model } = args;
    if (model !== undefined && !MODELS.includes(model)) {
      return `Unknown model "${model}"; use one of ${MODELS.join(', ')}.`;
    }
    switch (action) {
      case 'generate_music':
        if (!prompt?.trim()) return '"prompt" is required.';
        if (customMode) {
          if (!style?.trim()) return '"style" is required in custom mode.';
          if (!title?.trim()) return '"title" is required in custom mode.';
        }
        return null;
      case 'generate_lyrics':
        return prompt?.trim() ? null : '"prompt" is required.';
      case 'check_status':
        return taskId?.trim() ? null : '"taskId" is required.';
      case 'extend_music':
        if (!audioId?.trim()) return '"audioId" is required.';
        if (!prompt?.trim()) return '"prompt" is required.';
        if (typeof continueAt !== 'number' || !Number.isFinite(continueAt) || continueAt < 0)
          return '"continueAt" is required: the second where the extension starts.';
        return null;
      case 'separate_vocals':
      case 'create_music_video':
        if (!audioId?.trim()) return '"audioId" is required.';
        if (!taskId?.trim()) return '"taskId" is required.';
        return null;
      case 'get_credits':
        return null;
      default:
        return `Unknown action "${String(action)}".`;
    }
  }

  /**
   * One Suno API call. Throws on a transport or API error.
   * @param path - Path under the API base.
   * @param apiKey - Suno API key.
   * @param body - JSON body for a POST; none for a GET.
   */
  protected async call<T>(path: string, apiKey: string, body?: object): Promise<T> {
    const response = await requestUrl({
      url: `${BASE_URL}${path}`,
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      throw: false,
    });
    const result = response.json as SunoApiResponse<T> | undefined;
    if (response.status >= 400 || !result || result.code !== 200) {
      throw new Error(result?.msg || `Suno answered HTTP ${response.status}.`);
    }
    return result.data;
  }

  /**
   * @param args - Validated arguments.
   * @param apiKey - Suno API key.
   */
  private async run(args: SunoArgs, apiKey: string): Promise<SunoOutcome> {
    const { action, prompt, customMode, instrumental, style, title, taskId, audioId } = args;
    const model = args.model ?? 'V5';
    const out: SunoOutcome = {
      summary: '',
      details: [],
      task_id: null,
      status: null,
      credits: null,
      tracks: [],
      lyrics: [],
      stems: null,
    };
    const started = async (path: string, body: object, what: string, wait: string) => {
      void this.status(`Suno: ${what}...`);
      const data = await this.call<SunoTaskResult>(path, apiKey, body);
      out.task_id = data.taskId;
      out.status = 'PENDING';
      out.summary = `Started ${what}; it usually takes ${wait}.`;
      out.details = [
        `Task id: ${data.taskId}`,
        'Call check_status with this task id for the result.',
      ];
      return out;
    };

    switch (action) {
      case 'get_credits': {
        const data = await this.call<SunoCreditsData>('/get-credits', apiKey);
        out.credits = data.credits;
        out.summary = `You have ${data.credits} Suno credits left.`;
        return out;
      }
      case 'generate_music':
        return started(
          '/generate',
          {
            prompt,
            model,
            customMode: !!customMode,
            instrumental: !!instrumental,
            style,
            title,
            // The API requires a callback URL; results are fetched with check_status instead.
            callBackUrl: 'https://api.example.com/callback',
          },
          'making the song',
          'one to two minutes',
        );
      case 'generate_lyrics':
        return started('/lyrics', { prompt }, 'writing the lyrics', 'under a minute');
      case 'extend_music':
        return started(
          '/generate/extend',
          { audioId, prompt, continueAt: args.continueAt, model },
          'extending the track',
          'one to two minutes',
        );
      case 'separate_vocals':
        return started(
          '/vocal-removal/generate',
          { taskId, audioId },
          'separating the vocals',
          'about a minute',
        );
      case 'create_music_video':
        return started(
          '/generate/video',
          { taskId, audioId, author: args.author, domainName: args.domainName },
          'making the music video',
          'a few minutes',
        );
      case 'check_status':
        return this.checkStatus(String(taskId), apiKey, out);
      default:
        throw new Error(`Unknown action "${String(action)}".`);
    }
  }

  /**
   * @param taskId - Task id.
   * @param apiKey - Suno API key.
   * @param out - Outcome to fill.
   */
  private async checkStatus(
    taskId: string,
    apiKey: string,
    out: SunoOutcome,
  ): Promise<SunoOutcome> {
    void this.status(`Checking Suno task ${taskId}...`);
    const data = await this.call<SunoStatusData>(
      `/generate/record-info?taskId=${encodeURIComponent(taskId.trim())}`,
      apiKey,
    );
    out.task_id = taskId;
    out.status = data.status;
    if (data.status !== 'SUCCESS') {
      out.summary = `The task is still ${String(data.status).toLowerCase().replace(/_/g, ' ')}; check again in a minute.`;
      return out;
    }
    for (const item of data.response?.data ?? []) {
      if (item.audio_url) {
        out.tracks.push({
          id: item.id,
          title: item.title || 'Untitled',
          audio_url: item.audio_url,
          duration: item.duration || 0,
        });
      } else if (item.text) {
        out.lyrics.push(item.text);
      }
    }
    if (data.vocal_removal_info) {
      out.stems = {
        instrumental_url: data.vocal_removal_info.instrumental_url,
        vocal_url: data.vocal_removal_info.vocal_url,
      };
    }
    const parts = [
      out.tracks.length ? `${out.tracks.length} track${out.tracks.length === 1 ? '' : 's'}` : '',
      out.lyrics.length
        ? `${out.lyrics.length} set${out.lyrics.length === 1 ? '' : 's'} of lyrics`
        : '',
      out.stems ? 'separated vocals and instrumental' : '',
    ].filter(Boolean);
    out.summary = parts.length
      ? `Done: ${parts.join(' and ')}.`
      : 'Done, but Suno returned no files.';
    out.tracks.forEach((t, i) =>
      out.details.push(
        `Track ${i + 1}: ${t.title} (${Math.round(t.duration)}s)`,
        `- URL: ${t.audio_url}`,
        `- Audio id: ${t.id}`,
      ),
    );
    out.lyrics.forEach((text, i) => out.details.push(`Lyrics ${i + 1}:`, text));
    if (out.stems) {
      out.details.push(
        `Instrumental: ${out.stems.instrumental_url}`,
        `Vocals: ${out.stems.vocal_url}`,
      );
    }
    return out;
  }
}

/**
 * Shows a paid action and its cost and waits for the user. Closing it, or no answer within a
 * few minutes, counts as no.
 */
export class SunoConfirmationModal extends Modal {
  private resolved = false;
  private timer = 0;

  /**
   * @param app - Obsidian app.
   * @param action - Suno action.
   * @param cost - Credits.
   * @param details - Arguments to show.
   * @param onResolve - Called once with the answer.
   */
  constructor(
    app: App,
    readonly action: string,
    readonly cost: number,
    readonly details: Record<string, unknown>,
    readonly onResolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  /** @param confirmed - The answer. */
  finish(confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    window.clearTimeout(this.timer);
    this.onResolve(confirmed);
    this.close();
  }

  /** Opens the window and starts the no-answer timer. */
  open(): void {
    this.timer = window.setTimeout(() => this.finish(false), CONFIRM_TIMEOUT_MS);
    super.open();
  }

  /** Draws the action and its cost. */
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // eslint-disable-next-line obsidianmd/ui/sentence-case
    this.setTitle('Confirm Suno API action');
    new Setting(contentEl)
      .setHeading()
      .setName(`The agent wants to run: ${this.action}`)
      .setDesc(`Estimated cost: ${spokenCost(this.cost)} (US dollars)`);

    for (const [key, value] of Object.entries(this.details)) {
      new Setting(contentEl).setName(key).setDesc(String(value));
    }

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Confirm & run')
          .setCta()
          .onClick(() => this.finish(true)),
      )
      .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.finish(false)));
  }

  /** Closing without an answer counts as no. */
  onClose() {
    this.contentEl.empty();
    this.finish(false);
  }
}
