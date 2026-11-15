/**
 * A small in-memory stand-in for the `obsidian` module, enough to run the plugin's tools and
 * agents under Node's test runner. Tests are bundled with esbuild, which aliases `obsidian` to
 * this file (see run.mjs). It is a model of Obsidian, not Obsidian: the evidence pass in a real
 * Obsidian is separate.
 */

export class TAbstractFile {
  path = '';
  name = '';
  parent: TFolder | null = null;
  vault!: MockVault;
}

export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === '/' || this.path === '';
  }
}

export const normalizePath = (p: string): string =>
  p
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '') || '/';

export class Notice {
  static shown: string[] = [];
  constructor(message: string | DocumentFragment) {
    Notice.shown.push(String(message));
  }
  hide(): void {}
  setMessage(): this {
    return this;
  }
}

export const Platform = { isMobile: false, isDesktopApp: true, isDesktop: true };
export const requestUrl = async (): Promise<never> => {
  throw new Error('requestUrl is not available in unit tests');
};
export const requireApiVersion = (): boolean => true;
export const getIcon = (): null => null;
export const setIcon = (): void => {};
export const addIcon = (): void => {};
export const stringifyYaml = (o: unknown): string => JSON.stringify(o);
export const parseYaml = (s: string): Record<string, unknown> => parseFrontmatter(s);
export const parseLinktext = (l: string): { path: string; subpath: string } => {
  const i = l.indexOf('#');
  return i < 0 ? { path: l, subpath: '' } : { path: l.slice(0, i), subpath: l.slice(i) };
};
export const resolveSubpath = (): null => null;
export const debounce = <T extends (...a: never[]) => unknown>(fn: T): T => fn;
export const moment = (): { format: () => string } => ({ format: () => '2026-11-15' });

export class Component {
  load(): void {}
  unload(): void {}
  register(): void {}
  registerEvent(): void {}
}
export class Plugin extends Component {}
export class ItemView extends Component {}
export class MarkdownView {}
export class Modal {
  constructor(public app?: unknown) {}
  open(): void {}
  close(): void {}
}
export class Setting {}
export class SettingGroup {}
export class PluginSettingTab {}
export class MarkdownRenderer {}
export class EditorSuggest {}
export class FuzzySuggestModal {}
export class ExtraButtonComponent {}
export class TextAreaComponent {}
export class WorkspaceLeaf {}

/** Minimal frontmatter parser: `key: value`, `key: [a, b]` and `key:\n  - a` lists. */
export function parseFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let listKey = '';
  for (const raw of yaml.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      (out[listKey] as unknown[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') {
      out[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value)) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map(v => unquote(v.trim()))
        .filter(Boolean);
      listKey = '';
    } else {
      out[key] = unquote(value);
      listKey = '';
    }
  }
  return out;
}

function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, '');
}

interface Pos {
  line: number;
  col: number;
  offset: number;
}
interface CacheItem {
  position: { start: Pos; end: Pos };
}

