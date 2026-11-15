import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipToolOutput, compactHistory } from '../../../src/agents/LocalSubAgentBackend';
import { spokenError } from '../../../src/agents/OrchestratorAgent';

test('a long tool output keeps its head and tail', () => {
  const output = 'A'.repeat(9000) + 'END';
  const clipped = clipToolOutput(output, 1000);
  assert.ok(clipped.length < 1200);
  assert.ok(clipped.startsWith('AAA'));
  assert.ok(clipped.endsWith('END'));
  assert.match(clipped, /characters cut/);
  assert.equal(clipToolOutput('short', 1000), 'short');
});

test('old tool outputs are dropped once the budget is passed, recent ones kept', () => {
  const messages = [
    { role: 'system', content: 'brief' },
    { role: 'user', content: 'task' },
    ...Array.from({ length: 10 }, (_, i) => ({
      role: 'tool',
      content: `${i}:` + 'x'.repeat(1000),
    })),
  ];
  const dropped = compactHistory(messages, 5000);
  assert.ok(dropped >= 4);
  assert.equal(messages[0].content, 'brief');
  assert.equal(messages[1].content, 'task');
  // The latest six outputs are always whole.
  for (const m of messages.slice(-6)) assert.ok((m.content as string).length > 1000);
  assert.match(messages[2].content as string, /dropped/);
});

test('history under the budget is left alone', () => {
  const messages = [{ role: 'tool', content: 'x'.repeat(500) }];
  assert.equal(compactHistory(messages, 5000), 0);
});

test('orchestrator errors are said in plain words', () => {
  assert.match(spokenError('HTTP 401 Unauthorized'), /sign-in/);
  assert.match(spokenError('429 rate limit'), /rate-limiting/);
  assert.match(spokenError('fetch failed'), /can't reach/);
  assert.ok(spokenError('x'.repeat(500)).length <= 160);
});
