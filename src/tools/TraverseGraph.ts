import type { App } from 'obsidian';
import { normalizePath, TFile } from 'obsidian';
import {
  ontologyHeadline,
  ontologySummary,
  resolveGraphNote,
  scopeFilter,
} from '../graph/ontology';
import { VaultGraph } from '../graph/VaultGraph';
import type { GraphNode, TraverseResult } from '../graph/VaultGraph';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

/** Most edges and unresolved links one JSON result carries; counts give the full totals. */
const MAX_JSON_EDGES = 300;
const MAX_JSON_UNRESOLVED = 100;
const DIRECTIONS = ['both', 'out', 'in'] as const;
type Direction = (typeof DIRECTIONS)[number];

const scopeProperties = {
  folder: {
    type: 'string',
    description: 'Only list notes inside this folder (a path or a bare name, such as "LO").',
  },
  tag: {
    type: 'string',
    description: 'Only list notes with this tag (child tags count).',
  },
  node_types: {
    type: 'array',
    items: { type: 'string', description: 'Node type name.' },
    description: 'Only list notes whose frontmatter `type` is one of these (see vault_ontology).',
  },
} as const;

/**
 * The vault graph a graph tool works on, with inline fields read and reused between calls.
 * @param app - Obsidian app.
 * @param typesFolder - Folder of Typed Graph schema notes from settings.
 */
function graphFor(app: App, typesFolder: string | undefined): Promise<VaultGraph> {
  return VaultGraph.load(app, typesFolder ?? '');
}

/**
 * An error for a `format` other than text or json, or null.
 * @param args - Tool arguments.
 */
function formatError(args: { format?: unknown }): string | null {
  if (args.format === undefined || args.format === 'text' || args.format === 'json') return null;
  return toolError(
    'InvalidArgument',
    `format must be "text" or "json", not ${JSON.stringify(args.format)}.`,
    ['Leave format out for text, or pass "json" for data.'],
  );
}

/**
 * A list argument as strings: accepts an array or a comma-separated string.
 * @param value - Argument value.
 */
function stringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.map(v => String(v).trim()).filter(Boolean);
}

/**
 * A whole number within bounds, or the default.
 * @param value - Argument value.
 * @param min - Lowest.
 * @param max - Highest.
 * @param fallback - Default.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** @param path - Note path. */
function noteName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

/**
 * @param n - Count.
 * @param word - Singular word.
 */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Says how a chain of notes connects, in words: "A links to B; C has part-of B".
 * @param chain - Chain from graph.path, start first.
 */
function describeChain(chain: GraphNode[]): string {
  const verb = (type: string) =>
    type === 'link' ? 'links to' : type === 'embed' ? 'embeds' : `has ${type}`;
  return chain
    .slice(1)
    .map((n, i) => {
      const prev = noteName(chain[i].path);
      const [dir, type] = n.via.split(':');
      const cur = noteName(n.path);
      return dir === 'out' ? `${prev} ${verb(type)} ${cur}` : `${cur} ${verb(type)} ${prev}`;
    })
    .join('; ');
}

/**
 * Finds the note a graph call starts from, or a tool error.
 * @param app - Obsidian app.
 * @param ref - Path, name, [[link]] or "active".
 * @param param - Parameter name, for the recovery lines.
 */
function resolveStart(
  app: App,
  ref: string | undefined,
  param: string,
): { path: string } | { error: string } {
  const r = resolveGraphNote(app, ref);
  if (r.file) return { path: r.file.path };
  const said = (ref ?? '').trim();
  if (r.candidates.length) {
    return {
      error: toolError(
        'AmbiguousNote',
        `${r.candidates.length} notes match "${said}"; say which one.`,
        r.candidates.slice(0, 8).map(f => `${param}: "${f.path}"`),
      ),
    };
  }
  if (!said || /^(active|current|this)( note)?$/i.test(said)) {
    return {
      error: toolError('NoActiveNote', 'No note is open, and no note was named.', [
        `Pass ${param} as a path, name or [[link]].`,
        'get_active_context shows what the user has open.',
      ]),
    };
  }
  return {
    error: toolError('NotFound', `No note found for "${said}".`, [
      ...r.near.map(f => `Did you mean ${param}: "${f.path}"?`),
      'search_vault with words from its title.',
      `glob_vault_files with "**/*${noteName(said)}*.md".`,
      'list_vault_folders on the folder it should be in.',
    ]),
  };
}

