import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateNoteTool } from '../../../src/tools/CreateNote';
import { guardPath } from '../../../src/tools/EditReview';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { lastJson, nextModal, takeModals, writeSettings } from './helpers';

test('in a chat the user reviews a new note, then it is saved', async () => {
  const h = toolHarness();
  const pending = h.run(CreateNoteTool, { path: 'Ideas/Groceries', content: '- milk' });
  const modal = await nextModal();
  modal.approve();
  const out = await pending;
  assert.equal(out.split('\n')[0], 'Created "Ideas/Groceries.md".');
  assert.match(out, /Approved by the user/);
  assert.equal(await h.app.vault.adapter.read('Ideas/Groceries.md'), '- milk');
});

test('the user can edit the content before approving', async () => {
  const h = toolHarness();
  const pending = h.run(CreateNoteTool, { path: 'a.md', content: 'draft', format: 'json' });
  const modal = await nextModal();
  modal.content = 'final';
  modal.approve();
  const json = JSON.parse(await pending);
  assert.equal(json.edited, true);
  assert.equal(await h.app.vault.adapter.read('a.md'), 'final');
});

test('a rejected review is a tool error and writes nothing', async () => {
  const h = toolHarness();
  const pending = h.run(CreateNoteTool, { path: 'a.md', content: 'x' });
  (await nextModal()).reject();
  const out = await pending;
  assert.ok(isToolError(out), out);
  assert.match(out, /UserRejected/);
  assert.equal(h.app.vault.getAbstractFileByPath('a.md'), null);
});

test('a background worker writes under the allow policy, with no window', async () => {
  const h = toolHarness({}, { role: 'subagent', settings: writeSettings({ create: 'allow' }) });
  const out = await h.run(CreateNoteTool, {
    path: 'Agent/out.md',
    content: '# Out',
    properties: { status: 'draft' },
    format: 'json',
  });
  assert.equal(takeModals().length, 0);
  assert.deepEqual(JSON.parse(out), {
    ok: true,
    action: 'create',
    path: 'Agent/out.md',
    applied: true,
    review: 'policy:allow',
    lines_before: 0,
    lines_after: 1,
  });
  assert.match(await h.app.vault.adapter.read('Agent/out.md'), /status: draft[\s\S]*# Out/);
});

test('deny refuses a worker with an error, and nothing is written', async () => {
  const h = toolHarness({}, { role: 'subagent', settings: writeSettings({ create: 'deny' }) });
  const out = await h.run(CreateNoteTool, { path: 'a.md', content: 'x', format: 'json' });
  assert.ok(isToolError(out), out);
  assert.match(out, /WriteDenied/);
  assert.equal(lastJson(out).review, 'denied');
  assert.equal(lastJson(out).applied, false);
  assert.equal(takeModals().length, 0);
  assert.equal(h.app.vault.getAbstractFileByPath('a.md'), null);
});

test('the orchestrator agent never writes and never opens a window', async () => {
  const h = toolHarness({}, { role: 'orchestrator-agent', settings: writeSettings() });
  const out = await h.run(CreateNoteTool, { path: 'a.md', content: 'x' });
  assert.ok(isToolError(out), out);
  assert.equal(takeModals().length, 0);
});

test('an existing note needs overwrite, and an overwrite is an edit', async () => {
  const h = toolHarness({ 'a.md': 'old' }, { role: 'subagent', settings: writeSettings() });
  const out = await h.run(CreateNoteTool, { path: 'a.md', content: 'new' });
  assert.ok(isToolError(out), out);
  assert.match(out, /FileExists/);
  const w = toolHarness(
    { 'a.md': 'old' },
    { role: 'subagent', settings: writeSettings({ edit: 'deny' }) },
  );
  const denied = await w.run(CreateNoteTool, { path: 'a.md', content: 'new', overwrite: true });
  assert.match(denied, /WriteDenied: Background tasks can't edit existing notes/);
  assert.equal(await w.app.vault.adapter.read('a.md'), 'old');
});

test('missing arguments are tool errors', async () => {
  const h = toolHarness();
  assert.ok(isToolError(await h.run(CreateNoteTool, { path: '', content: 'x' })));
  assert.ok(isToolError(await h.run(CreateNoteTool, { path: 'a', content: 3 as never })));
});

test('agents may not write in the config folder, with relative parts, or to memory.json', () => {
  assert.match(guardPath('.obsidian/snippets/x.css', '.obsidian'), /app's own folder/);
  assert.match(guardPath('Notes/../.obsidian/a.md', '.obsidian'), /relative part/);
  assert.match(
    guardPath('Voice Agent/Memory/memory.json', '.obsidian', 'Voice Agent/Memory/memory.json'),
    /memory tools/,
  );
  assert.equal(guardPath('Notes/Altitude.md', '.obsidian', 'Voice Agent/Memory/memory.json'), '');
});
