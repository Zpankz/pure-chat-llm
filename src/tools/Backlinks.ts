import { defineToolParameters, InferArgs, Tool } from '../tools';
import { normalizePath, TFile } from 'obsidian';
import { ToolOutputBuilder } from './ToolOutputBuilder';
import { resolveNote } from '../utils/vaultResolve';

const backlinksParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'The note: a path, its name, a [[wikilink]] or "active" for the note the user has open.',
    },
  },
  required: ['path'],
} as const);

export type BacklinksArgs = InferArgs<typeof backlinksParameters>;

/**
 *
 */
export class BacklinksTool extends Tool<BacklinksArgs> {
  readonly name = 'get_backlinks';
  readonly classification = 'Vault';
  readonly description =
    'Finds all notes that link to a specific note (backlinks), helping map relationships in the vault.';
  readonly parameters = backlinksParameters;

  /**
   *
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   *
   * @param args
   */
  async execute(args: BacklinksArgs): Promise<string> {
    const { path } = args;
    const app = this.chat.plugin.app;
    const resolved = resolveNote(app, path);
    if (!resolved.file && resolved.candidates.length) {
      return `Several notes match "${path}": ${resolved.candidates.map(f => f.path).join(', ')}. Call again with the full path.`;
    }
    const normalizedPath = resolved.file?.path ?? normalizePath(path);

    const targetFile = resolved.file;
    if (!targetFile || !(targetFile instanceof TFile)) {
      const parentDir = normalizedPath.split('/').slice(0, -1).join('/');
      const similarGlob = parentDir ? `${parentDir}/*.md` : '*.md';
      const listFolderPath = parentDir || '/';
      return new ToolOutputBuilder()
        .addError('FileNotFoundError', `No file exists at path "${normalizedPath}"`, [
          `glob_vault_files("${similarGlob}") - Search similar files`,
          `list_vault_folders("${listFolderPath}") - Explore directory`,
        ])
        .build();
    }

    void this.status(`Finding backlinks for "${normalizedPath}"...`);

    const backlinks: Array<{ path: string; count: number }> = [];
    const resolvedLinks = app.metadataCache.resolvedLinks;

    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[normalizedPath]) {
        backlinks.push({ path: sourcePath, count: links[normalizedPath] });
      }
    }

    if (backlinks.length === 0) {
      return new ToolOutputBuilder()
        .addHeader(`BACKLINKS FOR: "${normalizedPath}"`)
        .addKeyValue('Status', 'No backlinks found')
        .addSeparator()
        .addSuggestions(
          `traverse_graph("${normalizedPath}") - Follow its outgoing links and the wider local graph`,
          `search_vault("${targetFile.basename}") - Find plain-text mentions`,
          'This note is not linked from any other notes yet',
        )
        .build();
    }

    // Sort by link count (relationship strength)
    backlinks.sort((a, b) => b.count - a.count);

    const builder = new ToolOutputBuilder();
    builder.addHeader(`BACKLINKS FOR: "${normalizedPath}"`);
    builder.addKeyValue(
      'Total backlinks',
      `${backlinks.length} note${backlinks.length === 1 ? '' : 's'}`,
    );
    builder.addSeparator();

    // Show backlinks with relationship strength
    backlinks.forEach((backlink, idx) => {
      const strength = backlink.count > 5 ? '[***]' : backlink.count > 2 ? '[**-]' : '[*--]';
      builder.addKeyValue(
        `${idx + 1}. ${backlink.path}`,
        `${strength} (${backlink.count} link${backlink.count === 1 ? '' : 's'})`,
      );
    });

    builder.addSeparator();
    builder.addSuggestions(
      `read_file("${backlinks[0].path}") - View the strongest connection`,
      `search_vault("[[${targetFile.basename}]]") - See link contexts`,
    );

    return builder.build();
  }
}
