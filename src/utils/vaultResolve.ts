import {
  App,
  CachedMetadata,
  MarkdownView,
  normalizePath,
  resolveSubpath,
  TFile,
  TFolder,
} from 'obsidian';
import { layerForRole, toolError } from '../tools/toolContract';

/**
 * The note the user is looking at. Side panels (like the voice view) take focus, so this falls
 * back to the most recently used Markdown editor.
 * @param app - Obsidian app.
 */
export function activeNote(app: App): TFile | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (view?.file) return view.file;
  const active = app.workspace.getActiveFile();
  if (active?.extension === 'md') return active;
  let recent: TFile | null = null;
  app.workspace.iterateAllLeaves(leaf => {
    if (!recent && leaf.view instanceof MarkdownView && leaf.view.file) recent = leaf.view.file;
  });
  return recent;
}

/**
 * The Markdown view of the note the user is looking at, for its editor (cursor, selection).
 * Falls back to the open view of `activeNote` when a side panel has focus.
 * @param app - Obsidian app.
 */
export function activeMarkdownView(app: App): MarkdownView | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (view?.file) return view;
  const file = activeNote(app);
  if (!file) return null;
  let found: MarkdownView | null = null;
  app.workspace.iterateAllLeaves(leaf => {
    if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path)
      found = leaf.view;
  });
  return found;
}

/**
 * Splits a note reference into the note part and a `#Heading` / `#^block` subpath, dropping
 * `[[ ]]` and an `|alias`. An empty note part (`[[#Heading]]`) means the active note.
 * @param ref - Path, name, wikilink or "active", optionally with a subpath.
 */
export function splitNoteRef(ref: string): { note: string; subpath: string } {
  const cleaned = (ref ?? '')
    .trim()
    .replace(/^\[\[|\]\]$/g, '')
    .split('|')[0]
    .trim();
  const i = cleaned.indexOf('#');
  if (i < 0) return { note: cleaned, subpath: '' };
  return { note: cleaned.slice(0, i).trim(), subpath: cleaned.slice(i).trim() };
}

/**
 * The tool error for a note reference that `resolveNote` could not settle: `Ambiguous` with the
 * candidates, `NoActiveNote` for "active" with nothing open, otherwise `NotFound`.
 * @param ref - What the caller passed.
 * @param candidates - `resolveNote`'s candidates.
 * @param tool - Tool name for the retry hint.
 */
export function noteRefError(ref: string, candidates: TFile[], tool: string): string {
  const raw = (ref ?? '').trim();
  if (candidates.length) {
    return toolError(
      'Ambiguous',
      `Several notes match "${raw}": ${candidates.map(f => f.path).join(', ')}.`,
      [`Call ${tool} again with the full path of the one you mean.`],
    );
  }
  if (!raw || /^(active|current|this)( note)?$/i.test(raw)) {
    return toolError('NoActiveNote', 'No note is open in the editor.', [
      'Ask the user which note they mean, then pass its name or path.',
    ]);
  }
  return toolError('NotFound', `No note or file found for "${raw}".`, [
    `search_vault(query="${raw}") finds notes by title and text.`,
    'glob_vault_files(pattern="**/*name*") finds paths by pattern.',
  ]);
}

/**
 * Finds a note from what a model (or a voice transcript) says: an exact path, a path without
 * `.md`, a wikilink, a basename, or "active"/"current". Returns candidates when the name is
 * ambiguous.
 * @param app - Obsidian app.
 * @param ref - Path, name, wikilink or "active".
 */
