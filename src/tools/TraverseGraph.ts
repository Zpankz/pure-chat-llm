import { normalizePath, TFile } from 'obsidian';
import { ontologySummary, scopeFilter } from '../graph/ontology';
import { VaultGraph } from '../graph/VaultGraph';
import type { TraverseResult } from '../graph/VaultGraph';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { resolveNote } from '../utils/vaultResolve';

const scopeProperties = {
  folder: {
    type: 'string',
    description: 'Only keep notes inside this folder (path or bare name, such as "lo").',
  },
  tag: {
    type: 'string',
    description: 'Only keep notes with this tag (child tags count).',
  },
  node_types: {
    type: 'array',
    items: { type: 'string', description: 'Name.' },
    description: 'Only keep notes whose frontmatter `type` is one of these (see vault_ontology).',
  },
} as const;

const traverseParameters = defineToolParameters({
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description:
        'Start note: a path, its name, a [[wikilink]], or "active" for the note the user has open. Defaults to the active note.',
    },
    depth: {
      type: 'integer',
      description: 'Hops to follow from the start note, 1 to 6. Defaults to 2.',
      default: 2,
    },
    direction: {
      type: 'string',
      enum: ['both', 'out', 'in'],
      description: 'Follow outgoing links, backlinks, or both. Defaults to both.',
      default: 'both',
    },
    edge_types: {
      type: 'array',
      items: { type: 'string', description: 'Name.' },
      description:
        'Only follow these link types: frontmatter relation names from the ontology (such as concept, principle, up, related), "link" for body links, "embed" for embeds. Empty follows all.',
    },
    max_nodes: {
      type: 'integer',
      description: 'Stop after this many notes. Defaults to 60.',
      default: 60,
    },
    ...scopeProperties,
    include_unresolved: {
      type: 'boolean',
      description: 'Also list links to notes that do not exist yet. Defaults to true.',
      default: true,
    },
    format: {
      type: 'string',
      enum: ['text', 'json'],
      description: 'text for reading; json (nodes, edges, unresolved) for code-mode scripts.',
      default: 'text',
    },
  },
  required: [],
} as const);

export type TraverseGraphArgs = InferArgs<typeof traverseParameters>;

/**
 * Multi-hop traversal of the typed link graph from one note: breadth first over body links,
 * embeds and typed frontmatter relations, in either direction, to a set depth, with folder,
 * tag, node-type and edge-type filters.
 */
export class TraverseGraphTool extends Tool<TraverseGraphArgs> {
  readonly name = 'traverse_graph';
  readonly classification = 'Vault';
  readonly description =
    "Walks the vault's typed link graph from a note (outgoing links, backlinks and typed frontmatter relations, several hops) and returns its local graph: notes by distance with the relation each was reached by, hub notes and unresolved links. Filter by edge type, node type, folder or tag. Use it for connections, related notes, or a note's neighbourhood. format json returns data for scripts.";
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
    const { file, candidates } = resolveNote(app, args.note ?? 'active');
    if (!file) {
      return candidates.length
        ? `Several notes match "${args.note}": ${candidates.map(f => f.path).join(', ')}. Call again with the full path.`
        : `Error: no note found for "${args.note ?? 'active'}". Open a note or pass its path or name.`;
    }
    const graph = VaultGraph.for(app, this.chat.plugin.settings.graph?.typesFolder ?? '');
    const scope = scopeFilter(app, graph, {
      folder: args.folder,
      tag: args.tag,
      nodeTypes: args.node_types as string[] | undefined,
    });
    if (scope.error) return `Error: ${scope.error}`;
    void this.status(`Traversing links from "${file.path}"...`);
    const result = graph.traverse(file.path, {
      depth: args.depth ?? 2,
      direction: (args.direction as 'both' | 'out' | 'in' | undefined) ?? 'both',
      edgeTypes: (args.edge_types as string[] | undefined) ?? [],
      maxNodes: args.max_nodes ?? 60,
      keep: scope.keep,
    });
    if (args.format === 'json') return JSON.stringify(withTypes(graph, result));
    return formatTraversal(graph, result, {
      depth: args.depth ?? 2,
      direction: args.direction ?? 'both',
      scope: scope.label,
      edgeTypes: (args.edge_types as string[] | undefined) ?? [],
      unresolved: args.include_unresolved ?? true,
    });
  }
}

/**
 * Adds node types to a traversal for scripts.
 * @param graph - Vault graph.
 * @param r - Traversal.
 */
