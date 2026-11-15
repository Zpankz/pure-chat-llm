import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';
import {
  findSection,
  isTextFile,
  noteRefError,
  noteStats,
  pageLines,
  readCharCap,
  resolveNote,
  splitNoteRef,
  statsLine,
} from '../utils/vaultResolve';

const readFileParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'The file: a path, a note name, a [[wikilink]] (a #Heading in it limits the read to that section), or "active" for the note the user has open.',
    },
    offset: {
      type: 'integer',
      description:
        'First line to read, 0-based line number in the file. Pass next_offset from a truncated read to continue.',
    },
    limit: {
      type: 'integer',
      description: 'Most lines to return. Defaults to 2000.',
      default: 2000,
    },
    max_chars: {
      type: 'integer',
      description:
        'Most characters to return; the read stops at a whole line. Defaults to 5000 in voice, 20000 elsewhere.',
    },
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['path'],
} as const);

export type ReadFileArgs = InferArgs<typeof readFileParameters>;

/**
 * Reads a text file or note, a page at a time, by path, name, wikilink or "active".
 */
export class ReadFileTool extends Tool<ReadFileArgs> {
  readonly name = 'read_file';
  readonly classification = 'Vault';
  readonly description =
    'Reads the text of a note or other text file in the vault, a page at a time. Use it to read a whole note, a non-note text file (csv, json, canvas), or a line range; use read_note_section for a note\'s outline or one heading\'s section. path takes a path, a note name, a [[wikilink]] or "active". Long files are cut at max_chars; the result says the offset to continue from. format json returns {path, offset, end, total_lines, truncated, next_offset, content}.';
  readonly parameters = readFileParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Reads one page.
   * @param args - Tool arguments.
   */
  async execute(args: ReadFileArgs): Promise<string> {
    const app = this.chat.plugin.app;
    const ref = String(args.path ?? '');
    const { note, subpath } = splitNoteRef(ref);
    const { file, candidates } = resolveNote(app, note || 'active');
    if (!file) return noteRefError(note, candidates, 'read_file');
    if (!isTextFile(file)) {
      return toolError('NotText', `"${file.path}" is a ${file.extension} file, not text.`, [
        'Read notes and text files only; for an image or PDF, tell the user where it is.',
      ]);
    }

    let content: string;
    try {
      void this.status(`Reading "${file.path}"...`);
      content = await app.vault.cachedRead(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('ReadFailed', `Could not read "${file.path}": ${message}`, [
        'Try again once; if it fails again, tell the user.',
      ]);
    }

    const lines = content.split(/\r?\n/);
    const cache = file.extension === 'md' ? app.metadataCache.getFileCache(file) : null;
    let windowStart = 0;
    let windowEnd = lines.length;
    let section = '';
    if (subpath) {
      const found = findSection(cache, subpath, lines.length);
      if (!found) {
        return toolError('SectionNotFound', `No section "${subpath}" in "${file.path}".`, [
          `read_note_section(link="${file.path}", headings_only=true) lists its headings.`,
        ]);
      }
      windowStart = found.start;
      windowEnd = found.end;
      section = found.label;
    }

    const offset = typeof args.offset === 'number' ? Math.floor(args.offset) : windowStart;
    if (offset < windowStart || offset >= Math.max(windowEnd, windowStart + 1)) {
      return toolError(
        'OutOfRange',
        `offset ${offset} is outside ${section ? `section "${section}" (lines ${windowStart}-${windowEnd - 1})` : `"${file.path}" (${lines.length} lines, 0 to ${lines.length - 1})`}.`,
        [`Call read_file without offset to start at line ${windowStart}.`],
      );
    }
    const limit = Math.max(1, Math.floor(args.limit ?? 2000));
    const page = pageLines(
      lines,
      offset,
      windowEnd,
      limit,
      readCharCap(this.chat.role, args.max_chars),
    );
    const target = section ? `${file.path}#${section}` : file.path;
    const continueHint =
      page.nextOffset !== null ? `read_file(path="${target}", offset=${page.nextOffset})` : '';

    if (wantsJson(args)) {
      return jsonResult({
        path: file.path,
        ...(section ? { section } : {}),
        offset: page.start,
        end: page.end,
        total_lines: lines.length,
        truncated: page.truncated,
        next_offset: page.nextOffset,
        content: page.text,
      });
    }

    const range = `lines ${page.start + 1}-${page.end} of ${section ? `section "${section}" (${windowStart + 1}-${windowEnd})` : lines.length}`;
    const summary = page.truncated
      ? `Read "${file.basename}": ${range}, truncated${page.nextOffset !== null ? `; continue with offset ${page.nextOffset}` : ' (one very long line was cut)'}.`
      : `Read "${file.basename}": ${range}.`;
    const meta = [
      `Path: ${file.path}`,
      `Modified: ${new Date(file.stat.mtime).toISOString().slice(0, 16).replace('T', ' ')}`,
      `Size: ${content.length.toLocaleString()} characters`,
    ];
    const stats = statsLine(noteStats(cache));
    if (stats && !section) meta.push(`Structure: ${stats}`);
    const out = [summary, meta.join(' · '), '---', page.text, '---'];
    if (continueHint) out.push(`Truncated: continue with ${continueHint}.`);
    return out.join('\n');
  }
}
