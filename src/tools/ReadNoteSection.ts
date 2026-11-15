import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';
import {
  findSection,
  noteRefError,
  noteStats,
  pageLines,
  readCharCap,
  resolveNote,
  splitNoteRef,
  statsLine,
} from '../utils/vaultResolve';

const readNoteSectionParameters = defineToolParameters({
  type: 'object',
  properties: {
    link: {
      type: 'string',
      description:
        'The note and section: [[Note#Heading]], [[Note#^block-id]], Note#Heading, or just the note (a path, its name or "active") with headings_only.',
    },
    headings_only: {
      type: 'boolean',
      description: "Return the note's outline (its headings) instead of text. Defaults to false.",
      default: false,
    },
    depth: {
      type: 'integer',
      description: 'Deepest heading level in the outline, 1 to 6. Defaults to 6.',
      default: 6,
    },
    max_chars: {
      type: 'integer',
      description:
        'Most characters of section text to return. Defaults to 5000 in voice, 20000 elsewhere.',
    },
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['link'],
} as const);

export type ReadNoteSectionArgs = InferArgs<typeof readNoteSectionParameters>;

/** Most headings an outline lists. */
const OUTLINE_LIMIT = 200;

/**
 * Reads a note's outline, or the text under one heading or block.
 */
export class ReadNoteSectionTool extends Tool<ReadNoteSectionArgs> {
  readonly name = 'read_note_section';
  readonly classification = 'Vault';
  readonly description =
    'Reads part of a note: its outline (headings_only) or the text under one heading or block, given as [[Note#Heading]] or [[Note#^block-id]]. Use it on long notes: outline first, then the section you need. Use read_file for a whole note, a non-note file or a line range. Headings match loosely (case and punctuation ignored). format json returns {path, total_lines, headings, truncated} for an outline, or {path, section, kind, offset, end, truncated, next_offset, content}; line numbers in json are 0-based.';
  readonly parameters = readNoteSectionParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Reads the outline or section.
   * @param args - Tool arguments.
   */
  async execute(args: ReadNoteSectionArgs): Promise<string> {
    const app = this.chat.plugin.app;
    const link = String(args.link ?? '');
    const { note, subpath } = splitNoteRef(link);
    const { file, candidates } = resolveNote(app, note || 'active');
    if (!file) return noteRefError(note, candidates, 'read_note_section');
    if (file.extension !== 'md') {
      return toolError(
        'NotANote',
        `"${file.path}" is not a Markdown note, so it has no sections.`,
        [`read_file(path="${file.path}") reads it as text.`],
      );
    }

    let content: string;
    try {
      void this.status(`Reading "${file.path}"${subpath ? ` ${subpath}` : ''}...`);
      content = await app.vault.cachedRead(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('ReadFailed', `Could not read "${file.path}": ${message}`, [
        'Try again once; if it fails again, tell the user.',
      ]);
    }
    const cache = app.metadataCache.getFileCache(file);
    const lines = content.split(/\r?\n/);

    if (args.headings_only) {
      const depth = Math.max(1, Math.min(6, Math.floor(args.depth ?? 6)));
      const all = cache?.headings ?? [];
      const shown = all.filter(h => h.level <= depth).slice(0, OUTLINE_LIMIT);
      if (wantsJson(args)) {
        return jsonResult({
          path: file.path,
          total_lines: lines.length,
          headings: shown.map(h => ({
            level: h.level,
            heading: h.heading,
            offset: h.position.start.line,
          })),
          truncated: all.filter(h => h.level <= depth).length > shown.length,
        });
      }
      const summary = shown.length
        ? `Outline of "${file.basename}": ${shown.length} heading${shown.length === 1 ? '' : 's'}.`
        : `"${file.basename}" has no headings${all.length ? ` at depth 1-${depth}` : ''}.`;
      const stats = statsLine(noteStats(cache));
      const out = [
        summary,
        `Path: ${file.path} · ${lines.length} lines${stats ? ` · ${stats}` : ''}`,
      ];
      if (shown.length) {
        out.push('---');
        for (const h of shown) {
          out.push(
            `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.heading}  (line ${h.position.start.line + 1})`,
          );
        }
        out.push('---');
        out.push(
          `Read a section with read_note_section(link="[[${file.path}#${shown[0].heading}]]"), or the whole note with read_file(path="${file.path}").`,
        );
      } else {
        out.push(`Read it with read_file(path="${file.path}").`);
      }
      return out.join('\n');
    }

    // No section named: the whole note, as before (read_file does the same with paging).
    const found = subpath
      ? findSection(cache, subpath, lines.length)
      : { start: 0, end: lines.length, kind: 'note' as const, label: '' };
    if (!found) {
      const names = (cache?.headings ?? []).slice(0, 15).map(h => h.heading);
      return toolError(
        subpath.startsWith('#^') ? 'BlockNotFound' : 'SectionNotFound',
        `No section "${subpath.replace(/^#/, '')}" in "${file.path}".`,
        [
          names.length
            ? `Headings in this note: ${names.join(' | ')}.`
            : 'This note has no headings; read_file reads it whole.',
          `read_note_section(link="${file.path}", headings_only=true) shows the outline.`,
        ],
      );
    }

    const page = pageLines(
      lines,
      found.start,
      found.end,
      Number.MAX_SAFE_INTEGER,
      readCharCap(this.chat.role, args.max_chars),
    );
    const target = found.label ? `${file.path}#${found.label}` : file.path;
    if (wantsJson(args)) {
      return jsonResult({
        path: file.path,
        section: found.label,
        kind: found.kind,
        offset: found.start,
        end: found.end,
        truncated: page.truncated,
        next_offset: page.nextOffset,
        content: page.text,
      });
    }
    const what = found.label
      ? `Section "${found.label}" of "${file.basename}"`
      : `Whole note "${file.basename}"`;
    const summary = `${what}: lines ${found.start + 1}-${found.end}${page.truncated ? `, truncated${page.nextOffset !== null ? `; continue with read_file offset ${page.nextOffset}` : ''}` : ''}.`;
    const out = [summary, `Path: ${file.path}`, '---', page.text, '---'];
    if (page.nextOffset !== null) {
      out.push(`Truncated: continue with read_file(path="${target}", offset=${page.nextOffset}).`);
    } else if (!found.label && cache?.headings?.length) {
      out.push(
        `Tip: read_note_section(link="${file.path}", headings_only=true) gives the outline of a long note.`,
      );
    }
    return out.join('\n');
  }
}