/** Builds a metadata cache entry like Obsidian's for one note. */
export function buildCache(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  const pos = (line: number, col: number): Pos => ({ line, col, offset: offsets[line] + col });
  const cache: Record<string, unknown> = {};
  let body = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      cache.frontmatter = parseFrontmatter(lines.slice(1, end).join('\n'));
      cache.frontmatterPosition = { start: pos(0, 0), end: pos(end, 3) };
      body = end + 1;
      // Links in properties, keyed like Obsidian: `up`, or `related.0` for list items.
      const fmLinks: { key: string; link: string; original: string; displayText: string }[] = [];
      for (const [key, value] of Object.entries(cache.frontmatter as Record<string, unknown>)) {
        (Array.isArray(value) ? value : [value]).forEach((v, i) => {
          const m =
            typeof v === 'string' ? /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(v.trim()) : null;
          if (!m) return;
          const k = Array.isArray(value) ? `${key}.${i}` : key;
          fmLinks.push({
            key: k,
            link: m[1].trim(),
            original: v,
            displayText: (m[2] ?? m[1]).trim(),
          });
        });
      }
      if (fmLinks.length) cache.frontmatterLinks = fmLinks;
    }
  }
  const headings: (CacheItem & { heading: string; level: number })[] = [];
  const links: (CacheItem & { link: string; original: string; displayText: string })[] = [];
  const embeds: typeof links = [];
  const tags: (CacheItem & { tag: string })[] = [];
  const sections: (CacheItem & { type: string })[] = [];
  const blocks: Record<string, CacheItem & { id: string }> = {};
  let fence = false;
  for (let i = body; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      headings.push({
        heading: h[2].trim(),
        level: h[1].length,
        position: { start: pos(i, 0), end: pos(i, line.length) },
      });
      sections.push({ type: 'heading', position: { start: pos(i, 0), end: pos(i, line.length) } });
    }
    for (const m of line.matchAll(/(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
      const item = {
        link: m[2].trim(),
        original: m[0],
        displayText: (m[3] ?? m[2]).trim(),
        position: { start: pos(i, m.index ?? 0), end: pos(i, (m.index ?? 0) + m[0].length) },
      };
      (m[1] ? embeds : links).push(item);
    }
    for (const m of line.matchAll(/(^|\s)(#[\w/-]+)/g)) {
      if (h && m.index === 0) continue;
      tags.push({
        tag: m[2],
        position: { start: pos(i, m.index ?? 0), end: pos(i, (m.index ?? 0) + m[0].length) },
      });
    }
    const block = /\s\^([\w-]+)\s*$/.exec(line);
    if (block)
      blocks[block[1]] = { id: block[1], position: { start: pos(i, 0), end: pos(i, line.length) } };
  }
  if (headings.length) cache.headings = headings;
  if (links.length) cache.links = links;
  if (embeds.length) cache.embeds = embeds;
  if (tags.length) cache.tags = tags;
  if (sections.length) cache.sections = sections;
  if (Object.keys(blocks).length) cache.blocks = blocks;
  return cache;
}

export class MockVault {
  files = new Map<string, TAbstractFile>();
  contents = new Map<string, string>();
  configDir = '.obsidian';
  root: TFolder;
  trashed: string[] = [];
  adapter = {
    exists: async (p: string) => this.files.has(normalizePath(p)) || this.contents.has(p),
    read: async (p: string) => this.contents.get(normalizePath(p)) ?? '',
    write: async (p: string, data: string) => {
      this.contents.set(normalizePath(p), data);
    },
    list: async (p: string) => {
      const dir = normalizePath(p);
      const kids = [...this.files.values()].filter(f => f.parent?.path === dir);
      return {
        files: kids.filter(f => f instanceof TFile).map(f => f.path),
        folders: kids.filter(f => f instanceof TFolder).map(f => f.path),
      };
    },
    getBasePath: () => '/vault',
  };

  constructor() {
    this.root = new TFolder();
    this.root.path = '/';
    this.root.name = '';
    this.root.vault = this;
    this.files.set('/', this.root);
  }

  private folderFor(path: string): TFolder {
    const i = path.lastIndexOf('/');
    if (i < 0) return this.root;
    const dir = path.slice(0, i);
    const existing = this.files.get(dir);
    if (existing instanceof TFolder) return existing;
    return this.makeFolder(dir);
  }

  private makeFolder(path: string): TFolder {
    const parent = this.folderFor(path);
    const f = new TFolder();
    f.path = path;
    f.name = path.split('/').pop() ?? path;
    f.parent = parent;
    f.vault = this;
    parent.children.push(f);
    this.files.set(path, f);
    return f;
  }

  /** Adds or replaces a file without events (test setup). */
  put(path: string, content: string): TFile {
    const p = normalizePath(path);
    let f = this.files.get(p) as TFile | undefined;
    if (!f) {
      f = new TFile();
      f.path = p;
      f.name = p.split('/').pop() ?? p;
      f.extension = f.name.includes('.') ? (f.name.split('.').pop() ?? '') : '';
      f.basename = f.extension ? f.name.slice(0, -(f.extension.length + 1)) : f.name;
      f.vault = this;
      f.parent = this.folderFor(p);
      f.parent.children.push(f);
      this.files.set(p, f);
    }
    this.contents.set(p, content);
    f.stat = { ctime: f.stat.ctime || Date.now(), mtime: Date.now(), size: content.length };
    return f;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(normalizePath(path)) ?? null;
  }
  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }
  getFolderByPath(path: string): TFolder | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }
  getRoot(): TFolder {
    return this.root;
  }
  getFiles(): TFile[] {
    return [...this.files.values()].filter((f): f is TFile => f instanceof TFile);
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter(f => f.extension === 'md');
  }
  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.files.values()];
  }
  getAllFolders(includeRoot = false): TFolder[] {
    return [...this.files.values()].filter(
      (f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()),
    );
  }
  async read(file: TFile): Promise<string> {
    return this.contents.get(file.path) ?? '';
  }
  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }
  async create(path: string, content: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.files.has(p)) throw new Error('File already exists.');
    return this.put(p, content);
  }
  async createBinary(path: string): Promise<TFile> {
    return this.put(path, '[binary]');
  }
  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.files.has(p)) throw new Error('Folder already exists.');
    return this.makeFolder(p);
  }
  async modify(file: TFile, content: string): Promise<void> {
    this.put(file.path, content);
  }
  async append(file: TFile, content: string): Promise<void> {
    this.put(file.path, (this.contents.get(file.path) ?? '') + content);
  }
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.contents.get(file.path) ?? '');
    this.put(file.path, next);
    return next;
  }
  async delete(file: TAbstractFile): Promise<void> {
    this.remove(file);
  }
  async trash(file: TAbstractFile): Promise<void> {
    this.trashed.push(file.path);
    this.remove(file);
  }
  remove(file: TAbstractFile): void {
    this.files.delete(file.path);
    this.contents.delete(file.path);
    if (file.parent) file.parent.children = file.parent.children.filter(c => c !== file);
  }
  on(): { e: string } {
    return { e: 'event' };
  }
  offref(): void {}
}

