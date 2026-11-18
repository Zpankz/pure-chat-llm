import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NewTopicTool } from '../../../src/tools/TopicTool';
import { allowedIn } from '../../../src/tools/toolContract';

/**
 * @param role - Chat role.
 * @param callNotes - Call layout.
 * @param calls - Call recorder stand-in.
 */
function tool(role: string, callNotes = 'topics', calls: unknown = undefined) {
  const plugin = { settings: { voice: { saveCalls: true, callNotes } }, calls };
  return new NewTopicTool({ plugin, role } as never, {} as never);
}

test('only the voice in a call can mark topics', () => {
  for (const role of ['voice', 'orchestrator', 'direct-voice']) {
    assert.equal(tool(role).isAvailable(), true, role);
  }
  for (const role of ['agent', 'subagent', 'orchestrator-agent']) {
    assert.equal(tool(role).isAvailable(), false, role);
  }
  assert.equal(tool('voice', 'transcript').isAvailable(), false);
  assert.equal(allowedIn('new_topic', 'voice'), true);
  assert.equal(allowedIn('new_topic', 'worker'), false);
  assert.equal(allowedIn('new_topic', 'codemode'), false);
});

test('new_topic passes titles and follows_from to the recorder', async () => {
  const seen: unknown[] = [];
  const calls = {
    isLive: true,
    newTopic: (...a: unknown[]) => (seen.push(['new', ...a]), 'ok'),
    returnToTopic: (...a: unknown[]) => (seen.push(['return', ...a]), 'back'),
  };
  const t = tool('voice', 'topics', calls);
  assert.equal(await t.execute({ title: 'Idea', kind: 'idea', follows_from: '1, Canvas' }), 'ok');
  assert.equal(await t.execute({ title: 'Idea', action: 'return' }), 'back');
  assert.deepEqual(seen, [
    ['new', 'Idea', 'idea', ['1', 'Canvas']],
    ['return', 'Idea'],
  ]);
  assert.match(await tool('voice', 'topics', { isLive: false }).execute({ title: 'x' }), /NoCall/);
  assert.match(await tool('voice', 'topics', calls).execute({ title: ' ' }), /InvalidArgument/);
});
