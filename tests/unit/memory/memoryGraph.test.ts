import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { GraphEngine, loadRelate, setRelateWasmForTests } from '../../../src/memory/relateEngine';
import {
  MemoryGraph,
  mergeSnapshots,
  parseRef,
  unboundedReason,
  withRowLimit,
} from '../../../src/memory/MemoryGraph';
import { DEFAULT_MEMORY, MemoryService } from '../../../src/memory/MemoryService';
import type { MemorySettings, MemoryStore } from '../../../src/memory/MemoryService';

before(async () => {
  setRelateWasmForTests(
    readFileSync(join(process.cwd(), 'node_modules/@relate/relate-wasm/relate_bg.wasm')),
  );
  await loadRelate();
});

test('the read-only check refuses writes, including inside a subquery', () => {
  const engine = new GraphEngine();
  engine.must('CREATE (:Fact {key: "a", text: "hello"})');
  const allowed = [
    'MATCH (n) RETURN n LIMIT 5',
    'MATCH (f:Fact) WHERE f.key = $k RETURN f.text',
    'CALL db.labels()',
    'MATCH (n) RETURN labels(n), count(*)',
    'MATCH (f:Fact) RETURN f.text AS text // CREATE in a comment',
    "MATCH (f:Fact) WHERE f.text = 'SET me' RETURN f",
  ];
  for (const q of allowed) assert.equal(engine.writeCheck(q, { k: 'a' }), null, q);
  const refused = [
    'CREATE (:X)',
    'MATCH (n) SET n.q = 1',
    'MATCH (n) DETACH DELETE n',
    'MERGE (:X {key: 1})',
    'MATCH (n) CALL { WITH n SET n.q = 1 } RETURN n',
    'MATCH (n) RETURN n; MATCH (m) DELETE m',
    'EXPLAIN MATCH (n) RETURN n',
    'DROP INDEX fact_text',
    'LOAD CSV FROM "file:///x" AS row RETURN row',
    'CALL db.createLabel("X")',
  ];
  for (const q of refused) assert.notEqual(engine.writeCheck(q), null, q);
  assert.equal(engine.must('MATCH (n) RETURN count(n) AS c').rows[0].c, 1);
  engine.dispose();
});

test('a fact in a slot closes the slot’s earlier fact, and recall finds the current one', () => {
  let now = 1_700_000_000_000;
  const graph = new MemoryGraph({ now: () => (now += 1000) });
  const first = graph.remember({
    text: 'Hani prefers morning check-ins',
    kind: 'preference',
    slot: 'check-in time',
    about: ['person:Hani'],
    agent: 'voice',
  });
  const second = graph.remember({
    text: 'Hani prefers evening check-ins',
    kind: 'preference',
    slot: 'check-in time',
    about: ['person:Hani'],
    agent: 'orchestrator',
  });
  assert.deepEqual(second.closed, [first.key]);
  const current = graph.recall({ query: 'check-ins' });
  assert.deepEqual(
    current.map(f => f.text),
    ['Hani prefers evening check-ins'],
  );
  const all = graph.recall({ query: 'check-ins', includeClosed: true });
  assert.equal(all.length, 2);
  const about = graph.recall({ about: 'Hani' });
  assert.equal(about.length, 1);
  assert.deepEqual(about[0].about, ['Hani']);
  assert.ok(graph.forget(second.key, 'wrong', 'chat'));
  assert.equal(graph.recall({ query: 'check-ins' }).length, 0);
  graph.dispose();
});

