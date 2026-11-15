import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeRoute } from '../../../src/agents/peerReview';
import { reviewProposal } from '../../../src/tools/EditReview';
import { ReplaceInNoteTool } from '../../../src/tools/ReplaceInNote';
import { WriteNoteSectionTool } from '../../../src/tools/WriteNoteSection';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { fakeReviewer, lastJson, nextModal, takeModals, writeSettings } from './helpers';

test('routes: user present reviews; workers follow the policy; review becomes a queue', () => {
  const plugin = { settings: writeSettings({ edit: 'review', delete: 'deny' }) } as never;
  assert.equal(writeRoute(plugin, { role: 'agent' } as never, 'edit'), 'user');
  assert.equal(writeRoute(plugin, { role: 'voice' } as never, 'delete'), 'user');
  assert.equal(writeRoute(plugin, { role: 'subagent' } as never, 'create'), 'allow');
  assert.equal(writeRoute(plugin, { role: 'subagent' } as never, 'edit'), 'queue');
  assert.equal(writeRoute(plugin, { role: 'subagent' } as never, 'delete'), 'deny');
  assert.equal(writeRoute(plugin, { role: 'orchestrator-agent' } as never, 'create'), 'deny');
});

test('"ask me" for a worker saves a proposal, opens no window, and leaves the note', async () => {
  const h = toolHarness(
    { 'a.md': '## Log\n- one\n' },
    { role: 'subagent', settings: writeSettings({ edit: 'review' }) },
  );
  const out = await h.run(WriteNoteSectionTool, {
    path: 'a.md',
    heading: 'Log',
    content: '- two',
    reason: 'log the run',
    format: 'json',
  });
  assert.equal(takeModals().length, 0);
  const json = JSON.parse(out);
  assert.equal(json.applied, false);
  assert.equal(json.review, 'policy:window');
  assert.match(json.proposal, /^Agent tasks\/Proposals\/.* edit a\.md$/);
  assert.equal(await h.app.vault.adapter.read('a.md'), '## Log\n- one\n');
  const proposal = await h.app.vault.adapter.read(json.proposal);
  assert.match(proposal, /voice-agent-proposal: edit/);
  assert.match(proposal, /Why: log the run/);

  // Later, with the user present, the proposal opens in the review window and applies.
  const pending = reviewProposal(h.app as never, json.proposal);
  (await nextModal()).approve();
  const done = await pending;
  assert.equal(done.applied, true, done.error);
  assert.equal(await h.app.vault.adapter.read('a.md'), '## Log\n- one\n- two\n');
  assert.match(await h.app.vault.adapter.read(json.proposal), /status: applied/);
});

test('two reviewers approve: the edit is made and the note backed up first', async () => {
  const fake = fakeReviewer(() => 'APPROVE\nfine');
  try {
    const h = toolHarness(
      { 'a.md': 'abc' },
      { role: 'subagent', settings: writeSettings({ edit: 'peer' }) },
    );
    const json = JSON.parse(
      await h.run(ReplaceInNoteTool, { path: 'a.md', search: 'b', replace: 'B', format: 'json' }),
    );
    assert.equal(json.review, 'policy:reviewers');
    assert.equal(json.applied, true);
    assert.match(json.backup, /^Agent tasks\/Backups\/.* a\.md$/);
    assert.equal(await h.app.vault.adapter.read(json.backup), 'abc');
    assert.equal(await h.app.vault.adapter.read('a.md'), 'aBc');
    assert.equal(fake.calls.length, 2);
    assert.equal(takeModals().length, 0);
  } finally {
    fake.restore();
  }
});

test('a reviewer rejects: a tool error, and nothing changes', async () => {
  const fake = fakeReviewer(n => (n === 0 ? 'APPROVE\nok' : 'REJECT\ndrops a link'));
  try {
    const h = toolHarness(
      { 'a.md': 'abc' },
      { role: 'subagent', settings: writeSettings({ edit: 'peer' }) },
    );
    const out = await h.run(ReplaceInNoteTool, {
      path: 'a.md',
      search: 'b',
      replace: '',
      format: 'json',
    });
    assert.ok(isToolError(out), out);
    assert.match(out, /ReviewRejected/);
    assert.equal(lastJson(out).review, 'policy:reviewers');
    assert.equal(await h.app.vault.adapter.read('a.md'), 'abc');
  } finally {
    fake.restore();
  }
});
