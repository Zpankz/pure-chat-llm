import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProposal, peerReview } from '../../../src/agents/peerReview';
import { createApp } from '../obsidian-mock';
import { fakeReviewer, writeSettings } from './helpers';

/** A plugin with one note, for calling the reviewers directly. */
function plugin() {
  const app = createApp();
  app.vault.put('Notes/a.md', '# A\nkeep this\n');
  return { app, settings: writeSettings() } as never;
}

test('current behaviour: an empty reviewer answer counts as a rejection', async () => {
  const fake = fakeReviewer(() => '');
  try {
    const p = plugin();
    const proposal = await buildProposal(p, 'Notes/a.md', '# A\nkeep this\nmore\n', 'add', 'edit');
    const verdict = await peerReview(p, proposal);
    assert.equal(verdict.approved, false);
    assert.equal(fake.calls.length, 2);
    // Each reviewer is capped at 200 tokens, which a reasoning model at high effort can spend
    // before it writes any answer.
    assert.equal(fake.calls[0].maxTokens, 200);
    assert.equal(fake.calls[0].effort, 'xhigh');
    assert.match(verdict.verdicts[0], /rejected/);
  } finally {
    fake.restore();
  }
});
