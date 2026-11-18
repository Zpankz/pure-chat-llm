import { normalizePath } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { renderWrite, submitWrite } from './EditReview';
import { FORMAT_PARAMETER, toolError } from './toolContract';

/** Shared `reason` parameter of the write tools. */
export const REASON_PARAMETER = {
  type: 'string',
  description: 'Why you are making this change, in one sentence. Reviewers see it.',
} as const;

/**
 * The shared `format` parameter, with a mutable `enum` so it fits the tool parameter type.
 */
export const WRITE_FORMAT = {
  type: FORMAT_PARAMETER.type,
  description: FORMAT_PARAMETER.description,
  enum: [...FORMAT_PARAMETER.enum] as string[],
};

const createNoteParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        "Vault path of the new note, such as 'Projects/AI Agent.md'. `.md` is added when there is no extension; missing folders are created.",
    },
    content: {
      type: 'string',
      description: 'The note body in Markdown.',
    },
    properties: {
      type: 'object',
      description:
        'Optional frontmatter properties, such as {"tags": ["project"], "status": "draft"}.',
    },
    overwrite: {
      type: 'boolean',
      description:
        'Replace the note if it already exists (counts as an edit). Default false: an existing note is an error.',
    },
    reason: REASON_PARAMETER,
    format: WRITE_FORMAT,
  },
  required: ['path', 'content'],
} as const);

export type CreateNoteArgs = InferArgs<typeof createNoteParameters>;

/**
 * Adds `.md` when a path has no extension.
 * @param path - Vault path.
 */
export function notePath(path: string): string {
  const p = normalizePath(path.trim());
  return /\.[A-Za-z0-9]+$/.test(p.split('/').pop() ?? '') ? p : `${p}.md`;
}

/** Creates a note. */
export class CreateNoteTool extends Tool<CreateNoteArgs> {
  readonly name = 'create_obsidian_note';
  readonly classification = 'Vault';
  readonly description =
    'Creates a new Markdown note, with optional frontmatter properties. Use it for a new note; to add to or change part of an existing note use write_note_section or replace_in_note, and to start from a template use manage_templates. In a chat the user reviews the note before it is saved; background workers follow the write policy in settings.';
  readonly parameters = createNoteParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: CreateNoteArgs): Promise<string> {
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return toolError('InvalidArgument', 'path is required.', ["path: 'Folder/Note.md'"]);
    }
    if (typeof args.content !== 'string') {
      return toolError('InvalidArgument', 'content must be a string.');
    }
    const path = notePath(args.path);
    void this.status(`Saving "${path}"...`);
    const outcome = await submitWrite(this.chat, {
      kind: 'write',
      path,
      content: args.content,
      properties: isRecord(args.properties) ? args.properties : undefined,
      overwrite: args.overwrite === true,
      instruction: 'Create a note',
      reason: args.reason,
    });
    const verb = outcome.action === 'edit' ? 'Replaced' : 'Created';
    return renderWrite(outcome, args, `${verb} "${path}"`, {}, [
      `read_file("${path}") to check it`,
    ]);
  }
}

/** @param value - Value to test. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
