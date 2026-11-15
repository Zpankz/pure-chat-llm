import type { App, CachedMetadata } from 'obsidian';

/** One typed link between two notes. */
export interface GraphEdge {
  from: string;
  to: string;
  /** `link` (body wikilink or Markdown link), `embed`, or the frontmatter property name. */
  type: string;
  /** Heading or block the link points at (`#Section`), when it names one. */
  subpath?: string;
}

/** Node and edge types declared in Typed Graph (TGS) schema notes. */
export interface VaultSchema {
  nodeTypes: Map<
    string,
    { name: string; description: string; properties: string[]; edges: string[]; source: string }
  >;
  edgeTypes: Map<
    string,
    { name: string; from: string[]; to: string[]; description: string; source: string }
  >;
  sources: string[];
}

/** A link to a note that does not exist yet. */
export interface UnresolvedEdge {
  from: string;
  name: string;
  type: string;
}

/** A note reached by a traversal. */
export interface GraphNode {
  path: string;
  hop: number;
  /** Note it was reached from (empty for the start note). */
  parent: string;
  /** Edge type and direction it was reached by, such as `out:parent` or `in:link`. */
  via: string;
}

export interface TraverseOptions {
  depth?: number;
  direction?: 'both' | 'out' | 'in';
  /** Only follow these edge types (property names, `link`, `embed`). Empty follows all. */
  edgeTypes?: string[];
  maxNodes?: number;
  /** Keep a note when this returns true. The start note is always kept. */
  keep?: (path: string) => boolean;
}

export interface TraverseResult {
  start: string;
  nodes: GraphNode[];
  /** Edges among the notes found. */
  edges: GraphEdge[];
  unresolved: UnresolvedEdge[];
  truncated: boolean;
}

/**
 * Typed link graph of the vault, built from Obsidian's metadata cache.
 *
 * Unlike `resolvedLinks`, every edge keeps its type: body links are `link`, embeds are `embed`
 * and links in frontmatter take the property name (`parent`, `up`, `related`...), which is how
 * most typed vault ontologies are written. Section links (`[[note#Heading]]`, as lat.md uses)
 * keep their subpath. The graph is pure data, so tools and code-mode scripts can traverse it
 * deterministically.
 */
export class VaultGraph {
  readonly out = new Map<string, GraphEdge[]>();
  readonly in = new Map<string, GraphEdge[]>();
  readonly unresolved = new Map<string, UnresolvedEdge[]>();
  readonly tags = new Map<string, Set<string>>();
  /** Frontmatter property name -> value kinds seen and note count. */
  readonly properties = new Map<string, { notes: number; kinds: Set<string> }>();
  readonly paths: string[] = [];
  /** Note type from frontmatter `type` (Typed Graph labels), by path. */
  readonly nodeTypes = new Map<string, string[]>();
  /** Typed Graph (TGS) schema notes: node types and edge types declared in the vault. */
  readonly schema: VaultSchema = { nodeTypes: new Map(), edgeTypes: new Map(), sources: [] };

  private static cached: { app: App; at: number; graph: VaultGraph; types: string } | null = null;

  /**
   * The graph for a vault, rebuilt at most every few seconds so scripts that call the graph
   * many times in a row share one build.
   * @param app - Obsidian app.
   * @param maxAgeMs - Reuse a build younger than this.
   */
  static for(app: App, typesFolder = '', maxAgeMs = 5000): VaultGraph {
    const c = VaultGraph.cached;
    if (c && c.app === app && c.types === typesFolder && Date.now() - c.at < maxAgeMs)
      return c.graph;
    const graph = VaultGraph.build(app, typesFolder);
    VaultGraph.cached = { app, at: Date.now(), graph, types: typesFolder };
    return graph;
  }

