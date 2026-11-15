import { App, MarkdownView, normalizePath, TFile, TFolder } from 'obsidian';

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
  const viaLink = app.metadataCache.getFirstLinkpathDest(cleaned, '');
  if (viaLink) return { file: viaLink, candidates: [] };

  const key = cleaned.replace(/\.md$/i, '').toLowerCase();
  const files = app.vault.getMarkdownFiles();
  const exact = files.filter(f => f.basename.toLowerCase() === key);
  if (exact.length === 1) return { file: exact[0], candidates: [] };
  if (exact.length > 1) return { file: null, candidates: exact.slice(0, 10) };
  // Speech often drops spaces and punctuation: compare letters and digits only.
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sq = squash(key);
  const loose = sq ? files.filter(f => squash(f.basename) === sq) : [];
  if (loose.length === 1) return { file: loose[0], candidates: [] };
  const partial = sq ? files.filter(f => squash(f.basename).includes(sq)) : [];
  if (partial.length === 1) return { file: partial[0], candidates: [] };
  return { file: null, candidates: [...loose, ...partial].slice(0, 10) };
}

/**
 * Finds folders from an exact path or a bare folder name anywhere in the vault ("LO" matches
 * "Medicine/ANZCA/LO").
 * @param app - Obsidian app.
 * @param ref - Folder path or name.
 */
export function resolveFolders(app: App, ref: string): TFolder[] {
  const raw = (ref ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return [app.vault.getRoot()];
  const direct = app.vault.getAbstractFileByPath(normalizePath(raw));
  if (direct instanceof TFolder) return [direct];
  const key = raw.toLowerCase();
  const all = app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
  const byName = all.filter(f => f.name.toLowerCase() === key);
  if (byName.length) return byName;
  return all.filter(f => f.path.toLowerCase().endsWith(`/${key}`) || f.path.toLowerCase() === key);
}

/**
 * True when a file sits inside any of the folders (at any depth).
 * @param file - File.
 * @param folders - Folders.
 */
export function inFolders(file: TFile, folders: TFolder[]): boolean {
  return folders.some(f => f.isRoot() || file.path.startsWith(`${f.path}/`));
}