/** @param message - Scope filter error. */
function folderError(message: string): string {
  return toolError('FolderNotFound', message, [
    'list_vault_folders to see folder names.',
    'Call again without folder.',
  ]);
}

const traverseParameters = defineToolParameters({
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description:
        'Start note: a path, a name, a [[link]], or "active" for the note the user has open (the default).',
    },
    depth: {
      type: 'integer',
      description: 'Hops to follow from the start note, 1 to 6. Defaults to 2.',
    },
    direction: {
      type: 'string',
      enum: ['both', 'out', 'in'],
      description:
        'both (default) follows outgoing links and backlinks; out only outgoing; in only backlinks.',
    },
    edge_types: {
      type: 'array',
      items: { type: 'string', description: 'Relation name.' },
      description:
        'Only follow these relations: frontmatter property or inline field names (such as up, part-of, concept), "link" for plain body links, "embed" for embeds. Empty follows all. See vault_ontology.',
    },
    max_nodes: {
      type: 'integer',
      description: 'Most notes to list, 1 to 500. Defaults to 60.',
    },
    ...scopeProperties,
    stay_in_scope: {
      type: 'boolean',
      description:
        'false (default): walk through any note and list only those matching folder, tag and node_types. true: walk only through matching notes.',
    },
    include_unresolved: {
      type: 'boolean',
      description: 'Also list links to notes that do not exist yet. Defaults to true.',
    },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: [],
} as const);

export type TraverseGraphArgs = InferArgs<typeof traverseParameters>;

/** What a traversal was asked to do, for its summary and output. */
interface TraversalAsk {
  depth: number;
  direction: Direction;
  edgeTypes: string[];
  scope: string;
  filtered: boolean;
  stayInScope: boolean;
  maxNodes: number;
  unresolved: boolean;
  filters: { folder: string; tag: string; node_types: string[] };
}

/**
 * Multi-hop traversal of the typed link graph from one note: breadth first over body links,
 * embeds, typed frontmatter relations and inline fields, in either direction, to a set depth,
 * with folder, tag, node-type and edge-type filters.
 */
export class TraverseGraphTool extends Tool<TraverseGraphArgs> {
  readonly name = 'traverse_graph';
  readonly classification = 'Vault';
  readonly description =
    "Walks the vault's links from a note, several hops out, and lists the notes it reaches with the relation that led to each. It follows outgoing links, backlinks, embeds and typed relations (frontmatter properties and inline fields such as up, part-of or concept). Use it for any question about a note's connections, related notes or local graph; it covers backlinks (direction in, depth 1). For the shortest chain between two notes, hub notes or notes sharing neighbours use graph_cli; for relation and note type names use vault_ontology. Key parameters: note (path, name, [[link]] or active), depth 1 to 6 (default 2), direction (default both), edge_types, and folder, tag or node_types to choose which notes are listed. format json returns nodes, edges and unresolved links for scripts.";
  readonly parameters = traverseParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Runs the traversal.
   * @param args - Tool arguments.
   */
  async execute(args: TraverseGraphArgs): Promise<string> {
    const app = this.chat.plugin.app;
    const bad = formatError(args);
    if (bad) return bad;
    const direction = (args.direction ?? 'both') as Direction;
    if (!DIRECTIONS.includes(direction)) {
      return toolError(
        'InvalidArgument',
        `direction must be both, out or in, not "${String(args.direction)}".`,
        ['Leave direction out to follow links both ways.'],
      );
    }
    const start = resolveStart(app, args.note, 'note');
    if ('error' in start) return start.error;
    const graph = await graphFor(app, this.chat.plugin.settings.graph?.typesFolder);
    const nodeTypes = stringList(args.node_types);
    const scope = scopeFilter(app, graph, { folder: args.folder, tag: args.tag, nodeTypes });
    if (scope.error) return folderError(scope.error);
    const ask: TraversalAsk = {
      depth: clampInt(args.depth, 1, 6, 2),
      direction,
      edgeTypes: stringList(args.edge_types),
      scope: scope.label,
      filtered: scope.active,
      stayInScope: args.stay_in_scope === true,
      maxNodes: clampInt(args.max_nodes, 1, 500, 60),
      unresolved: args.include_unresolved ?? true,
      filters: { folder: args.folder ?? '', tag: args.tag ?? '', node_types: nodeTypes },
    };
    void this.status(`Traversing links from "${start.path}"...`);
    const result = graph.traverse(start.path, {
      depth: ask.depth,
      direction: ask.direction,
      edgeTypes: ask.edgeTypes,
      maxNodes: ask.maxNodes,
      keep: scope.keep,
      walk: ask.stayInScope ? scope.keep : undefined,
    });
    const summary = traversalSummary(graph, result, ask);
    if (wantsJson(args)) return jsonResult(traversalJson(graph, result, ask, summary));
    return formatTraversal(graph, result, ask, summary);
  }
}

