import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchVaultTool } from '../../../src/tools/SearchVault';
import { isToolError, toolErrorMessage } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';

const vault = () => ({
  'Uni/LO/LO.md': '# Learning objectives\nIndex of the objective notes.',
  'Uni/LO/AP11AO402.md': '# Airway pressure\nLearning outcome: explain the objective of PEEP.',
  'Uni/LO/CV02.md': 'Cardiac output.\nThe objective is to describe preload.',
  'Uni/LO/Sub/Deep.md': 'nested objective note',
  'Uni/Other/Elsewhere.md': 'Another objective outside the folder.',
  'Inbox.md': 'objective in the root',
});

test('search_vault json has stable keys and a folder per match', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(SearchVaultTool, { query: 'objective', folder: 'LO', format: 'json' }),
  );
  assert.deepEqual(Object.keys(data), [
    'query',
    'mode',
    'folders',
    'recursive',
    'files_searched',
    'title_matches',
    'title_matches_total',
    'matches',
    'notes_matched',
    'truncated',
  ]);
  assert.equal(data.mode, 'text');
  assert.deepEqual(data.folders, ['Uni/LO']);
  assert.equal(data.recursive, true);
  assert.equal(data.files_searched, 4);
  assert.equal(data.notes_matched, 4);
  assert.equal(data.truncated, false);
  const m = data.matches.find((x: { path: string }) => x.path === 'Uni/LO/CV02.md');
  assert.deepEqual(Object.keys(m), ['path', 'folder', 'line', 'offset', 'snippet']);
  assert.equal(m.folder, 'Uni/LO');
  assert.equal(m.line, 2);
  assert.equal(m.offset, 1);
  assert.match(m.snippet, /^> The objective is to describe preload\.$/m);
  const deep = data.matches.find((x: { path: string }) => x.path === 'Uni/LO/Sub/Deep.md');
  assert.equal(deep.folder, 'Uni/LO/Sub');
});

test('search_vault recursive=false keeps to the folder itself', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(SearchVaultTool, {
      query: 'objective',
      folder: 'LO',
      recursive: false,
      format: 'json',
    }),
  );
  const paths = data.matches.map((x: { path: string }) => x.path);
  assert.ok(!paths.includes('Uni/LO/Sub/Deep.md'), paths.join());
  assert.ok(paths.includes('Uni/LO/CV02.md'));
  const text = await h.run(SearchVaultTool, { query: 'objective', folder: 'LO', recursive: false });
  assert.match(text.split('\n')[0], /in folder "Uni\/LO" \(top level only\)/);
});

test('search_vault first line is a spoken summary', async () => {
  const h = toolHarness(vault());
  const out = await h.run(SearchVaultTool, { query: 'preload' });
  assert.equal(out.split('\n')[0], 'Found 1 match in 1 note for "preload".');
});

test('search_vault lists the exact name, then folder notes, first among title hits', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(await h.run(SearchVaultTool, { query: 'LO', format: 'json' }));
  assert.equal(data.title_matches[0], 'Uni/LO/LO.md');
  assert.equal(data.title_matches_total, 4);
  const byName = JSON.parse(await h.run(SearchVaultTool, { query: 'cv02', format: 'json' }));
  assert.deepEqual(byName.title_matches, ['Uni/LO/CV02.md']);
});

test('search_vault reads each note once, including when a phrase falls back to its words', async () => {
  const h = toolHarness(vault());
  let reads = 0;
  const read = h.app.vault.cachedRead.bind(h.app.vault);
  h.app.vault.cachedRead = async f => {
    reads++;
    return read(f);
  };
  const data = JSON.parse(
    await h.run(SearchVaultTool, { query: 'outcome objective', format: 'json' }),
  );
  assert.equal(data.mode, 'all_words');
  assert.ok(
    data.matches.some((m: { path: string }) => m.path === 'Uni/LO/AP11AO402.md'),
    JSON.stringify(data),
  );
  assert.equal(reads, 6, 'one read per note');
});

test('search_vault keeps an exact phrase and does not fall back', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(SearchVaultTool, { query: 'describe preload', format: 'json' }),
  );
  assert.equal(data.mode, 'phrase');
  assert.deepEqual(
    data.matches.map((m: { path: string }) => m.path),
    ['Uni/LO/CV02.md'],
  );
});

test('search_vault boolean AND across lines still gives a snippet', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(SearchVaultTool, { query: 'cardiac AND preload', format: 'json' }),
  );
  assert.equal(data.mode, 'boolean');
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0].path, 'Uni/LO/CV02.md');
});

test('search_vault stops at limit and says so', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(SearchVaultTool, { query: 'objective', limit: 2, format: 'json' }),
  );
  assert.equal(data.matches.length, 2);
  assert.equal(data.truncated, true);
  const text = await h.run(SearchVaultTool, { query: 'objective', limit: 2 });
  assert.match(text, /More matches may exist: raise limit \(now 2\)/);
});

test('search_vault regex mode', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(SearchVaultTool, { query: 'AP\\d+AO', regex: true, format: 'json' }),
  );
  assert.equal(data.mode, 'regex');
  assert.equal(data.matches.length, 0); // the name is only in the path
  const lines = JSON.parse(
    await h.run(SearchVaultTool, { query: 'pre(load|ssure)', regex: true, format: 'json' }),
  );
  assert.equal(lines.matches.length, 2);
});

test('search_vault failures are tool errors', async () => {
  const h = toolHarness(vault());
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ query: '' }, /^InvalidArgument:/],
    [{ query: '(', regex: true }, /^InvalidRegex:/],
    [{ query: 'x', folder: 'Nope' }, /^FolderNotFound:/],
  ];
  for (const [args, pattern] of cases) {
    const out = await h.run(SearchVaultTool, args as never);
    assert.ok(isToolError(out), out);
    assert.match(toolErrorMessage(out), pattern, out);
  }
  const near = await h.run(SearchVaultTool, { query: 'x', folder: 'Othe' });
  assert.match(near, /Similar folders: Uni\/Other/);
});
