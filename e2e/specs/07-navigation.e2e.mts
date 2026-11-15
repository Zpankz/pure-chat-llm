// NAV-1..4: navigation on the DTW-shaped vault after the tool rework (validation-scenarios.md §2).
// Model replies are scripted (fake); the graph, search and note-resolution tools are real.
import { check, expect, runChat, toolCalls, useFakeServices, type Evidence } from '../support/harness.mts';

async function run(ev: Evidence, id: string, text: string, rounds: Array<Array<{ name: string; args?: unknown }>>) {
  await runChat(id, text, { rounds });
  const calls = toolCalls(id, ev.mark);
  ev.save('tool-calls', calls);
  await ev.shot('chat-after');
  expect(calls.length).toBe(rounds.flat().length);
  return calls;
}

describe('Navigation: typed links, routes, folder scope and names', () => {
  before(async () => {
    await useFakeServices();
  });

  check('NAV-1', 'traverse_graph from dead-space, whose relations are inline fields (field:: [[x]]), filtered by each relation', async ev => {
    const [all, contrasts, measured] = await run(ev, 'NAV-1', 'How is dead space related to other concepts?', [
      [{ name: 'traverse_graph', args: { note: 'dead-space', depth: 1, direction: 'out', format: 'json' } }],
      [{ name: 'traverse_graph', args: { note: 'dead-space', depth: 1, direction: 'out', edge_types: ['contrasts'] } }],
      [{ name: 'traverse_graph', args: { note: 'dead-space', depth: 1, direction: 'out', edge_types: ['measured-by'] } }],
    ]);
    for (const [field, target] of [['part-of', 'respiratory-physiology'], ['contrasts', 'shunt'], ['measured-by', 'bohr-equation']]) {
      expect(all.result).toContain(field);
      expect(all.result).toContain(target);
    }
    expect(contrasts.result).toContain('shunt');
    expect(contrasts.result).not.toContain('bohr-equation');
    expect(measured.result).toContain('bohr-equation');
    expect(measured.result).not.toContain('shunt');
    ev.note('The three inline fields (a plain line, a list item and a bracketed field inside a sentence) come back as typed relations, and edge_types follows only the one asked for.');
  });

  check('NAV-2', 'Multi-hop: graph_cli path from dead-space to AP11AO402, and traverse_graph three hops out', async ev => {
    const [path, walk] = await run(ev, 'NAV-2', 'How does dead space connect to AP11AO402?', [
      [{ name: 'graph_cli', args: { command: 'path', note: 'dead-space', to: 'AP11AO402', direction: 'both' } }],
      [{ name: 'traverse_graph', args: { note: 'dead-space', depth: 3, direction: 'both' } }],
    ]);
    expect(path.result).not.toMatch(/^(Error|ERROR)/);
    expect(path.result).toContain('shunt');
    expect(path.result).toContain('AP11AO402');
    expect(walk.result).toContain('AP11AO402');
    ev.note(`path: ${path.result.replace(/\s+/g, ' ').slice(0, 240)}`);
  });

  check('NAV-3', 'Folder scope: search, glob, traversal and folder listing limited to src/ontology/principles; the folder note comes first', async ev => {
    const [search, glob, walk, list] = await run(ev, 'NAV-3', 'Only look in the principles folder.', [
      [{ name: 'search_vault', args: { query: 'dead space', folder: 'src/ontology/principles' } }],
      [{ name: 'glob_vault_files', args: { pattern: 'src/ontology/principles/*.md' } }],
      [{ name: 'traverse_graph', args: { note: 'dead-space', depth: 2, direction: 'both', folder: 'src/ontology/principles' } }],
      [{ name: 'list_vault_folders', args: { path: 'src/ontology/principles', include_notes: true } }],
    ]);
    expect(search.result).toContain('bohr-equation');
    expect(search.result).not.toContain('src/ontology/concepts/dead-space');
    expect(glob.result).toContain('bohr-equation');
    expect(glob.result).not.toContain('concepts/');
    expect(walk.result).toContain('bohr-equation');
    expect(walk.result).not.toContain('respiratory-physiology');
    const notes = list.result.split('\n').filter(l => /\.md|principles|bohr|partial|fick|alveolar/.test(l));
    ev.save('listing-lines', notes);
    const folderNote = list.result.indexOf('principles.md');
    const other = Math.min(...['bohr-equation', 'partial-pressure', 'fick-law', 'alveolar-gas'].map(n => list.result.indexOf(n)).filter(i => i >= 0));
    expect(folderNote).toBeGreaterThanOrEqual(0);
    expect(folderNote).toBeLessThan(other);
  });

  check('NAV-4', 'Names: a note by its alias, by a bare name two notes share, and by a folder note name', async ev => {
    const [alias, ambiguous, folderNote] = await run(ev, 'NAV-4', 'Open Bohr dead space, then overview, then principles.', [
      [{ name: 'traverse_graph', args: { note: 'Bohr dead space', depth: 1 } }],
      [{ name: 'traverse_graph', args: { note: 'overview', depth: 1 } }],
      [{ name: 'traverse_graph', args: { note: 'principles', depth: 1 } }],
    ]);
    expect(alias.result).toContain('dead-space');
    expect(alias.result).not.toMatch(/NotFound|AmbiguousNote/);
    expect(ambiguous.result).toContain('AmbiguousNote');
    expect(ambiguous.result).toContain('src/note/overview.md');
    expect(ambiguous.result).toContain('src/qs/overview.md');
    expect(folderNote.result).toContain('src/ontology/principles/principles');
    expect(folderNote.result).not.toMatch(/NotFound|AmbiguousNote/);
    ev.note('The alias resolved to dead-space, the shared bare name came back as AmbiguousNote listing both notes, and the folder note name resolved to the folder note.');
  });
});