function withTypes(graph: VaultGraph, r: TraverseResult) {
  return {
    start: r.start,
    truncated: r.truncated,
    nodes: r.nodes.map(n => ({ ...n, types: graph.nodeTypes.get(n.path) ?? [] })),
    edges: r.edges,
    unresolved: r.unresolved,
  };
}

/**
 * Readable local graph.
 * @param graph - Vault graph.
 * @param r - Traversal.
 * @param o - What was asked.
 * @param o.depth - Depth.
 * @param o.direction - Direction.
 * @param o.scope - Scope label.
 * @param o.edgeTypes - Edge types followed.
 * @param o.unresolved - Whether to list unresolved links.
 */
function formatTraversal(
  graph: VaultGraph,
  r: TraverseResult,
  o: { depth: number; direction: string; scope: string; edgeTypes: string[]; unresolved: boolean },
): string {
  const typeOf = (p: string) => {
    const t = graph.nodeTypes.get(p);
    return t?.length ? ` [${t.join(', ')}]` : '';
  };
  const n = r.nodes.length - 1;
  const lines = [
    `LOCAL GRAPH OF: ${r.start}${typeOf(r.start)}`,
    `Depth ${o.depth}, direction ${o.direction}${o.edgeTypes.length ? `, following ${o.edgeTypes.join(', ')}` : ''}${o.scope ? `, notes ${o.scope}` : ''}: ${n} connected note${n === 1 ? '' : 's'}, ${r.edges.length} link${r.edges.length === 1 ? '' : 's'} among them${r.truncated ? ' (stopped at the note limit)' : ''}.`,
  ];
  const outs = graph.out.get(r.start)?.length ?? 0;
  const ins = graph.in.get(r.start)?.length ?? 0;
  lines.push(
    `Start note: ${outs} outgoing link${outs === 1 ? '' : 's'}, ${ins} backlink${ins === 1 ? '' : 's'}.`,
  );
  const maxHop = Math.max(0, ...r.nodes.map(x => x.hop));
  for (let hop = 1; hop <= maxHop; hop++) {
    const at = r.nodes.filter(x => x.hop === hop);
    if (!at.length) continue;
    lines.push('', `Hop ${hop} (${at.length}):`);
    for (const x of at) {
      const [dir, type] = x.via.split(':');
      const how = dir === 'out' ? `${type} from ${x.parent}` : `${type} to ${x.parent}`;
      lines.push(`- ${x.path}${typeOf(x.path)} (${dir === 'out' ? '→' : '←'} ${how})`);
    }
  }
  const degree = new Map<string, number>();
  for (const e of r.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const hubs = [...degree.entries()]
    .filter(([p, d]) => p !== r.start && d > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (hubs.length) {
    lines.push('', 'Best connected in this graph:');
    for (const [p, d] of hubs) lines.push(`- ${p}: ${d} links`);
  }
  if (o.unresolved && r.unresolved.length) {
    const names = [...new Set(r.unresolved.map(u => u.name))].slice(0, 30);
    lines.push('', `Links to notes that don't exist yet: ${names.join(', ')}`);
  }
  if (n === 0) {
    lines.push(
      '',
      o.edgeTypes.length || o.scope
        ? 'Nothing matched the filters. Try without edge_types or the folder, tag or type filter.'
        : 'No linked notes. Try search_vault for its title to find plain-text mentions, or list_vault_folders on its folder.',
    );
  }
  return lines.join('\n');
}

const ontologyParameters = defineToolParameters({
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: ['text', 'json'],
      description: 'text for reading; json for scripts.',
      default: 'text',
    },
  },
  required: [],
} as const);

export type VaultOntologyArgs = InferArgs<typeof ontologyParameters>;

/** The vault's typed ontology: declared and used node types, edge types, tags and properties. */
export class VaultOntologyTool extends Tool<VaultOntologyArgs> {
  readonly name = 'vault_ontology';
  readonly classification = 'Vault';
  readonly description =
    "Describes the vault's typed ontology: node types (frontmatter type), edge types (typed frontmatter relations) with their domain, range and meaning from Typed Graph schema notes, how often each is used, tags and properties. Read it before traversing or writing typed notes.";
  readonly parameters = ontologyParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: VaultOntologyArgs): Promise<string> {
    const graph = VaultGraph.for(
      this.chat.plugin.app,
      this.chat.plugin.settings.graph?.typesFolder ?? '',
    );
    if (args.format === 'json') {
      return JSON.stringify({
        notes: graph.paths.length,
        schemaNotes: graph.schema.sources,
        nodeTypes: [...graph.schema.nodeTypes.values()],
        edgeTypes: [...graph.schema.edgeTypes.values()],
        nodeTypesUsed: graph.typeCounts(),
        edgeTypesUsed: graph.edgeTypes().map(e => ({ type: e.type, count: e.count })),
        tags: graph.tagCounts().slice(0, 100),
      });
    }
    return ontologySummary(graph);
  }
}

