import { normalizePath, parseLinktext, TFile } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { notePath, REASON_PARAMETER, WRITE_FORMAT } from './CreateNote';
import { renderWrite, submitWrite } from './EditReview';
import { toolError } from './toolContract';

const MODES = ['append', 'prepend', 'replace'] as const;
type Mode = (typeof MODES)[number];

const writeNoteSectionParameters = defineToolParameters({
  type: 'object',
  properties: {
    link: {
      type: 'string',
      description:
        'Where to write, as a wiki link: [[Note#Heading]], [[Note#Parent#Child]] for a nested heading, or [[Note]] for the whole note. Give this or path.',
    },
    path: {
      type: 'string',
      description: "Vault path of the note, such as 'Projects/Plan.md'. Give this or link.",
    },
    heading: {
      type: 'string',
      description:
        'Heading to write under (case does not matter; Parent#Child for a nested one). Overrides a heading in link. Leave it out to write to the whole note.',
    },
    content: {
      type: 'string',
      description: 'Markdown to write.',
    },
    mode: {
      type: 'string',
      description:
        '`append` (default) adds at the end of the section, after its sub-sections, or at the end of the note when there is no heading. `prepend` adds right under the heading, or at the start of the note after its frontmatter. `replace` replaces the section body (heading kept; needs a heading).',
      enum: [...MODES],
    },
    create_heading: {
      type: 'boolean',
      description:
        'Add the heading at the end of the note (or of its parent section) when it is missing. Default true.',
    },
    heading_level: {
      type: 'integer',
      description: 'Level 1-6 for a new top-level heading. Default 2.',
    },
    reason: REASON_PARAMETER,
    format: WRITE_FORMAT,
  },
  required: ['content'],
} as const);

export type WriteNoteSectionArgs = InferArgs<typeof writeNoteSectionParameters>;

/** A heading as Obsidian's metadata cache reports it. */
interface HeadingCache {
  heading: string;
  level: number;
  position: { start: { offset: number }; end: { offset: number } };
}

/** A heading's section: heading line start and end, and where the section ends. */
interface Section {
  start: number;
  headingEnd: number;
  end: number;
  level: number;
}

/**
 * Finds a heading's section. `Parent#Child` looks for Child inside Parent's section. Matches
 * the exact heading text first, then ignoring case. When only the last heading is missing,
 * returns its name and the parent's section (if any) so it can be created there.
 * @param headings - Headings in document order.
 * @param length - Length of the note's text.
 * @param subpath - Heading path, with or without a leading `#`.
 */
export function findSection(
  headings: HeadingCache[],
  length: number,
  subpath: string,
): { section: Section } | { missing: string; parent?: Section } | { error: string } {
  const parts = subpath
    .split('#')
    .map(p => p.trim())
    .filter(Boolean);
  let scope: Section | undefined;
  for (let i = 0; i < parts.length; i++) {
    const within = headings.filter(
      h =>
        (!scope ||
          (h.position.start.offset > scope.start && h.position.start.offset < scope.end)) &&
        (!scope || h.level > scope.level),
    );
    const want = parts[i];
    const hit =
      within.find(h => h.heading.trim() === want) ??
      within.find(h => h.heading.trim().toLowerCase() === want.toLowerCase());
    if (!hit) {
      if (i === parts.length - 1) return { missing: want, parent: scope };
      return { error: `Heading "${want}" not found${scope ? ' in its parent section' : ''}.` };
    }
    const next = headings.find(
      h => h.position.start.offset > hit.position.start.offset && h.level <= hit.level,
    );
    scope = {
      start: hit.position.start.offset,
      headingEnd: hit.position.end.offset,
      end: next ? next.position.start.offset : length,
      level: hit.level,
    };
  }
  return scope ? { section: scope } : { error: 'No heading given.' };
}

/**
 * The separator between two blocks: one newline when both sides are list items or table rows
 * (so a list stays one list), otherwise a blank line.
 * @param before - Text before.
 * @param after - Text after.
 */
function joiner(before: string, after: string): string {
  const last = before.split('\n').pop() ?? '';
  const first = after.split('\n')[0] ?? '';
  const list = /^\s*([-*+]|\d+[.)])\s/;
  const table = /^\s*\|/;
  return (list.test(last) && list.test(first)) || (table.test(last) && table.test(first))
    ? '\n'
    : '\n\n';
}

/**
 * Joins two blocks with the right separator; either may be empty.
 * @param a - First block.
 * @param b - Second block.
 */
function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a + joiner(a, b) + b;
}

/** @param content - Content to insert, without blank lines around it. */
const clean = (content: string) => content.replace(/^\s*\n/, '').replace(/\s+$/, '');

/**
 * Writes into a heading's section.
 * @param text - Note text.
 * @param section - The section.
 * @param content - Markdown to write.
 * @param mode - Write mode.
 */
export function writeSection(text: string, section: Section, content: string, mode: Mode): string {
  const head = text.slice(0, section.headingEnd);
  const body = text.slice(section.headingEnd, section.end);
  const tail = text.slice(section.end);
  const lead = /^\s*\n/.exec(body)?.[0] ?? '\n';
  const core = body.slice(lead.length).replace(/\s+$/, '');
  const piece = clean(content);
  const next =
    mode === 'replace' ? piece : mode === 'append' ? join(core, piece) : join(piece, core);
  // Keep the note's own spacing under the heading when the section had text; else a blank line.
  const gap = core && mode !== 'replace' ? lead.replace(/[^\n]/g, '') || '\n' : '\n\n';
  return `${head}${gap}${next}\n${tail ? `\n${tail}` : ''}`;
}

