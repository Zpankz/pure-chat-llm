import { TFile, TFolder } from 'obsidian';
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { folderNote, folderRefError, resolveFolders } from '../utils/vaultResolve';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

const listFoldersParameters = defineToolParameters({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'The folder to list: a path ("Uni/ANZCA/LO") or just a folder name ("LO"), found wherever it sits. Defaults to the vault root (/).',
      default: '/',
    },
    recursive: {
      type: 'boolean',
      description:
        "Include subfolders at every depth (default true); false lists one level: the folder's own notes and direct subfolders.",
      default: true,
    },
    include_notes: {
      type: 'boolean',
      description: 'Also list notes, not just folders. Defaults to true.',
      default: true,
    },
    limit: {
      type: 'integer',
      description: 'Most notes to list, 1 to 500. Defaults to 80.',
      default: 80,
    },
    format: { ...FORMAT_PARAMETER, enum: ['text', 'json'] },
  },
  required: [],
} as const);

export type ListFoldersArgs = InferArgs<typeof listFoldersParameters>;

/** Most subfolders listed. */
const FOLDER_LIMIT = 200;

interface FolderRow {
  path: string;
  /** Files at any depth below it. */
  files: number;
  /** Markdown notes at any depth below it. */
  notes: number;
  /** Its folder note (`X/X.md`), or null. */
  folder_note: string | null;
}

interface NoteRow {
  path: string;
  /** Folder the note sits in ("/" at the root). */
  folder: string;
  /** True for a folder note (`X/X.md`). */
  folder_note: boolean;
}

/**
 * Lists a folder's notes and subfolders; a bare folder name is found anywhere in the vault.
 * Folder notes (`X/X.md`) come first in their folder.
 */
export class ListFoldersTool extends Tool<ListFoldersArgs> {
  readonly name = 'list_vault_folders';
  readonly classification = 'Vault';
  readonly description =
    'Lists the notes and subfolders in one folder, including subfolders at every depth unless recursive is false. Takes a full path or just a folder name ("LO"), found wherever it sits. A folder note (X/X.md, the overview note of folder X) is listed first and marked; read it first to learn what a folder holds. Use it for "the notes in folder X" or to browse the vault\'s structure; use search_vault to find notes by their text and glob_vault_files to match paths by pattern. format json returns {folder, folder_note, recursive, folders:[{path, files, notes, folder_note}], notes:[{path, folder, folder_note}], notes_total, truncated}.';
  readonly parameters = listFoldersParameters;

