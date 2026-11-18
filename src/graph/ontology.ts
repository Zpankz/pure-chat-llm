import type { App } from 'obsidian';
import { normalizePath, TFile, TFolder } from 'obsidian';
import { activeNote, inFolders, resolveFolders } from '../utils/vaultResolve';
import type { VaultGraph } from './VaultGraph';

/** A note found from what a model or a transcript said, or why none was. */
export interface NoteLookup {
  file: TFile | null;
  /** Several notes fit equally well: ask which one. */
  candidates: TFile[];
  /** Nothing fit; these come close. */
  near: TFile[];
}

/**
 * Lower-case letters and digits only, so "AP 11-AO402" and "ap11ao402" compare equal.
 * @param s - Text.
 */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

const byPath = (a: TFile, b: TFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * A note's aliases from frontmatter (`aliases` or `alias`, a list or a comma-separated string).
 * @param app - Obsidian app.
 * @param file - Note.
 */
export function noteAliases(app: App, file: TFile): string[] {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  const raw: unknown = fm?.aliases ?? fm?.alias;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return list.map(a => String(a).trim()).filter(Boolean);
}

/**
 * True for a folder note: `X/X.md`.
 * @param file - Note.
 */
function isFolderNote(file: TFile): boolean {
  return !!file.parent && file.parent.name.toLowerCase() === file.basename.toLowerCase();
}

/**
 * Finds the note a graph tool should start from, for vaults with many similar names: an exact
 * path (with or without `.md`), a [[link]] (alias and heading dropped), "active", a
 * folder-qualified name ("LO/AP11AO402"), a folder whose folder note (`X/X.md`) stands for it,
 * a basename in any case, a frontmatter alias, then the same with spaces and punctuation
 * ignored. Equal matches are returned as candidates instead of a guess (a folder note wins over
 * other notes of the same name, as folder-note vaults link it); when nothing fits, close names
 * are returned as `near`.
 * @param app - Obsidian app.
 * @param ref - What was said.
 */
export function resolveGraphNote(app: App, ref: string | undefined): NoteLookup {
  const none: NoteLookup = { file: null, candidates: [], near: [] };
  const raw = (ref ?? '').trim();
  if (!raw || /^(active|current|this)( note)?$/i.test(raw)) {
    return { ...none, file: activeNote(app) };
  }
  const cleaned = raw
    .replace(/^!?\[\[|\]\]$/g, '')
    .split('|')[0]
    .split('#')[0]
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!cleaned) return none;
  const one = (list: TFile[]): NoteLookup | null => {
    if (list.length === 1) return { ...none, file: list[0] };
    if (list.length > 1) {
      const folderNotes = list.filter(isFolderNote);
      if (folderNotes.length === 1) return { ...none, file: folderNotes[0] };
      return { ...none, candidates: [...list].sort(byPath).slice(0, 10) };
    }
    return null;
  };

  const path = normalizePath(cleaned);
  for (const candidate of [path, `${path}.md`]) {
    const f = app.vault.getAbstractFileByPath(candidate);
    if (f instanceof TFile && f.extension === 'md') return { ...none, file: f };
    if (f instanceof TFolder) {
      const note = app.vault.getAbstractFileByPath(`${f.path}/${f.name}.md`);
      if (note instanceof TFile) return { ...none, file: note };
    }
  }

  const files = app.vault.getMarkdownFiles();
  const key = cleaned.replace(/\.md$/i, '').toLowerCase();
  const last = key.split('/').pop() ?? key;
  if (key.includes('/')) {
    const suffix = files.filter(f => {
      const p = f.path.toLowerCase();
      return (
        p === `${key}.md` ||
        p.endsWith(`/${key}.md`) ||
        p === `${key}/${last}.md` ||
        p.endsWith(`/${key}/${last}.md`)
      );
    });
    const found = one(suffix);
    if (found) return found;
  }
  const found =
    one(files.filter(f => f.basename.toLowerCase() === last)) ??
    one(files.filter(f => noteAliases(app, f).some(a => a.toLowerCase() === last)));
  if (found) return found;

  const sq = squash(last);
  if (!sq) return none;
  const loose = files.filter(
    f => squash(f.basename) === sq || noteAliases(app, f).some(a => squash(a) === sq),
  );
  const looseFound = one(loose);
  if (looseFound) return looseFound;
  const partial = files.filter(f => squash(f.basename).includes(sq));
  if (partial.length === 1) return { ...none, file: partial[0] };
  if (partial.length > 1) return { ...none, candidates: [...partial].sort(byPath).slice(0, 10) };

  // Nothing fits: offer names that share a word or contain each other.
  const words = last.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
  const near = files
    .map(f => {
      const name = f.basename.toLowerCase();
      const score =
        (sq.includes(squash(name)) && squash(name).length >= 3 ? 2 : 0) +
        words.filter(w => name.includes(w)).length;
      return { f, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || byPath(a.f, b.f))
    .slice(0, 6)
    .map(x => x.f);
  return { ...none, near };
}

/** Filters shared by graph tools. */
export interface GraphScope {
  folder?: string;
  tag?: string;
  nodeTypes?: string[];
}

/**
 * Turns folder, tag and node-type filters into one predicate. Returns an error message when a
 * folder can't be found.
 * @param app - Obsidian app.
 * @param graph - Vault graph.
 * @param scope - Filters.
 */
export function scopeFilter(
  app: App,
  graph: VaultGraph,
  scope: GraphScope,
): { keep: (path: string) => boolean; label: string; active: boolean; error?: string } {
  const parts: string[] = [];
  let folders: ReturnType<typeof resolveFolders> | null = null;
  if (scope.folder?.trim()) {
    folders = resolveFolders(app, scope.folder);
    if (!folders.length) {
      return {
        keep: () => false,
        label: '',
        active: true,
        error: `No folder named or at "${scope.folder}".`,
      };
    }
    parts.push(`in ${folders.map(f => f.path || '/').join(', ')}`);
  }
  if (scope.tag?.trim()) parts.push(`tagged #${scope.tag.replace(/^#/, '')}`);
  const types = (scope.nodeTypes ?? []).filter(Boolean);
  if (types.length) parts.push(`of type ${types.join(' or ')}`);
  const keep = (path: string) => {
    if (folders) {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile) || !inFolders(f, folders)) return false;
    }
    if (scope.tag?.trim() && !graph.hasTag(path, scope.tag)) return false;
    if (types.length && !graph.hasType(path, types)) return false;
    return true;
  };
  return { keep, label: parts.join(', '), active: parts.length > 0 };
}