/**
 * Spoken-friendly first line, and what to try next when the result is empty or cut short.
 * @param graph - Vault graph.
 * @param r - Traversal.
 * @param o - What was asked.
 */
function traversalSummary(
  graph: VaultGraph,
  r: TraverseResult,
  o: TraversalAsk,
): { line: string; hint: string } {
  const name = noteName(r.start);
  const n = r.nodes.length - 1;
  const outs = graph.out.get(r.start)?.length ?? 0;
  const ins = graph.in.get(r.start)?.length ?? 0;
  const within = `within ${plural(o.depth, 'hop')} of ${name}`;
  const how =
    (o.direction === 'out' ? ', following outgoing links only' : '') +
    (o.direction === 'in' ? ', following backlinks only' : '') +
    (o.edgeTypes.length ? `, through ${o.edgeTypes.join(' and ')} relations` : '');
  if (n > 0) {
    const perHop = new Map<number, number>();
    for (const x of r.nodes.slice(1)) perHop.set(x.hop, (perHop.get(x.hop) ?? 0) + 1);
    const hops = [...perHop.entries()].map(([h, c]) => `${c} at hop ${h}`).join(', ');
    const what = o.scope ? `${plural(n, 'note')} ${o.scope}` : `${plural(n, 'connected note')}`;
    const line = `Found ${what} ${within}${how} (${hops}).${r.truncated ? ` Stopped at the limit of ${o.maxNodes}; more are available.` : ''}`;
    const hint = r.truncated
      ? 'More notes are available: raise max_nodes, lower depth, or narrow with edge_types, folder, tag or node_types.'
      : '';
    return { line, hint };
  }
  if (outs + ins === 0) {
    return {
      line: `${name} has no links in or out, so there is nothing to walk.`,
      hint: `search_vault for "${name}" finds plain-text mentions; list_vault_folders shows its neighbours by folder.`,
    };
  }
  if (o.direction === 'in' && ins === 0) {
    return {
      line: `${name} has no backlinks, but it links out to ${plural(outs, 'note')}.`,
      hint: 'Call again with direction both (or out) to follow its outgoing links.',
    };
  }
  if (o.direction === 'out' && outs === 0) {
    return {
      line: `${name} has no outgoing links, but ${plural(ins, 'note')} link to it.`,
      hint: 'Call again with direction both (or in) to follow its backlinks.',
    };
  }
  if (o.edgeTypes.length || o.filtered) {
    const known = graph
      .edgeTypes()
      .slice(0, 12)
      .map(e => e.type);
    return {
      line: `No notes ${within}${how} matched${o.filtered ? ` the filters (${o.scope})` : ''}.`,
      hint: [
        o.stayInScope ? 'Try stay_in_scope false so the walk can pass through other notes.' : '',
        o.edgeTypes.length ? `Relations used in this vault include: ${known.join(', ')}.` : '',
        'Try a greater depth or fewer filters.',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }
  return {
    line: `No notes found ${within}${how}.`,
    hint: 'Try a greater depth or direction both.',
  };
}

/**
 * Stable JSON for scripts and workers.
 * @param graph - Vault graph.
 * @param r - Traversal.
 * @param o - What was asked.
 * @param s - Summary.
 * @param s.line - First line.
 * @param s.hint - What to try next.
 */
function traversalJson(
  graph: VaultGraph,
  r: TraverseResult,
  o: TraversalAsk,
  s: { line: string; hint: string },
): Record<string, unknown> {
  const unresolved = o.unresolved ? r.unresolved : [];
  return {
    summary: s.line,
    start: r.start,
    depth: o.depth,
    direction: o.direction,
    edge_types: o.edgeTypes,
    filters: { ...o.filters, stay_in_scope: o.stayInScope },
    counts: {
      nodes: r.nodes.length - 1,
      edges: r.edges.length,
      unresolved: unresolved.length,
      walked_through: r.walked,
      start_outgoing: graph.out.get(r.start)?.length ?? 0,
      start_backlinks: graph.in.get(r.start)?.length ?? 0,
    },
    truncated: r.truncated,
    hint: s.hint,
    nodes: r.nodes.map((n: GraphNode) => ({
      path: n.path,
      hop: n.hop,
      parent: n.parent,
      via: n.via,
      types: graph.nodeTypes.get(n.path) ?? [],
      route: n.route ?? [],
    })),
    edges: r.edges
      .slice(0, MAX_JSON_EDGES)
      .map(e => ({ from: e.from, to: e.to, type: e.type, subpath: e.subpath ?? '' })),
    unresolved: unresolved
      .slice(0, MAX_JSON_UNRESOLVED)
      .map(u => ({ from: u.from, name: u.name, type: u.type })),
    omitted: {
      edges: Math.max(0, r.edges.length - MAX_JSON_EDGES),
      unresolved: Math.max(0, unresolved.length - MAX_JSON_UNRESOLVED),
    },
  };
}

/**
 * Readable local graph.
 * @param graph - Vault graph.
 * @param r - Traversal.
 * @param o - What was asked.
 * @param s - Summary.
 * @param s.line - First line.
 * @param s.hint - What to try next.
 */
function formatTraversal(
  graph: VaultGraph,
  r: TraverseResult,
  o: TraversalAsk,
  s: { line: string; hint: string },
): string {
  const typeOf = (p: string) => {
    const t = graph.nodeTypes.get(p);
    return t?.length ? ` [${t.join(', ')}]` : '';
  };
  const n = r.nodes.length - 1;
  const outs = graph.out.get(r.start)?.length ?? 0;
  const ins = graph.in.get(r.start)?.length ?? 0;
  const lines = [
    s.line,
    '',
    `LOCAL GRAPH OF: ${r.start}${typeOf(r.start)}`,
    `Depth ${o.depth}, direction ${o.direction}${o.edgeTypes.length ? `, following ${o.edgeTypes.join(', ')}` : ''}${o.scope ? `, listing notes ${o.scope}${o.stayInScope ? ' (walk stays in scope)' : ''}` : ''}: ${plural(n, 'note')}, ${plural(r.edges.length, 'link')} among them${r.walked ? `, ${plural(r.walked, 'other note')} walked through` : ''}.`,
    `Start note: ${plural(outs, 'outgoing link')}, ${plural(ins, 'backlink')}.`,
  ];
  const maxHop = Math.max(0, ...r.nodes.map(x => x.hop));
  for (let hop = 1; hop <= maxHop; hop++) {
    const at = r.nodes.filter(x => x.hop === hop);
    if (!at.length) continue;
    lines.push('', `Hop ${hop} (${at.length}):`);
    for (const x of at) {
      const [dir, type] = x.via.split(':');
      const how = dir === 'out' ? `${type} from ${x.parent}` : `${type} to ${x.parent}`;
      const through = (x.route ?? []).slice(0, -1).map(step => noteName(step.path));
      lines.push(
        `- ${x.path}${typeOf(x.path)} (${dir === 'out' ? '→' : '←'} ${how}${through.length > 1 ? `; route ${noteName(r.start)} > ${through.join(' > ')}` : ''})`,
      );
    }
  }
  const degree = new Map<string, number>();
  for (const e of r.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const hubs = [...degree.entries()]
    .filter(([p, d]) => p !== r.start && d > 1)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8);
  if (hubs.length) {
    lines.push('', 'Best connected in this graph:');
    for (const [p, d] of hubs) lines.push(`- ${p}: ${d} links`);
  }
  if (o.unresolved && r.unresolved.length) {
    const names = [...new Set(r.unresolved.map(u => u.name))];
    lines.push(
      '',
      `Links to notes that don't exist yet: ${names.slice(0, 30).join(', ')}${names.length > 30 ? `, and ${names.length - 30} more` : ''}`,
    );
  }
  if (s.hint) lines.push('', s.hint);
  return lines.join('\n');
}

const ontologyParameters = defineToolParameters({
  type: 'object',
  properties: {
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: [],
} as const);

export type VaultOntologyArgs = InferArgs<typeof ontologyParameters>;

/** Most entries per list in vault_ontology's JSON. */
const MAX_ONTOLOGY_ITEMS = 200;

/** The vault's typed ontology: declared and used node types, edge types, tags and properties. */
export class VaultOntologyTool extends Tool<VaultOntologyArgs> {
  readonly name = 'vault_ontology';
  readonly classification = 'Vault';
  readonly description =
    "Describes how this vault's notes are typed and linked: note types (frontmatter type), relation types (frontmatter properties and inline fields that link notes) with their meaning from Typed Graph schema notes, how often each is used, tags and properties. Read it before filtering traverse_graph by edge_types or node_types, or before writing typed notes. It takes no input apart from format; json returns the same lists for scripts.";
  readonly parameters = ontologyParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: VaultOntologyArgs): Promise<string> {
    const bad = formatError(args);
    if (bad) return bad;
    const graph = await graphFor(
      this.chat.plugin.app,
      this.chat.plugin.settings.graph?.typesFolder,
    );
    if (!wantsJson(args)) return ontologySummary(graph);
    const cap = <T>(list: T[]) => list.slice(0, MAX_ONTOLOGY_ITEMS);
    const nodeTypes = [...graph.schema.nodeTypes.values()];
    const edgeTypes = [...graph.schema.edgeTypes.values()];
    const nodeTypesUsed = graph.typeCounts();
    const edgeTypesUsed = graph.edgeTypes().map(e => ({ type: e.type, count: e.count }));
    const tags = graph.tagCounts();
    const properties = [...graph.properties.entries()]
      .map(([name, v]) => ({ name, notes: v.notes, kinds: [...v.kinds].sort() }))
      .sort((a, b) => b.notes - a.notes || (a.name < b.name ? -1 : 1));
    const over = (list: unknown[]) => Math.max(0, list.length - MAX_ONTOLOGY_ITEMS);
    return jsonResult({
      summary: ontologyHeadline(graph),
      notes: graph.paths.length,
      schemaNotes: graph.schema.sources,
      nodeTypes: cap(nodeTypes),
      edgeTypes: cap(edgeTypes),
      nodeTypesUsed: cap(nodeTypesUsed),
      edgeTypesUsed: cap(edgeTypesUsed),
      tags: cap(tags),
      properties: cap(properties),
      omitted: {
        nodeTypes: over(nodeTypes),
        edgeTypes: over(edgeTypes),
        nodeTypesUsed: over(nodeTypesUsed),
        edgeTypesUsed: over(edgeTypesUsed),
        tags: over(tags),
        properties: over(properties),
      },
    });
  }
}

const GRAPH_COMMANDS = ['help', 'path', 'hubs', 'related', 'run', 'save'] as const;

/** Commands graph_cli used to have, and the tool that does each now. */
const MOVED_COMMANDS: Record<string, { tool: string; how: string }> = {
  traverse: {
    tool: 'traverse_graph',
    how: 'Call traverse_graph with note, depth, direction, edge_types and the folder, tag or node_types filters.',
  },
  ontology: {
    tool: 'vault_ontology',
    how: 'Call vault_ontology (format json for data).',
  },
  backlinks: {
    tool: 'traverse_graph',
    how: 'Call traverse_graph with note, direction "in" and depth 1.',
  },
};

const cliParameters = defineToolParameters({
  type: 'object',
  properties: {
    command: {
      type: 'string',
      enum: ['help', 'path', 'hubs', 'related', 'run', 'save'],
      description:
        'help (list commands and saved commands), path, hubs, related, run (a saved command), save (keep a script as a command).',
    },
    note: {
      type: 'string',
      description: 'For path (start) and related: a path, name, [[link]] or "active".',
    },
    to: { type: 'string', description: 'For path: the target note.' },
    depth: {
      type: 'integer',
      description: 'For path: longest chain to look for, 1 to 8 (default 6).',
    },
    direction: {
      type: 'string',
      enum: ['both', 'out', 'in'],
      description:
        'For path: both (default) follows links either way; out only from note towards to; in only the reverse.',
    },
    edge_types: {
      type: 'array',
      items: { type: 'string', description: 'Relation name.' },
      description: 'For path: only follow these relations.',
    },
    ...scopeProperties,
    limit: {
      type: 'integer',
      description: 'For hubs and related: results to return, 1 to 100 (default 15).',
    },
    max_hub_links: {
      type: 'integer',
      description:
        'For path: skip notes with more links than this (index notes), default 150; 0 allows any.',
    },
    name: { type: 'string', description: 'For run and save: the saved command name.' },
    args: {
      type: 'object',
      description: 'For run: arguments passed to the saved command as `args`.',
    },
    intent: { type: 'string', description: 'For save: what the command is for, in one line.' },
    code: {
      type: 'string',
      description:
        'For save: code-mode JavaScript that receives `args` and calls tools (such as tools.traverse_graph).',
    },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: ['command'],
} as const);

export type GraphCliArgs = InferArgs<typeof cliParameters>;

/**
 * The graph CLI: single-intent, deterministic commands over the typed graph that traverse_graph
 * and vault_ontology don't cover, plus saved commands (code-mode scripts kept as notes) so useful
 * traversals can be promoted, hardened and reused.
 */
export class GraphCliTool extends Tool<GraphCliArgs> {
  readonly name = 'graph_cli';
  readonly classification = 'Vault';
  readonly description =
    "Runs graph commands that traverse_graph doesn't: path finds the shortest chain of links between two notes, hubs lists the most-linked notes in a folder, tag or note type, and related finds notes that share neighbours with a note without linking to it directly. Saved commands are code-mode scripts kept as notes: run one by name, or save a script that worked so it becomes a reusable command; call help to list them. For a note's local graph or backlinks use traverse_graph; for relation and note types use vault_ontology. format json returns one object for scripts.";
  readonly parameters = cliParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: GraphCliArgs): Promise<string> {
    const bad = formatError(args);
    if (bad) return bad;
    const command = String(args.command ?? 'help')
      .trim()
      .toLowerCase();
    const moved = MOVED_COMMANDS[command];
    if (moved) {
      return toolError(
        'MovedCommand',
        `graph_cli no longer has "${command}"; ${moved.tool} does it.`,
        [moved.how],
      );
    }
    if (!(GRAPH_COMMANDS as readonly string[]).includes(command)) {
      return toolError('UnknownCommand', `graph_cli has no command "${String(args.command)}".`, [
        `Commands: ${GRAPH_COMMANDS.join(', ')}.`,
        "For a note's local graph use traverse_graph; for types use vault_ontology.",
      ]);
    }
    const json = wantsJson(args);
    switch (command) {
      case 'help':
        return this.help(json);
      case 'path':
        return await this.path(args, json);
      case 'hubs':
      case 'related':
        return await this.ranked(command, args, json);
      case 'run':
        return await this.runSaved(args.name ?? '', (args.args as Record<string, unknown>) ?? {});
      default:
        return await this.save(args.name ?? '', args.intent ?? '', args.code ?? '');
    }
  }

  private get app(): App {
    return this.chat.plugin.app;
  }

  private graph(): Promise<VaultGraph> {
    return graphFor(this.app, this.chat.plugin.settings.graph?.typesFolder);
  }

  private async path(args: GraphCliArgs, json: boolean): Promise<string> {
    if (!args.to?.trim()) {
      return toolError('InvalidArgument', 'path needs a target note in to.', [
        'Pass note (the start, default active) and to (the target).',
      ]);
    }
    const a = resolveStart(this.app, args.note, 'note');
    if ('error' in a) return a.error;
    const b = resolveStart(this.app, args.to, 'to');
    if ('error' in b) return b.error;
    const direction = (args.direction ?? 'both') as Direction;
    if (!DIRECTIONS.includes(direction)) {
      return toolError(
        'InvalidArgument',
        `direction must be both, out or in, not "${String(args.direction)}".`,
        ['Leave direction out to follow links both ways.'],
      );
    }
    const graph = await this.graph();
    const scope = scopeFilter(this.app, graph, {
      folder: args.folder,
      tag: args.tag,
      nodeTypes: stringList(args.node_types),
    });
    if (scope.error) return folderError(scope.error);
    const depth = clampInt(args.depth, 1, 8, 6);
    const edgeTypes = stringList(args.edge_types);
    const chain = graph.path(
      a.path,
      b.path,
      depth,
      edgeTypes,
      clampInt(args.max_hub_links, 0, 100000, 150),
      {
        direction,
        through: scope.active ? scope.keep : undefined,
      },
    );
    const hops = chain ? chain.length - 1 : null;
    const summary = chain
      ? `${noteName(a.path)} connects to ${noteName(b.path)} in ${plural(hops ?? 0, 'step')}: ${describeChain(chain)}.`
      : `No chain of links between ${noteName(a.path)} and ${noteName(b.path)} within ${plural(depth, 'hop')}${scope.label ? `, passing only through notes ${scope.label}` : ''}.`;
    const hint = chain
      ? ''
      : `Try a greater depth (up to 8), max_hub_links 0 to pass through index notes${direction !== 'both' ? ', direction both' : ''}${edgeTypes.length ? ', without edge_types' : ''}${scope.active ? ', or without the folder, tag or type filter' : ''}.`;
    if (json) {
      return jsonResult({
        command: 'path',
        summary,
        from: a.path,
        to: b.path,
        found: !!chain,
        hops,
        direction,
        edge_types: edgeTypes,
        scope: scope.label,
        chain: (chain ?? []).map(n => ({ path: n.path, hop: n.hop, parent: n.parent, via: n.via })),
        hint,
      });
    }
    if (!chain) return `${summary}\n${hint}`;
    return [
      summary,
      '',
      ...chain.map((n, i) =>
        i === 0
          ? n.path
          : `  ${n.via.startsWith('out') ? '→' : '←'} ${n.via.split(':')[1]} → ${n.path}`,
      ),
    ].join('\n');
  }

  private async ranked(
    command: 'hubs' | 'related',
    args: GraphCliArgs,
    json: boolean,
  ): Promise<string> {
    const graph = await this.graph();
    const scope = scopeFilter(this.app, graph, {
      folder: args.folder,
      tag: args.tag,
      nodeTypes: stringList(args.node_types),
    });
    if (scope.error) return folderError(scope.error);
    const limit = clampInt(args.limit, 1, 100, 15);
    const types = (p: string) => graph.nodeTypes.get(p) ?? [];
    const where = scope.label ? ` ${scope.label}` : '';
    if (command === 'hubs') {
      const found = graph.hubs(scope.keep, limit + 1);
      const hubs = found.slice(0, limit).map(h => ({ ...h, types: types(h.path) }));
      const summary = hubs.length
        ? `The most linked note${where} is ${noteName(hubs[0].path)}, with ${plural(hubs[0].in, 'backlink')}.`
        : `No linked notes${where}.`;
      if (json) {
        return jsonResult({
          command,
          summary,
          scope: scope.label,
          count: hubs.length,
          more: found.length > limit,
          hubs,
        });
      }
      return [
        summary,
        '',
        `Most linked notes${where}:`,
        ...hubs.map(h => `- ${h.path}: ${h.in} in, ${h.out} out`),
        ...(found.length > limit ? ['More are available: raise limit.'] : []),
      ].join('\n');
    }
    const a = resolveStart(this.app, args.note, 'note');
    if ('error' in a) return a.error;
    const all = graph.related(a.path, 500).filter(r => scope.keep(r.path));
    const rel = all.slice(0, limit).map(r => ({ ...r, types: types(r.path) }));
    const summary = rel.length
      ? `${plural(all.length, 'note')}${where} share neighbours with ${noteName(a.path)}; the closest is ${noteName(rel[0].path)}.`
      : `No notes${where} share neighbours with ${noteName(a.path)}.`;
    if (json) {
      return jsonResult({
        command,
        summary,
        note: a.path,
        scope: scope.label,
        count: rel.length,
        more: all.length > limit,
        related: rel,
      });
    }
    return [
      summary,
      '',
      `Notes sharing neighbours with ${a.path}:`,
      ...rel.map(
        r =>
          `- ${r.path}: ${r.shared} shared (score ${r.score})${r.direct ? ' (also linked directly)' : ''}`,
      ),
      ...(all.length > limit ? ['More are available: raise limit.'] : []),
    ].join('\n');
  }

  private get folder(): string {
    return normalizePath(
      this.chat.plugin.settings.graph?.commandsFolder?.trim() || 'Agent graph commands',
    );
  }

  /** Saved commands: notes in the commands folder with a `command` property and a code block. */
  private saved(): Array<{ name: string; intent: string; file: TFile }> {
    const prefix = `${this.folder}/`;
    return this.app.vault
      .getMarkdownFiles()
      .filter(f => f.path.startsWith(prefix))
      .map(file => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        return {
          name: String(fm.command ?? file.basename),
          intent: String(fm.intent ?? ''),
          file,
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private help(json: boolean): string {
    const saved = this.saved();
    const commands = [
      {
        name: 'path',
        usage: 'note= to= depth= edge_types= max_hub_links=',
        does: 'shortest chain of links between two notes',
      },
      {
        name: 'hubs',
        usage: 'folder= tag= node_types= limit=',
        does: 'most-linked notes in a scope',
      },
      {
        name: 'related',
        usage: 'note= limit= folder= tag= node_types=',
        does: 'notes that share neighbours',
      },
      { name: 'run', usage: 'name= args={}', does: 'run a saved command' },
      {
        name: 'save',
        usage: 'name= intent= code=',
        does: 'keep a working code-mode script as a command',
      },
    ];
    const summary = `graph_cli has ${commands.length} commands and ${plural(saved.length, 'saved command')}.`;
    if (json) {
      return jsonResult({
        command: 'help',
        summary,
        commands,
        moved: Object.fromEntries(Object.entries(MOVED_COMMANDS).map(([k, v]) => [k, v.tool])),
        folder: this.folder,
        saved: saved.map(s => ({ name: s.name, intent: s.intent, path: s.file.path })),
      });
    }
    return [
      summary,
      '',
      'GRAPH CLI COMMANDS',
      ...commands.map(c => `- ${c.name} ${c.usage}: ${c.does}`),
      'Add format=json for data a script can use.',
      'Local graph and backlinks: traverse_graph. Node and relation types: vault_ontology.',
      '',
      saved.length
        ? `Saved commands (${this.folder}):\n${saved.map(s => `- ${s.name}: ${s.intent || 'no description'}`).join('\n')}`
        : `No saved commands yet (${this.folder}).`,
    ].join('\n');
  }

  private async runSaved(name: string, args: Record<string, unknown>): Promise<string> {
    if (!name.trim()) {
      return toolError('InvalidArgument', 'run needs the saved command name.', [
        'Call graph_cli with command "help" to list them.',
      ]);
    }
    const cmd = this.saved().find(s => s.name.toLowerCase() === name.trim().toLowerCase());
    if (!cmd) {
      return toolError('NotFound', `No saved command "${name}".`, [
        'Call graph_cli with command "help" to list them.',
      ]);
    }
    const text = await this.app.vault.cachedRead(cmd.file);
    const code = /```(?:js|javascript|ts|typescript)\s*\n([\s\S]*?)```/i.exec(text)?.[1];
    if (!code) {
      return toolError('InvalidCommand', `Saved command "${cmd.name}" has no js code block.`, [
        `Add a \`\`\`js block to ${cmd.file.path}.`,
      ]);
    }
    if (!this.registry.tools.some(t => t.name === 'codemode')) {
      return toolError('Unavailable', 'Saved commands need code mode, which is off in settings.', [
        'Turn code mode on, or use path, hubs or related.',
      ]);
    }
    return await this.registry.executeTool('codemode', {
      code: `const args = ${JSON.stringify(args)};\n${code}`,
    });
  }

  private async save(name: string, intent: string, code: string): Promise<string> {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug || !code.trim()) {
      return toolError('InvalidArgument', 'save needs a name and the code to keep.', [
        'Pass name, a one-line intent and code (a code-mode script that reads `args`).',
      ]);
    }
    if (this.saved().some(s => s.name === slug)) {
      return toolError('AlreadyExists', `A command named "${slug}" exists.`, [
        'Pick another name, or edit its note.',
      ]);
    }
    const body = [
      `# ${slug}`,
      '',
      intent || 'Saved graph command.',
      '',
      'Runs in code mode with `args`. Edit the code to harden it; keep one clear intent per command.',
      '',
      '```js',
      code.trim(),
      '```',
      '',
    ].join('\n');
    return await this.registry.executeTool('create_obsidian_note', {
      path: `${this.folder}/${slug}.md`,
      content: body,
      properties: { command: slug, intent, created: new Date().toISOString().slice(0, 10) },
    });
  }
}
