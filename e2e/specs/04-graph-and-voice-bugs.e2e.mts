// BUG-1..3 (the 8:20 PM voice test) and GRA-1..3 (graph traversal, ontology, graph CLI), run
// from chat notes against the DTW-shaped vault. Model replies are scripted (fake); tools are real.
import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { check, expect, runChat, toolCalls, useFakeServices, type Evidence } from '../support/harness.mts';

async function run(ev: Evidence, id: string, text: string, rounds: Array<Array<{ name: string; args?: unknown }>>) {
  await runChat(id, text, { rounds });
  const calls = toolCalls(id, ev.mark);
  ev.save('tool-calls', calls);
  await ev.shot('chat-after');
  return calls;
}

describe('8:20 PM voice-test bugs and graph tools', () => {
  before(async () => {
    await useFakeServices();
  });

  check('BUG-1', 'Ask for the notes "under the sub-directory LO" with only the bare folder name', async ev => {
    const [c] = await run(ev, 'BUG-1', 'They are all under the sub-directory LO.', [[{ name: 'list_vault_folders', args: { path: 'LO' } }]]);
    for (const n of ['AP11AO401', 'AP11AO402', 'AP11AO403', 'AP11AO404', 'AP11AO405']) expect(c.result).toContain(n);
    ev.note('list_vault_folders("LO") resolved the nested src/lo/anzca/LO folder and listed all five notes.');
  });

  check('BUG-2', 'search_vault for "oxygen" limited to the folder LO', async ev => {
    const [c] = await run(ev, 'BUG-2', 'Search the LO folder for oxygen.', [[{ name: 'search_vault', args: { query: 'oxygen', folder: 'LO' } }]]);
    expect(c.result).toContain('AP11AO401');
    expect(c.result).not.toContain('src/ontology');
    expect(c.result).not.toContain('src/qs');
    ev.note('Hits come only from the LO folder; the ontology and question notes that also mention oxygen are excluded.');
  });

  check('BUG-3', 'With AP11AO402 open, get_backlinks finds nothing, then traverse_graph from it walks three hops', async ev => {
    await obsidianPage.openFile('src/lo/anzca/LO/AP11AO402.md');
    await ev.shot('active-note-AP11AO402');
    const calls = await run(ev, 'BUG-3', 'Perform multi hop traversal based on the active note and find the larger local graph.', [
      [{ name: 'get_backlinks', args: { path: 'src/lo/anzca/LO/AP11AO402.md' } }],
      [{ name: 'traverse_graph', args: { note: 'AP11AO402', depth: 3, direction: 'both', include_unresolved: true } }],
    ]);
    const [back, walk] = calls;
    expect(back.result).not.toContain('AP11AO401');
    for (const n of ['alveolar-gas-equation', 'fick-law-of-diffusion', 'ventilation-perfusion-matching', 'shunt', 'partial-pressure', 'oxygen-cascade']) {
      expect(walk.result).toContain(n);
    }
    expect(walk.result).toContain('missing-concept-note');
    ev.note('No backlinks, yet the traversal reached 2- and 3-hop neighbours and listed the unresolved link.');
  });

  check('GRA-1', 'traverse_graph from AP11AO402, depth 3, both directions, JSON output', async ev => {
    const [c] = await run(ev, 'GRA-1', 'Traverse as JSON.', [[{ name: 'traverse_graph', args: { note: 'AP11AO402', depth: 3, direction: 'both', include_unresolved: true, format: 'json' } }]]);
    const parsed = JSON.parse(c.result);
    ev.save('traversal-json', parsed);
    const text = JSON.stringify(parsed);
    // AP11AO401 is three hops away and only reachable through an incoming link to oxygen-cascade.
    expect(text).toContain('AP11AO401');
    expect(text).toContain('missing-concept-note');
  });

  check('GRA-2', 'Typed traversal over concept and principle relations only, then vault_ontology', async ev => {
    const [typed, onto] = await run(ev, 'GRA-2', 'Follow only typed relations, then show the ontology.', [
      [{ name: 'traverse_graph', args: { note: 'AP11AO402', depth: 3, direction: 'out', edge_types: ['concept', 'principle'] } }],
      [{ name: 'vault_ontology', args: {} }],
    ]);
    expect(typed.result).toContain('alveolar-gas-equation');
    expect(typed.result).toContain('fick-law-of-diffusion');
    expect(typed.result).toContain('partial-pressure');
    expect(typed.result).not.toContain('ventilation-perfusion-matching');
    expect(onto.result).toContain('_types/relations.md');
    expect(onto.result).toContain('part-of');
    expect(onto.result).toContain('objective');
    ev.note('Body links were not followed when edge_types was set; the ontology lists the _types schema notes, edge and node types.');
  });

  check('GRA-3', 'graph_cli path AP11AO402 to shunt, hubs, and related for AP11AO401', async ev => {
    const [path, hubs, related] = await run(ev, 'GRA-3', 'Use the graph CLI.', [
      [{ name: 'graph_cli', args: { command: 'path', note: 'AP11AO402', to: 'shunt' } }],
      [{ name: 'graph_cli', args: { command: 'hubs' } }],
      [{ name: 'graph_cli', args: { command: 'related', note: 'AP11AO401' } }],
    ]);
    expect(path.result).toContain('ventilation-perfusion-matching');
    expect(hubs.result).toMatch(/oxygen-cascade|respiratory-physiology|partial-pressure/);
    expect(related.result).not.toMatch(/^(Error|ERROR)/);
    ev.note('path went through ventilation-perfusion-matching; hubs and related answered.');
    await browser.executeObsidianCommand('graph:open');
    await browser.pause(2000);
    await ev.shot('obsidian-graph-view');
  });
});