  /** Always available. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Lists the folder.
   * @param args - Tool arguments.
   */
  async execute(args: ListFoldersArgs): Promise<string> {
    const app = this.chat.plugin.app;
    const requested = String(args.path ?? '/').trim() || '/';
    const recursive = args.recursive !== false;
    const includeNotes = args.include_notes !== false;
    const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 80)));

    const matches = resolveFolders(app, requested === '/' ? '' : requested);
    if (!matches.length) return folderRefError(app, requested);
    if (matches.length > 1) {
      const counts = matches.map(f => `${f.path} (${plural(countBelow(f).notes, 'note')})`);
      return toolError(
        'Ambiguous',
        `Several folders are named "${requested}": ${counts.join(', ')}.`,
        [
          'Call list_vault_folders again with the full path of the one you mean.',
          `search_vault(query, folder="${requested}") searches all of them at once.`,
        ],
      );
    }
    const root = matches[0];
    const label = root.isRoot() ? '/' : root.path;
    const rootNote = folderNote(root);
    void this.status(`Listing "${label}"...`);

    const folders: FolderRow[] = [];
    const notes: NoteRow[] = [];
    // Depth first, so each folder's notes stay together: its folder note, its other notes, then
    // its subfolders.
    const walk = (folder: TFolder) => {
      const kids = sorted(folder.children);
      if (includeNotes) {
        const own = folderNote(folder);
        if (own) notes.push(noteRow(own, true));
        for (const child of kids) {
          if (child instanceof TFile && child.extension === 'md' && child !== own) {
            notes.push(noteRow(child, false));
          }
        }
      }
      for (const child of kids) {
        if (!(child instanceof TFolder)) continue;
        folders.push({
          path: child.path,
          ...countBelow(child),
          folder_note: folderNote(child)?.path ?? null,
        });
        if (recursive) walk(child);
      }
    };
    walk(root);

    const shownNotes = notes.slice(0, limit);
    const shownFolders = folders.slice(0, FOLDER_LIMIT);
    const truncated = shownNotes.length < notes.length || shownFolders.length < folders.length;

    if (wantsJson(args)) {
      return jsonResult({
        folder: label,
        folder_note: rootNote?.path ?? null,
        recursive,
        folders: shownFolders,
        notes: shownNotes,
        notes_total: notes.length,
        truncated,
      });
    }

    const parts: string[] = [plural(folders.length, 'subfolder')];
    if (includeNotes) parts.push(plural(notes.length, 'note'));
    const out = [
      `Folder "${label}": ${parts.join(', ')}${recursive ? ' at every depth' : ' at the top level'}${rootNote ? `; its folder note is ${rootNote.path}` : ''}.`,
    ];
    if (shownFolders.length) {
      out.push('', 'Subfolders:');
      for (const f of shownFolders) {
        const note = f.folder_note ? `, folder note ${f.folder_note.split('/').pop()}` : '';
        out.push(`- ${f.path}/ (${plural(f.notes, 'note')}, ${plural(f.files, 'file')}${note})`);
      }
      if (folders.length > shownFolders.length) {
        out.push(`…and ${folders.length - shownFolders.length} more`);
      }
    }
    if (shownNotes.length) {
      // Full paths, grouped by folder (each folder's own note first), so any line can be passed
      // straight to read_file.
      out.push('', 'Notes:');
      for (const n of shownNotes) out.push(`- ${n.path}${n.folder_note ? ' (folder note)' : ''}`);
      if (notes.length > shownNotes.length) {
        out.push(`…and ${notes.length - shownNotes.length} more (raise limit, now ${limit})`);
      }
    }
    if (!folders.length && !notes.length) {
      out.push(includeNotes ? 'It is empty.' : 'It has no subfolders.');
    }
    out.push('');
    const first = rootNote?.path ?? shownNotes[0]?.path;
    if (first)
      out.push(
        `Next: read_file(path="${first}") reads ${rootNote ? 'the folder note' : 'a note'}.`,
      );
    if (recursive && truncated) {
      out.push(`For a shorter overview: list_vault_folders(path="${label}", recursive=false).`);
    }
    return out.join('\n').trimEnd();
  }
}

/**
 * A note row.
 * @param file - Note.
 * @param isFolderNote - Whether it is its folder's folder note.
 */
function noteRow(file: TFile, isFolderNote: boolean): NoteRow {
  const i = file.path.lastIndexOf('/');
  return {
    path: file.path,
    folder: i < 0 ? '/' : file.path.slice(0, i),
    folder_note: isFolderNote,
  };
}

/**
 * Files and notes at any depth below a folder.
 * @param folder - Folder.
 */
function countBelow(folder: TFolder): { files: number; notes: number } {
  let files = 0;
  let notes = 0;
  const walk = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFile) {
        files++;
        if (c.extension === 'md') notes++;
      } else if (c instanceof TFolder) walk(c);
    }
  };
  walk(folder);
  return { files, notes };
}

/**
 * "1 note", "3 notes".
 * @param n - Count.
 * @param word - Singular noun.
 */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Children sorted by path, so output is stable.
 * @param children - Folder children.
 */
function sorted<T extends { path: string }>(children: T[]): T[] {
  return [...children].sort((a, b) => a.path.localeCompare(b.path));
}
