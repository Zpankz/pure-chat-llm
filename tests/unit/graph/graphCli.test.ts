import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphCliTool } from '../../../src/tools/TraverseGraph';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { CASE, CSHT, LO_VAULT, PROPOFOL, START, VD } from './fixtures';

const json = async (h: ReturnType<typeof toolHarness>, args: Record<string, unknown>) => {
  const out = await h.run(GraphCliTool, { ...args, format: 'json' } as never);
  assert.ok(!isToolError(out), out);
  return JSON.parse(out) as Record<string, unknown>;
};

test('removed commands point to the tool that does them now', async () => {
  const h = toolHarness(LO_VAULT);
  const cases: Array<[string, RegExp]> = [
    [
      'traverse',
      /^Error: MovedCommand: graph_cli no longer has "traverse"; traverse_graph does it\.\nTry:\n- Call traverse_graph/,
    ],
    ['ontology', /^Error: MovedCommand: .*vault_ontology does it/],
    [
      'Backlinks',
      /^Error: MovedCommand: .*traverse_graph does it\.\nTry:\n- .*direction "in" and depth 1/,
    ],
  ];
  for (const [command, pattern] of cases) {
    const out = await h.run(GraphCliTool, { command, note: START });
    assert.ok(isToolError(out), out);
    assert.match(out, pattern);
  }
  const unknown = await h.run(GraphCliTool, { command: 'teleport' });
  assert.ok(isToolError(unknown));
  assert.match(
    unknown,
    /^Error: UnknownCommand: .*\nTry:\n- Commands: help, path, hubs, related, run, save\./,
  );
  const schema = new GraphCliTool(null as never, null as never).parameters;
  assert.deepEqual(schema.properties.command.enum, [
    'help',
    'path',
    'hubs',
    'related',
    'run',
    'save',
  ]);
});

test('path answers "how does A connect to B", with direction, relation and folder limits', async () => {
  const h = toolHarness(LO_VAULT);
  const text = await h.run(GraphCliTool, { command: 'path', note: 'AP11AO402', to: 'Case 1' });
  assert.match(
    text.split('\n')[0],
    /^AP11AO402 connects to Case 1 in 3 steps: AP11AO402 links to Context sensitive half time; Context sensitive half time links to Propofol; Case 1 links to Propofol\.$/,
  );

  const j = await json(h, { command: 'path', note: START, to: CASE });
  assert.deepEqual(Object.keys(j), [
    'command',
    'summary',
    'from',
    'to',
    'found',
    'hops',
    'direction',
    'edge_types',
    'scope',
    'chain',
    'hint',
  ]);
  assert.equal(j.hops, 3);
  assert.deepEqual(
    (j.chain as Array<{ path: string; via: string }>).map(c => [c.path, c.via]),
    [
      [START, 'start'],
      [CSHT, 'out:link'],
      [PROPOFOL, 'out:link'],
      [CASE, 'in:link'],
    ],
  );

  // Following links only forwards, Case 1 (which links in to Propofol) is out of reach.
  const forward = await json(h, { command: 'path', note: START, to: CASE, direction: 'out' });
  assert.equal(forward.found, false);
  assert.equal(forward.hops, null);
  assert.match(String(forward.hint), /direction both/);

  const typed = await json(h, {
    command: 'path',
    note: START,
    to: VD,
    edge_types: ['concept', 'principle'],
  });
  assert.match(
    String(typed.summary),
    /AP11AO402 has concept Pharmacokinetics; Pharmacokinetics has principle Volume of distribution/,
  );

  // Only through notes in Concepts: the chain to Propofol still works (CSHT is in Concepts);
  // only through Drugs it doesn't, as CSHT would be needed.
  assert.equal(
    (await json(h, { command: 'path', note: START, to: PROPOFOL, folder: 'Concepts' })).found,
    true,
  );
  assert.equal(
    (await json(h, { command: 'path', note: START, to: PROPOFOL, folder: 'Drugs' })).found,
    false,
  );
});

