import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BacklinksTool } from '../../../src/tools/Backlinks';
import { TraverseGraphTool } from '../../../src/tools/TraverseGraph';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { CASE, CSHT, FOLDER_NOTE, LO_VAULT, PK, PROPOFOL, READING, START, VD } from './fixtures';

interface Json {
  summary: string;
  start: string;
  counts: Record<string, number>;
  truncated: boolean;
  hint: string;
  nodes: Array<{
    path: string;
    hop: number;
    parent: string;
    via: string;
    types: string[];
    route: Array<{ path: string; via: string }>;
  }>;
  edges: Array<{ from: string; to: string; type: string; subpath: string }>;
  unresolved: Array<{ from: string; name: string; type: string }>;
  omitted: { edges: number; unresolved: number };
}

async function traverse(
  h: ReturnType<typeof toolHarness>,
  args: Record<string, unknown>,
): Promise<Json> {
  const out = await h.run(TraverseGraphTool, { ...args, format: 'json' });
  assert.ok(!isToolError(out), out);
  return JSON.parse(out) as Json;
}

const at = (j: Json) => Object.fromEntries(j.nodes.map(n => [n.path, n.hop]));

test('8:20 PM voice test: the answer two hops out is found, where backlinks alone gave up', async () => {
  const h = toolHarness(LO_VAULT);
  const file = h.app.vault.getFileByPath(START);
  h.app.workspace.getActiveFile = () => file;

  // What the old agent did: one hop of backlinks. Nothing, so it stopped.
  const backlinks = await h.run(BacklinksTool, { path: 'active' });
  assert.ok(!isToolError(backlinks), backlinks);
  assert.match(backlinks.split('\n')[0], /AP11AO402 has no backlinks, but it links out to 2 notes/);
  assert.match(backlinks, /direction both/);

  // traverse_graph with no arguments: the active note, both directions, two hops.
  const text = await h.run(TraverseGraphTool, {});
  assert.match(text.split('\n')[0], /^Found 5 connected notes within 2 hops of AP11AO402/);
  assert.match(text, /Medicine\/Drugs\/Propofol\.md \[drug\] \(→ link from .*Context sensitive/);
  assert.match(
    text,
    /Volume of distribution\.md \[principle\] \(→ principle from .*Pharmacokinetics/,
  );

  const j = await traverse(h, {});
  assert.deepEqual(at(j), { [START]: 0, [CSHT]: 1, [PK]: 1, [PROPOFOL]: 2, [READING]: 2, [VD]: 2 });
  const propofol = j.nodes.find(n => n.path === PROPOFOL)!;
  assert.deepEqual(propofol, {
    path: PROPOFOL,
    hop: 2,
    parent: CSHT,
    via: 'out:link',
    types: ['drug'],
    route: [
      { path: CSHT, via: 'out:link' },
      { path: PROPOFOL, via: 'out:link' },
    ],
  });
  assert.equal(j.nodes.find(n => n.path === PK)!.via, 'out:concept');
  assert.equal(j.nodes.find(n => n.path === READING)!.via, 'in:link');
  assert.equal(j.counts.start_backlinks, 0);
  assert.equal(j.counts.start_outgoing, 2);
  assert.deepEqual(j.unresolved, [{ from: CSHT, name: 'Missing note', type: 'link' }]);
});

test('direction and depth: outgoing only, backlinks only, and three hops both ways', async () => {
  const h = toolHarness(LO_VAULT);
  const out = await traverse(h, { note: START, direction: 'out' });
  assert.deepEqual(Object.keys(at(out)).sort(), [START, CSHT, PK, PROPOFOL, VD].sort());

  const inOnly = await traverse(h, { note: START, direction: 'in', depth: 3 });
  assert.equal(inOnly.counts.nodes, 0);
  assert.match(inOnly.hint, /direction both/);

  const three = await traverse(h, { note: START, depth: 3 });
  assert.equal(at(three)[CASE], 3);
  assert.equal(three.nodes.find(n => n.path === CASE)!.via, 'in:link');

  const fromDrug = await traverse(h, { note: 'Propofol', direction: 'in', depth: 2 });
  assert.deepEqual(at(fromDrug), {
    [PROPOFOL]: 0,
    [CASE]: 1,
    [CSHT]: 1,
    [FOLDER_NOTE]: 1,
    [START]: 2,
  });
});

test('edge_types follow only typed relations (or only plain links)', async () => {
  const h = toolHarness(LO_VAULT);
  const typed = await traverse(h, { note: START, depth: 3, edge_types: ['concept', 'principle'] });
  assert.deepEqual(at(typed), { [START]: 0, [PK]: 1, [VD]: 2 });
  assert.match(typed.summary, /through concept and principle relations/);

  const caseless = await traverse(h, { note: START, depth: 3, edge_types: 'Concept, PRINCIPLE' });
  assert.deepEqual(at(caseless), at(typed));

  const plain = await traverse(h, { note: START, direction: 'out', edge_types: ['link'] });
  assert.deepEqual(at(plain), { [START]: 0, [CSHT]: 1, [PROPOFOL]: 2 });

  const none = await traverse(h, { note: START, edge_types: ['nope'] });
  assert.equal(none.counts.nodes, 0);
  assert.match(none.hint, /Relations used in this vault include: .*concept/);
});

test('folder, tag and node_types pick the notes listed; the walk passes through others', async () => {
  const h = toolHarness(LO_VAULT);
  const drugs = await traverse(h, { note: START, folder: 'Drugs' });
  assert.deepEqual(at(drugs), { [START]: 0, [PROPOFOL]: 2 });
  assert.equal(drugs.nodes[1].parent, CSHT);
  // The note between is hidden by the filter, but the route still shows how Propofol connects.
  assert.deepEqual(
    drugs.nodes[1].route.map(s => s.path),
    [CSHT, PROPOFOL],
  );
  const deep = await traverse(h, { note: START, depth: 3, folder: 'Cases' });
  assert.deepEqual(deep.nodes[1].route, [
    { path: CSHT, via: 'out:link' },
    { path: PROPOFOL, via: 'out:link' },
    { path: CASE, via: 'in:link' },
  ]);
  const deepText = await h.run(TraverseGraphTool, { note: START, depth: 3, folder: 'Cases' });
  assert.match(deepText, /route AP11AO402 > Context sensitive half time > Propofol/);
  assert.ok(drugs.counts.walked_through >= 2);

  const stay = await traverse(h, { note: START, folder: 'Drugs', stay_in_scope: true });
  assert.equal(stay.counts.nodes, 0);
  assert.match(stay.hint, /stay_in_scope false/);

  const tagged = await traverse(h, { note: START, tag: '#pharm' });
  assert.deepEqual(at(tagged), { [START]: 0, [PROPOFOL]: 2, [VD]: 2 });

  const typed = await traverse(h, { note: START, node_types: ['drug'] });
  assert.deepEqual(at(typed), { [START]: 0, [PROPOFOL]: 2 });
  const two = await traverse(h, { note: START, node_types: 'drug,principle' });
  assert.deepEqual(at(two), { [START]: 0, [PROPOFOL]: 2, [VD]: 2 });

  const text = await h.run(TraverseGraphTool, { note: START, folder: 'Drugs' });
  assert.match(text.split('\n')[0], /^Found 1 note in Medicine\/Drugs within 2 hops of AP11AO402/);
});

test('start notes: name, [[link]], folder-qualified name, path and active', async () => {
  const h = toolHarness(LO_VAULT);
  for (const note of [
    'AP11AO402',
    '[[AP11AO402]]',
    '[[AP11AO402|the objective]]',
    'LO/AP11AO402',
    'Medicine/ANZCA/LO/AP11AO402',
    START,
    'ap11ao402',
  ]) {
    const j = await traverse(h, { note, depth: 1 });
    assert.equal(j.start, START, note);
  }
  h.app.workspace.getActiveFile = () => h.app.vault.getFileByPath(PK);
  assert.equal((await traverse(h, { depth: 1 })).start, PK);
  assert.equal((await traverse(h, { note: 'this note', depth: 1 })).start, PK);
});

test('every failure is a tool error with recovery lines', async () => {
  const h = toolHarness(LO_VAULT);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ note: 'No such note anywhere' }, /^Error: NotFound: .*\nTry:\n- search_vault/],
    [
      { note: 'Index' },
      /^Error: AmbiguousNote: 2 notes match "Index"; say which one\.\nTry:\n- note: "(Archive|Notes)\/Index\.md"/,
    ],
    [{}, /^Error: NoActiveNote: /],
    [{ note: START, folder: 'Nowhere' }, /^Error: FolderNotFound: /],
    [{ note: START, direction: 'sideways' }, /^Error: InvalidArgument: direction/],
    [{ note: START, format: 'xml' }, /^Error: InvalidArgument: format/],
  ];
  for (const [args, pattern] of cases) {
    const out = await h.run(TraverseGraphTool, args as never);
    assert.ok(isToolError(out), out);
    assert.match(out, pattern);
  }
  const backlinks = await h.run(BacklinksTool, { path: 'No such note anywhere' });
  assert.ok(isToolError(backlinks), backlinks);
});

