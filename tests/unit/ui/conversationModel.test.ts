import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  applyVoiceEvent,
  argPreview,
  clipPreview,
  continuesTurn,
  formatDuration,
  settleSpeech,
  toolMeta,
  type TranscriptLine,
} from '../../../src/ui/conversationModel';

test('tools get plain labels, icons and categories; MCP and unknown tools fall back', () => {
  assert.deepEqual(toolMeta('activate_skill'), {
    label: 'Used a skill',
    icon: 'sparkles',
    category: 'skill',
  });
  assert.equal(toolMeta('memory_recall').category, 'memory');
  assert.equal(toolMeta('delete_obsidian_note').category, 'delete');
  assert.deepEqual(toolMeta('mcp__github__list_issues'), {
    label: 'List issues (github)',
    icon: 'plug',
    category: 'mcp',
  });
  assert.deepEqual(toolMeta('some_new_tool'), {
    label: 'Some new tool',
    icon: 'wrench',
    category: 'other',
  });
});

test('the argument preview picks the telling argument and keeps it short', () => {
  assert.equal(argPreview({ format: 'json', query: 'graph  theory\nnotes' }), 'graph theory notes');
  assert.equal(argPreview({ name: 'pdf-tools', path: 'x.md' }), 'pdf-tools');
  assert.equal(argPreview({ depth: 3, other: 'fallback' }), 'fallback');
  assert.equal(argPreview({ depth: 3 }), '');
  assert.equal(argPreview(undefined), '');
  const long = argPreview({ query: 'a'.repeat(100) }, 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

test('durations read naturally', () => {
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(4200), '4.2 s');
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(125_000), '2m 05s');
  assert.equal(formatDuration(3_900_000), '1h 05m');
  assert.equal(formatDuration(-1), '');
});

test('speech: an interim line is updated in place, then a new one starts', () => {
  const lines: TranscriptLine[] = [];
  const a = applyVoiceEvent(
    lines,
    { type: 'transcript', role: 'user', text: 'Find', final: false },
    1,
  );
  const b = applyVoiceEvent(
    lines,
    { type: 'transcript', role: 'user', text: 'Find my notes', final: true },
    2,
  );
  assert.equal(a, b);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Find my notes');
  assert.equal(lines[0].rev, 1);
  applyVoiceEvent(lines, { type: 'transcript', role: 'assistant', text: 'Sure', final: true }, 3);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].kind, 'speech');
  assert.equal(
    applyVoiceEvent(lines, { type: 'transcript', role: 'user', text: '  ', final: false }, 4),
    null,
  );
});

test('a tool call is one card: started, then finished with its result and time', () => {
  const lines: TranscriptLine[] = [];
  applyVoiceEvent(
    lines,
    { type: 'tool', name: 'search_vault', phase: 'start', id: 't1', args: { query: 'x' } },
    100,
  );
  applyVoiceEvent(lines, { type: 'tool', name: 'read_file', phase: 'start', id: 't2' }, 110);
  const end = applyVoiceEvent(
    lines,
    { type: 'tool', name: 'search_vault', phase: 'end', id: 't1', result: '3 notes', ms: 40 },
    150,
  );
  assert.equal(lines.length, 2);
  assert.equal(end, lines[0]);
  assert.equal(lines[0].tool?.status, 'done');
  assert.equal(lines[0].tool?.result, '3 notes');
  assert.equal(lines[0].tool?.ms, 40);
  assert.equal(lines[0].text, 'search_vault finished');
  assert.equal(lines[1].tool?.status, 'running');
});

test('a tool error marks the card failed; an end without an id matches by name', () => {
  const lines: TranscriptLine[] = [];
  applyVoiceEvent(lines, { type: 'tool', name: 'backend agent', phase: 'start' }, 10);
  applyVoiceEvent(
    lines,
    { type: 'tool', name: 'backend agent', phase: 'end', error: 'timed out' },
    30,
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tool?.status, 'failed');
  assert.equal(lines[0].tool?.error, 'timed out');
  assert.equal(lines[0].tool?.ms, 20);
  assert.equal(lines[0].text, 'backend agent failed: timed out');
});

test('an end with no start still shows a card', () => {
  const lines: TranscriptLine[] = [];
  applyVoiceEvent(lines, { type: 'tool', name: 'read_file', phase: 'end', id: 'z' }, 5);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tool?.status, 'done');
});

test('turns: same speaker continues, tools belong to the agent, status lines stand alone', () => {
  const user: TranscriptLine = { role: 'user', text: 'a', final: true, kind: 'speech' };
  const agent: TranscriptLine = { role: 'assistant', text: 'b', final: true, kind: 'speech' };
  const tool: TranscriptLine = { role: 'tool', text: 'c', final: true, kind: 'tool' };
  const status: TranscriptLine = { role: 'tool', text: 'd', final: true, kind: 'status' };
  assert.equal(continuesTurn(undefined, user), false);
  assert.equal(continuesTurn(user, user), true);
  assert.equal(continuesTurn(user, agent), false);
  assert.equal(continuesTurn(agent, tool), true);
  assert.equal(continuesTurn(status, status), false);
  assert.equal(continuesTurn(status, agent), false);
});

test('previews clip at a line break when one is near', () => {
  assert.equal(clipPreview('  short  '), 'short');
  const text = `${'a'.repeat(80)}\n${'b'.repeat(80)}`;
  assert.equal(clipPreview(text, 100), `${'a'.repeat(80)}\n…`);
  assert.equal(clipPreview('x'.repeat(200), 100), `${'x'.repeat(100)}\n…`);
});

test('only the newest line can still be live: anything after a line settles it', () => {
  const lines: TranscriptLine[] = [];
  // GPT-Live never sends final transcripts.
  applyVoiceEvent(lines, { type: 'transcript', role: 'user', text: 'Hi', final: false }, 1);
  applyVoiceEvent(lines, { type: 'transcript', role: 'assistant', text: 'Hello', final: false }, 2);
  assert.equal(lines[0].final, true);
  assert.equal(lines[1].final, false);
  applyVoiceEvent(lines, { type: 'tool', name: 'relay_to_orchestrator', phase: 'start' }, 3);
  assert.equal(lines[1].final, true);
  applyVoiceEvent(lines, { type: 'transcript', role: 'user', text: 'Thanks', final: false }, 4);
  assert.deepEqual(
    lines.map(l => l.final),
    [true, true, true, false],
  );
  settleSpeech(lines);
  assert.ok(lines.every(l => l.final));
});

test('the orchestrator has its own turns, apart from the voice', () => {
  const voice: TranscriptLine = { role: 'assistant', text: 'a', final: true, kind: 'speech' };
  const orch: TranscriptLine = {
    role: 'tool',
    text: 'b',
    final: true,
    kind: 'tool',
    by: 'orchestrator',
  };
  assert.equal(continuesTurn(voice, orch), false);
  assert.equal(continuesTurn(orch, { ...orch }), true);
  assert.equal(continuesTurn(orch, voice), false);
});
