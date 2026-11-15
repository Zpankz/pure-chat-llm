import { App, parseLinktext } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import {
  FOLDER_SCOPE_PARAMETERS,
  folderScope,
  parentPath,
  pathInFolders,
} from '../utils/vaultResolve';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

// The parts of the Smart Connections plugin's API this tool relies on. It is another plugin's
// internal API, so every step is checked and failures come back as tool errors.
interface SmartItem {
  data?: {
    lines?: number[];
  };
}

interface SmartResult {
  key: string;
  score: number;
  item: SmartItem;
}

interface LookupOptions {
  hypotheticals: string[];
  filter?: {
    limit?: number;
    [key: string]: unknown;
  };
}

interface SmartCollection {
  lookup(options: LookupOptions | string): Promise<SmartResult[]> | SmartResult[];
}

interface SmartEnv {
  smart_blocks: SmartCollection;
  smart_sources: SmartCollection;
}

interface SmartConnectionsPlugin {
  env: SmartEnv;
  smart_env?: SmartEnv;
}

interface AppWithPlugins extends App {
  plugins: {
    getPlugin(id: string): SmartConnectionsPlugin | undefined | null;
  };
}

const smartConnectionsParameters = defineToolParameters({
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'What to find, in plain words; a question or a concept works (e.g. "my notes on resilience").',
    },
    limit: {
      type: 'integer',
      description: 'Number of results, 1 to 20. Defaults to 5.',
      default: 5,
    },
    type: {
      type: 'string',
      description:
        '"blocks" for passages (default, best for answering questions) or "sources" for whole notes.',
      enum: ['blocks', 'sources'],
      default: 'blocks',
    },
    ...FOLDER_SCOPE_PARAMETERS,
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['query'],
} as const);

export type SmartConnectionsArgs = InferArgs<typeof smartConnectionsParameters>;

/** Longest passage returned per result. */
const RESULT_CHARS = 1500;

/**
 * Semantic search through the Smart Connections plugin's embeddings index.
 */
export class SmartConnectionsRetrievalTool extends Tool<SmartConnectionsArgs> {
  readonly name = 'smart_connections_rag';
  readonly classification = 'AI';
  readonly description =
    "Finds notes and passages by meaning, using the Smart Connections plugin's embeddings, so it works when the words differ from the note's words. Use it for open questions or concepts; use search_vault for exact words or names, and traverse_graph for links. Can be limited to one folder. Only available when Smart Connections is installed. format json returns {query, type, folders, recursive, results:[{key, path, folder, score, content}]}.";
  readonly parameters = smartConnectionsParameters;

  /** Available when the Smart Connections plugin is loaded with its environment. */
  isAvailable(): boolean {
    const app = this.chat.plugin.app as AppWithPlugins;
    const plugin = app.plugins?.getPlugin('smart-connections');
    return !!plugin && (!!plugin.env || !!plugin.smart_env);
  }

  /**
   * Runs the lookup.
   * @param args - Tool arguments.
   */
  async execute(args: SmartConnectionsArgs): Promise<string> {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return toolError('InvalidArgument', 'query is empty.', ['Pass what to look for.']);
    }
    const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 5)));
    const type = args.type === 'sources' ? 'sources' : 'blocks';
    const app = this.chat.plugin.app as AppWithPlugins;
    const plugin = app.plugins?.getPlugin('smart-connections');
    const fallback = [`search_vault(query="${query}") searches by words instead.`];

    if (!plugin) {
      return toolError('Unavailable', 'The Smart Connections plugin is not loaded.', fallback);
    }
    const env = plugin.env || plugin.smart_env;
    if (!env) {
      return toolError('NotReady', 'Smart Connections has not finished loading its index.', [
        'Wait a moment and try again.',
        ...fallback,
      ]);
    }
    const collection = type === 'sources' ? env.smart_sources : env.smart_blocks;
    if (!collection || typeof collection.lookup !== 'function') {
      return toolError('Unavailable', `Smart Connections has no ${type} collection.`, [
        `Try type="${type === 'sources' ? 'blocks' : 'sources'}".`,
        ...fallback,
      ]);
    }

    const scope = folderScope(app, args.folder);
    if (scope.error) return scope.error;
    const recursive = args.recursive !== false;
    const folderPaths = scope.folders?.map(f => (f.isRoot() ? '/' : f.path)) ?? null;

    void this.status(
      `Searching Smart Connections (${type}) for "${query}"${folderPaths ? ` in ${folderPaths.join(', ')}` : ''}...`,
    );

    let results: SmartResult[];
    try {
      // The index has no folder filter here, so ask for more and keep those inside the folder.
      const want = scope.folders ? Math.min(100, limit * 5) : limit;
      const raw = await collection.lookup({ hypotheticals: [query], filter: { limit: want } });
      results = (Array.isArray(raw) ? raw : []).filter(r => r && typeof r.key === 'string');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('SearchFailed', `Smart Connections lookup failed: ${message}`, fallback);
    }
    if (scope.folders) {
      const folders = scope.folders;
      results = results.filter(r => pathInFolders(parseLinktext(r.key).path, folders, recursive));
    }
    results = results.slice(0, limit);

    const rows = await Promise.all(
      results.map(async r => {
        const path = parseLinktext(r.key).path;
        const content = await this.passage(app, path, r.item?.data?.lines, type);
        return {
          key: r.key,
          path,
          folder: parentPath(path) || '/',
          score: Math.round((r.score || 0) * 1000) / 1000,
          content,
        };
      }),
    );

    if (wantsJson(args)) {
      return jsonResult({ query, type, folders: folderPaths, recursive, results: rows });
    }

    const where = folderPaths ? ` in ${folderPaths.join(', ')}` : '';
    if (!rows.length) {
      return `No ${type} found by meaning for "${query}"${where}. ${fallback[0]}`;
    }
    const out = [
      `Found ${rows.length} ${type === 'sources' ? 'note' : 'passage'}${rows.length === 1 ? '' : 's'} related to "${query}"${where}; best match ${rows[0].path}.`,
    ];
    rows.forEach((r, i) => {
      out.push(
        '',
        `[${i + 1}] ${r.key} (similarity ${Math.round(r.score * 100)}%)`,
        r.content || '[No text: open the note with read_file.]',
      );
    });
    out.push('', `Next: read_file(path="${rows[0].path}") reads the best match in full.`);
    return out.join('\n');
  }

  /**
   * The text a result points at, capped. `lines` is either [start, end] (1-based) or a list of
   * line numbers; for whole sources with no lines, the start of the note.
   * @param app - Obsidian app.
   * @param path - Note path.
   * @param lines - Line numbers from Smart Connections.
   * @param type - Collection type.
   */
  private async passage(
    app: AppWithPlugins,
    path: string,
    lines: number[] | undefined,
    type: string,
  ): Promise<string> {
    try {
      const file = app.vault.getFileByPath(path);
      if (!file) return '';
      const text = (await app.vault.cachedRead(file)).split('\n');
      let picked: string[] = [];
      if (Array.isArray(lines) && lines.length) {
        if (lines.length === 2 && lines[1] >= lines[0]) {
          picked = text.slice(Math.max(0, lines[0] - 1), Math.min(text.length, lines[1]));
        } else {
          picked = lines.map(n => text[n - 1] ?? '');
        }
      } else if (type === 'sources') {
        picked = text;
      }
      const joined = picked.join('\n').trim();
      return joined.length > RESULT_CHARS ? `${joined.slice(0, RESULT_CHARS)}…` : joined;
    } catch (e) {
      console.warn(`smart_connections_rag: could not read ${path}`, e);
      return '';
    }
  }
}
