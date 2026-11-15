import { defineToolParameters, InferArgs, Tool } from '../tools';
import { Notice } from 'obsidian';
import { FORMAT_PARAMETER, jsonResult, layerForRole, toolError, wantsJson } from './toolContract';

/** Longest message shown; longer text is cut so the toast stays readable. */
const MAX_MESSAGE = 300;
const DEFAULT_MS = 5000;
const MIN_MS = 1000;
const MAX_MS = 30000;

const showNoticeParameters = defineToolParameters({
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: `The short text to show (up to ${MAX_MESSAGE} characters).`,
    },
    duration: {
      type: 'integer',
      description: `How long to show it, in milliseconds (${MIN_MS} to ${MAX_MS}). Defaults to ${DEFAULT_MS}.`,
    },
    // Spread with an inline enum: FORMAT_PARAMETER's readonly enum doesn't fit ToolParameter.
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['message'],
} as const);

export type ShowNoticeArgs = InferArgs<typeof showNoticeParameters>;

/**
 * Shows a short toast in Obsidian. Harmless anywhere: where nobody watches the screen it shows
 * nothing and says so.
 */
export class ShowNoticeTool extends Tool<ShowNoticeArgs> {
  readonly name = 'show_obsidian_notice';
  readonly classification = 'UI';
  readonly description =
    'Shows a short pop-up message (a notice) on the Obsidian screen for a few seconds. ' +
    'Use it only for something the user should still see on screen, such as a reminder or a finished task. ' +
    'In a voice call say things out loud instead; the user may not be looking at the screen. ' +
    'Free, no confirmation.';
  readonly parameters = showNoticeParameters;

  /** Always offered; layers decide who gets it. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Message, duration and format. */
  async execute(args: ShowNoticeArgs): Promise<string> {
    const raw = typeof args.message === 'string' ? args.message.trim() : '';
    if (!raw) {
      return toolError('InvalidArgument', '"message" is empty.', [
        'Pass the text to show in "message".',
      ]);
    }
    const message = raw.length > MAX_MESSAGE ? `${raw.slice(0, MAX_MESSAGE - 1)}…` : raw;
    const requested = Number(args.duration);
    const duration = Number.isFinite(requested)
      ? Math.min(MAX_MS, Math.max(MIN_MS, Math.round(requested)))
      : DEFAULT_MS;

    // Background layers have nobody looking at the screen: do nothing, harmlessly.
    const layer = layerForRole(this.chat.role);
    const visible = layer === 'chat' || layer === 'voice';
    if (visible) new Notice(message, duration);

    if (wantsJson(args)) {
      return jsonResult({
        shown: visible,
        message,
        duration_ms: duration,
        truncated: message !== raw,
      });
    }
    return visible
      ? `Showed a notice on screen for ${Math.round(duration / 1000)} seconds: "${message}"`
      : 'Not shown: nobody is watching the screen here. Put the message in your reply instead.';
  }
}
