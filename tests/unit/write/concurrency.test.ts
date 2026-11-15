import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebase, reviewProposal } from '../../../src/tools/EditReview';
import { ReplaceInNoteTool } from '../../../src/tools/ReplaceInNote';
import { WriteNoteSectionTool } from '../../../src/tools/WriteNoteSection';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { fakeReviewer, nextModal, writeSettings } from './helpers';

const NOTE = '# Log\n\n## Monday\nwork\n\n## Tuesday\nrest\n';

test('rebase: unchanged, merged cleanly, or a conflict', () => {
  assert.equal(rebase('a', 'x\n', 'y\n', 'x\n'), 'y\n');
  assert.equal(
    rebase('a', 'a\nb\nc\nd\ne\nf\n', 'A\nb\nc\nd\ne\nf\n', 'a\nb\nc\nd\ne\nF\n'),
    'A\nb\nc\nd\ne\nF\n',
  );
  assert.equal(rebase('a', 'a\n', 'b\n', 'c\n'), null);
  assert.equal(rebase('a', null, 'new', 'anything'), 'new');
});

test('an edit made to the note during review is not lost', async () => {
  let h: ReturnType<typeof toolHarness> | undefined;
  const fake = fakeReviewer(async n => {
    // While the reviewers think, the user adds a line elsewhere in the note.
    if (n === 0) {
      const now = await h!.app.vault.adapter.read('Log.md');
      h!.app.vault.put('Log.md', now.replace('rest\n', 'rest\nwalk\n'));
    }
    return 'APPROVE\nok';
  });
  try {
    h = toolHarness(
      { 'Log.md': NOTE },
      { role: 'subagent', settings: writeSettings({ edit: 'peer' }) },
    );
    const out = await h.run(WriteNoteSectionTool, {
      path: 'Log.md',
      heading: 'Monday',
      content: 'meeting',
      format: 'json',
    });
    assert.equal(JSON.parse(out).merged, true, out);
    const text = await h.app.vault.adapter.read('Log.md');
    assert.match(text, /## Monday\nwork\n\nmeeting\n/);
    assert.match(text, /rest\nwalk\n/);
  } finally {
    fake.restore();
  }
});

test('a conflicting change during review is refused, and the newer text kept', async () => {
  const h = toolHarness({ 'a.md': 'colour: red\n' });
  const pending = h.run(ReplaceInNoteTool, { path: 'a.md', search: 'red', replace: 'blue' });
  const modal = await nextModal();
  // The user changes the same line before approving.
  h.app.vault.put('a.md', 'colour: green\n');
  modal.approve();
  const out = await pending;
  assert.ok(isToolError(out), out);
  assert.match(out, /Conflict/);
  assert.equal(await h.app.vault.adapter.read('a.md'), 'colour: green\n');
});

test('two writes to one note take turns, and both land', async () => {
  let inFlight = 0;
  let most = 0;
  const fake = fakeReviewer(async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    return 'APPROVE\nok';
  });
  try {
    const h = toolHarness(
      { 'Log.md': NOTE },
      { role: 'subagent', settings: writeSettings({ edit: 'peer' }) },
    );
    const [a, b] = await Promise.all([
      h.run(WriteNoteSectionTool, { path: 'Log.md', heading: 'Monday', content: 'one' }),
      h.run(WriteNoteSectionTool, { path: 'Log.md', heading: 'Tuesday', content: 'two' }),
    ]);
    assert.ok(!isToolError(a) && !isToolError(b), `${a}\n${b}`);
    // Each write asks two reviewers at once; the second write waited for the first.
    assert.equal(most, 2);
    const text = await h.app.vault.adapter.read('Log.md');
    assert.match(text, /work\n\none\n/);
    assert.match(text, /rest\n\ntwo\n/);
  } finally {
    fake.restore();
  }
});

test('a saved proposal is replayed on the note as it is now', async () => {
  const h = toolHarness(
    { 'Log.md': NOTE },
    { role: 'subagent', settings: writeSettings({ edit: 'review' }) },
  );
  const json = JSON.parse(
    await h.run(WriteNoteSectionTool, {
      path: 'Log.md',
      heading: 'Monday',
      content: 'x',
      format: 'json',
    }),
  );
  h.app.vault.put(
    'Log.md',
    `${NOTE}\n## Wednesday\nchores\n`.replace('chores', 'chores, then a walk'),
  );
  const pending = reviewProposal(h.app as never, json.proposal);
  (await nextModal()).approve();
  assert.equal((await pending).applied, true);
  const text = await h.app.vault.adapter.read('Log.md');
  assert.match(text, /work\n\nx\n/);
  assert.match(text, /chores, then a walk/);
});