/**
 * One spoken-friendly sentence about the vault's graph, for the first line of tool output.
 * @param graph - Vault graph.
 */
export function ontologyHeadline(graph: VaultGraph): string {
  const used = graph.edgeTypes();
  const links = used.reduce((n, u) => n + u.count, 0);
  const nodeTypes = new Set([
    ...graph.schema.nodeTypes.keys(),
    ...graph.typeCounts().map(t => t.type),
  ]).size;
  const tags = graph.tagCounts().length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `This vault has ${plural(graph.paths.length, 'note')} and ${plural(links, 'link')} of ${plural(used.length, 'relation type')}, with ${plural(nodeTypes, 'note type')} and ${plural(tags, 'tag')}.`;
}

/**
 * Describes the vault's typed ontology for an agent: declared node and edge types (from Typed
 * Graph schema notes), what is actually used, tags and frontmatter properties.
 * @param graph - Vault graph.
 * @param compact - A short version for system prompts.
 */
export function ontologySummary(graph: VaultGraph, compact = false): string {
  const lines: string[] = [];
  const declaredEdges = [...graph.schema.edgeTypes.values()];
  const declaredNodes = [...graph.schema.nodeTypes.values()];
  const used = graph.edgeTypes();
  const usedCount = new Map(used.map(u => [u.type, u.count]));
  const nodeCounts = graph.typeCounts();
  const nodeCount = new Map(nodeCounts.map(n => [n.type, n.notes]));

  lines.push(ontologyHeadline(graph), '', 'VAULT ONTOLOGY');
  if (graph.schema.sources.length) {
    lines.push(`Schema notes (Typed Graph): ${graph.schema.sources.join(', ')}`);
  }

  if (declaredEdges.length) {
    lines.push('', 'Edge types (frontmatter properties that link notes):');
    const max = compact ? 25 : 200;
    for (const e of declaredEdges.slice(0, max)) {
      const range = `${short(e.from, compact)} -> ${short(e.to, compact)}`;
      const desc = compact ? firstSentence(e.description, 110) : e.description;
      lines.push(`- ${e.name} (${usedCount.get(e.name) ?? 0} links; ${range}): ${desc}`);
    }
    const undeclared = used.filter(
      u => !graph.schema.edgeTypes.has(u.type) && u.type !== 'link' && u.type !== 'embed',
    );
    if (undeclared.length)
      lines.push(
        `- Also used, not declared: ${undeclared
          .slice(0, 15)
          .map(u => `${u.type} (${u.count})`)
          .join(', ')}`,
      );
  } else if (used.length) {
    lines.push('', 'Link types in use (no schema notes found):');
    for (const u of used.slice(0, compact ? 15 : 60)) lines.push(`- ${u.type}: ${u.count}`);
  }
  const plain = used.filter(u => u.type === 'link' || u.type === 'embed');
  if (plain.length)
    lines.push(`- Untyped: ${plain.map(u => `${u.type} ${u.count}`).join(', ')} (body links)`);

  if (declaredNodes.length || nodeCounts.length) {
    lines.push('', 'Node types (frontmatter `type`):');
    const names = new Set([...declaredNodes.map(n => n.name), ...nodeCounts.map(n => n.type)]);
    const sorted = [...names].sort((a, b) => (nodeCount.get(b) ?? 0) - (nodeCount.get(a) ?? 0));
    if (compact) {
      lines.push(
        sorted
          .slice(0, 40)
          .map(n => `${n} (${nodeCount.get(n) ?? 0})`)
          .join(', '),
      );
    } else {
      if (sorted.length > 150)
        lines.push(`(${sorted.length} node types; the 150 most used are listed.)`);
      for (const n of sorted.slice(0, 150)) {
        const d = graph.schema.nodeTypes.get(n);
        const edges = d?.edges.length ? ` Edges: ${d.edges.join(', ')}.` : '';
        lines.push(
          `- ${n} (${nodeCount.get(n) ?? 0} notes)${d ? `: ${firstSentence(d.description, 220)}${edges}` : ''}`,
        );
      }
    }
  }

  const tags = graph.tagCounts();
  if (tags.length) {
    lines.push(
      '',
      `Tags: ${tags
        .slice(0, compact ? 15 : 50)
        .map(t => `#${t.tag} (${t.notes})`)
        .join(', ')}`,
    );
  }
  if (!compact && graph.properties.size) {
    const props = [...graph.properties.entries()].sort((a, b) => b[1].notes - a[1].notes);
    lines.push(
      '',
      `Frontmatter properties: ${props
        .slice(0, 60)
        .map(([k, v]) => `${k} (${v.notes}, ${[...v.kinds].join('/')})`)
        .join(', ')}`,
    );
  }
  lines.push(
    '',
    compact
      ? 'Follow typed edges with traverse_graph (edge_types, node_types, folder, tag); graph_cli has path, hubs and related; call vault_ontology for the full schema.'
      : 'Use edge type names in traverse_graph `edge_types` (or graph_cli path) to follow only those relations; filter notes with `node_types`, `folder` and `tag`.',
  );
  return lines.join('\n');
}

function short(list: string[], compact: boolean): string {
  if (!list.length) return 'any';
  if (!compact || list.length <= 4) return list.join('|');
  return `${list.slice(0, 3).join('|')}|+${list.length - 3}`;
}

function firstSentence(text: string, max: number): string {
  const end = text.search(/\.\s/);
  const s = end >= 0 ? text.slice(0, end + 1) : text;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