export class MockMetadataCache {
  constructor(private vault: MockVault) {}
  getFileCache(file: TFile): Record<string, unknown> | null {
    if (file.extension !== 'md') return null;
    return buildCache(this.vault.contents.get(file.path) ?? '');
  }
  getCache(path: string): Record<string, unknown> | null {
    const f = this.vault.getFileByPath(path);
    return f ? this.getFileCache(f) : null;
  }
  getFirstLinkpathDest(linkpath: string, _source: string): TFile | null {
    const target = parseLinktext(linkpath).path.trim();
    if (!target) return null;
    const files = this.vault.getFiles();
    const withExt = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
    return (
      files.find(f => f.path === withExt) ??
      files.find(f => f.path.endsWith(`/${withExt}`)) ??
      files.find(f => f.basename.toLowerCase() === target.toLowerCase()) ??
      null
    );
  }
  fileToLinktext(file: TFile): string {
    return file.basename;
  }
  /** source path -> target path -> count, as Obsidian keeps it. */
  get resolvedLinks(): Record<string, Record<string, number>> {
    return this.links(true);
  }
  get unresolvedLinks(): Record<string, Record<string, number>> {
    return this.links(false);
  }
  private links(resolved: boolean): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const file of this.vault.getMarkdownFiles()) {
      const row: Record<string, number> = {};
      const cache = this.getFileCache(file) as {
        links?: { link: string }[];
        frontmatter?: Record<string, unknown>;
      } | null;
      const targets = (cache?.links ?? []).map(l => l.link);
      for (const v of Object.values(cache?.frontmatter ?? {})) {
        for (const s of Array.isArray(v) ? v : [v]) {
          const m = typeof s === 'string' ? /^\[\[([^\]|]+)/.exec(s) : null;
          if (m) targets.push(m[1]);
        }
      }
      for (const t of targets) {
        const dest = this.getFirstLinkpathDest(t, file.path);
        const key = dest ? dest.path : parseLinktext(t).path;
        if (!!dest !== resolved) continue;
        row[key] = (row[key] ?? 0) + 1;
      }
      out[file.path] = row;
    }
    return out;
  }
  on(): { e: string } {
    return { e: 'event' };
  }
  offref(): void {}
}

export interface MockApp {
  vault: MockVault;
  metadataCache: MockMetadataCache;
  fileManager: {
    trashFile(file: TAbstractFile): Promise<void>;
    processFrontMatter(file: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void>;
    getAvailablePathForAttachment(name: string): Promise<string>;
    generateMarkdownLink(file: TFile): string;
  };
  workspace: Record<string, unknown>;
  plugins: { getPlugin(id: string): unknown; enabledPlugins: Set<string> };
  secretStorage?: unknown;
}

/** A fresh app with an empty vault. */
export function createApp(): MockApp {
  const vault = new MockVault();
  const metadataCache = new MockMetadataCache(vault);
  return {
    vault,
    metadataCache,
    fileManager: {
      trashFile: async file => vault.trash(file),
      processFrontMatter: async (file, fn) => {
        const text = vault.contents.get(file.path) ?? '';
        const cache = buildCache(text);
        const fm = { ...((cache.frontmatter as Record<string, unknown>) ?? {}) };
        fn(fm);
        const bodyStart = text.startsWith('---\n') ? text.indexOf('\n---', 4) + 4 : 0;
        const yaml = Object.entries(fm)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`)
          .join('\n');
        vault.put(file.path, `---\n${yaml}\n---${bodyStart ? text.slice(bodyStart) : `\n${text}`}`);
      },
      getAvailablePathForAttachment: async name => name,
      generateMarkdownLink: file => `[[${file.basename}]]`,
    },
    workspace: {
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
      getMostRecentLeaf: () => null,
      iterateAllLeaves: () => {},
      getLeaf: () => ({ openFile: async () => undefined }),
      on: () => ({}),
    },
    plugins: { getPlugin: () => null, enabledPlugins: new Set() },
  };
}