const cliParameters = defineToolParameters({
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'help (list commands), ontology, traverse, path, hubs, related, run (a saved command), save (promote a script to a command).',
    },
    note: { type: 'string', description: 'Note for traverse, related, path (start).' },
    to: { type: 'string', description: 'Target note for path.' },
    depth: { type: 'integer', description: 'Hops for traverse (default 2) or path (default 6).' },
    direction: {
      type: 'string',
      enum: ['both', 'out', 'in'],
      description: 'Link direction for traverse.',
    },
    edge_types: {
      type: 'array',
      items: { type: 'string', description: 'Edge type.' },
      description: 'Only follow these edge types.',
    },
    ...scopeProperties,
    limit: { type: 'integer', description: 'Results to return (default 15).' },
    max_hub_links: {
      type: 'integer',
      description:
        'For path: skip notes with more links than this (index notes), default 150; 0 allows any.',
    },
    name: { type: 'string', description: 'Saved command name for run or save.' },
    args: { type: 'object', description: 'Arguments passed to a saved command as `args`.' },
    intent: { type: 'string', description: 'For save: what the command is for, in one line.' },
    code: {
      type: 'string',
      description:
        'For save: code-mode JavaScript that receives `args` and calls tools (such as tools.graph_cli with format json).',
    },
    format: {
      type: 'string',
      enum: ['text', 'json'],
      default: 'text',
      description: 'text for reading; json for scripts.',
    },
  },
  required: ['command'],
} as const);

export type GraphCliArgs = InferArgs<typeof cliParameters>;

/**
 * The graph CLI: single-intent, deterministic commands over the typed graph, plus saved commands
 * (code-mode scripts kept as notes) so useful traversals can be promoted, hardened and reused.
 */
export class GraphCliTool extends Tool<GraphCliArgs> {
  readonly name = 'graph_cli';
  readonly classification = 'Vault';
  readonly description =
    'Graph command line for the typed vault graph. Built-in commands: traverse (local graph), path (shortest chain of links between two notes), hubs (most-linked notes in a folder, tag or type), related (notes sharing neighbours), ontology. Saved commands are scripts kept as notes: run one by name, or save a script that worked so it becomes a reusable command. Call with command "help" first.';
  readonly parameters = cliParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /** @param args - Tool arguments. */
  async execute(args: GraphCliArgs): Promise<string> {
    const plugin = this.chat.plugin;
    const app = plugin.app;
    const graph = VaultGraph.for(app, plugin.settings.graph?.typesFolder ?? '');
    const json = args.format === 'json';
    const limit = Math.min(100, Math.max(1, args.limit ?? 15));
    const scope = scopeFilter(app, graph, {
      folder: args.folder,
      tag: args.tag,
      nodeTypes: args.node_types as string[] | undefined,
    });
    if (scope.error) return `Error: ${scope.error}`;
    const note = (ref: string | undefined) => {
      const r = resolveNote(app, ref ?? 'active');
      if (r.file) return { path: r.file.path };
      return {
        error: r.candidates.length
          ? `Several notes match "${ref}": ${r.candidates.map(f => f.path).join(', ')}.`
          : `No note found for "${ref ?? 'active'}".`,
      };
    };
    const types = (p: string) => graph.nodeTypes.get(p) ?? [];

    switch ((args.command ?? 'help').trim().toLowerCase()) {
      case 'help':
        return this.help();
      case 'ontology':
        return json
          ? await this.registry.executeTool('vault_ontology', { format: 'json' })
          : ontologySummary(graph);
      case 'traverse':
        return await this.registry.executeTool('traverse_graph', {
          note: args.note,
          depth: args.depth,
          direction: args.direction,
          edge_types: args.edge_types,
          folder: args.folder,
          tag: args.tag,
          node_types: args.node_types,
          max_nodes: args.limit,
          format: args.format,
        });
      case 'path': {
        const a = note(args.note);
        const b = note(args.to);
        if ('error' in a) return `Error: ${a.error}`;
        if ('error' in b) return `Error: ${b.error}`;
        const chain = graph.path(
          a.path,
          b.path,
          Math.min(8, args.depth ?? 6),
          (args.edge_types as string[] | undefined) ?? [],
          args.max_hub_links ?? 150,
        );
        if (json) return JSON.stringify(chain);
        if (!chain) return `No chain of links within ${args.depth ?? 6} hops.`;
        return chain
          .map((n, i) =>
            i === 0
              ? n.path
              : `  ${n.via.startsWith('out') ? '→' : '←'} ${n.via.split(':')[1]} → ${n.path}`,
          )
          .join('\n');
      }
      case 'hubs': {
        const hubs = graph.hubs(scope.keep, limit).map(h => ({ ...h, types: types(h.path) }));
        if (json) return JSON.stringify(hubs);
        return [
          `Most linked notes${scope.label ? ` ${scope.label}` : ''}:`,
          ...hubs.map(h => `- ${h.path}: ${h.in} in, ${h.out} out`),
        ].join('\n');
      }
      case 'related': {
        const a = note(args.note);
        if ('error' in a) return `Error: ${a.error}`;
        const rel = graph
          .related(a.path, 200)
          .filter(r => scope.keep(r.path))
          .slice(0, limit)
          .map(r => ({ ...r, types: types(r.path) }));
        if (json) return JSON.stringify(rel);
        return [
          `Notes sharing neighbours with ${a.path}:`,
          ...rel.map(
            r =>
              `- ${r.path}: ${r.shared} shared (score ${r.score})${r.direct ? ' (also linked directly)' : ''}`,
          ),
        ].join('\n');
      }
      case 'run':
        return await this.runSaved(args.name ?? '', (args.args as Record<string, unknown>) ?? {});
      case 'save':
        return await this.save(args.name ?? '', args.intent ?? '', args.code ?? '');
      default:
        return `Unknown command "${args.command}". ${this.help()}`;
    }
  }

