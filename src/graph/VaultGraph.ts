import type { App, CachedMetadata, TFile } from 'obsidian';

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
  /**
   * For traversals: each step from the start note to this one (the start itself left out), so
   * a note reached through notes the filters hid still shows how it connects.
   */
  route?: Array<{ path: string; via: string }>;
}

export interface TraverseOptions {
  depth?: number;
  direction?: 'both' | 'out' | 'in';
  /** Only follow these edge types (property names, `link`, `embed`). Empty follows all. */
  edgeTypes?: string[];
  /** Most notes to list, not counting the start note. */
  maxNodes?: number;
  /** List a note when this returns true. The start note is always listed. */
  keep?: (path: string) => boolean;
  /**
   * Walk on through a note when this returns true. Defaults to every note, so filters pick what
   * is listed without cutting off notes that are only reachable through notes that don't match.
   * Pass `keep` here too to stay inside the filters.
   */
  walk?: (path: string) => boolean;
}

export interface TraverseResult {
  start: string;
  /** The start note (hop 0), then the notes listed, by hop and path. */
  nodes: GraphNode[];
  /** Edges among the notes listed, by source, target and type. */
  edges: GraphEdge[];
  /** Links from listed notes to notes that don't exist yet. */
  unresolved: UnresolvedEdge[];
  /** Notes walked through that the filters left out of `nodes`. */
  walked: number;
  /** True when the walk stopped at the note limit before it reached the depth. */
  truncated: boolean;
}

/** Hard cap on notes visited by one traversal, listed or not, so a walk stays fast. */
const MAX_VISITED = 20000;

