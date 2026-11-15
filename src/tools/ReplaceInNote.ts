import { normalizePath, TFile } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { notePath, REASON_PARAMETER, WRITE_FORMAT } from './CreateNote';
import { renderWrite, submitWrite } from './EditReview';
import { jsonResult, toolError, wantsJson } from './toolContract';

const replaceInNoteParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Vault path of the note.' },
    search: {
      type: 'string',
      description: 'Text to find, or a regular expression when regex is true.',
    },
    replace: {
      type: 'string',
      description:
        'Replacement text. Taken literally unless regex is true, where $1 and so on insert capture groups. Empty deletes the match.',
    },
    regex: { type: 'boolean', description: 'Treat search as a regular expression. Default false.' },
    case_sensitive: { type: 'boolean', description: 'Match case. Default false.' },
    expected_matches: {
      type: 'integer',
      description:
        'How many matches you expect. When the note has a different number, nothing changes and the count is reported. Use 1 to make sure you change only the place you mean.',
    },
    reason: REASON_PARAMETER,
    format: WRITE_FORMAT,
  },
  required: ['path', 'search', 'replace'],
} as const);

export type ReplaceInNoteArgs = InferArgs<typeof replaceInNoteParameters>;

/** Replaces text in one note. */
export class ReplaceInNoteTool extends Tool<ReplaceInNoteArgs> {
  readonly name = 'replace_in_note';
  readonly classification = 'Vault';
  readonly description =
    'Finds and replaces text in one note, every match, as plain text or a regular expression. Use it to correct or remove specific text; use write_note_section to add or replace a whole section. Set expected_matches to avoid changing more than you mean. In a chat the user reviews the edit first; background workers follow the write policy in settings.';
  readonly parameters = replaceInNoteParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: ReplaceInNoteArgs): Promise<string> {
    const { search, replace, regex = false, case_sensitive = false } = args;
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return toolError('InvalidArgument', 'path is required.');
    }
    if (typeof search !== 'string' || !search) {
      return toolError('InvalidArgument', 'search must be non-empty text.');
    }
    if (typeof replace !== 'string') {
      return toolError('InvalidArgument', 'replace must be text (empty to delete the match).');
    }
    const app = this.chat.plugin.app;
    const file =
      app.vault.getFileByPath(normalizePath(args.path)) ??
      app.vault.getFileByPath(notePath(args.path));
    if (!(file instanceof TFile)) {
      return toolError('NotFound', `No note at "${args.path}".`, [
        'glob_vault_files to find the path',
        `search_vault("${search.slice(0, 60)}") to find notes containing the text`,
      ]);
    }

    let pattern: RegExp;
    try {
      const source = regex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = new RegExp(source, case_sensitive ? 'g' : 'gi');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('InvalidRegex', message, ['Fix the pattern, or set regex: false.']);
    }

    const text = await app.vault.read(file);
    const matches = text.match(pattern)?.length ?? 0;
    const expected = args.expected_matches;
    if (typeof expected === 'number' && matches !== expected) {
      return toolError(
        'MatchCountMismatch',
        `Found ${matches} match${matches === 1 ? '' : 'es'} in "${file.path}", expected ${expected}. Nothing changed.`,
        ['Make search more specific, or read the note first.'],
      );
    }
    if (matches === 0) {
      const summary = `No matches for "${search.slice(0, 80)}" in "${file.path}"; nothing changed.`;
      if (wantsJson(args)) {
        return jsonResult({
          ok: true,
          action: 'edit',
          path: file.path,
          applied: false,
          review: 'none',
          matches: 0,
        });
      }
      return `${summary}\nNext: read_file("${file.path}") to see the text, or try regex: true.`;
    }
    // A function keeps a literal replacement literal ($& and $1 are not expanded).
    const next = regex ? text.replace(pattern, replace) : text.replace(pattern, () => replace);

    void this.status(`Replacing ${matches} match${matches === 1 ? '' : 'es'} in "${file.path}"...`);
    const outcome = await submitWrite(this.chat, {
      kind: 'write',
      path: file.path,
      content: next,
      overwrite: true,
      original: text,
      instruction: `Replace ${matches} match${matches === 1 ? '' : 'es'} of "${search.slice(0, 80)}"`,
      reason: args.reason,
    });
    return renderWrite(
      outcome,
      args,
      `Replaced ${matches} match${matches === 1 ? '' : 'es'} in "${file.path}"`,
      { matches },
      [`read_file("${file.path}") to check it`],
    );
  }
}
