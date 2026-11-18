import type { TFile } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { BooleanSearchParser, ParsedQuery } from '../utils/BooleanSearchParser';
import {
  FOLDER_SCOPE_PARAMETERS,
  folderScope,
  inFolders,
  isFolderNote,
  parentPath,
} from '../utils/vaultResolve';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

const searchVaultParameters = defineToolParameters({
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Words or a phrase to find, or a boolean expression with AND, OR, NOT and "quoted phrases" (example: life story OR escape AND trauma). Matching ignores case.',
    },
    ...FOLDER_SCOPE_PARAMETERS,
    regex: {
      type: 'boolean',
      description: 'Treat query as a regular expression. Defaults to false.',
      default: false,
    },
    limit: {
      type: 'integer',
      description: 'Most matching lines to return (not notes), 1 to 100. Defaults to 20.',
      default: 20,
    },
    context_lines: {
      type: 'integer',
      description: 'Lines of context around each match, 0 to 5. Defaults to 1.',
      default: 1,
    },
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: ['query'],
} as const);

export type SearchVaultArgs = InferArgs<typeof searchVaultParameters>;

/** Longest line kept in a snippet. */
const SNIPPET_LINE_CHARS = 300;
/** Most title or path hits listed. */
const TITLE_HITS = 10;

interface Match {
  path: string;
  /** Folder the note sits in ("/" at the root). */
  folder: string;
  /** 1-based line number, for people. */
  line: number;
  /** 0-based line, as read_file's offset takes it. */
  offset: number;
  snippet: string;
}

/**
 * Full-text search over note contents, titles and paths, optionally inside one folder.
 */
