import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../obsidian-mock';
import { CallRecorder, type CallLine } from '../../../src/agents/CallRecorder';
import type { SubAgentTask } from '../../../src/agents/types';

(globalThis as unknown as { window: unknown }).window = globalThis;

/**
 * @param voiceRole - Orchestrator voice role.
 */
function setup(voiceRole: string, callNotes: 'topics' | 'transcript' = 'transcript') {
  const app = createApp();
  const tasks = new Map<string, SubAgentTask>();
  const plugin = {
    app,
    settings: {
      voice: { saveCalls: true, callsFolder: 'Voice Agent', callNotes },
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

test('a call split into topics: notes per topic, branching links, an index', async () => {
  const { app, recorder, task } = setup('layered', 'topics');
  const t0 = Date.now();
  const lines: CallLine[] = [];
  const record = recorder.start('GPT Live', () => lines);
  assert.ok(record);
  const say = (role: 'user' | 'assistant', text: string, at: number) =>
    lines.push({ role, text, at });

  // The first named topic takes over the opening note, since nothing was said under it yet.
  say('user', 'Let us talk about folder notes for calls', t0 + 10);
  assert.match(recorder.newTopic('Folder notes', 'concept'), /Topic 1 is now/);
  say('assistant', 'Sure.', t0 + 20);
  recorder.logOrchestrator('input', 'Plan folder notes', true);
  const t1 = task('t1', 'Plan');
  recorder.attachTask(t1);

  // A new idea, then a branch back from topic 1, joining topic 2.
  say('user', 'What about Zettelkasten notes', Date.now() + 1);
  assert.match(recorder.newTopic('Zettelkasten notes', 'idea'), /Topic 2/);
  say('user', 'Or an alternative using canvases', Date.now() + 2);
  const msg = recorder.newTopic('Canvas layout', 'alternative', ['1', 'zettelkasten', 'nope']);
  assert.match(msg, /Topic 3 "Canvas layout" started, following 1 "Folder notes" and 2/);
  assert.match(msg, /No earlier topic matched "nope"/);
  assert.match(recorder.returnToTopic('Folder notes'), /Back on topic 1/);
  assert.match(recorder.returnToTopic('missing'), /^Error: NotFound/);

  await recorder.finish();
  await recorder.flush();

  const [one, two, three] = record.topics;
  assert.equal(one.path, `${record.folder}/${record.stamp} 01 Folder notes.md`);
  assert.equal(
    app.vault.getAbstractFileByPath(`${record.folder}/${record.stamp} 01 Start of the call.md`),
    null,
  );
  assert.deepEqual(three.followsFrom, [1, 2]);
  assert.equal(t1.topicNote, one.path);

  const index = app.vault.contents.get(record.callPath) ?? '';
  assert.match(index, /## Map/);
  assert.ok(index.indexOf('01 Folder notes') < index.indexOf('02 Zettelkasten notes'));
  assert.match(index, /also from \[\[[^\]]*02 Zettelkasten notes\|Zettelkasten notes\]\]/);
  assert.match(index, /## Flow/);

  const n1 = app.vault.contents.get(one.path) ?? '';
  const n2 = app.vault.contents.get(two.path) ?? '';
  const n3 = app.vault.contents.get(three.path) ?? '';
  // The words that opened each topic are in its note, with hand-offs inline.
  assert.match(n1, /folder notes for calls/);
  assert.match(n1, /Passed to the \[\[.*#\^relay-1\|orchestrator\]\]/);
  assert.match(n2, /Zettelkasten notes/);
  assert.match(n3, /alternative using canvases/);
  // Links both ways between topics.
  assert.match(n3, /follows_from:/);
  assert.ok(n1.includes('## Leads to') && n1.includes('02 Zettelkasten notes'));
  assert.ok(n2.includes('03 Canvas layout'));
  assert.match(n1, /type: voice-topic/);
  // The orchestrator's relay links back to the topic it came from.
  const orch = app.vault.contents.get(record.orchestratorPath as string) ?? '';
  assert.match(orch, /Relayed from \[\[[^\]]*01 Folder notes\|Folder notes\]\] in/);
});

test('topics are refused when the call is laid out as one transcript', () => {
  const { recorder } = setup('layered', 'transcript');
  recorder.start('x', () => []);
  assert.match(recorder.newTopic('Anything', 'idea'), /^Error: NoCall/);
  void recorder.finish();
});

test('moving call notes never waits on an "Update links?" prompt', async () => {
  const { app, recorder, task } = setup('layered', 'topics');
  // fileManager.renameFile can open a prompt and wait for an answer; make it hang like one.
  let prompted = 0;
  (app.fileManager as unknown as { renameFile: () => Promise<void> }).renameFile = () => {
    prompted++;
    return new Promise(() => undefined);
  };
  const lines: CallLine[] = [];
  const record = recorder.start('GPT Live', () => lines);
  assert.ok(record);
  await recorder.flush();
  // The opening topic is renamed, then the orchestrator gains a thread and moves into a folder.
  recorder.newTopic('Sleep notes', 'concept');
  recorder.logOrchestrator('input', 'Find my notes on sleep', true);
  await recorder.flush();
  recorder.attachTask(task('t1', 'Sleep notes'));
  lines.push({ role: 'user', text: 'Find my notes on sleep', at: Date.now() + 1000 });
  const done = await Promise.race([
    recorder
      .finish()
      .then(() => recorder.flush())
      .then(() => 'saved'),
    new Promise(resolve => setTimeout(() => resolve('stalled'), 2000)),
  ]);
  assert.equal(done, 'saved');
  assert.equal(prompted, 0);
  const { stamp, folder } = record;
  assert.ok(app.vault.contents.has(`${folder}/${stamp} 01 Sleep notes.md`));
  assert.ok(app.vault.contents.has(`${folder}/${stamp} orchestrator/${stamp} orchestrator.md`));
});

test('a thread the voice starts from a topic lands on its own line there', async () => {
  const { app, recorder, task } = setup('direct', 'topics');
  const lines: CallLine[] = [];
  const record = recorder.start('GPT Live', () => lines);
  assert.ok(record);
  recorder.newTopic('Bohr equation', 'concept');
  lines.push({ role: 'user', text: 'Who uses the Bohr equation?', at: Date.now() + 10 });
  const t = task('t2', 'Bohr equation users');
  recorder.attachTask(t);
  await recorder.finish();
  await recorder.flush();
  const topic = record.topics[0];
  assert.equal(t.parentNote, topic.path);
  assert.equal(t.parentAnchor, 'spawn-t2');
  const note = app.vault.contents.get(topic.path) ?? '';
  // The thread links back at #^spawn-t2, so the topic must define that block on its own line.
  assert.match(note, /^.*→ Started \[\[.*t2 Bohr equation users.*\]\] \^spawn-t2$/m);
  assert.doesNotMatch(note, /^> .*\^spawn-t2/m);
});
