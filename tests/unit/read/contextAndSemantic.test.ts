import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActiveContextTool } from '../../../src/tools/ActiveContext';
import { SmartConnectionsRetrievalTool } from '../../../src/tools/SmartConnectionsRetrieval';
import { isToolError, toolErrorMessage } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { MarkdownView, type TFile } from '../obsidian-mock';

const vault = () => ({
  'Uni/LO/LO.md': '# LO',
  'Uni/LO/AP11AO402.md': '# Airway pressure\nPEEP keeps alveoli open.\n## Detail\nMore. #resp',
  'Other/Note.md': 'line one\nline two\nline three',
});

/** A Markdown view like Obsidian's, with an editor on the note's text. */
function viewFor(file: TFile, text: string, selection = ''): MarkdownView {
  const lines = text.split('\n');
  return Object.assign(new MarkdownView(), {
    file,
    editor: {
      getSelection: () => selection,
      getCursor: () => ({ line: 1, ch: 4 }),
      lineCount: () => lines.length,
      getValue: () => text,
    },
  });
}

// get_active_context

test('get_active_context json: path, title, folder, folder note, selection; no content', async () => {
  const h = toolHarness(vault(), { role: 'orchestrator-agent' });
  const file = h.app.vault.getFileByPath('Uni/LO/AP11AO402.md')!;
  const text = h.app.vault.contents.get(file.path)!;
  const view = viewFor(file, text, 'PEEP');
  h.app.workspace.getActiveViewOfType = () => view;
  const data = JSON.parse(await h.run(ActiveContextTool, { format: 'json' }));
  assert.deepEqual(data, {
    path: 'Uni/LO/AP11AO402.md',
    title: 'AP11AO402',
    folder: 'Uni/LO',
    folder_note: 'Uni/LO/LO.md',
    cursor: { line: 1, ch: 4 },
    line_count: 4,
    selection: 'PEEP',
    selection_truncated: false,
    headings: [
      { level: 1, heading: 'Airway pressure', offset: 0 },
      { level: 2, heading: 'Detail', offset: 2 },
    ],
    tags: ['#resp'],
  });
  const out = await h.run(ActiveContextTool, {});
  assert.equal(
    out.split('\n')[0],
    'The open note is "AP11AO402" in folder Uni/LO, with 4 characters selected.',
  );
  assert.doesNotMatch(out, /PEEP keeps alveoli open/);
});

test('get_active_context include_content returns capped text with a continue offset', async () => {
  const h = toolHarness(vault());
  const file = h.app.vault.getFileByPath('Other/Note.md')!;
  const big = Array.from({ length: 300 }, (_, i) => `row ${i} ${'w'.repeat(20)}`).join('\n');
  h.app.workspace.getActiveViewOfType = () => viewFor(file, big);
  const data = JSON.parse(
    await h.run(ActiveContextTool, { include_content: true, max_chars: 1000, format: 'json' }),
  );
  assert.ok(data.content.length <= 1000);
  assert.equal(data.truncated, true);
  assert.equal(typeof data.next_offset, 'number');
  assert.equal(data.folder_note, null);
});

test('get_active_context falls back to the last editor when a side panel has focus', async () => {
  const h = toolHarness(vault());
  const file = h.app.vault.getFileByPath('Other/Note.md')!;
  const view = viewFor(file, 'line one\nline two\nline three', 'two');
  h.app.workspace.iterateAllLeaves = (cb: (leaf: { view: unknown }) => void) => cb({ view });
  const data = JSON.parse(await h.run(ActiveContextTool, { format: 'json' }));
  assert.equal(data.path, 'Other/Note.md');
  assert.equal(data.selection, 'two');
});

test('get_active_context with no open note is a tool error', async () => {
  const h = toolHarness(vault());
  const out = await h.run(ActiveContextTool, {});
  assert.ok(isToolError(out));
  assert.match(toolErrorMessage(out), /^NoActiveNote:/);
});

// smart_connections_rag (a stand-in for the plugin's lookup API; real behaviour is unverified)

function withSmartConnections(
  h: ReturnType<typeof toolHarness>,
  lookup: (opts: { filter?: { limit?: number } }) => unknown,
): { calls: { filter?: { limit?: number } }[] } {
  const calls: { filter?: { limit?: number } }[] = [];
  const collection = {
    lookup: (opts: { filter?: { limit?: number } }) => {
      calls.push(opts);
      return lookup(opts);
    },
  };
  h.app.plugins.getPlugin = (id: string) =>
    id === 'smart-connections'
      ? { env: { smart_blocks: collection, smart_sources: collection } }
      : null;
  return { calls };
}

const hits = [
  { key: 'Other/Note.md#x', score: 0.91, item: { data: { lines: [2, 3] } } },
  { key: 'Uni/LO/AP11AO402.md#Airway pressure', score: 0.8, item: { data: { lines: [2, 2] } } },
];

test('smart_connections_rag json has stable keys and the passage text', async () => {
  const h = toolHarness(vault());
  withSmartConnections(h, () => hits);
  const tool = new SmartConnectionsRetrievalTool(
    { plugin: { app: h.app, settings: {} } } as never,
    {} as never,
  );
  assert.equal(tool.isAvailable(), true);
  const data = JSON.parse(
    await h.run(SmartConnectionsRetrievalTool, { query: 'q', format: 'json' }),
  );
  assert.deepEqual(Object.keys(data), ['query', 'type', 'folders', 'recursive', 'results']);
  assert.deepEqual(data.results[0], {
    key: 'Other/Note.md#x',
    path: 'Other/Note.md',
    folder: 'Other',
    score: 0.91,
    content: 'line two\nline three',
  });
  assert.equal(data.results[1].content, 'PEEP keeps alveoli open.');
  const text = await h.run(SmartConnectionsRetrievalTool, { query: 'q' });
  assert.equal(text.split('\n')[0], 'Found 2 passages related to "q"; best match Other/Note.md.');
});

test('smart_connections_rag folder scope filters results and asks the index for more', async () => {
  const h = toolHarness(vault());
  const { calls } = withSmartConnections(h, () => hits);
  const data = JSON.parse(
    await h.run(SmartConnectionsRetrievalTool, {
      query: 'q',
      folder: 'LO',
      limit: 3,
      format: 'json',
    }),
  );
  assert.deepEqual(
    data.results.map((r: { path: string }) => r.path),
    ['Uni/LO/AP11AO402.md'],
  );
  assert.deepEqual(data.folders, ['Uni/LO']);
  assert.equal(calls[0].filter?.limit, 15);
});

test('smart_connections_rag failures are tool errors', async () => {
  const h = toolHarness(vault());
  const missing = await h.run(SmartConnectionsRetrievalTool, { query: 'q' });
  assert.ok(isToolError(missing));
  assert.match(toolErrorMessage(missing), /^Unavailable:/);
  withSmartConnections(h, () => {
    throw new Error('index locked');
  });
  const failed = await h.run(SmartConnectionsRetrievalTool, { query: 'q' });
  assert.match(toolErrorMessage(failed), /^SearchFailed: .*index locked/);
  const empty = await h.run(SmartConnectionsRetrievalTool, { query: ' ' });
  assert.match(toolErrorMessage(empty), /^InvalidArgument:/);
  const folder = await h.run(SmartConnectionsRetrievalTool, { query: 'q', folder: 'Nope' });
  assert.match(toolErrorMessage(folder), /^FolderNotFound:/);
});