export function resolveNote(app: App, ref: string): { file: TFile | null; candidates: TFile[] } {
  const raw = (ref ?? '').trim();
  if (!raw || /^(active|current|this)( note)?$/i.test(raw)) {
    return { file: activeNote(app), candidates: [] };
  }
  const cleaned = raw
    .replace(/^\[\[|\]\]$/g, '')
    .split('|')[0]
    .split('#')[0]
    .trim();
  const path = normalizePath(cleaned);
  for (const candidate of [path, `${path}.md`]) {
    const file = app.vault.getAbstractFileByPath(candidate);
    if (file instanceof TFile) return { file, candidates: [] };
  }
  const key = cleaned.replace(/\.md$/i, '').toLowerCase();
  const files = app.vault.getMarkdownFiles();
  const exact = files.filter(f => f.basename.toLowerCase() === key);
  // A bare name shared by several notes is ambiguous; a [[wikilink]] resolves as Obsidian would.
  if (exact.length > 1 && !raw.startsWith('[[') && !cleaned.includes('/')) {
    return { file: null, candidates: exact.slice(0, 10) };
  }
  const viaLink = app.metadataCache.getFirstLinkpathDest(cleaned, '');
  if (viaLink) return { file: viaLink, candidates: [] };

  if (exact.length === 1) return { file: exact[0], candidates: [] };
  if (exact.length > 1) return { file: null, candidates: exact.slice(0, 10) };
  // Speech often drops spaces and punctuation: compare letters and digits only.
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const sq = squash(key);
  const loose = sq ? files.filter(f => squash(f.basename) === sq) : [];
  if (loose.length === 1) return { file: loose[0], candidates: [] };
  const partial = sq ? files.filter(f => squash(f.basename).includes(sq)) : [];
  if (partial.length === 1) return { file: partial[0], candidates: [] };
  return { file: null, candidates: [...new Set([...loose, ...partial])].slice(0, 10) };
}

/**
 * Finds folders from an exact path or a bare folder name anywhere in the vault ("LO" matches
 * "Medicine/ANZCA/LO"). A bare name is matched in tiers, and the first tier with a match wins:
 * the same name with the same case, then the same name in any case, then a path ending. Within a
 * tier one match is the answer, and so is the only top-level one among several; anything else is
 * a true tie and every match comes back (callers that need one folder say it is ambiguous). So
 * "LO" picks `Medicine/ANZCA/LO` over `src/lo` (validation run 2).
 * @param app - Obsidian app.
 * @param ref - Folder path or name.
 */
export function resolveFolders(app: App, ref: string): TFolder[] {
  const raw = (ref ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return [app.vault.getRoot()];
  const direct = app.vault.getAbstractFileByPath(normalizePath(raw));
  if (direct instanceof TFolder) return [direct];
  const key = raw.toLowerCase();
  const all = app.vault
    .getAllLoadedFiles()
    .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot());
  const pick = (matches: TFolder[]): TFolder[] => {
    if (matches.length <= 1) return matches;
    const top = matches.filter(f => !f.path.includes('/'));
    return top.length === 1 ? top : matches;
  };
  const tiers = [
    all.filter(f => f.name === raw),
    all.filter(f => f.name.toLowerCase() === key),
    all.filter(f => f.path.toLowerCase().endsWith(`/${key}`) || f.path.toLowerCase() === key),
  ];
  for (const tier of tiers) if (tier.length) return pick(tier);
  return [];
}

/**
 * The tool error for a folder that `resolveFolders` did not find, naming folders whose name
 * is close (speech often adds or drops words).
 * @param app - Obsidian app.
 * @param ref - What the caller passed.
 */
export function folderRefError(app: App, ref: string): string {
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const key = squash(ref.split('/').filter(Boolean).pop() ?? ref);
  const near = key
    ? app.vault
        .getAllLoadedFiles()
        .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
        .filter(f => {
          const name = squash(f.name);
          return !!name && (name.includes(key) || (name.length >= 3 && key.includes(name)));
        })
        .slice(0, 5)
        .map(f => f.path)
    : [];
  return toolError('FolderNotFound', `No folder named or at "${ref}".`, [
    ...(near.length ? [`Similar folders: ${near.join(', ')}.`] : []),
    'list_vault_folders(path="/", include_notes=false) lists every folder.',
  ]);
}

/**
 * True when a file sits inside any of the folders: at any depth, or with `recursive` false
 * only directly in one of them.
 * @param file - File.
 * @param folders - Folders.
 * @param recursive - Include subfolders (default true).
 */
export function inFolders(file: TFile, folders: TFolder[], recursive = true): boolean {
  return pathInFolders(file.path, folders, recursive);
}

/**
 * `inFolders` for a path string (such as a search index key).
 * @param path - File path.
 * @param folders - Folders.
 * @param recursive - Include subfolders (default true).
 */
