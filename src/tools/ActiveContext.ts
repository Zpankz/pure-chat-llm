import { defineToolParameters, InferArgs, Tool } from '../tools';
import {
  activeMarkdownView,
  activeNote,
  folderNote,
  noteStats,
  pageLines,
  readCharCap,
  statsLine,
} from '../utils/vaultResolve';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

const activeContextParameters = defineToolParameters({
  type: 'object',
  properties: {
    include_content: {
      type: 'boolean',
      description:
        "Also return the note's text (capped like read_file). Defaults to false: path, title, selection and outline only.",
      default: false,
    },
    max_chars: {
      type: 'integer',
      description:
        'Most characters of selection or content to return. Defaults to 5000 in voice, 20000 elsewhere.',
    },
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: [],
} as const);

export type ActiveContextArgs = InferArgs<typeof activeContextParameters>;

/** Headings listed in the outline. */
const OUTLINE_LIMIT = 30;

/**
 * What the user has open: the active note's path, title, cursor and selection.
 */
export class ActiveContextTool extends Tool<ActiveContextArgs> {
  readonly name = 'get_active_context';
  readonly classification = 'UI';
  readonly description =
    'Tells you which note the user has open: its path, title, folder, cursor line, selected text and outline. Use it to resolve "this note", "here" or "what I\'ve selected"; other tools also accept "active" as a note name. The note\'s text comes only with include_content (or use read_file). format json returns {path, title, folder, folder_note, cursor, line_count, selection, selection_truncated, headings, tags, content?, truncated?, next_offset?}.';
  readonly parameters = activeContextParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Describes the active note.
   * @param args - Tool arguments.
   */
  async execute(args: ActiveContextArgs): Promise<string> {
    const app = this.chat.plugin.app;
    const view = activeMarkdownView(app);
    const file = view?.file ?? activeNote(app);
    if (!file) {
      return toolError('NoActiveNote', 'No note is open in the editor.', [
        'Ask the user which note they mean, then pass its name to read_file or search_vault.',
      ]);
    }
    const cap = readCharCap(this.chat.role, args.max_chars);
    const editor = view?.editor;
    const rawSelection = editor?.getSelection() ?? '';
    const selection = rawSelection.slice(0, cap);
    const selectionTruncated = rawSelection.length > selection.length;
    const cursor = editor ? editor.getCursor() : null;
    const cache = app.metadataCache.getFileCache(file);
    const stats = noteStats(cache);
    const headings = (cache?.headings ?? []).slice(0, OUTLINE_LIMIT).map(h => ({
      level: h.level,
      heading: h.heading,
      offset: h.position.start.line,
    }));
    const folder = file.parent && !file.parent.isRoot() ? file.parent.path : '/';
    // The overview note of the folder it sits in (X/X.md), for navigating around it.
    const parentNote = file.parent ? folderNote(file.parent) : null;
    const folderNotePath = parentNote && parentNote.path !== file.path ? parentNote.path : null;

    let text: string | null = null;
    if (args.include_content) {
      try {
        text = editor ? editor.getValue() : await app.vault.cachedRead(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError('ReadFailed', `Could not read "${file.path}": ${message}`, [
          `read_file(path="${file.path}") reads it from disk.`,
        ]);
      }
    }
    const lines = text?.split(/\r?\n/) ?? null;
    const lineCount = editor ? editor.lineCount() : (lines?.length ?? null);
    const page = lines ? pageLines(lines, 0, lines.length, Number.MAX_SAFE_INTEGER, cap) : null;

    if (wantsJson(args)) {
      return jsonResult({
        path: file.path,
        title: file.basename,
        folder,
        folder_note: folderNotePath,
        cursor: cursor ? { line: cursor.line, ch: cursor.ch } : null,
        line_count: lineCount,
        selection,
        selection_truncated: selectionTruncated,
        headings,
        tags: stats.tags,
        ...(page
          ? { content: page.text, truncated: page.truncated, next_offset: page.nextOffset }
          : {}),
      });
    }

    const out = [
      `The open note is "${file.basename}" in ${folder === '/' ? 'the vault root' : `folder ${folder}`}${selection ? `, with ${rawSelection.length} characters selected` : ''}.`,
      `Path: ${file.path}${folderNotePath ? ` · folder note: ${folderNotePath}` : ''}`,
    ];
    if (cursor) {
      out.push(
        `Cursor: line ${cursor.line + 1}, column ${cursor.ch + 1}${lineCount !== null ? ` of ${lineCount} lines` : ''}`,
      );
    } else {
      out.push('Cursor: unknown (the note is not in an open editor)');
    }
    const structure = statsLine(stats);
    if (structure) out.push(`Structure: ${structure}`);
    if (headings.length) {
      out.push(`Outline: ${headings.map(h => `${'#'.repeat(h.level)} ${h.heading}`).join(' | ')}`);
    }
    if (selection) {
      out.push('Selection:', '---', selection, '---');
      if (selectionTruncated) out.push(`(selection cut at ${cap} characters)`);
    } else {
      out.push('Selection: none');
    }
    if (page) {
      out.push('Content:', '---', page.text, '---');
      if (page.nextOffset !== null) {
        out.push(
          `Truncated: continue with read_file(path="${file.path}", offset=${page.nextOffset}).`,
        );
      }
    }
    return out.join('\n');
  }
}