/**
 * Typed link graph of the vault, built from Obsidian's metadata cache.
 *
 * Unlike `resolvedLinks`, every edge keeps its type: body links are `link`, embeds are `embed`,
 * links in frontmatter take the property name (`parent`, `up`, `related`...) and links in
 * Dataview-style inline fields (`part-of:: [[x]]`, `[part-of:: [[x]]]`) take the field name,
 * which is how most typed vault ontologies are written. `./x` and `../x` resolve against the
 * note's folder. Section links (`[[note#Heading]]`, as lat.md uses)
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

  private static cached: {
    app: App;
    at: number;
    graph: VaultGraph;
    types: string;
    signature: string;
    settled: boolean;
  } | null = null;

  /** Inline fields parsed from note bodies, by app, then path, kept while the note's mtime holds. */
  private static fieldCache = new WeakMap<
    App,
    Map<string, { mtime: number; fields: InlineFieldLink[] }>
  >();

  /**
   * The graph for a vault, from what is cached: no note bodies are read, so inline fields
   * (`field:: [[x]]`) come from the last `load`, for notes unchanged since. Prefer `load` in
   * tools.
   * @param app - Obsidian app.
   * @param typesFolder - Folder of Typed Graph schema notes (empty: anywhere).
   * @param maxAgeMs - While notes were still changing at the last build, reuse it for this long.
   */
  static for(app: App, typesFolder = '', maxAgeMs = 5000): VaultGraph {
    const signature = vaultSignature(app);
    const reuse = VaultGraph.reusable(app, typesFolder, signature, maxAgeMs);
    if (reuse) return reuse;
    return VaultGraph.remember(app, typesFolder, signature, VaultGraph.build(app, typesFolder));
  }

  /**
   * The graph for a vault, with inline fields read from note bodies. Incremental: the graph is
   * reused while no note was added, removed, renamed or modified, and only notes whose
   * modification time changed are read again.
   * @param app - Obsidian app.
   * @param typesFolder - Folder of Typed Graph schema notes (empty: anywhere).
   * @param maxAgeMs - While notes were still changing at the last build, reuse it for this long.
   */
  static async load(app: App, typesFolder = '', maxAgeMs = 5000): Promise<VaultGraph> {
    const signature = vaultSignature(app);
    const reuse = VaultGraph.reusable(app, typesFolder, signature, maxAgeMs);
    if (reuse) return reuse;
    const fields =
      VaultGraph.fieldCache.get(app) ??
      new Map<string, { mtime: number; fields: InlineFieldLink[] }>();
    VaultGraph.fieldCache.set(app, fields);
    const files = app.vault.getMarkdownFiles();
    const live = new Set(files.map(f => f.path));
    for (const path of [...fields.keys()]) if (!live.has(path)) fields.delete(path);
    const stale = files.filter(f => fields.get(f.path)?.mtime !== f.stat.mtime);
    for (let i = 0; i < stale.length; i += 64) {
      await Promise.all(
        stale.slice(i, i + 64).map(async file => {
          try {
            const text = await app.vault.cachedRead(file);
            const cache = app.metadataCache.getFileCache(file);
            fields.set(file.path, {
              mtime: file.stat.mtime,
              fields: parseInlineFields(text, skippedLines(cache)),
            });
          } catch {
            fields.delete(file.path);
          }
        }),
      );
    }
    return VaultGraph.remember(app, typesFolder, signature, VaultGraph.build(app, typesFolder));
  }

  private static reusable(
    app: App,
    typesFolder: string,
    signature: string,
    maxAgeMs: number,
  ): VaultGraph | null {
    const c = VaultGraph.cached;
    if (!c || c.app !== app || c.types !== typesFolder || c.signature !== signature) return null;
    // Obsidian updates its metadata cache shortly after a file changes, so a build made while
    // notes were changing is only trusted briefly.
    if (!c.settled && Date.now() - c.at >= maxAgeMs) return null;
    return c.graph;
  }

  private static remember(
    app: App,
    typesFolder: string,
    signature: string,
    graph: VaultGraph,
  ): VaultGraph {
    const at = Date.now();
    const settled = app.vault.getMarkdownFiles().every(f => f.stat.mtime < at - SETTLE_MS);
    VaultGraph.cached = { app, at, graph, types: typesFolder, signature, settled };
    return graph;
  }

  /**
   * Builds the graph from the metadata cache, plus inline fields from the last `load`.
   * @param app - Obsidian app.
   * @param typesFolder - Folder of Typed Graph schema notes (empty: anywhere).
   */
  static build(app: App, typesFolder = ''): VaultGraph {
    const g = new VaultGraph();
    const typesPrefix = typesFolder.trim().replace(/^\/+|\/+$/g, '');
    const fieldCache = VaultGraph.fieldCache.get(app);
    const files = app.vault.getMarkdownFiles();
    // Frontmatter aliases, so `[[Alias]]` links that Obsidian leaves unresolved still connect
    // when exactly one note carries that alias.
    const aliases = new Map<string, TFile[]>();
    for (const file of files) {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      const raw: unknown = fm?.aliases ?? fm?.alias;
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
      for (const a of list) {
        const key = String(a).trim().toLowerCase();
        if (key) aliases.set(key, [...(aliases.get(key) ?? []), file]);
      }
    }
    for (const file of files) {
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
      const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      const add = (raw: string, type: string) => {
        const [rawPath, ...rest] = raw.split('#');
        const subpath = rest.length ? rest.join('#') : undefined;
        if (!rawPath) return; // a link to a heading in the same note
        const linkpath = relativeTo(folder, rawPath.trim());
        const byAlias = aliases.get(linkpath.toLowerCase());
        const dest =
          app.metadataCache.getFirstLinkpathDest(linkpath, file.path) ??
          (byAlias?.length === 1 ? byAlias[0] : null);
        if (dest) {
          if (dest.extension !== 'md' || dest.path === file.path) return;
          g.addEdge({ from: file.path, to: dest.path, type, ...(subpath ? { subpath } : {}) });
        } else {
          const list = g.unresolved.get(file.path) ?? [];
          list.push({ from: file.path, name: linkpath, type });
          g.unresolved.set(file.path, list);
        }
      };
      // Body links inside an inline field (`part-of:: [[x]]`) take the field's name as their
      // type instead of `link`, once each; field links the cache doesn't list are added too.
      const cached = fieldCache?.get(file.path);
      const fields = cached && cached.mtime === file.stat.mtime ? cached.fields : [];
      const unmatched = new Map<string, InlineFieldLink[]>();
      for (const f of fields) {
        const key = `${f.line}|${f.link}`;
        unmatched.set(key, [...(unmatched.get(key) ?? []), f]);
      }
      const fieldType = (l: { link: string; position?: { start: { line: number } } }) => {
        if (!l.position) return undefined;
        const list = unmatched.get(`${l.position.start.line}|${l.link.trim()}`);
        return list?.shift()?.field;
      };
      for (const l of cache.links ?? []) add(l.link, fieldType(l) ?? 'link');
      for (const e of cache.embeds ?? []) add(e.link, fieldType(e) ?? 'embed');
      for (const list of unmatched.values()) for (const f of list) add(f.link, f.field);
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
      .sort((a, b) => b.notes - a.notes || compare(a.type, b.type));
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
    // Relation names are matched without case, as speech and models don't keep it.
    const wanted = new Set(edgeTypes.map(t => t.trim().toLowerCase()).filter(Boolean));
    const typeOk = (e: GraphEdge) => !wanted.size || wanted.has(e.type.toLowerCase());
    const list: Array<{ path: string; edge: GraphEdge; dir: 'out' | 'in' }> = [];
    if (direction !== 'in')
      for (const e of this.out.get(path) ?? [])
        if (typeOk(e)) list.push({ path: e.to, edge: e, dir: 'out' });
    if (direction !== 'out')
      for (const e of this.in.get(path) ?? [])
        if (typeOk(e)) list.push({ path: e.from, edge: e, dir: 'in' });
    // A fixed order makes walks deterministic whatever order Obsidian lists files in. For the
    // same neighbour, outgoing before incoming and typed relations before plain links, so the
    // relation a note is reported as reached by is the most informative one.
    const plain = (t: string) => (t === 'link' || t === 'embed' ? 1 : 0);
    return list.sort(
      (a, b) =>
        compare(a.path, b.path) ||
        compare(a.dir === 'out' ? 0 : 1, b.dir === 'out' ? 0 : 1) ||
        plain(a.edge.type) - plain(b.edge.type) ||
        compare(a.edge.type, b.edge.type),
    );
  }

  /**
   * Breadth-first traversal from one note. Filters (`keep`) choose the notes listed; the walk
   * passes through other notes too unless `walk` says otherwise, so a note two hops away is
   * found even when the note between doesn't match.
   * @param start - Start note path.
   * @param opts - Depth, direction, edge types, note cap and filters.
   */
  traverse(start: string, opts: TraverseOptions = {}): TraverseResult {
    const depth = Math.min(6, Math.max(1, Math.floor(opts.depth ?? 2)));
    const maxNodes = Math.min(500, Math.max(1, Math.floor(opts.maxNodes ?? 60)));
    const keep = opts.keep ?? (() => true);
    const walk = opts.walk ?? (() => true);
    const startNode: GraphNode = { path: start, hop: 0, parent: '', via: 'start' };
    const seen = new Map<string, { parent: string; via: string }>([
      [start, { parent: '', via: 'start' }],
    ]);
    const listed: GraphNode[] = [];
    let walked = 0;
    let frontier = [start];
    let truncated = false;
    for (let hop = 1; hop <= depth && frontier.length && !truncated; hop++) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const n of this.neighbours(from, opts.direction, opts.edgeTypes)) {
          if (seen.has(n.path)) continue;
          const listIt = keep(n.path);
          const walkOn = walk(n.path);
          if (!listIt && !walkOn) continue;
          if ((listIt && listed.length >= maxNodes) || seen.size >= MAX_VISITED) {
            truncated = true;
            break;
          }
          const via = `${n.dir}:${n.edge.type}`;
          seen.set(n.path, { parent: from, via });
          if (listIt) listed.push({ path: n.path, hop, parent: from, via });
          else walked++;
          if (walkOn) next.push(n.path);
        }
        if (truncated) break;
      }
      frontier = next;
    }
    listed.sort((a, b) => a.hop - b.hop || compare(a.path, b.path));
    for (const node of listed) {
      const route: Array<{ path: string; via: string }> = [];
      for (let p = node.path; p !== start; ) {
        const step = seen.get(p);
        if (!step) break;
        route.unshift({ path: p, via: step.via });
        p = step.parent;
      }
      node.route = route;
    }
    const nodes = [startNode, ...listed];
    const inGraph = new Set(nodes.map(n => n.path));
    const edges: GraphEdge[] = [];
    const unresolved: UnresolvedEdge[] = [];
    for (const p of inGraph) {
      for (const e of this.out.get(p) ?? []) if (inGraph.has(e.to)) edges.push(e);
      unresolved.push(...(this.unresolved.get(p) ?? []));
    }
    edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.type, b.type));
    unresolved.sort((a, b) => compare(a.from, b.from) || compare(a.name, b.name));
    return { start, nodes, edges, unresolved, walked, truncated };
  }

  /**
   * Shortest chain of links between two notes, following links either way.
   * @param from - Start path.
   * @param to - Target path.
   * @param maxDepth - Longest chain to look for.
   * @param edgeTypes - Types to follow (empty follows all).
   * @param maxHubDegree - Don't pass through notes with more links than this (index notes); 0
   *   allows any.
   * @param opts - Direction of links to follow (`out` reads "from links to", `in` the reverse;
   *   default both) and which notes the chain may pass through (the two ends always may).
   * @param opts.direction - Link direction.
   * @param opts.through - Notes the chain may pass through.
   */
  path(
    from: string,
    to: string,
    maxDepth = 6,
    edgeTypes: string[] = [],
    maxHubDegree = 0,
    opts: { direction?: 'both' | 'out' | 'in'; through?: (path: string) => boolean } = {},
  ): GraphNode[] | null {
    const through = opts.through ?? (() => true);
    if (from === to) return [{ path: from, hop: 0, parent: '', via: 'start' }];
    const seen = new Map<string, GraphNode>([
      [from, { path: from, hop: 0, parent: '', via: 'start' }],
    ]);
    let frontier = [from];
    for (let hop = 1; hop <= maxDepth && frontier.length; hop++) {
      const next: string[] = [];
      for (const p of frontier) {
        for (const n of this.neighbours(p, opts.direction ?? 'both', edgeTypes)) {
          if (seen.has(n.path)) continue;
          if (n.path !== to && !through(n.path)) continue;
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
      .sort((a, b) => b.in - a.in || b.out - a.out || compare(a.path, b.path))
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
      .sort(
        (a, b) =>
          b.score - a.score || Number(a.direct) - Number(b.direct) || compare(a.path, b.path),
      )
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
      .sort((a, b) => b.count - a.count || compare(a.type, b.type));
  }

  /** Tags with note counts, most common first. */
  tagCounts(): Array<{ tag: string; notes: number }> {
    const counts = new Map<string, number>();
    for (const set of this.tags.values())
      for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
      .map(([tag, notes]) => ({ tag, notes }))
      .sort((a, b) => b.notes - a.notes || compare(a.tag, b.tag));
  }
}

/**
 * Plain code-point order, the same on every machine (unlike `localeCompare`).
 * @param a - First.
 * @param b - Second.
 */
function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/** A link inside a Dataview-style inline field (`field:: [[target]]`) in a note body. */
export interface InlineFieldLink {
  /** Field name, used as the edge type. */
  field: string;
  /** Link text as Obsidian caches it: target and subpath, without the alias. */
  link: string;
  /** Zero-based line in the note. */
  line: number;
}

/** A build made while notes were changing this recently is only reused briefly. */
const SETTLE_MS = 3000;

const FIELD_KEY = String.raw`[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*?`;
/** `field:: value` at the start of a line, list item, task or quote, with optional bold key. */
const LINE_FIELD = new RegExp(
  String.raw`^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)?(?:\*\*|__)?(${FIELD_KEY})(?:\*\*|__)?\s*::(.*)$`,
  'u',
);
/** Start of a bracketed inline field: `[field::` or `(field::`. */
const INLINE_START = new RegExp(String.raw`[[(]\s*(${FIELD_KEY})\s*::`, 'gu');
const WIKILINK = /!?\[\[([^\]]+?)\]\]/g;

/**
 * Finds links in Dataview-style inline fields: `field:: [[a]]` at the start of a line or list
 * item (several links allowed: `- field:: [[a]], [[b]]`) and bracketed `[field:: [[x]]]` or
 * `(field:: [[x]])` anywhere in a line. Skips frontmatter, fenced code and any extra lines given.
 * @param text - Note text.
 * @param skip - Zero-based lines to skip (such as code sections from the metadata cache).
 */
export function parseInlineFields(text: string, skip: Set<number> = new Set()): InlineFieldLink[] {
  if (!text.includes('::')) return [];
  const lines = text.split('\n');
  const out: InlineFieldLink[] = [];
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) start = end + 1;
  }
  let fence = '';
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = '';
      continue;
    }
    if (fence || skip.has(i) || !line.includes('::')) continue;
    // Bracketed fields first: their links take their own field name.
    const spans: Array<{ from: number; to: number; field: string }> = [];
    for (const m of line.matchAll(INLINE_START)) {
      const at = m.index ?? 0;
      if (at > 0 && (line[at - 1] === '[' || line[at - 1] === '!')) continue;
      if (spans.some(s => at >= s.from && at < s.to)) continue;
      const open = line[at];
      const close = open === '[' ? ']' : ')';
      let depth = 0;
      let end = -1;
      for (let j = at; j < line.length; j++) {
        if (line[j] === open) depth++;
        else if (line[j] === close && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) continue;
      spans.push({ from: at, to: end + 1, field: fieldName(m[1]) });
    }
    const whole = LINE_FIELD.exec(line);
    const lineField = whole && !spans.some(s => s.from === 0) ? fieldName(whole[1]) : '';
    const valueFrom = whole ? line.length - whole[2].length : line.length;
    for (const m of line.matchAll(WIKILINK)) {
      const at = m.index ?? 0;
      const span = spans.find(s => at >= s.from && at < s.to);
      const field = span?.field ?? (lineField && at >= valueFrom ? lineField : '');
      const link = m[1].split('|')[0].trim();
      if (field && link) out.push({ field, link, line: i });
    }
  }
  return out;
}