  private get folder(): string {
    return normalizePath(
      this.chat.plugin.settings.graph?.commandsFolder?.trim() || 'Agent graph commands',
    );
  }

  /** Saved commands: notes in the commands folder with a `command` property and a code block. */
  private saved(): Array<{ name: string; intent: string; file: TFile }> {
    const app = this.chat.plugin.app;
    const prefix = `${this.folder}/`;
    return app.vault
      .getMarkdownFiles()
      .filter(f => f.path.startsWith(prefix))
      .map(file => {
        const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        return {
          name: String(fm.command ?? file.basename),
          intent: String(fm.intent ?? ''),
          file,
        };
      });
  }

  private help(): string {
    const saved = this.saved();
    return [
      'GRAPH CLI COMMANDS',
      '- traverse note= depth= direction= edge_types= folder= tag= node_types=: local graph',
      '- path note= to= depth= edge_types=: shortest chain of links between two notes',
      '- hubs folder= tag= node_types= limit=: most-linked notes in a scope',
      '- related note= limit= (scope filters): notes that share neighbours',
      '- ontology: node and edge types of this vault',
      '- run name= args={}: run a saved command',
      '- save name= intent= code=: keep a working code-mode script as a command',
      'Add format=json for data a script can use.',
      '',
      saved.length
        ? `Saved commands (${this.folder}):\n${saved.map(s => `- ${s.name}: ${s.intent || 'no description'}`).join('\n')}`
        : `No saved commands yet (${this.folder}).`,
    ].join('\n');
  }

  private async runSaved(name: string, args: Record<string, unknown>): Promise<string> {
    const cmd = this.saved().find(s => s.name.toLowerCase() === name.trim().toLowerCase());
    if (!cmd) return `No saved command "${name}". Call graph_cli with command "help".`;
    const text = await this.chat.plugin.app.vault.cachedRead(cmd.file);
    const code = /```(?:js|javascript|ts|typescript)\s*\n([\s\S]*?)```/i.exec(text)?.[1];
    if (!code) return `Saved command "${name}" has no js code block.`;
    if (!this.registry.tools.some(t => t.name === 'codemode'))
      return 'Saved commands need code mode, which is off in settings.';
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
    if (!slug || !code.trim()) return 'Give a name and the code to save.';
    if (this.saved().some(s => s.name === slug))
      return `A command named "${slug}" exists. Pick another name or edit its note.`;
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