test('state, sessions, tasks and the brief', () => {
  let now = 1_700_000_000_000;
  const graph = new MemoryGraph({ now: () => (now += 1000) });
  graph.startSession('call-1', 'call', 'Planning call');
  graph.endSession('call-1', 'Planned the vault cleanup.');
  graph.startSession('call-2', 'call', 'Second call');
  graph.recordTask({ key: 't1', title: 'Tidy inbox notes', status: 'running', session: 'call-2' });
  graph.setState('global', 'Focus', 'vault cleanup', 'orchestrator');
  graph.setState('call-2', 'topic', 'inbox', 'voice');
  graph.remember({ text: 'Always link new notes to a MOC', kind: 'instruction', agent: 'voice' });
  graph.remember({
    text: 'The inbox has 40 notes',
    agent: 'worker',
    task: 't1',
    about: ['[[Inbox]]'],
  });
  const brief = graph.brief({ session: 'call-2' });
  assert.match(brief, /Always link new notes to a MOC/);
  assert.match(brief, /The inbox has 40 notes \(about Inbox\)/);
  assert.match(brief, /Tidy inbox notes \(running\)/);
  assert.match(brief, /Planned the vault cleanup/);
  assert.match(brief, /focus = vault cleanup/);
  assert.match(brief, /this session: topic = inbox/);
  graph.setState('global', 'focus', '', 'voice');
  assert.doesNotMatch(graph.brief(), /focus =/);
  graph.recordTask({ key: 't1', title: 'Tidy inbox notes', status: 'done', result: 'ok' });
  assert.doesNotMatch(graph.brief(), /Tidy inbox notes/);
  const follows = graph.query(
    'MATCH (:Session {key: $a})-[:FOLLOWS]->(p:Session) RETURN p.key AS key',
    { a: 'call-2' },
  );
  assert.deepEqual(follows.rows, [{ key: 'call-1' }]);
  graph.dispose();
});

test('query is read-only and capped', () => {
  const graph = new MemoryGraph();
  for (let i = 0; i < 5; i++) graph.remember({ text: `fact ${i}`, agent: 'chat' });
  const r = graph.query('MATCH (f:Fact) RETURN f.text AS text ORDER BY text', {}, 3);
  assert.equal(r.rows.length, 3);
  assert.ok(r.truncated);
  assert.throws(() => graph.query('MATCH (f:Fact) DETACH DELETE f'), /Refused/);
  assert.equal(graph.stats().Fact, 5);
  graph.dispose();
});

test('a snapshot round-trips, and two copies merge without losing anything', () => {
  let now = 1_700_000_000_000;
  const a = new MemoryGraph({ now: () => (now += 1000) });
  const kept = a.remember({ text: 'Shared fact', about: ['project:Voice Agent'], agent: 'voice' });
  a.relate('project:Voice Agent', 'part of', 'project:PKM');
  const snapA = a.snapshot();
  const b = new MemoryGraph({ now: () => (now += 1000) });
  b.load(snapA);
  assert.deepEqual(b.stats(), a.stats());
  b.remember({ text: 'Only on the phone', agent: 'voice' });
  a.forget(kept.key, 'outdated', 'chat');
  const merged = mergeSnapshots(a.snapshot(), b.snapshot());
  const c = new MemoryGraph();
  c.load(merged);
  assert.equal(c.stats().Fact, 2);
  // The close on one device wins over the open copy on the other.
  assert.deepEqual(
    c.recall({}).map(f => f.text),
    ['Only on the phone'],
  );
  assert.equal(c.query('MATCH ()-[r:RELATED]->() RETURN r.kind AS kind').rows[0].kind, 'part of');
  for (const g of [a, b, c]) g.dispose();
});

test('a merge keeps a clear, and one current fact per slot', () => {
  let now = 1_700_000_000_000;
  const a = new MemoryGraph({ now: () => (now += 1000) });
  a.setState('global', 'focus', 'Garden', 'voice');
  const b = new MemoryGraph({ now: () => (now += 1000) });
  b.load(a.snapshot());
  a.setState('global', 'focus', '', 'voice');
  a.remember({ text: 'Prefers detailed answers', slot: 'answer style', agent: 'voice' });
  b.remember({ text: 'Prefers bullet answers', slot: 'answer style', agent: 'voice' });
  b.setState('global', 'other', 'x', 'voice');
  const c = new MemoryGraph();
  c.load(mergeSnapshots(a.snapshot(), b.snapshot()));
  assert.deepEqual(
    c.getState(['global']).map(s => s.name),
    ['other'],
  );
  assert.deepEqual(
    c.recall({}).map(f => f.text),
    ['Prefers bullet answers'],
  );
  assert.doesNotMatch(c.brief(), /focus =|detailed/);
  for (const g of [a, b, c]) g.dispose();
});