test('get_backlinks is traverse_graph with direction in and depth 1', async () => {
  const h = toolHarness(LO_VAULT);
  for (const format of ['json', 'text']) {
    const alias = await h.run(BacklinksTool, { path: 'Pharmacokinetics', format });
    const direct = await h.run(TraverseGraphTool, {
      note: 'Pharmacokinetics',
      direction: 'in',
      depth: 1,
      max_nodes: 200,
      format,
    });
    assert.equal(alias, direct);
  }
  const j = JSON.parse(await h.run(BacklinksTool, { path: PK, format: 'json' })) as Json;
  assert.deepEqual(at(j), { [PK]: 0, [START]: 1, [READING]: 1 });
  assert.match(
    j.summary,
    /^Found 2 connected notes within 1 hop of Pharmacokinetics, following backlinks only/,
  );
  assert.match(
    new BacklinksTool(null as never, null as never).description,
    /Deprecated.*traverse_graph/,
  );
});

test('JSON is deterministic, has stable keys, and is bounded with a more-available hint', async () => {
  const h = toolHarness(LO_VAULT);
  const a = await h.run(TraverseGraphTool, { note: START, depth: 3, format: 'json' });
  // Same vault written in the opposite order: same answer, byte for byte.
  const reversed = toolHarness(Object.fromEntries(Object.entries(LO_VAULT).reverse()));
  const b = await reversed.run(TraverseGraphTool, { note: START, depth: 3, format: 'json' });
  assert.equal(a, b);
  const j = JSON.parse(a) as Json;
  assert.deepEqual(Object.keys(j), [
    'summary',
    'start',
    'depth',
    'direction',
    'edge_types',
    'filters',
    'counts',
    'truncated',
    'hint',
    'nodes',
    'edges',
    'unresolved',
    'omitted',
  ]);
  assert.deepEqual(Object.keys(j.edges[0]), ['from', 'to', 'type', 'subpath']);

  const spokes: Record<string, string> = { 'Hub.md': '# Hub' };
  for (let i = 0; i < 400; i++) spokes[`Spokes/S${String(i).padStart(3, '0')}.md`] = 'To [[Hub]].';
  const big = toolHarness(spokes);
  const small = await traverse(big, { note: 'Hub', depth: 1, max_nodes: 10 });
  assert.equal(small.nodes.length, 11);
  assert.equal(small.truncated, true);
  assert.match(small.summary, /Stopped at the limit of 10; more are available\./);
  assert.match(small.hint, /raise max_nodes/);
  assert.equal(small.nodes[1].path, 'Spokes/S000.md');

  const wide = await traverse(big, { note: 'Hub', depth: 1, max_nodes: 500 });
  assert.equal(wide.counts.nodes, 400);
  assert.equal(wide.counts.edges, 400);
  assert.equal(wide.edges.length, 300);
  assert.equal(wide.omitted.edges, 100);

  const text = await big.run(TraverseGraphTool, { note: 'Hub', depth: 1, max_nodes: 5 });
  assert.match(text, /more are available/);
  assert.ok(text.split('\n').length < 30);
});

test('a note with no links at all says so in its first line', async () => {
  const h = toolHarness({ 'Alone.md': '# Alone' });
  const text = await h.run(TraverseGraphTool, { note: 'Alone' });
  assert.ok(!isToolError(text));
  assert.match(text.split('\n')[0], /^Alone has no links in or out/);
});
