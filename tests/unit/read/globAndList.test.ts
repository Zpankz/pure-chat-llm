import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GlobFilesTool } from '../../../src/tools/GlobFiles';
import { ListFoldersTool } from '../../../src/tools/ListFolders';
import { isToolError, toolErrorMessage } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';

const vault = () => ({
  'Uni/LO/LO.md': '# LO overview',
  'Uni/LO/AP11AO402.md': 'a',
  'Uni/LO/CV02.md': 'b',
  'Uni/LO/diagram.png': 'png',
  'Uni/LO/Sub/Deep.md': 'c',
  'Uni/LO/Sub/Sub.md': 'sub overview',
  'Uni/Other/Elsewhere.md': 'd',
  'Work/LO/Meeting.md': 'e',
  'Inbox.md': 'f',
});

// glob_vault_files

test('glob_vault_files json has stable keys with a folder per file', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(GlobFilesTool, {
      pattern: 'Uni/LO/*.md',
      include_fields: ['size', 'extension'],
      format: 'json',
    }),
  );
  assert.deepEqual(Object.keys(data), [
    'pattern',
    'folders',
    'recursive',
    'total',
    'truncated',
    'files',
  ]);
  assert.equal(data.total, 3);
  assert.deepEqual(data.files[0], {
    path: 'Uni/LO/AP11AO402.md',
    folder: 'Uni/LO',
    size: 1,
    extension: 'md',
  });
});

test('glob_vault_files: ** across folders, case-insensitive, bare pattern searches all folders', async () => {
  const h = toolHarness(vault());
  const any = JSON.parse(await h.run(GlobFilesTool, { pattern: '**/lo/*.md', format: 'json' }));
  assert.equal(any.total, 4);
  const bare = await h.run(GlobFilesTool, { pattern: '*meeting*' });
  assert.match(bare, /Work\/LO\/Meeting\.md/);
  assert.match(bare.split('\n')[0], /^Found 1 file matching "\*\*\/\*meeting\*"\.$/);
});

test('glob_vault_files with folder scope matches below the folder, recursive by default', async () => {
  const h = toolHarness(vault());
  const deep = JSON.parse(
    await h.run(GlobFilesTool, { pattern: '*.md', folder: 'Uni/LO', format: 'json' }),
  );
  assert.deepEqual(
    deep.files.map((f: { path: string }) => f.path),
    [
      'Uni/LO/AP11AO402.md',
      'Uni/LO/CV02.md',
      'Uni/LO/LO.md',
      'Uni/LO/Sub/Deep.md',
      'Uni/LO/Sub/Sub.md',
    ],
  );
  const top = JSON.parse(
    await h.run(GlobFilesTool, {
      pattern: '*.md',
      folder: 'Uni/LO',
      recursive: false,
      format: 'json',
    }),
  );
  assert.equal(top.total, 3);
  // A bare name matching two folders searches both.
  const both = JSON.parse(
    await h.run(GlobFilesTool, { pattern: '*.md', folder: 'LO', format: 'json' }),
  );
  assert.deepEqual(both.folders, ['Uni/LO', 'Work/LO']);
  assert.equal(both.total, 6);
  const pngs = JSON.parse(
    await h.run(GlobFilesTool, { pattern: '*.png', folder: 'LO', format: 'json' }),
  );
  assert.deepEqual(
    pngs.files.map((f: { path: string }) => f.path),
    ['Uni/LO/diagram.png'],
  );
});

test('glob_vault_files limit sets truncated', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(GlobFilesTool, { pattern: '**/*.md', limit: 2, format: 'json' }),
  );
  assert.equal(data.files.length, 2);
  assert.equal(data.truncated, true);
  assert.equal(data.total, 8);
});

