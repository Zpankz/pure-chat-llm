import { defineToolParameters, InferArgs, Tool } from '../tools';
import { WRITE_FORMAT } from './CreateNote';
import { WriteNoteSectionTool } from './WriteNoteSection';
import { allowedIn, layerForRole, toolError } from './toolContract';

const patchNoteParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Vault path of the note.' },
    heading: {
      type: 'string',
      description:
        'Heading to append under; created when missing. Leave out for the end of the note.',
    },
    new_content: { type: 'string', description: 'Markdown to append.' },
    format: WRITE_FORMAT,
  },
  required: ['path', 'new_content'],
} as const);

export type PatchNoteArgs = InferArgs<typeof patchNoteParameters>;

/**
 * Deprecated: kept so chats and scripts that name `patch_note` keep working. It is
 * write_note_section in append mode.
 */
export class PatchNoteTool extends Tool<PatchNoteArgs> {
  readonly name = 'patch_note';
  readonly classification = 'Vault';
  readonly description =
    'Deprecated: use write_note_section with mode "append". Appends Markdown under a heading, or at the end of the note. Same review as write_note_section.';
  readonly parameters = patchNoteParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: PatchNoteArgs): Promise<string> {
    // patch_note has no entry in the layer table, so check write_note_section's layers here.
    const layer = layerForRole(this.chat.role);
    if (!allowedIn('write_note_section', layer)) {
      return toolError('NotAllowed', `patch_note is not available to the ${layer} layer.`);
    }
    return new WriteNoteSectionTool(this.chat, this.registry).execute({
      path: args.path,
      heading: args.heading,
      content: args.new_content,
      mode: 'append',
      format: args.format,
    });
  }
}
