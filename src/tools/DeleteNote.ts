import { normalizePath, TFile } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { notePath, REASON_PARAMETER, WRITE_FORMAT } from './CreateNote';
import { renderWrite, submitWrite } from './EditReview';
import { toolError } from './toolContract';

const deleteNoteParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Vault path of the note or file to delete.' },
    reason: REASON_PARAMETER,
    format: WRITE_FORMAT,
  },
  required: ['path'],
} as const);

export type DeleteNoteArgs = InferArgs<typeof deleteNoteParameters>;

/** Moves a note to the trash. */
export class DeleteNoteTool extends Tool<DeleteNoteArgs> {
  readonly name = 'delete_obsidian_note';
  readonly classification = 'Vault';
  readonly description =
    'Deletes one note or file by moving it to the trash, where it can be restored. Use it only when the note itself should go; to remove text from a note use replace_in_note. In a chat the user confirms first; background workers follow the write policy in settings.';
  readonly parameters = deleteNoteParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: DeleteNoteArgs): Promise<string> {
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return toolError('InvalidArgument', 'path is required.');
    }
    const app = this.chat.plugin.app;
    const file =
      app.vault.getFileByPath(normalizePath(args.path)) ??
      app.vault.getFileByPath(notePath(args.path));
    if (!(file instanceof TFile)) {
      const parent = normalizePath(args.path).split('/').slice(0, -1).join('/');
      return toolError('NotFound', `No note or file at "${args.path}".`, [
        `glob_vault_files("${parent ? `${parent}/` : ''}*.md") to find it`,
        `list_vault_folders("${parent || '/'}")`,
      ]);
    }
    void this.status(`Deleting "${file.path}"...`);
    const outcome = await submitWrite(this.chat, {
      kind: 'delete',
      path: file.path,
      instruction: 'Delete the note (move it to the trash)',
      reason: args.reason,
    });
    return renderWrite(outcome, args, `Deleted "${file.path}"`, { trashed: outcome.applied });
  }
}