  /**
   * Builds the graph from the metadata cache.
   * @param app - Obsidian app.
   */
  static build(app: App, typesFolder = ''): VaultGraph {
    const g = new VaultGraph();
    const typesPrefix = typesFolder.trim().replace(/^\/+|\/+$/g, '');
    for (const file of app.vault.getMarkdownFiles()) {
      g.paths.push(file.path);
      const cache = app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const fm = cache.frontmatter;
      if (fm && 'tgs' in fm && (!typesPrefix || file.path.startsWith(`${typesPrefix}/`))) {
        g.readSchema(file.path, fm);
      }
      const type: unknown = fm?.type;
      const types = (Array.isArray(type) ? type : [type]).filter(
        (t): t is string => typeof t === 'string' && !!t.trim(),
      );
      if (types.length) g.nodeTypes.set(file.path, types);
      g.indexTags(file.path, cache);
      g.indexProperties(cache);
      const add = (raw: string, type: string) => {
        const [linkpath, ...rest] = raw.split('#');
        const subpath = rest.length ? rest.join('#') : undefined;
        if (!linkpath) return; // a link to a heading in the same note
        const dest = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
        if (dest) {
          if (dest.extension !== 'md' || dest.path === file.path) return;
          g.addEdge({ from: file.path, to: dest.path, type, ...(subpath ? { subpath } : {}) });
        } else {
          const list = g.unresolved.get(file.path) ?? [];
          list.push({ from: file.path, name: linkpath, type });
          g.unresolved.set(file.path, list);
        }
      };
      for (const l of cache.links ?? []) add(l.link, 'link');
      for (const e of cache.embeds ?? []) add(e.link, 'embed');
      for (const f of cache.frontmatterLinks ?? []) add(f.link, propertyName(f.key));
    }
    return g;
  }

  /**
   * Reads a Typed Graph schema note: `schemas:` (node types with properties and allowed edges)
   * and `edgeTypes:` (edge types with domain, range and meaning).
   * @param path - Schema note path.
   * @param fm - Its frontmatter.
   */
  private readSchema(path: string, fm: Record<string, unknown>): void {
    this.schema.sources.push(path);
    const schemas = fm.schemas;
    if (schemas && typeof schemas === 'object') {
      for (const [name, def] of Object.entries(schemas as Record<string, unknown>)) {
        const d = (def ?? {}) as Record<string, unknown>;
        this.schema.nodeTypes.set(name, {
          name,
          description: typeof d.description === 'string' ? d.description : '',
          properties: Object.keys((d.properties as object) ?? {}),
          edges: Object.keys((d.edges as object) ?? {}),
          source: path,
        });
      }
    }
    const edgeTypes = fm.edgeTypes;
    if (edgeTypes && typeof edgeTypes === 'object') {
      for (const [name, def] of Object.entries(edgeTypes as Record<string, unknown>)) {
        const d = (def ?? {}) as Record<string, unknown>;
        const list = (v: unknown): string[] =>
          Array.isArray(v) ? v.map(x => String(x)) : typeof v === 'string' ? [v] : [];
        this.schema.edgeTypes.set(name, {
          name,
          from: list(d.from),
          to: list(d.to),
          description: typeof d.description === 'string' ? d.description : '',
          source: path,
        });
      }
    }
  }

  /**
   * True when a note has one of the node types.
   * @param path - Note path.
   * @param types - Wanted types.
   */
  hasType(path: string, types: string[]): boolean {
    const own = this.nodeTypes.get(path) ?? [];
    return types.some(t => own.includes(t));
  }

  /** Node types in use with note counts, most common first. */
  typeCounts(): Array<{ type: string; notes: number }> {
    const counts = new Map<string, number>();
    for (const list of this.nodeTypes.values())
      for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
      .map(([type, notes]) => ({ type, notes }))
      .sort((a, b) => b.notes - a.notes);
  }

  /** @param edge - Edge to add (duplicates of the same type are kept once). */
  addEdge(edge: GraphEdge): void {
    const outs = this.out.get(edge.from) ?? [];
    if (outs.some(e => e.to === edge.to && e.type === edge.type)) return;
    outs.push(edge);
    this.out.set(edge.from, outs);
    const ins = this.in.get(edge.to) ?? [];
    ins.push(edge);
    this.in.set(edge.to, ins);
  }

  private indexTags(path: string, cache: CachedMetadata): void {
    const found = new Set<string>();
    for (const t of cache.tags ?? []) found.add(normalizeTag(t.tag));
    const fm: unknown = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
    const list: unknown[] = Array.isArray(fm)
      ? fm
      : typeof fm === 'string'
        ? fm.split(/[,\s]+/)
        : [];
    for (const t of list) if (typeof t === 'string' && t.trim()) found.add(normalizeTag(t));
    if (found.size) this.tags.set(path, found);
  }