export function pathInFolders(path: string, folders: TFolder[], recursive = true): boolean {
  const dir = parentPath(path);
  return folders.some(f => {
    if (!recursive) return f.isRoot() ? dir === '' : dir === f.path;
    return f.isRoot() || path.startsWith(`${f.path}/`);
  });
}

/**
 * The folder part of a path ('' at the vault root).
 * @param path - File path.
 */
export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * A folder's folder note, by the convention that `X/X.md` is the note for folder X.
 * @param folder - Folder.
 */
export function folderNote(folder: TFolder): TFile | null {
  if (folder.isRoot()) return null;
  const name = folder.name.toLowerCase();
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === 'md' && child.basename.toLowerCase() === name)
      return child;
  }
  return null;
}

/**
 * Whether a note is its folder's folder note (`X/X.md`).
 * @param file - Note.
 */
export function isFolderNote(file: TFile): boolean {
  const dir = parentPath(file.path);
  if (!dir || file.extension !== 'md') return false;
  return dir.split('/').pop()?.toLowerCase() === file.basename.toLowerCase();
}

/**
 * Resolves a tool's `folder` argument: null for no scope (empty or "/"), the matching folders,
 * or a FolderNotFound tool error.
 * @param app - Obsidian app.
 * @param folder - Folder path or bare name, or undefined.
 */
export function folderScope(
  app: App,
  folder: string | undefined,
): { folders: TFolder[] | null; error?: string } {
  const ref = (folder ?? '').trim();
  if (!ref || ref === '/') return { folders: null };
  const folders = resolveFolders(app, ref);
  if (!folders.length) return { folders: null, error: folderRefError(app, ref) };
  return { folders };
}

/** The shared `folder` and `recursive` parameters of the search and listing tools. */
export const FOLDER_SCOPE_PARAMETERS = {
  folder: {
    type: 'string',
    description:
      'Only look inside this folder: a path ("Uni/ANZCA/LO") or just a folder name ("LO"), found wherever it sits. Omit for the whole vault.',
  },
  recursive: {
    type: 'boolean',
    description:
      'With folder: include its subfolders at every depth (default true); false keeps to the folder itself, one level.',
    default: true,
  },
} as const;

/** Default character caps for reads: voice output is spoken and clipped, workers share a budget. */
export const READ_CHAR_CAPS = { voice: 5000, other: 20000, min: 500, max: 100000 } as const;

/**
 * The character cap for a read: the caller's `max_chars` (clamped), or the default for the
 * layer the chat runs in.
 * @param role - `PureChatLLMChat.role`.
 * @param maxChars - The caller's `max_chars`, if any.
 */
export function readCharCap(role: string | undefined, maxChars?: number): number {
  if (typeof maxChars === 'number' && Number.isFinite(maxChars)) {
    return Math.max(READ_CHAR_CAPS.min, Math.min(READ_CHAR_CAPS.max, Math.floor(maxChars)));
  }
  return layerForRole(role) === 'voice' ? READ_CHAR_CAPS.voice : READ_CHAR_CAPS.other;
}

/** One page of lines. Line numbers are 0-based; `end` is exclusive. */
export interface LinePage {
  text: string;
  start: number;
  end: number;
  /** More lines remain in the window, or the one line returned was cut. */
  truncated: boolean;
  /** Where to continue (`offset`), or null when the window is done. */
  nextOffset: number | null;
  /** The single line returned was longer than the cap and was cut. */
  cutLine: boolean;
}

/**
 * Takes whole lines from `start` until `end`, `maxLines` or `maxChars` is reached. A first line
 * longer than the cap is cut so a page is never empty.
 * @param lines - All lines.
 * @param start - First line (0-based).
 * @param end - End of the window (exclusive).
 * @param maxLines - Most lines.
 * @param maxChars - Most characters.
 */
export function pageLines(
  lines: string[],
  start: number,
  end: number,
  maxLines: number,
  maxChars: number,
): LinePage {
  const out: string[] = [];
  let chars = 0;
  let i = start;
  while (i < end && out.length < maxLines) {
    const cost = lines[i].length + (out.length ? 1 : 0);
    if (chars + cost > maxChars) break;
    out.push(lines[i]);
    chars += cost;
    i++;
  }
  let cutLine = false;
  if (!out.length && start < end) {
    out.push(lines[start].slice(0, maxChars));
    cutLine = lines[start].length > maxChars;
    i = start + 1;
  }
  return {
    text: out.join('\n'),
    start,
    end: i,
    truncated: i < end || cutLine,
    nextOffset: i < end ? i : null,
    cutLine,
  };
}