test('hubs and related are bounded, scoped and deterministic', async () => {
  const h = toolHarness(LO_VAULT);
  const hubs = await json(h, { command: 'hubs', limit: 2 });
  assert.deepEqual(Object.keys(hubs), ['command', 'summary', 'scope', 'count', 'more', 'hubs']);
  assert.equal(hubs.count, 2);
  assert.equal(hubs.more, true);
  const first = (hubs.hubs as Array<{ path: string; in: number }>)[0];
  assert.equal(first.path, PROPOFOL);
  assert.match(String(hubs.summary), /^The most linked note is Propofol, with 3 backlinks\.$/);

  const scoped = await json(h, { command: 'hubs', folder: 'Concepts' });
  for (const x of scoped.hubs as Array<{ path: string }>) assert.match(x.path, /\/Concepts\//);

  const rel = await json(h, { command: 'related', note: 'Context sensitive half time' });
  assert.deepEqual(Object.keys(rel), [
    'command',
    'summary',
    'note',
    'scope',
    'count',
    'more',
    'related',
  ]);
  const paths = (rel.related as Array<{ path: string }>).map(r => r.path);
  assert.ok(paths.includes(CASE), paths.join());
  assert.equal(
    JSON.stringify(rel),
    JSON.stringify(await json(h, { command: 'related', note: CSHT })),
  );

  const text = await h.run(GraphCliTool, { command: 'hubs', limit: 1 });
  assert.match(text, /More are available: raise limit\./);
});

test('help lists commands, moved commands and saved commands', async () => {
  const h = toolHarness({
    ...LO_VAULT,
    'Agent graph commands/drug-map.md':
      '---\ncommand: drug-map\nintent: Drugs linked from an LO\n---\n```js\nreturn 1;\n```',
  });
  const j = await json(h, { command: 'help' });
  assert.deepEqual(
    (j.commands as Array<{ name: string }>).map(c => c.name),
    ['path', 'hubs', 'related', 'run', 'save'],
  );
  assert.deepEqual(j.moved, {
    traverse: 'traverse_graph',
    ontology: 'vault_ontology',
    backlinks: 'traverse_graph',
  });
  assert.deepEqual(j.saved, [
    {
      name: 'drug-map',
      intent: 'Drugs linked from an LO',
      path: 'Agent graph commands/drug-map.md',
    },
  ]);
  const text = await h.run(GraphCliTool, { command: 'help' });
  assert.match(text.split('\n')[0], /^graph_cli has 5 commands and 1 saved command\.$/);
});

test('graph_cli failures are tool errors', async () => {
  const h = toolHarness({
    ...LO_VAULT,
    'Agent graph commands/broken.md': '---\ncommand: broken\n---\nNo code here.',
  });
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ command: 'path', note: START }, /^Error: InvalidArgument: path needs a target/],
    [{ command: 'path', note: START, to: 'Nothing like it' }, /^Error: NotFound: /],
    [{ command: 'path', note: 'Index', to: START }, /^Error: AmbiguousNote: /],
    [
      { command: 'path', note: START, to: CASE, direction: 'up' },
      /^Error: InvalidArgument: direction/,
    ],
    [{ command: 'hubs', folder: 'Nowhere' }, /^Error: FolderNotFound: /],
    [{ command: 'related', note: 'Nothing like it' }, /^Error: NotFound: /],
    [{ command: 'run' }, /^Error: InvalidArgument: run needs/],
    [{ command: 'run', name: 'missing' }, /^Error: NotFound: No saved command "missing"/],
    [{ command: 'run', name: 'broken' }, /^Error: InvalidCommand: .*no js code block/],
    [{ command: 'save', name: 'x' }, /^Error: InvalidArgument: save needs/],
    [{ command: 'save', name: 'broken', code: 'return 1;' }, /^Error: AlreadyExists: /],
    [{ command: 'hubs', format: 'yaml' }, /^Error: InvalidArgument: format/],
  ];
  for (const [args, pattern] of cases) {
    const out = await h.run(GraphCliTool, args as never);
    assert.ok(isToolError(out), out);
    assert.match(out, pattern);
  }
});
