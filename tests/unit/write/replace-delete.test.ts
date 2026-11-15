import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeleteNoteTool } from '../../../src/tools/DeleteNote';
import { ReplaceInNoteTool } from '../../../src/tools/ReplaceInNote';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { nextModal, takeModals, writeSettings } from './helpers';

/** A worker that may edit and delete without review. */
const worker = (files: Record<string, string>) =>
  toolHarness(files, {
    role: 'subagent',
    settings: writeSettings({ edit: 'allow', delete: 'allow' }),
  });

test('replace_in_note: literal text stays literal, regex groups work', async () => {
  const h = worker({ 'a.md': 'Price: 5 USD. price: 6 usd.' });
  const out = await h.run(ReplaceInNoteTool, { path: 'a', search: 'usd', replace: '$&$1 EUR' });
  assert.equal(out.split('\n')[0], 'Replaced 2 matches in "a.md".');
  assert.equal(await h.app.vault.adapter.read('a.md'), 'Price: 5 $&$1 EUR. price: 6 $&$1 EUR.');
  const json = await h.run(ReplaceInNoteTool, {
    path: 'a.md',
    search: '(\\d) \\$&\\$1',
    replace: '$1.00',
    regex: true,
    case_sensitive: true,
    format: 'json',
  });
  assert.deepEqual(JSON.parse(json), {
    ok: true,
    action: 'edit',
    path: 'a.md',
    applied: true,
    review: 'policy:allow',
    lines_before: 1,
    lines_after: 1,
    matches: 2,
  });
  assert.equal(await h.app.vault.adapter.read('a.md'), 'Price: 5.00 EUR. price: 6.00 EUR.');
});

test('replace_in_note: expected_matches guards against changing too much', async () => {
  const h = worker({ 'a.md': 'x x x' });
  const out = await h.run(ReplaceInNoteTool, {
    path: 'a.md',
    search: 'x',
    replace: 'y',
    expected_matches: 1,
  });
  assert.ok(isToolError(out), out);
  assert.match(out, /Found 3 matches/);
  assert.equal(await h.app.vault.adapter.read('a.md'), 'x x x');
});

test('replace_in_note: no match is not an error, but nothing is written', async () => {
  const h = worker({ 'a.md': 'abc' });
  const json = JSON.parse(
    await h.run(ReplaceInNoteTool, { path: 'a.md', search: 'zzz', replace: 'y', format: 'json' }),
  );
  assert.equal(json.applied, false);
  assert.equal(json.matches, 0);
});

test('replace_in_note: errors', async () => {
  const h = worker({ 'a.md': 'abc' });
  for (const args of [
    { path: 'a.md', search: '(', replace: 'y', regex: true },
    { path: 'nope.md', search: 'a', replace: 'y' },
    { path: 'a.md', search: '', replace: 'y' },
  ]) {
    const out = await h.run(ReplaceInNoteTool, args);
    assert.ok(isToolError(out), out);
  }
});

test('replace_in_note: in a chat the user reviews; a rejection is an error', async () => {
  const h = toolHarness({ 'a.md': 'abc' });
  const pending = h.run(ReplaceInNoteTool, { path: 'a.md', search: 'b', replace: 'B' });
  (await nextModal()).reject();
  assert.ok(isToolError(await pending));
  assert.equal(await h.app.vault.adapter.read('a.md'), 'abc');
});

test('delete: a chat confirms, then the note goes to the trash', async () => {
  const h = toolHarness({ 'Old/a.md': 'x' });
  const pending = h.run(DeleteNoteTool, { path: 'Old/a' });
  (await nextModal()).approve();
  const out = await pending;
  assert.equal(out.split('\n')[0], 'Deleted "Old/a.md".');
  assert.match(out, /trash/);
  assert.deepEqual(h.app.vault.trashed, ['Old/a.md']);
});

test('delete: a worker under allow trashes it with no window; JSON keys', async () => {
  const h = worker({ 'a.md': 'x' });
  const json = JSON.parse(await h.run(DeleteNoteTool, { path: 'a.md', format: 'json' }));
  assert.deepEqual(json, {
    ok: true,
    action: 'delete',
    path: 'a.md',
    applied: true,
    review: 'policy:allow',
    trashed: true,
  });
  assert.equal(takeModals().length, 0);
  assert.deepEqual(h.app.vault.trashed, ['a.md']);
});

test('delete: deny refuses, missing note is an error', async () => {
  const h = toolHarness(
    { 'a.md': 'x' },
    { role: 'subagent', settings: writeSettings({ delete: 'deny' }) },
  );
  const out = await h.run(DeleteNoteTool, { path: 'a.md' });
  assert.ok(isToolError(out), out);
  assert.match(out, /WriteDenied: Background tasks can't delete notes/);
  assert.ok(h.app.vault.getAbstractFileByPath('a.md'));
  assert.ok(isToolError(await h.run(DeleteNoteTool, { path: 'missing.md' })));
  assert.equal(takeModals().length, 0);
});
