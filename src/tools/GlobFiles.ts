import GlobToRegExp from 'glob-to-regexp';
import type { TFile } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FOLDER_SCOPE_PARAMETERS, folderScope, inFolders, parentPath } from '../utils/vaultResolve';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

const globFilesParameters = defineToolParameters({
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Glob over vault paths, ignoring case: * matches within a folder, ** across folders. Examples: "**/LO/*.md" (notes in any LO folder), "Daily/2025-*.md", "**/*.pdf". A pattern without a folder ("*meeting*") also searches all folders. With folder set, the pattern applies to paths below that folder.',
    },
    include_fields: {
      type: 'array',
      items: {
        type: 'string',
        description: 'Field name.',
        enum: ['path', 'name', 'extension', 'size', 'mtime'],
      },
      description: 'Fields to return for each file. Defaults to just the path.',
    },
    ...FOLDER_SCOPE_PARAMETERS,
    limit: {
      type: 'integer',
      description: 'Most files to return, 1 to 1000. Defaults to 100.',
      default: 100,
    },
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['pattern'],
} as const);

export type GlobFilesArgs = InferArgs<typeof globFilesParameters>;

type Field = 'path' | 'name' | 'extension' | 'size' | 'mtime';
const FIELDS: Field[] = ['path', 'name', 'extension', 'size', 'mtime'];

/**
 * Lists vault files whose path matches a glob pattern.
 */
export class GlobFilesTool extends Tool<GlobFilesArgs> {
  readonly name = 'glob_vault_files';
  readonly classification = 'Vault';
  readonly description =
    'Lists files whose path matches a glob pattern, such as "**/LO/*.md" or "**/*.pdf", optionally inside one folder (subfolders included unless recursive is false). Use it to find files by name, extension or path shape, including attachments; it never reads contents. Use search_vault to find notes by what they say, and list_vault_folders to see one folder\'s notes and subfolders. format json returns {pattern, folders, recursive, total, truncated, files:[{path, folder, ...fields}]}.';
  readonly parameters = globFilesParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Matches the pattern against every file path.
   * @param args - Tool arguments.
   */
  async execute(args: GlobFilesArgs): Promise<string> {
    const raw = String(args.pattern ?? '').trim();
    const pattern = raw.replace(/^\/+/, '');
    if (!pattern) {
      return toolError('InvalidArgument', 'pattern is empty.', [
        'Pass a glob such as "**/*.md" or "**/LO/*".',
      ]);
    }
    const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 100)));
    const requested = ((args.include_fields as string[] | undefined) ?? []).filter(
      (f): f is Field => (FIELDS as string[]).includes(f),
    );
    const fields: Field[] = ['path', ...requested.filter(f => f !== 'path')];
    const app = this.chat.plugin.app;
    const scope = folderScope(app, args.folder);
    if (scope.error) return scope.error;
    const recursive = args.recursive !== false;
    const folderPaths = scope.folders?.map(f => (f.isRoot() ? '/' : f.path)) ?? null;
    let files = app.vault.getFiles();
    if (scope.folders) {
      const folders = scope.folders;
      files = files.filter(f => inFolders(f, folders, recursive));
    }
    // Inside a folder the pattern is matched against the path below that folder.
    const relative = (f: TFile): string => {
      if (!scope.folders) return f.path;
      const base = scope.folders.find(d => d.isRoot() || f.path.startsWith(`${d.path}/`));
      return !base || base.isRoot() ? f.path : f.path.slice(base.path.length + 1);
    };

    void this.status(
      `Finding files matching "${pattern}"${folderPaths ? ` in ${folderPaths.join(', ')}` : ''}...`,
    );

    let matched: TFile[];
    let used = pattern;
    try {
      const test = (p: string) => {
        const re = GlobToRegExp(p, { globstar: true, flags: 'i' });
        return files.filter(f => re.test(relative(f)));
      };
      // "*meeting*" means any folder to most callers; glob alone would look at the top only.
      if (scope.folders && recursive && !pattern.includes('/')) used = `**/${pattern}`;
      matched = test(used);
      if (!matched.length && !scope.folders && !pattern.includes('/')) {
        used = `**/${pattern}`;
        matched = test(used);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError('InvalidPattern', `"${raw}" is not a valid glob: ${message}`, [
        'Use * within a folder and ** across folders, for example "**/*.md".',
      ]);
    }
    matched.sort((a, b) => a.path.localeCompare(b.path));
    const shown = matched.slice(0, limit);
    const truncated = matched.length > shown.length;

    if (wantsJson(args)) {
      return jsonResult({
        pattern: used,
        folders: folderPaths,
        recursive,
        total: matched.length,
        truncated,
        files: shown.map(f => {
          const row: Record<string, unknown> = { path: f.path, folder: parentPath(f.path) || '/' };
          for (const field of fields) row[field] = value(f, field);
          return row;
        }),
      });
    }

    const where = folderPaths
      ? ` in ${folderPaths.join(', ')}${recursive ? '' : ' (top level only)'}`
      : '';
    if (!shown.length) {
      return [
        `No files match "${raw}"${where}.`,
        `Searched ${files.length} files. Use ** for any depth ("**/name*"), search_vault for note text, or list_vault_folders to browse.`,
      ].join('\n');
    }
    const out = [
      `Found ${matched.length} file${matched.length === 1 ? '' : 's'} matching "${used}"${where}${truncated ? `, showing the first ${shown.length}` : ''}.`,
    ];
    if (used !== pattern && !scope.folders)
      out.push(`(No file matched at the vault root, so all folders were searched.)`);
    out.push('---');
    for (const f of shown) {
      const extra = fields
        .filter(field => field !== 'path')
        .map(field => `${field}: ${display(f, field)}`);
      out.push(extra.length ? `${f.path}  (${extra.join(', ')})` : f.path);
    }
    out.push('---');
    if (truncated) out.push(`More files match: raise limit (now ${limit}) or narrow the pattern.`);
    out.push(`Next: read_file(path="${shown[0].path}") reads a file.`);
    return out.join('\n');
  }
}

/**
 * JSON value of a field.
 * @param f - File.
 * @param field - Field.
 */
function value(f: TFile, field: Field): string | number {
  switch (field) {
    case 'path':
      return f.path;
    case 'name':
      return f.name;
    case 'extension':
      return f.extension;
    case 'size':
      return f.stat.size;
    case 'mtime':
      return f.stat.mtime;
  }
}

/**
 * Text value of a field.
 * @param f - File.
 * @param field - Field.
 */
function display(f: TFile, field: Field): string {
  if (field === 'size') {
    const b = f.stat.size;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (field === 'mtime') return new Date(f.stat.mtime).toISOString().slice(0, 16).replace('T', ' ');
  return String(value(f, field));
}
