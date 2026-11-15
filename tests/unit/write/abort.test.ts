import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNoteWrite, submitWrite } from '../../../src/tools/EditReview';
import { ReplaceInNoteTool } from '../../../src/tools/ReplaceInNote';
import { isToolError } from '../../../src/tools/toolContract';
import { createApp } from '../obsidian-mock';
import { fakeReviewer, nextModal, writeSettings } from './helpers';

/**
 * A chat as the write tools see it, with the run's abort signal.
 * @param role - Chat role.
 * @param writes - Worker write policy.
 * @param signal - The run's signal.
 */
function chatWith(
  role: string | undefined,
  writes: Parameters<typeof writeSettings>[0],
  signal?: AbortSignal,
) {
  const app = createApp();
  app.vault.put('a.md', 'abc');
  return {
    app,
    chat: { plugin: { app, settings: writeSettings(writes) }, role, abortSignal: signal },
  };
}

test('an aborted signal means no write', async () => {
  const { app } = chatWith('subagent', {});
  const controller = new AbortController();
  controller.abort();
  const result = await applyNoteWrite(app as never, {
    path: 'a.md',
    content: 'changed',
    overwrite: true,
    original: 'abc',
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && isToolError(result.error) && /Cancelled/.test(result.error));
  assert.equal(await app.vault.adapter.read('a.md'), 'abc');
});

test("a worker's run that stops during review leaves no ghost write", async () => {
  const controller = new AbortController();
  const fake = fakeReviewer(async () => {
    controller.abort(); // the run times out while the reviewers think
    return 'APPROVE\nok';
  });
  try {
    const { app, chat } = chatWith('subagent', { edit: 'peer' }, controller.signal);
    const tool = new ReplaceInNoteTool(chat as never, { statusUpdate: async () => {} } as never);
    const out = await tool.execute({ path: 'a.md', search: 'b', replace: 'B' });
    assert.ok(isToolError(out), out);
    assert.match(out, /Cancelled/);
    assert.equal(await app.vault.adapter.read('a.md'), 'abc');
    assert.equal(app.vault.getAbstractFileByPath('Agent tasks/Backups'), null, 'no backup either');
  } finally {
    fake.restore();
  }
});

test('a stopped run closes its review window unanswered', async () => {
  const controller = new AbortController();
  const { app, chat } = chatWith(undefined, {}, controller.signal);
  const pending = submitWrite(chat as never, {
    kind: 'write',
    path: 'a.md',
    content: 'changed',
    overwrite: true,
    instruction: 'test',
  });
  await nextModal();
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.applied, false);
  assert.match(outcome.error ?? '', /Cancelled/);
  assert.equal(await app.vault.adapter.read('a.md'), 'abc');
});

test('a request signal works without one on the chat; deletes check it too', async () => {
  const { app, chat } = chatWith('subagent', { delete: 'allow' });
  const controller = new AbortController();
  controller.abort();
  const outcome = await submitWrite(chat as never, {
    kind: 'delete',
    path: 'a.md',
    instruction: 'test',
    signal: controller.signal,
  });
  assert.equal(outcome.applied, false);
  assert.ok(app.vault.getAbstractFileByPath('a.md'));
});