  private indexProperties(cache: CachedMetadata): void {
    for (const [key, value] of Object.entries(cache.frontmatter ?? {})) {
      if (key === 'position') continue;
      const entry = this.properties.get(key) ?? { notes: 0, kinds: new Set<string>() };
      entry.notes++;
      entry.kinds.add(valueKind(value));
      this.properties.set(key, entry);
    }
  }

  /**
   * True when a note has the tag or one of its child tags (`#lo` matches `#lo/cardio`).
   * @param path - Note path.
   * @param tag - Tag, with or without `#`.
   */
  hasTag(path: string, tag: string): boolean {
    const want = normalizeTag(tag);
    for (const t of this.tags.get(path) ?? [])
      if (t === want || t.startsWith(`${want}/`)) return true;
    return false;
  }

  /**
   * Edges next to a note.
   * @param path - Note path.
   * @param direction - Which side.
   * @param edgeTypes - Types to keep (empty keeps all).
   */
  neighbours(
    path: string,
    direction: 'both' | 'out' | 'in' = 'both',
    edgeTypes: string[] = [],
  ): Array<{ path: string; edge: GraphEdge; dir: 'out' | 'in' }> {
    const typeOk = (e: GraphEdge) => !edgeTypes.length || edgeTypes.includes(e.type);
    const list: Array<{ path: string; edge: GraphEdge; dir: 'out' | 'in' }> = [];
    if (direction !== 'in')
      for (const e of this.out.get(path) ?? [])
        if (typeOk(e)) list.push({ path: e.to, edge: e, dir: 'out' });
    if (direction !== 'out')
      for (const e of this.in.get(path) ?? [])
        if (typeOk(e)) list.push({ path: e.from, edge: e, dir: 'in' });
    return list;
  }

