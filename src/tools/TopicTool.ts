import { defineToolParameters, InferArgs, Tool } from '../tools';
import { toolError } from './toolContract';

/** Added to the voice's instructions when it can mark topics. */
export const TOPIC_GUIDANCE =
  'This call is saved as a map of linked topic notes. Whenever the conversation moves to a new concept, step, idea, aspect or alternative, call new_topic with a short title (and follows_from naming the earlier topics it builds on, so you can branch back to any of them); use action return to carry on in an earlier topic. Do it quietly, without mentioning it, and keep the conversation flowing. Stay on the current topic for follow-ups on the same point.';

/** Chat roles that speak with the user in a call. */
const VOICE_ROLES = ['voice', 'orchestrator', 'direct-voice'];

const topicParams = defineToolParameters({
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'A short name for the new topic, three to six words, such as "Folder notes for calls". To go back to an earlier topic, give its title or number.',
    },
    kind: {
      type: 'string',
      description:
        'What starts here: a new `concept`, a `step` in a plan, an `idea`, an `aspect` of the current topic, an `alternative` to it, a `question`, or a `decision`.',
      enum: ['concept', 'step', 'idea', 'aspect', 'alternative', 'question', 'decision'],
    },
    follows_from: {
      type: 'string',
      description:
        'The earlier topics this builds on, by title or number, separated by commas. Leave empty to follow the current topic. Name an older topic to branch from it, or several to join them.',
    },
    action: {
      type: 'string',
      description:
        '`new` (default) starts a new topic note; `return` carries on in an earlier topic named by title.',
      enum: ['new', 'return'],
    },
  },
  required: ['title'],
} as const);

/**
 * Voice: splits a call into linked topic notes (Hani's Zettelkasten calls). Each new concept, step,
 * idea, aspect or alternative becomes its own note in the call's folder, linked to the topics it
 * follows from; the call's index note maps them. Returns at once and is never spoken.
 */
export class NewTopicTool extends Tool<InferArgs<typeof topicParams>> {
  readonly name = 'new_topic';
  readonly classification = 'System';
  readonly description =
    'Start a new topic note for this call when the conversation moves to a new concept, step, idea, aspect or alternative, or go back to an earlier topic. The call is saved as linked notes, one per topic, so the user can follow its branches later. Silent: do not mention it to the user, and keep talking as you were.';
  readonly parameters = topicParams;

  isAvailable(): boolean {
    const v = this.chat.plugin.settings.voice;
    return (
      VOICE_ROLES.includes(this.chat.role) &&
      !!v?.saveCalls &&
      (v.callNotes ?? 'topics') === 'topics'
    );
  }

  execute(args: InferArgs<typeof topicParams>): Promise<string> {
    const calls = this.chat.plugin.calls;
    if (!calls?.isLive) {
      return Promise.resolve(
        toolError('NoCall', 'No call is being recorded, so there is no topic to start.'),
      );
    }
    const title = (args.title ?? '').trim();
    if (!title) {
      return Promise.resolve(
        toolError('InvalidArgument', 'A topic needs a title.', ['Give it three to six words.']),
      );
    }
    const refs = (args.follows_from ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return Promise.resolve(
      args.action === 'return'
        ? calls.returnToTopic(title)
        : calls.newTopic(title, args.kind ?? 'concept', refs),
    );
  }
}
