import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManageWorkspaceTool } from '../../../src/tools/ManageWorkspace';
import { ShowNoticeTool } from '../../../src/tools/ShowNotice';
import { isToolError } from '../../../src/tools/toolContract';
import { Notice } from '../obsidian-mock';
import { actionChat, fakeWorkspace } from './fixtures';

const notes = (c: ReturnType<typeof actionChat>) => {
  c.app.vault.put('Projects/Plan.md', '# Plan');
  c.app.vault.put('Inbox.md', 'inbox');
};

test('show_obsidian_notice shows a notice in chat and voice, and nothing in a worker', async () => {
  Notice.shown.length = 0;
  for (const role of [undefined, 'voice']) {
    const out = await actionChat({ role }).tool(ShowNoticeTool).execute({ message: 'Done' });
    assert.ok(!isToolError(out), out);
    assert.match(out, /^Showed a notice/);
  }
  assert.deepEqual(Notice.shown, ['Done', 'Done']);

  const worker = await actionChat({ role: 'subagent' })
    .tool(ShowNoticeTool)
    .execute({ message: 'Done', format: 'json' });
  assert.deepEqual(JSON.parse(worker), {
    shown: false,
    message: 'Done',
    duration_ms: 5000,
    truncated: false,
  });
  assert.equal(Notice.shown.length, 2);
});

test('show_obsidian_notice rejects an empty message and clamps the duration', async () => {
  const tool = actionChat().tool(ShowNoticeTool);
  assert.ok(isToolError(await tool.execute({ message: '  ' })));
  const out = JSON.parse(
    await tool.execute({ message: 'x'.repeat(400), duration: 999999, format: 'json' }),
  ) as { duration_ms: number; truncated: boolean; message: string };
  assert.equal(out.duration_ms, 30000);
  assert.equal(out.truncated, true);
  assert.equal(out.message.length, 300);
});

test('manage_workspace lists open notes as JSON', async () => {
  const c = actionChat();
  notes(c);
  fakeWorkspace(
    c.app,
    [
      { path: 'Projects/Plan.md', pinned: true },
      { path: 'Inbox.md', mode: 'preview' },
    ],
    'Inbox.md',
  );
  const out = JSON.parse(
    await c.tool(ManageWorkspaceTool).execute({ action: 'list', format: 'json' }),
  ) as Record<string, unknown>;
  assert.deepEqual(out, {
    action: 'list',
    changed: false,
    active: 'Inbox.md',
    tabs: [
      { path: 'Projects/Plan.md', mode: 'source', pinned: true, active: false },
      { path: 'Inbox.md', mode: 'preview', pinned: false, active: true },
    ],
  });
  const text = await c.tool(ManageWorkspaceTool).execute({ action: 'list' });
  assert.match(text, /^2 note tabs open\./);
});

test('manage_workspace opens by name, reuses an open tab, and splits on request', async () => {
  const c = actionChat();
  notes(c);
  const ws = fakeWorkspace(c.app, [{ path: 'Inbox.md' }]);
  const tool = c.tool(ManageWorkspaceTool);

  const opened = JSON.parse(
    await tool.execute({ action: 'open', path: 'Plan', mode: 'preview', format: 'json' }),
  ) as Record<string, unknown>;
  assert.deepEqual(opened, {
    action: 'open',
    changed: true,
    path: 'Projects/Plan.md',
    where: 'new_tab',
    mode: 'preview',
    active: true,
  });
  assert.equal(ws.leaves[1].view.mode, 'preview');

  const again = await tool.execute({ action: 'open', path: 'Inbox.md' });
  assert.match(again, /already open/);
  assert.ok(ws.calls.includes('reveal:Inbox.md'));
  assert.equal(ws.leaves.length, 2);

  const split = JSON.parse(
    await tool.execute({ action: 'open', path: 'Inbox', split: 'vertical', format: 'json' }),
  ) as { where: string };
  assert.equal(split.where, 'split_vertical');
  assert.ok(ws.calls.includes('getLeaf:split:vertical'));

  const missing = await tool.execute({ action: 'open', path: 'Nope' });
  assert.ok(isToolError(missing), missing);
  assert.ok(isToolError(await tool.execute({ action: 'open' })));
  assert.ok(isToolError(await tool.execute({ action: 'open', path: 'Inbox', split: 'diagonal' })));
});

test('manage_workspace close needs a path, saves first and keeps pinned tabs', async () => {
  const c = actionChat();
  notes(c);
  const ws = fakeWorkspace(c.app, [
    { path: 'Inbox.md', pinned: true },
    { path: 'Inbox.md' },
    { path: 'Projects/Plan.md' },
  ]);
  const tool = c.tool(ManageWorkspaceTool);

  // No implicit "close whatever is in focus".
  const bare = await tool.execute({ action: 'close' });
  assert.ok(isToolError(bare), bare);
  assert.equal(ws.leaves.length, 3);

  const out = JSON.parse(
    await tool.execute({ action: 'close', path: 'Inbox', all: true, format: 'json' }),
  ) as Record<string, unknown>;
  assert.deepEqual(out, {
    action: 'close',
    changed: true,
    path: 'Inbox.md',
    closed: 1,
    kept_pinned: 1,
    still_open: 1,
    saved_before_closing: true,
  });
  assert.deepEqual(ws.calls, ['save:Inbox.md', 'detach:Inbox.md']);

  const pinnedOnly = await tool.execute({ action: 'close', path: 'Inbox.md' });
  assert.match(pinnedOnly, /pinned/);
  assert.ok(!isToolError(pinnedOnly));

  const plan = await tool.execute({ action: 'close', path: 'Projects/Plan.md' });
  assert.match(plan, /^Closed 1 tab/);
  assert.match(await tool.execute({ action: 'close', path: 'Plan' }), /isn't open/);
});

test('manage_workspace set_mode switches the note in focus', async () => {
  const c = actionChat();
  notes(c);
  const ws = fakeWorkspace(c.app, [{ path: 'Inbox.md' }], 'Inbox.md');
  const tool = c.tool(ManageWorkspaceTool);
  const out = JSON.parse(
    await tool.execute({ action: 'set_mode', mode: 'preview', format: 'json' }),
  ) as Record<string, unknown>;
  assert.deepEqual(out, {
    action: 'set_mode',
    changed: true,
    path: 'Inbox.md',
    mode: 'preview',
    tabs: 1,
    switched: 1,
  });
  assert.equal(ws.leaves[0].view.mode, 'preview');
  assert.match(await tool.execute({ action: 'set_mode', mode: 'preview' }), /already/);
  assert.ok(isToolError(await tool.execute({ action: 'set_mode' })));
  assert.ok(isToolError(await tool.execute({ action: 'set_mode', mode: 'source', path: 'Plan' })));
  assert.ok(isToolError(await tool.execute({ action: 'shuffle' })));
});