interface HeadingLike {
  heading: string;
  level: number;
  position: { start: { line: number } };
}

/**
 * Finds a `#Heading` or `#^block` subpath in a note and returns its line range (0-based, end
 * exclusive). Headings that Obsidian does not match exactly are matched ignoring case, spaces and
 * punctuation, as speech transcripts often differ.
 * @param cache - The note's metadata cache.
 * @param subpath - `#Heading`, `#A#B` or `#^block`.
 * @param lineCount - Lines in the note.
 */
export function findSection(
  cache: CachedMetadata | null,
  subpath: string,
  lineCount: number,
): { start: number; end: number; kind: 'heading' | 'block'; label: string } | null {
  if (!cache || !subpath) return null;
  const label = subpath.replace(/^#/, '');
  const hit = resolveSubpath(cache, subpath);
  if (hit) {
    const endLoc = hit.end;
    const end = endLoc ? (endLoc.col === 0 ? endLoc.line : endLoc.line + 1) : lineCount;
    return {
      start: hit.start.line,
      end: Math.min(lineCount, Math.max(end, hit.start.line + 1)),
      kind: hit.type === 'block' ? 'block' : 'heading',
      label,
    };
  }
  if (label.startsWith('^')) return null;
  const headings = (cache.headings ?? []) as HeadingLike[];
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const want = squash(label.split('#').filter(Boolean).pop() ?? '');
  if (!want) return null;
  let idx = headings.findIndex(h => squash(h.heading) === want);
  if (idx < 0) {
    const partial = headings.flatMap((h, i) => (squash(h.heading).includes(want) ? [i] : []));
    if (partial.length !== 1) return null;
    idx = partial[0];
  }
  const h = headings[idx];
  const next = headings.slice(idx + 1).find(n => n.level <= h.level);
  return {
    start: h.position.start.line,
    end: next ? next.position.start.line : lineCount,
    kind: 'heading',
    label: h.heading,
  };
}

/**
 * What the metadata cache knows about a note, for one-line summaries.
 * @param cache - The note's metadata cache.
 */
export function noteStats(cache: CachedMetadata | null): {
  headings: number;
  links: number;
  tags: string[];
  properties: string[];
} {
  const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  const fmTags = fm.tags ?? fm.tag;
  const tags = new Set<string>((cache?.tags ?? []).map(t => t.tag));
  const listed = Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? [fmTags] : [];
  for (const t of listed) {
    if (typeof t === 'string' && t.trim()) tags.add(t.startsWith('#') ? t : `#${t}`);
  }
  return {
    headings: cache?.headings?.length ?? 0,
    links: (cache?.links?.length ?? 0) + (cache?.embeds?.length ?? 0),
    tags: [...tags],
    properties: Object.keys(fm).filter(k => k !== 'position'),
  };
}

/**
 * One line describing a note's structure, such as "3 headings, 2 links, tags #a #b".
 * @param stats - From `noteStats`.
 */
export function statsLine(stats: ReturnType<typeof noteStats>): string {
  const parts: string[] = [];
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (stats.headings) parts.push(n(stats.headings, 'heading'));
  if (stats.links) parts.push(n(stats.links, 'link'));
  if (stats.tags.length) parts.push(`tags ${stats.tags.slice(0, 8).join(' ')}`);
  if (stats.properties.length) parts.push(`properties ${stats.properties.slice(0, 8).join(', ')}`);
  return parts.join(', ');
}

/** File extensions that are not text, so read tools refuse them. */
const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif webp bmp ico tif tiff avif heic pdf mp3 wav m4a ogg oga flac aac opus ' +
    'mp4 m4v mov webm mkv avi ogv 3gp zip gz tgz 7z rar docx xlsx pptx doc xls ppt epub ' +
    'woff woff2 ttf otf exe dmg bin'
  ).split(' '),
);

/**
 * Whether a file can be read as text.
 * @param file - File.
 */
export function isTextFile(file: TFile): boolean {
  return !BINARY_EXTENSIONS.has(file.extension.toLowerCase());
}
