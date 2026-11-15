import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../obsidian-mock';
import { CallRecorder, type CallLine } from '../../../src/agents/CallRecorder';
import type { SubAgentTask } from '../../../src/agents/types';

(globalThis as unknown as { window: unknown }).window = globalThis;

/**
 * @param voiceRole - Orchestrator voice role.
 */
function setup(voiceRole: string) {
  const app = createApp();
  const tasks = new Map<string, SubAgentTask>();
  const plugin = {
    app,
    settings: {
      voice: { saveCalls: true, callsFolder: 'Voice Agent' },
      orchestrator: { voiceRole },
    },
    agents: { find: (id: string) => tasks.get(id) },
    orchestrator: { label: 'Test model' },
    console: { error: () => undefined },
  };
  const recorder = new CallRecorder(plugin as never);
  const task = (id: string, title: string) => {
    const t = { id, title, origin: 'voice' } as SubAgentTask;
    tasks.set(id, t);
    return t;
  };
  return { app, recorder, task };
}

test('a layered call becomes a folder-note tree linked both ways', async () => {
  const { app, recorder, task } = setup('layered');
  const now = Date.now();
  const lines: CallLine[] = [{ role: 'user', text: 'Find my notes on sleep', at: now }];
  const record = recorder.start('GPT Live', () => lines);
  assert.ok(record);
  const { stamp, folder } = record;
  assert.equal(record.callPath, `Voice Agent/${stamp}/${stamp}.md`);

  // A user relay, then the orchestrator starts a thread.
  recorder.logOrchestrator('input', 'Find my notes on sleep', true);
  const t1 = task('t1', 'Sleep notes');
  recorder.attachTask(t1);
  lines.push({ role: 'assistant', text: 'On it.', at: Date.now() + 1000 });
  await recorder.finish();
  await recorder.flush();

  const orchPath = `${folder}/${stamp} orchestrator/${stamp} orchestrator.md`;
  assert.equal(record.orchestratorPath, orchPath, 'the orchestrator became a folder note');
  assert.equal(t1.notePath, `${folder}/${stamp} orchestrator/${stamp} t1 Sleep notes.md`);
  assert.equal(t1.parentNote, orchPath);
  assert.equal(t1.parentAnchor, 'spawn-t1');
  assert.equal(t1.callNote, record.callPath);
  assert.equal(app.vault.getAbstractFileByPath(`${folder}/${stamp} orchestrator.md`), null);

  const call = app.vault.contents.get(record.callPath) ?? '';
  const orch = app.vault.contents.get(orchPath) ?? '';
  const orchLink = orchPath.replace(/\.md$/, '');
  // Call links down to the orchestrator, inline at the relay, and to the thread.
  assert.match(call, new RegExp(`\\[\\[${escape(orchLink)}#\\^relay-1\\|orchestrator\\]\\]`));
  assert.match(call, /type: voice-call/);
  assert.ok(call.includes(t1.notePath.replace(/\.md$/, '')));
  // The relay link sits after what the user said.
  assert.ok(call.indexOf('Find my notes on sleep') < call.indexOf('Passed to the'));
  // Orchestrator links up to the call, carries the block ids, and links the thread where it started it.
  assert.ok(orch.includes(`parent: "[[${record.callPath.replace(/\.md$/, '')}]]"`));
  assert.match(orch, /\^relay-1/);
  assert.match(
    orch,
    new RegExp(
      `\\[\\[${escape(t1.notePath.replace(/\.md$/, ''))}\\|t1 Sleep notes\\]\\] \\^spawn-t1`,
    ),
  );
});

test('with the voice delegating directly, threads hang off the call', async () => {
  const { recorder, task } = setup('direct');
  const record = recorder.start('GPT Live', () => []);
  assert.ok(record);
  assert.equal(record.orchestratorPath, null);
  const t = task('t2', 'Draft email');
  recorder.attachTask(t);
  await recorder.finish();
  await recorder.flush();
  assert.equal(t.notePath, `${record.folder}/${record.stamp} t2 Draft email.md`);
  assert.equal(t.parentNote, record.callPath);
});

test('two calls in the same minute get separate folders', () => {
  const { recorder } = setup('direct');
  const a = recorder.start('x', () => []);
  void recorder.finish();
  const b = recorder.start('x', () => []);
  void recorder.finish();
  assert.ok(a && b);
  assert.notEqual(a.folder, b.folder);
});

test('recent user words are verbatim and only while live', async () => {
  const { recorder } = setup('layered');
  const lines: CallLine[] = [
    { role: 'user', text: 'one' },
    { role: 'assistant', text: 'ok' },
    { role: 'user', text: 'two' },
  ];
  recorder.start('x', () => lines);
  recorder.logTiming('relay to first spoken answer', 1234);
  assert.equal(recorder.recentUserWords(), 'one / two');
  assert.equal(recorder.current?.timings[0].ms, 1234);
  await recorder.finish();
  assert.equal(recorder.recentUserWords(), '');
});

/** @param s - Text for a RegExp. */
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