test('glob_vault_files failures are tool errors; no match is not', async () => {
  const h = toolHarness(vault());
  const empty = await h.run(GlobFilesTool, { pattern: '  ' });
  assert.ok(isToolError(empty));
  assert.match(toolErrorMessage(empty), /^InvalidArgument:/);
  const folder = await h.run(GlobFilesTool, { pattern: '*', folder: 'Nope' });
  assert.match(toolErrorMessage(folder), /^FolderNotFound:/);
  const none = await h.run(GlobFilesTool, { pattern: '**/*.xyz' });
  assert.ok(!isToolError(none));
  assert.match(none, /^No files match/);
});

// list_vault_folders

test('list_vault_folders json: folder note first, folders with their folder notes', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(await h.run(ListFoldersTool, { path: 'Uni/LO', format: 'json' }));
  assert.deepEqual(Object.keys(data), [
    'folder',
    'folder_note',
    'recursive',
    'folders',
    'notes',
    'notes_total',
    'truncated',
  ]);
  assert.equal(data.folder_note, 'Uni/LO/LO.md');
  assert.equal(data.recursive, true);
  assert.deepEqual(data.notes[0], { path: 'Uni/LO/LO.md', folder: 'Uni/LO', folder_note: true });
  assert.deepEqual(
    data.notes.map((n: { path: string }) => n.path),
    [
      'Uni/LO/LO.md',
      'Uni/LO/AP11AO402.md',
      'Uni/LO/CV02.md',
      'Uni/LO/Sub/Sub.md',
      'Uni/LO/Sub/Deep.md',
    ],
  );
  assert.deepEqual(data.folders, [
    { path: 'Uni/LO/Sub', files: 2, notes: 2, folder_note: 'Uni/LO/Sub/Sub.md' },
  ]);
  assert.equal(data.notes_total, 5);
});

test('list_vault_folders text: summary names the folder note and lists full paths', async () => {
  const h = toolHarness(vault());
  const out = await h.run(ListFoldersTool, { path: 'Uni/LO' });
  assert.equal(
    out.split('\n')[0],
    'Folder "Uni/LO": 1 subfolder, 5 notes at every depth; its folder note is Uni/LO/LO.md.',
  );
  assert.match(out, /- Uni\/LO\/LO\.md \(folder note\)\n- Uni\/LO\/AP11AO402\.md/);
  assert.match(out, /- Uni\/LO\/Sub\/ \(2 notes, 2 files, folder note Sub\.md\)/);
  assert.match(out, /Next: read_file\(path="Uni\/LO\/LO\.md"\) reads the folder note\./);
});

test('list_vault_folders recursive=false lists one level', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(ListFoldersTool, { path: 'Uni/LO', recursive: false, format: 'json' }),
  );
  assert.deepEqual(
    data.notes.map((n: { path: string }) => n.path),
    ['Uni/LO/LO.md', 'Uni/LO/AP11AO402.md', 'Uni/LO/CV02.md'],
  );
  const root = JSON.parse(
    await h.run(ListFoldersTool, { recursive: false, include_notes: false, format: 'json' }),
  );
  assert.equal(root.folder, '/');
  assert.equal(root.folder_note, null);
  assert.deepEqual(
    root.folders.map((f: { path: string }) => f.path),
    ['Uni', 'Work'],
  );
  assert.deepEqual(root.notes, []);
});

test('list_vault_folders limit truncates notes', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(await h.run(ListFoldersTool, { path: '/', limit: 2, format: 'json' }));
  assert.equal(data.notes.length, 2);
  assert.equal(data.notes_total, 8);
  assert.equal(data.truncated, true);
});

test('list_vault_folders failures are tool errors', async () => {
  const h = toolHarness(vault());
  const ambiguous = await h.run(ListFoldersTool, { path: 'LO' });
  assert.ok(isToolError(ambiguous), ambiguous);
  assert.match(
    toolErrorMessage(ambiguous),
    /^Ambiguous: .*Uni\/LO \(5 notes\).*Work\/LO \(1 note\)/,
  );
  const missing = await h.run(ListFoldersTool, { path: 'Uni/Nope' });
  assert.match(toolErrorMessage(missing), /^FolderNotFound:/);
});
