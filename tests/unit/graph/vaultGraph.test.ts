import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInlineFields, relativeTo, VaultGraph } from '../../../src/graph/VaultGraph';
import { TraverseGraphTool } from '../../../src/tools/TraverseGraph';
import { toolHarness } from '../harness';
import { FIELDS_VAULT } from './fixtures';

const edgesFrom = (g: VaultGraph, path: string) =>
  (g.out.get(path) ?? []).map(e => `${e.type} -> ${e.to}`).sort();

test('inline fields are parsed from lines, list items, several links and brackets', () => {
  const text = [
    '---',
    'up:: [[Not a field, frontmatter]]',
    '---',
    'part-of:: [[Body]]',
    '- related:: [[Lung]], [[Kidney|kidneys]]',
    '  * [ ] has_part:: [[Valve#Mitral]]',
    '> source:: [[Book]]',
    'The pump [supplies:: [[Brain]]] and (drains:: [[Liver]]) beside [[Plain]].',
    'part-of:: [[A]] [see-also:: [[B]]]',
    '~~~',
    'fake:: [[Ghost]]',
    '~~~',
    '**bold field**:: [[Spleen]]',
    'no field here [[Plain]]',
    'indented:: [[Code]]',
  ].join('\n');
  const got = parseInlineFields(text, new Set([14])).map(f => `${f.line} ${f.field} ${f.link}`);
  assert.deepEqual(got, [
    '3 part-of Body',
    '4 related Lung',
    '4 related Kidney',
    '5 has_part Valve#Mitral',
    '6 source Book',
    '7 supplies Brain',
    '7 drains Liver',
    '8 part-of A',
    '8 see-also B',
    '12 bold field Spleen',
  ]);
  assert.deepEqual(parseInlineFields('no fields [[x]]'), []);
  assert.equal(relativeTo('Topics/sub', '../Heart'), 'Topics/Heart');
  assert.equal(relativeTo('Topics/sub', './Sibling'), 'Topics/sub/Sibling');
  assert.equal(relativeTo('', './Root'), 'Root');
  assert.equal(relativeTo('A', 'B/C'), 'B/C');
});

test('inline fields become typed edges, once each, and relative links resolve', async () => {
  const h = toolHarness(FIELDS_VAULT);
  const g = await VaultGraph.load(h.app as never);
  assert.deepEqual(edgesFrom(g, 'Topics/Heart.md'), [
    'bold field -> Topics/Spleen.md',
    'drains -> Topics/Liver.md',
    'link -> Topics/Body.md',
    'part-of -> Topics/Body.md',
    'related -> Topics/Kidney.md',
    'related -> Topics/Lung.md',
    'supplies -> Topics/Brain.md',
  ]);
  // Lung is linked once, inside a field: typed, never also a plain `link`.
  assert.equal((g.in.get('Topics/Lung.md') ?? []).length, 1);
  // The fenced `fake:: [[Ghost]]` is code, not a link.
  assert.equal(g.in.get('Topics/Ghost.md'), undefined);
  assert.deepEqual(edgesFrom(g, 'Topics/sub/Child.md'), [
    'link -> Topics/sub/Sibling.md',
    'part-of -> Topics/Heart.md',
  ]);
  const used = new Map(g.edgeTypes().map(e => [e.type, e.count]));
  assert.equal(used.get('related'), 2);
  assert.equal(used.get('part-of'), 2);
});

test('edge_types follows inline-field relations (any case) through traverse_graph', async () => {
  const h = toolHarness(FIELDS_VAULT);
  const run = async (args: Record<string, unknown>) =>
    JSON.parse(await h.run(TraverseGraphTool, { ...args, format: 'json' })) as {
      nodes: Array<{ path: string; hop: number; via: string }>;
    };
  const partOf = await run({ note: 'Child', depth: 3, edge_types: ['part-of'], direction: 'out' });
  assert.deepEqual(
    partOf.nodes.map(n => [n.path, n.hop, n.via]),
    [
      ['Topics/sub/Child.md', 0, 'start'],
      ['Topics/Heart.md', 1, 'out:part-of'],
      ['Topics/Body.md', 2, 'out:part-of'],
    ],
  );
  const caseless = await run({
    note: 'Child',
    depth: 3,
    edge_types: ['Part-Of'],
    direction: 'out',
  });
  assert.deepEqual(caseless.nodes, partOf.nodes);
  const related = await run({ note: 'Heart', depth: 1, edge_types: ['related'] });
  assert.deepEqual(
    related.nodes.map(n => n.path),
    ['Topics/Heart.md', 'Topics/Kidney.md', 'Topics/Lung.md'],
  );
});

test('the graph is reused while the vault is unchanged and only changed notes are re-read', async () => {
  const h = toolHarness(FIELDS_VAULT);
  let reads = 0;
  const read = h.app.vault.cachedRead.bind(h.app.vault);
  h.app.vault.cachedRead = async f => {
    reads++;
    return read(f);
  };
  const first = await VaultGraph.load(h.app as never);
  assert.equal(reads, Object.keys(FIELDS_VAULT).length);
  assert.equal(await VaultGraph.load(h.app as never), first);
  assert.equal(VaultGraph.for(h.app as never), first);
  assert.equal(reads, Object.keys(FIELDS_VAULT).length);

  // One note changes: a new graph, and only that note is read again.
  const lung = h.app.vault.put('Topics/Lung.md', '# Lung\npart-of:: [[Body]]');
  lung.stat.mtime += 10_000;
  const second = await VaultGraph.load(h.app as never);
  assert.notEqual(second, first);
  assert.equal(reads, Object.keys(FIELDS_VAULT).length + 1);
  assert.deepEqual(edgesFrom(second, 'Topics/Lung.md'), ['part-of -> Topics/Body.md']);

  // A note added (or removed, or renamed) changes the graph too.
  h.app.vault.put('Topics/New.md', 'part-of:: [[Heart]]');
  const third = await VaultGraph.load(h.app as never);
  assert.notEqual(third, second);
  assert.deepEqual(edgesFrom(third, 'Topics/New.md'), ['part-of -> Topics/Heart.md']);
});

test('[[alias]] links resolve to the one note with that alias; folder notes link by name', async () => {
  const h = toolHarness({
    'Topics/Anaesthesia/Anaesthesia.md': '---\naliases: [GA]\n---\n# Anaesthesia',
    'Notes/A.md': 'See [[GA]] and [[Anaesthesia]].',
    'Notes/B.md': 'See [[Nobody has this alias]].',
  });
  const g = await VaultGraph.load(h.app as never);
  assert.deepEqual(edgesFrom(g, 'Notes/A.md'), ['link -> Topics/Anaesthesia/Anaesthesia.md']);
  assert.deepEqual(
    g.unresolved.get('Notes/B.md')?.map(u => u.name),
    ['Nobody has this alias'],
  );
});