test('references parse into notes and entities', () => {
  assert.deepEqual(parseRef('[[Projects/Voice Agent|VA]]'), {
    label: 'Note',
    key: 'Projects/Voice Agent.md',
    name: 'Projects/Voice Agent',
    kind: 'note',
  });
  assert.equal(parseRef('Person: Hani ').key, 'person:hani');
  assert.equal(parseRef('relate').key, 'thing:relate');
});

// ── The service: saving, sync merges and the never-clear rule ──

function vault(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const store: MemoryStore = {
    exists: async p => files.has(p) || [...files.keys()].some(f => f.startsWith(`${p}/`)),
    read: async p => {
      const text = files.get(p);
      if (text === undefined) throw new Error(`missing ${p}`);
      return text;
    },
    write: async (p, data) => {
      files.set(p, data);
    },
    mkdir: async () => undefined,
  };
  return { files, store };
}

function service(store: MemoryStore, extra: Partial<MemorySettings> = {}) {
  const settings: MemorySettings = { ...DEFAULT_MEMORY, enabled: true, ...extra };
  return new MemoryService({ settings: () => settings, store });
}

test('the service saves to the vault and a new session reads it back', async () => {
  const { files, store } = vault();
  const first = service(store);
  await first.use(g =>
    g.remember({ text: 'Prefers short answers', kind: 'preference', agent: 'voice' }),
  );
  await first.close();
  const saved = JSON.parse(files.get('Voice Agent/Memory/memory.json') ?? '{}');
  assert.equal(saved.format, 'voice-agent-memory');
  const second = service(store);
  await second.open();
  assert.match(second.brief(), /Prefers short answers/);
  assert.match(second.brief(), /memory_recall/);
  const sessions = await second.use(g =>
    g.query(
      'MATCH (s:Session) RETURN s.kind AS kind, s.endedAt IS NOT NULL AS ended ORDER BY s.startedAt',
    ),
  );
  assert.deepEqual(sessions.rows, [
    { kind: 'app', ended: true },
    { kind: 'app', ended: false },
  ]);
  await second.close();
});

test('a copy that sync brings is merged, not overwritten', async () => {
  const { files, store } = vault();
  const here = service(store);
  await here.use(g => g.remember({ text: 'Written here', agent: 'chat' }));
  await here.flush();
  // Another device wrote its own copy over the file.
  const there = new MemoryGraph();
  there.remember({ text: 'Written on the phone', agent: 'voice' });
  files.set(here.path, JSON.stringify(there.snapshot()));
  there.dispose();
  await here.onFileChanged(here.path);
  await here.flush();
  const texts = (await here.use(g => g.recall({}))).map(f => f.text).sort();
  assert.deepEqual(texts, ['Written here', 'Written on the phone']);
  const onDisk = JSON.parse(files.get(here.path) ?? '{}');
  assert.equal(onDisk.nodes.Fact.length, 2);
  await here.close();
});

test('a memory file that cannot be read is never replaced', async () => {
  const { files, store } = vault({ 'Voice Agent/Memory/memory.json': '{not json' });
  const s = service(store);
  await s.use(g => g.remember({ text: 'Kept in memory only', agent: 'chat' }));
  await s.close();
  assert.equal(files.get('Voice Agent/Memory/memory.json'), '{not json');
  assert.match(s.problem ?? '', /could not be read/);
});

test('agents’ Cypher through the service is read-only', async () => {
  const { store } = vault();
  const s = service(store);
  await s.use(g => g.remember({ text: 'A fact', agent: 'chat' }));
  const r = await s.query('MATCH (f:Fact) RETURN f.text AS text', {}, 10);
  assert.deepEqual(r.rows, [{ text: 'A fact' }]);
  await assert.rejects(s.query('MATCH (f:Fact) SET f.text = "x"', {}, 10), /Refused/);
  await assert.rejects(
    s.query('MATCH (f:Fact) CALL { WITH f DELETE f } RETURN 1', {}, 10),
    /Refused/,
  );
  assert.equal((await s.use(g => g.recall({})))[0].text, 'A fact');
  await s.close();
});