/**
 * Field and property names as edge types: markup and spaces trimmed; `related.1` -> `related`.
 * @param key - Raw key.
 */
function fieldName(key: string): string {
  return propertyName(
    key
      .trim()
      .replace(/^[*_]+|[*_]+$/g, '')
      .trim(),
  );
}

/**
 * Lines of indented code and other code sections the metadata cache knows about.
 * @param cache - Metadata cache entry.
 */
function skippedLines(cache: CachedMetadata | null): Set<number> {
  const skip = new Set<number>();
  for (const s of cache?.sections ?? []) {
    if (s.type !== 'code') continue;
    for (let l = s.position.start.line; l <= s.position.end.line; l++) skip.add(l);
  }
  return skip;
}

/**
 * Resolves `./x` and `../x` against a note's folder; other link paths are returned as written.
 * @param folder - The note's folder ('' for the vault root).
 * @param linkpath - Link path.
 */
export function relativeTo(folder: string, linkpath: string): string {
  if (!/^\.\.?\//.test(linkpath)) return linkpath;
  const parts = folder ? folder.split('/') : [];
  for (const seg of linkpath.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Changes when a note is added, removed, renamed or modified. Cheap: no note is read.
 * @param app - Obsidian app.
 */
function vaultSignature(app: App): string {
  let count = 0;
  let mtimes = 0;
  let names = 0;
  for (const f of app.vault.getMarkdownFiles()) {
    count++;
    mtimes = (mtimes + (f.stat.mtime % 1_000_000_007)) % 1_000_000_007;
    let h = 0;
    for (let i = 0; i < f.path.length; i++) h = (h * 31 + f.path.charCodeAt(i)) | 0;
    names = (names + h) | 0;
  }
  return `${count}:${mtimes}:${names}`;
}