/**
 * Writes to the whole note: append at the end, or prepend after the frontmatter.
 * @param text - Note text.
 * @param content - Markdown to write.
 * @param mode - `append` or `prepend`.
 */
export function writeWhole(text: string, content: string, mode: 'append' | 'prepend'): string {
  const piece = clean(content);
  if (mode === 'append') return `${join(text.replace(/\s+$/, ''), piece)}\n`;
  const fm = /^---\n[\s\S]*?\n---(\n|$)/.exec(text)?.[0] ?? '';
  const rest = text.slice(fm.length).replace(/^\s*\n/, '');
  return `${fm}${fm && !fm.endsWith('\n') ? '\n' : ''}${join(piece, rest.replace(/\s+$/, ''))}\n`;
}

/** Writes to a section of a note, or to the start or end of the whole note. */
export class WriteNoteSectionTool extends Tool<WriteNoteSectionArgs> {
  readonly name = 'write_note_section';
  readonly classification = 'Vault';
  readonly description =
    'Adds to or replaces part of an existing note: append or prepend under a heading (created if missing), replace a section body, or add to the start or end of the whole note. Use it for additions such as a new task, log entry or paragraph; use replace_in_note to change specific text and create_obsidian_note for a new note. In a chat the user reviews the edit first; background workers follow the write policy in settings.';
  readonly parameters = writeNoteSectionParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: WriteNoteSectionArgs): Promise<string> {
    const app = this.chat.plugin.app;
    const mode = (args.mode ?? 'append') as Mode;
    if (!MODES.includes(mode)) {
      return toolError(
        'InvalidArgument',
        `mode must be append, prepend or replace, not "${mode}".`,
      );
    }
    if (typeof args.content !== 'string') {
      return toolError('InvalidArgument', 'content must be a string.');
    }
    const link =
      typeof args.link === 'string' ? args.link.replace(/^!?\[\[|\]\]$/g, '').trim() : '';
    const parsed = link ? parseLinktext(link.split('|')[0]) : { path: '', subpath: '' };
    const target = (typeof args.path === 'string' && args.path.trim()) || parsed.path;
    const subpath = (typeof args.heading === 'string' && args.heading.trim()) || parsed.subpath;
    if (!target) {
      return toolError('InvalidArgument', 'Give the note as link ([[Note#Heading]]) or path.');
    }

    const file =
      app.vault.getFileByPath(normalizePath(target)) ??
      app.vault.getFileByPath(notePath(target)) ??
      app.metadataCache.getFirstLinkpathDest(target, '');
    if (!(file instanceof TFile)) {
      return toolError('NotFound', `No note found for "${target}".`, [
        'glob_vault_files or search_vault to find it',
        `create_obsidian_note(path="${notePath(target)}") to make a new note`,
      ]);
    }

    const text = await app.vault.read(file);
    const headings = ((app.metadataCache.getFileCache(file)?.headings ?? []) as HeadingCache[])
      .slice()
      .sort((a, b) => a.position.start.offset - b.position.start.offset);
    let next: string;
    let where: string;
    if (!subpath.replace(/#/g, '').trim()) {
      if (mode === 'replace') {
        return toolError('InvalidArgument', 'replace needs a heading.', [
          'heading: the section to replace',
          'replace_in_note to change specific text',
          'create_obsidian_note with overwrite: true to replace the whole note',
        ]);
      }
      next = writeWhole(text, args.content, mode);
      where = mode === 'append' ? 'the end of' : 'the start of';
    } else {
      const found = findSection(headings, text.length, subpath);
      if ('error' in found) {
        return toolError('HeadingNotFound', `${found.error} Note: "${file.path}".`, [
          `read_note_section(link="[[${file.basename}]]", headings_only=true) to list headings`,
        ]);
      }
      if ('section' in found) {
        next = writeSection(text, found.section, args.content, mode);
        where = `section "${subpath.replace(/^#/, '')}" in`;
      } else {
        if (args.create_heading === false) {
          return toolError('HeadingNotFound', `No heading "${found.missing}" in "${file.path}".`, [
            `read_note_section(link="[[${file.basename}]]", headings_only=true) to list headings`,
            'create_heading: true to add it',
          ]);
        }
        const level = found.parent
          ? Math.min(6, found.parent.level + 1)
          : Math.max(1, Math.min(6, Math.round(Number(args.heading_level ?? 2)) || 2));
        const block = `${'#'.repeat(level)} ${found.missing}\n\n${clean(args.content)}`;
        if (found.parent) {
          const before = text.slice(0, found.parent.end).replace(/\s+$/, '');
          const after = text.slice(found.parent.end);
          next = `${before}\n\n${block}\n${after ? `\n${after}` : ''}`;
        } else {
          const before = text.replace(/\s+$/, '');
          next = `${before}${before ? '\n\n' : ''}${block}\n`;
        }
        where = `new section "${found.missing}" in`;
      }
    }

    const verb = { append: 'Appended to', prepend: 'Prepended to', replace: 'Replaced' }[mode];
    const done = where.startsWith('new') ? `Added ${where}` : `${verb} ${where}`;
    void this.status(`Writing to "${file.path}"...`);
    const outcome = await submitWrite(this.chat, {
      kind: 'write',
      path: file.path,
      content: next,
      overwrite: true,
      original: text,
      instruction: `${done} the note`,
      reason: args.reason,
    });
    return renderWrite(
      outcome,
      args,
      `${done} "${file.path}"`,
      { mode, heading: subpath.replace(/^#/, '') || null },
      [
        `read_note_section(link="[[${file.basename}${subpath ? `#${subpath.replace(/^#/, '')}` : ''}]]")`,
      ],
    );
  }
}