test('the service stays out of the way when memory is off', async () => {
  const { files, store } = vault();
  const s = service(store, { enabled: false });
  assert.equal(s.brief(), '');
  await assert.rejects(s.open(), /off/);
  s.quietly(() => assert.fail('should not run'));
  await s.close();
  assert.equal(files.size, 0);
});

test('a half-synced file is read again, and a good read lifts the block', async () => {
  const { files, store } = vault();
  const problems: (string | null)[] = [];
  const settings: MemorySettings = { ...DEFAULT_MEMORY, enabled: true };
  const s = new MemoryService({
    settings: () => settings,
    store,
    sleep: async () => undefined,
    onProblem: p => problems.push(p),
  });
  await s.use(g => g.remember({ text: 'Likes tea', kind: 'preference', agent: 'voice' }));
  await s.flush();
  const path = 'Voice Agent/Memory/memory.json';
  const good = files.get(path) as string;
  // Sync writes the file in pieces: a torn copy blocks saving and says so.
  files.set(path, good.slice(0, 20));
  await s.onFileChanged(path);
  assert.match(s.problem ?? '', /could not be read/);
  assert.equal(problems.length, 1);
  // The finished copy arrives: saving resumes.
  files.set(path, good);
  await s.onFileChanged(path);
  assert.equal(s.problem, null);
  assert.deepEqual(problems.at(-1), null);
  await s.use(g => g.remember({ text: 'Walks at noon', kind: 'fact', agent: 'voice' }));
  await s.flush();
  assert.match(files.get(path) ?? '', /Walks at noon/);
});

test('changing the memory folder copies the file and leaves the old one', async () => {
  const { files, store } = vault();
  const settings: MemorySettings = { ...DEFAULT_MEMORY, enabled: true };
  const s = new MemoryService({ settings: () => settings, store });
  await s.use(g => g.remember({ text: 'Likes tea', kind: 'preference', agent: 'voice' }));
  await s.changeFolder(async () => {
    settings.folder = 'Elsewhere';
  });
  assert.match(files.get('Voice Agent/Memory/memory.json') ?? '', /Likes tea/);
  assert.match(files.get('Elsewhere/memory.json') ?? '', /Likes tea/);
  assert.equal(
    [...files.keys()].filter(k => /^E|^El|^N\//.test(k) && k !== 'Elsewhere/memory.json').length,
    0,
  );
});

test('agent queries get a row limit and a bounded range()', () => {
  assert.equal(withRowLimit('MATCH (n) RETURN n', 25), 'MATCH (n) RETURN n LIMIT 26');
  assert.equal(withRowLimit('MATCH (n) RETURN n LIMIT 5', 25), 'MATCH (n) RETURN n LIMIT 5');
  assert.equal(withRowLimit('CALL db.labels()', 25), 'CALL db.labels()');
  assert.match(unboundedReason('UNWIND range(1, 3e6) AS i RETURN count(i)'), /limited/);
  assert.equal(unboundedReason('UNWIND range(1, 100) AS i RETURN i'), '');
});

test('tasks cut off by an earlier quit are closed, this session’s stay open', () => {
  const g = new MemoryGraph();
  g.recordTask({ key: 'app-old-t1', title: 'Look up oxygen cascade', status: 'running' });
  g.recordTask({ key: 'app-new-t1', title: 'Current work', status: 'running' });
  g.recordTask({ key: 'durable-1-t1', title: 'Durable work', status: 'running' });
  assert.equal(g.closeStaleTasks('app-new'), 1);
  const brief = g.brief();
  assert.doesNotMatch(brief, /oxygen cascade/);
  assert.match(brief, /Open tasks:/);
  assert.match(brief, /Current work/);
  assert.match(brief, /Durable work/);
  g.dispose();
});