  /**
   * Breadth-first traversal from one note.
   * @param start - Start note path.
   * @param opts - Depth, direction, edge types, node cap and filter.
   */
  traverse(start: string, opts: TraverseOptions = {}): TraverseResult {
    const depth = Math.min(6, Math.max(1, opts.depth ?? 2));
    const maxNodes = Math.min(500, Math.max(2, opts.maxNodes ?? 60));
    const keep = opts.keep ?? (() => true);
    const nodes = new Map<string, GraphNode>([
      [start, { path: start, hop: 0, parent: '', via: 'start' }],
    ]);
    let frontier = [start];
    let truncated = false;
    for (let hop = 1; hop <= depth && frontier.length && !truncated; hop++) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const n of this.neighbours(from, opts.direction, opts.edgeTypes)) {
          if (nodes.has(n.path) || !keep(n.path)) continue;
          if (nodes.size >= maxNodes) {
            truncated = true;
            break;
          }
          nodes.set(n.path, { path: n.path, hop, parent: from, via: `${n.dir}:${n.edge.type}` });
          next.push(n.path);
        }
        if (truncated) break;
      }
      frontier = next;
    }
    const edges: GraphEdge[] = [];
    const unresolved: UnresolvedEdge[] = [];
    for (const p of nodes.keys()) {
      for (const e of this.out.get(p) ?? []) if (nodes.has(e.to)) edges.push(e);
      unresolved.push(...(this.unresolved.get(p) ?? []));
    }
    return { start, nodes: [...nodes.values()], edges, unresolved, truncated };
  }

  /**
   * Shortest chain of links between two notes, following links either way.
   * @param from - Start path.
   * @param to - Target path.
   * @param maxDepth - Longest chain to look for.
   * @param edgeTypes - Types to follow (empty follows all).
   * @param maxHubDegree - Don't pass through notes with more links than this (index notes); 0
   *   allows any.
   */
  path(
    from: string,
    to: string,
    maxDepth = 6,
    edgeTypes: string[] = [],
    maxHubDegree = 0,
  ): GraphNode[] | null {
    if (from === to) return [{ path: from, hop: 0, parent: '', via: 'start' }];
    const seen = new Map<string, GraphNode>([
      [from, { path: from, hop: 0, parent: '', via: 'start' }],
    ]);
    let frontier = [from];
    for (let hop = 1; hop <= maxDepth && frontier.length; hop++) {
      const next: string[] = [];
      for (const p of frontier) {
        for (const n of this.neighbours(p, 'both', edgeTypes)) {
          if (seen.has(n.path)) continue;
          seen.set(n.path, { path: n.path, hop, parent: p, via: `${n.dir}:${n.edge.type}` });
          if (n.path !== to && maxHubDegree > 0 && this.degree(n.path) > maxHubDegree) continue;
          if (n.path === to) {
            const chain: GraphNode[] = [];
            for (let cur: GraphNode | undefined = seen.get(to); cur; cur = seen.get(cur.parent))
              chain.unshift(cur);
            return chain;
          }
          next.push(n.path);
        }
      }
      frontier = next;
    }
    return null;
  }

  /**
   * Most-linked notes, by links in (backlinks) and out, inside a scope.
   * @param keep - Scope filter.
   * @param limit - How many.
   */
  hubs(
    keep: (path: string) => boolean = () => true,
    limit = 15,
  ): Array<{ path: string; in: number; out: number }> {
    return this.paths
      .filter(keep)
      .map(p => ({ path: p, in: this.in.get(p)?.length ?? 0, out: this.out.get(p)?.length ?? 0 }))
      .filter(h => h.in + h.out > 0)
      .sort((a, b) => b.in - a.in || b.out - a.out)
      .slice(0, limit);
  }

  /**
   * Notes that share neighbours with a note (co-citation and shared references), strongest first.
   * Catches related notes that do not link to each other directly.
   * @param path - Note path.
   * @param limit - How many.
   */
  related(
    path: string,
    limit = 15,
  ): Array<{ path: string; shared: number; score: number; direct: boolean }> {
    const direct = new Set(this.neighbours(path).map(n => n.path));
    const score = new Map<string, { shared: number; score: number }>();
    for (const mid of direct) {
      // Adamic-Adar: a neighbour shared through a small, specific note counts for more than one
      // shared through an index note that links to everything.
      const weight = 1 / Math.log(2 + this.degree(mid));
      for (const n of this.neighbours(mid)) {
        if (n.path === path) continue;
        const s = score.get(n.path) ?? { shared: 0, score: 0 };
        s.shared++;
        s.score += weight;
        score.set(n.path, s);
      }
    }
    return [...score.entries()]
      .map(([p, s]) => ({
        path: p,
        shared: s.shared,
        score: Math.round(s.score * 100) / 100,
        direct: direct.has(p),
      }))
      .sort((a, b) => b.score - a.score || Number(a.direct) - Number(b.direct))
      .slice(0, limit);
  }

  /**
   * Links in and out of a note.
   * @param path - Note path.
   */
  degree(path: string): number {
    return (this.out.get(path)?.length ?? 0) + (this.in.get(path)?.length ?? 0);
  }

  /** Edge types with how often each appears, most common first. */
  edgeTypes(): Array<{ type: string; count: number; example?: GraphEdge }> {
    const counts = new Map<string, { count: number; example: GraphEdge }>();
    for (const list of this.out.values()) {
      for (const e of list) {
        const c = counts.get(e.type);
        if (c) c.count++;
        else counts.set(e.type, { count: 1, example: e });
      }
    }
    return [...counts.entries()]
      .map(([type, c]) => ({ type, count: c.count, example: c.example }))
      .sort((a, b) => b.count - a.count);
  }

  /** Tags with note counts, most common first. */
  tagCounts(): Array<{ tag: string; notes: number }> {
    const counts = new Map<string, number>();
    for (const set of this.tags.values())
      for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
      .map(([tag, notes]) => ({ tag, notes }))
      .sort((a, b) => b.notes - a.notes);
  }
}

/**
 * `#Topic/Sub` -> `topic/sub`.
 * @param tag - Tag text.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, '').toLowerCase();
}

/**
 * Frontmatter link keys look like `parent` or `related.1`; the type is the property name.
 * @param key - Cache key.
 */
function propertyName(key: string): string {
  return key.split('.')[0] || 'property';
}

/** @param value - Frontmatter value. */
function valueKind(value: unknown): string {
  if (Array.isArray(value)) {
    return value.some(v => typeof v === 'string' && /^\[\[.*\]\]$/.test(v)) ? 'links' : 'list';
  }
  if (typeof value === 'string') {
    if (/^\[\[.*\]\]$/.test(value)) return 'link';
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    return 'text';
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'checkbox';
  return value === null ? 'empty' : 'object';
}
