import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PatchNoteTool } from '../../../src/tools/PatchNote';
import { WriteNoteSectionTool } from '../../../src/tools/WriteNoteSection';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { takeModals, writeSettings } from './helpers';

const NOTE = [
  '---',
  'tags: [plan]',
  '---',
  '# Plan',
  'intro',
  '## Tasks',
  '- one',
  '### Later',
  '- someday',
  '## Notes',
  'text',
  '',
].join('\n');

/** A worker that may edit without review, so writes land straight away. */
function worker(files: Record<string, string> = { 'Plan.md': NOTE }) {
  return toolHarness(files, { role: 'subagent', settings: writeSettings({ edit: 'allow' }) });
}

const read = (h: ReturnType<typeof worker>, path = 'Plan.md') => h.app.vault.adapter.read(path);

test('append goes to the end of the section, after its sub-sections', async () => {
  const h = worker();
  const out = await h.run(WriteNoteSectionTool, { link: '[[Plan#Tasks]]', content: '- two' });
  assert.equal(out.split('\n')[0], 'Appended to section "Tasks" in "Plan.md".');
  assert.match(await read(h), /### Later\n- someday\n- two\n\n## Notes\ntext/);
  assert.equal(takeModals().length, 0);
});

test('list items join a list without a blank line', async () => {
  const h = worker({ 'L.md': '## Tasks\n- one\n## Next\nx\n' });
  await h.run(WriteNoteSectionTool, { path: 'L.md', heading: 'tasks', content: '- two' });
  assert.equal(await read(h, 'L.md'), '## Tasks\n- one\n- two\n\n## Next\nx\n');
});

test('prepend and replace keep the heading', async () => {
  const h = worker({ 'L.md': '## A\nold\n## B\nb\n' });
  await h.run(WriteNoteSectionTool, { path: 'L', heading: 'A', content: 'first', mode: 'prepend' });
  assert.equal(await read(h, 'L.md'), '## A\nfirst\n\nold\n\n## B\nb\n');
  await h.run(WriteNoteSectionTool, { link: '[[L#A]]', content: 'only', mode: 'replace' });
  assert.equal(await read(h, 'L.md'), '## A\n\nonly\n\n## B\nb\n');
});

test('nested headings and a missing heading', async () => {
  const h = worker();
  await h.run(WriteNoteSectionTool, { link: '[[Plan#Tasks#Later]]', content: '- maybe' });
  assert.match(await read(h), /### Later\n- someday\n- maybe\n\n## Notes/);
  // A missing child is created inside its parent, one level down.
  await h.run(WriteNoteSectionTool, { path: 'Plan.md', heading: 'Notes#Links', content: 'x' });
  assert.match(await read(h), /## Notes\ntext\n\n### Links\n\nx\n$/);
  // A missing top-level heading is created at the end.
  const out = await h.run(WriteNoteSectionTool, {
    path: 'Plan.md',
    heading: 'Done',
    content: 'yes',
    heading_level: 3,
    format: 'json',
  });
  assert.equal(JSON.parse(out).heading, 'Done');
  assert.match(await read(h), /\n\n### Done\n\nyes\n$/);
});

test('without a heading: append to the end, prepend after the frontmatter', async () => {
  const h = worker();
  await h.run(WriteNoteSectionTool, { path: 'Plan.md', content: 'tail' });
  assert.match(await read(h), /## Notes\ntext\n\ntail\n$/);
  await h.run(WriteNoteSectionTool, { link: '[[Plan]]', content: 'top', mode: 'prepend' });
  assert.match(await read(h), /^---\ntags: \[plan\]\n---\ntop\n\n# Plan\n/);
});

test('errors: replace without a heading, heading not created, missing note, bad mode', async () => {
  const h = worker();
  const cases = [
    { path: 'Plan.md', content: 'x', mode: 'replace' },
    { path: 'Plan.md', heading: 'Nope', content: 'x', create_heading: false },
    { path: 'Plan.md', heading: 'Nope#Child', content: 'x' },
    { path: 'Missing.md', heading: 'A', content: 'x' },
    { path: 'Plan.md', content: 'x', mode: 'sideways' },
    { content: 'x' },
  ];
  for (const args of cases) {
    const out = await h.run(WriteNoteSectionTool, args);
    assert.ok(isToolError(out), `${JSON.stringify(args)} -> ${out}`);
  }
  assert.equal(await read(h), NOTE);
});

test('JSON output has stable keys', async () => {
  const h = worker();
  const out = await h.run(WriteNoteSectionTool, {
    link: '[[Plan#Tasks]]',
    content: '- two',
    format: 'json',
  });
  assert.deepEqual(Object.keys(JSON.parse(out)), [
    'ok',
    'action',
    'path',
    'applied',
    'review',
    'lines_before',
    'lines_after',
    'mode',
    'heading',
  ]);
});

test('patch_note is write_note_section in append mode', async () => {
  const a = worker();
  const b = worker();
  await a.run(PatchNoteTool, { path: 'Plan.md', heading: 'Tasks', new_content: '- two' });
  await b.run(WriteNoteSectionTool, { path: 'Plan.md', heading: 'Tasks', content: '- two' });
  assert.equal(await read(a), await read(b));
  const tool = new PatchNoteTool({} as never, {} as never);
  assert.match(tool.description, /^Deprecated: use write_note_section/);
  // It keeps write_note_section's layers.
  const orch = toolHarness({ 'Plan.md': NOTE }, { role: 'orchestrator-agent' });
  assert.ok(isToolError(await orch.run(PatchNoteTool, { path: 'Plan.md', new_content: 'x' })));
});
