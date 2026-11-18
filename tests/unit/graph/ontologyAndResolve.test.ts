import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGraphNote } from '../../../src/graph/ontology';
import { TraverseGraphTool, VaultOntologyTool } from '../../../src/tools/TraverseGraph';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { FIELDS_VAULT, FOLDER_NOTE, LO_VAULT, PK, START } from './fixtures';

test('vault_ontology: spoken first line, stable JSON keys, relation types from inline fields', async () => {
  const h = toolHarness({ ...LO_VAULT, ...FIELDS_VAULT });
  const text = await h.run(VaultOntologyTool, {});
  assert.ok(!isToolError(text));
  assert.match(
    text.split('\n')[0],
    /^This vault has 21 notes and 16 links of 8 relation types, with 5 note types and 2 tags\.$/,
  );
  assert.match(text, /part-of/);

  const j = JSON.parse(await h.run(VaultOntologyTool, { format: 'json' })) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(j), [
    'summary',
    'notes',
    'schemaNotes',
    'nodeTypes',
    'edgeTypes',
    'nodeTypesUsed',
    'edgeTypesUsed',
    'tags',
    'properties',
    'omitted',
  ]);
  const used = j.edgeTypesUsed as Array<{ type: string; count: number }>;
  assert.ok(used.some(u => u.type === 'part-of' && u.count === 2));
  assert.ok(used.some(u => u.type === 'concept' && u.count === 1));
  assert.equal(j.summary, text.split('\n')[0]);
  assert.equal(await h.run(VaultOntologyTool, { format: 'json' }), JSON.stringify(j));

  const bad = await h.run(VaultOntologyTool, { format: 'csv' });
  assert.ok(isToolError(bad), bad);
  assert.match(bad, /^Error: InvalidArgument: format must be "text" or "json"/);
});

test('vault_ontology reads Typed Graph schema notes', async () => {
  const h = toolHarness({
    'Types/Schema.md': '---\ntgs: 1\nedgeTypes:\n  - part-of\n---\n# Schema',
    'A.md': '---\ntype: organ\n---\npart-of:: [[B]]',
    'B.md': '# B',
  });
  const j = JSON.parse(await h.run(VaultOntologyTool, { format: 'json' })) as {
    schemaNotes: string[];
  };
  assert.deepEqual(j.schemaNotes, ['Types/Schema.md']);
});

test('note resolution for folder-note vaults: aliases, case, folders and near matches', () => {
  const h = toolHarness(LO_VAULT);
  const app = h.app as never;
  const path = (ref: string) => resolveGraphNote(app, ref).file?.path ?? null;
  // A folder note wins over a stray note of the same name, as `[[Anaesthesia]]` links it.
  assert.equal(path('Anaesthesia'), FOLDER_NOTE);
  assert.equal(path('[[anaesthesia]]'), FOLDER_NOTE);
  assert.equal(path('Topics/Anaesthesia'), FOLDER_NOTE);
  assert.equal(path('Topics/Anaesthesia/'), FOLDER_NOTE);
  assert.equal(path('Other/Anaesthesia'), 'Other/Anaesthesia.md');
  // Aliases, in any case.
  assert.equal(path('anesthesia'), FOLDER_NOTE);
  assert.equal(path('General Anaesthesia'), FOLDER_NOTE);
  // Case-insensitive basenames, folder-qualified names, speech without spaces.
  assert.equal(path('PHARMACOKINETICS'), PK);
  assert.equal(path('LO/ap11ao402'), START);
  assert.equal(path('AP 11 AO 402'), START);
  assert.equal(path('[[Pharmacokinetics#Clearance|PK]]'), PK);

  const ambiguous = resolveGraphNote(app, 'Index');
  assert.equal(ambiguous.file, null);
  assert.deepEqual(
    ambiguous.candidates.map(f => f.path),
    ['Archive/Index.md', 'Notes/Index.md'],
  );
  const near = resolveGraphNote(app, 'Pharmacokinetic studies');
  assert.equal(near.file, null);
  assert.equal(near.near[0]?.path, PK);
});

test('a missing note lists near matches in its error', async () => {
  const h = toolHarness(LO_VAULT);
  const out = await h.run(TraverseGraphTool, { note: 'Pharmacokinetic studies' });
  assert.ok(isToolError(out), out);
  assert.match(
    out,
    /^Error: NotFound: No note found for "Pharmacokinetic studies"\.\nTry:\n- Did you mean note: "Medicine\/Concepts\/Pharmacokinetics\.md"\?/,
  );
});