export class SearchVaultTool extends Tool<SearchVaultArgs> {
  readonly name = 'search_vault';
  readonly classification = 'Vault';
  readonly description =
    'Searches the text of notes for words or a phrase, and lists notes whose title or path contains them. Supports AND, OR, NOT, "quoted phrases" and regex, and can be limited to one folder by name or path (subfolders included unless recursive is false). A phrase with no exact hits is retried as all of its words. Title hits list the note named exactly so and folder notes (X/X.md) first. Use it to find what notes say or to find a note by name; use list_vault_folders to list a folder\'s notes, glob_vault_files for paths by pattern, and smart_connections_rag for meaning rather than words. format json returns {query, mode, folders, recursive, files_searched, title_matches, title_matches_total, matches:[{path, folder, line (1-based), offset (0-based, for read_file), snippet}], notes_matched, truncated}.';
  readonly parameters = searchVaultParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Runs the search: one read per note.
   * @param args - Tool arguments.
   */
  async execute(args: SearchVaultArgs): Promise<string> {
    const query = String(args.query ?? '').trim();
    const app = this.chat.plugin.app;
    if (!query) {
      return toolError('InvalidArgument', 'query is empty.', ['Pass the words to search for.']);
    }
    const regex = args.regex === true;
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 20)));
    const contextLines = Math.max(0, Math.min(5, Math.floor(args.context_lines ?? 1)));

    let files = app.vault.getMarkdownFiles();
    const scope = folderScope(app, args.folder);
    if (scope.error) return scope.error;
    const folderPaths = scope.folders?.map(f => f.path) ?? null;
    const recursive = args.recursive !== false;
    if (scope.folders) {
      const folders = scope.folders;
      files = files.filter(f => inFolders(f, folders, recursive));
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    // Matchers for the query as given, and for "all of its words" (the phrase fallback).
    let pattern: RegExp | null = null;
    if (regex) {
      try {
        pattern = new RegExp(query, 'i');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(
          'InvalidRegex',
          `"${query}" is not a valid regular expression: ${message}`,
          ['Fix the pattern, or call again with regex=false to search for the words.'],
        );
      }
    }
    let parsed: ParsedQuery | null = null;
    if (!regex && BooleanSearchParser.isBooleanQuery(query)) {
      try {
        parsed = BooleanSearchParser.parse(query);
      } catch {
        parsed = null;
      }
    }
    const lower = query.toLowerCase();
    const words = lower
      .replace(/\b(and|or|not)\b|[()"]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const matches = (text: string): boolean =>
      pattern
        ? pattern.test(text)
        : parsed
          ? BooleanSearchParser.evaluate(parsed, text)
          : text.toLowerCase().includes(lower);
    const allWords = (text: string): boolean => {
      const t = text.toLowerCase();
      return words.every(w => t.includes(w));
    };
    const anyWord = (text: string): boolean => {
      const t = text.toLowerCase();
      return words.some(w => t.includes(w));
    };
    // A plain phrase of several words that never appears is retried as all of its words. Both
    // are checked in the same pass, so each note is read once.
    const phraseFallback = !regex && !parsed && words.length > 1;

    void this.status(
      `Searching ${folderPaths ? `${folderPaths.join(', ')} ` : 'the vault '}for "${query}"...`,
    );

    const titleHits: TFile[] = [];
    const primary: Match[] = [];
    const fallback: Match[] = [];
    const primaryNotes = new Set<string>();
    const fallbackNotes = new Set<string>();
    let phraseInPath = false;
    let truncated = false;

    for (const file of files) {
      const path = file.path.toLowerCase();
      if (!regex && words.length && words.every(w => path.includes(w))) titleHits.push(file);
      if (phraseFallback && path.includes(lower)) phraseInPath = true;

      const wantPrimary = primary.length < limit;
      const wantFallback =
        phraseFallback && !primary.length && !phraseInPath && fallback.length < limit;
      if (!wantPrimary && !wantFallback) {
        if (primary.length >= limit) truncated = true;
        continue;
      }

      let content: string;
      try {
        content = await app.vault.cachedRead(file);
      } catch (e) {
        console.error(`search_vault: could not read ${file.path}`, e);
        continue;
      }
      if (wantPrimary && matches(content)) {
        primaryNotes.add(file.path);
        if (this.collect(file, content, matches, anyWord, primary, limit, contextLines))
          truncated = true;
      } else if (wantFallback && allWords(content)) {
        fallbackNotes.add(file.path);
        this.collect(file, content, allWords, anyWord, fallback, limit, contextLines);
      }
    }

    // Title or path hits, best first: the note named exactly so, then folder notes (X/X.md, the
    // overview of a folder whose name matched), then shallower paths.
    const rank = (f: TFile) =>
      (f.basename.toLowerCase() === lower ? 0 : 4) +
      (isFolderNote(f) ? 0 : 2) +
      (words.every(w => f.basename.toLowerCase().includes(w)) ? 0 : 1);
    const titleMatches = titleHits
      .map(f => ({ f, r: rank(f), depth: f.path.split('/').length }))
      .sort((a, b) => a.r - b.r || a.depth - b.depth || a.f.path.localeCompare(b.f.path))
      .slice(0, TITLE_HITS)
      .map(x => x.f.path);

    const usedFallback = phraseFallback && !primary.length && !phraseInPath && fallback.length > 0;
    const results = usedFallback ? fallback : primary;
    const notesMatched = (usedFallback ? fallbackNotes : primaryNotes).size;
    // Truncated: the limit was reached with lines or notes left unread.
    if (usedFallback) truncated = fallback.length >= limit;
    else if (primary.length < limit) truncated = false;
    const mode = regex
      ? 'regex'
      : parsed
        ? 'boolean'
        : usedFallback
          ? 'all_words'
          : words.length > 1
            ? 'phrase'
            : 'text';

    if (wantsJson(args)) {
      return jsonResult({
        query,
        mode,
        folders: folderPaths,
        recursive,
        files_searched: files.length,
        title_matches: titleMatches,
        title_matches_total: titleHits.length,
        matches: results,
        notes_matched: notesMatched,
        truncated,
      });
    }

    const where = folderPaths
      ? ` in ${folderPaths.length === 1 ? `folder "${folderPaths[0]}"` : `${folderPaths.length} folders (${folderPaths.join(', ')})`}${recursive ? '' : ' (top level only)'}`
      : '';
    const out: string[] = [];
    if (!results.length) {
      out.push(
        titleMatches.length
          ? `No text matches for "${query}"${where}, but ${titleMatches.length} note${titleMatches.length === 1 ? '' : 's'} have it in their title or path.`
          : `No matches for "${query}"${where} in ${files.length} notes.`,
      );
    } else {
      out.push(
        `Found ${results.length}${truncated ? '+' : ''} match${results.length === 1 ? '' : 'es'} in ${notesMatched} note${notesMatched === 1 ? '' : 's'} for "${query}"${where}${usedFallback ? ' (no exact phrase, so notes with all of its words)' : ''}.`,
      );
    }
    out.push(`Searched ${files.length} notes.`);
    if (titleMatches.length) {
      out.push(
        `Notes whose title or path matches${titleHits.length > titleMatches.length ? ` (first ${titleMatches.length} of ${titleHits.length})` : ''}: ${titleMatches.join(', ')}`,
      );
    }
    results.forEach((m, i) => out.push('', `[${i + 1}] ${m.path} (line ${m.line})`, m.snippet));
    out.push('');
    if (truncated) {
      out.push(`More matches may exist: raise limit (now ${limit}) or narrow the query.`);
    }
    if (results.length || titleMatches.length) {
      out.push(`Next: read_file(path="${results[0]?.path ?? titleMatches[0]}") reads a note.`);
    } else {
      out.push(
        "Next: try other words or OR between synonyms; list_vault_folders(path) lists a folder's notes; smart_connections_rag searches by meaning.",
      );
    }
    return out.join('\n').trimEnd();
  }

  /**
   * Adds a note's matching lines to `bucket`. A note that matches as a whole but on no single
   * line (AND across lines) gets one snippet at the first line with any query word.
   * @returns true when the bucket filled before the note's lines ran out.
   */
  private collect(
    file: TFile,
    content: string,
    lineMatches: (line: string) => boolean,
    anyWord: (line: string) => boolean,
    bucket: Match[],
    limit: number,
    contextLines: number,
  ): boolean {
    const lines = content.split('\n');
    const snippet = (i: number): string => {
      const from = Math.max(0, i - contextLines);
      const to = Math.min(lines.length - 1, i + contextLines);
      return lines
        .slice(from, to + 1)
        .map((l, k) => {
          const text = l.length > SNIPPET_LINE_CHARS ? `${l.slice(0, SNIPPET_LINE_CHARS)}…` : l;
          return `${from + k === i ? '>' : ' '} ${text}`;
        })
        .join('\n');
    };
    let added = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lineMatches(lines[i])) continue;
      if (bucket.length >= limit) return true;
      bucket.push({
        path: file.path,
        folder: parentPath(file.path) || '/',
        line: i + 1,
        offset: i,
        snippet: snippet(i),
      });
      added++;
      i += contextLines; // Skip the context just shown, so snippets do not overlap.
    }
    if (!added && bucket.length < limit) {
      const first = Math.max(
        0,
        lines.findIndex(l => anyWord(l)),
      );
      bucket.push({
        path: file.path,
        folder: parentPath(file.path) || '/',
        line: first + 1,
        offset: first,
        snippet: snippet(first),
      });
    }
    return false;
  }
}
