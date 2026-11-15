import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadFileTool } from '../../../src/tools/ReadFile';
import { isToolError, toolErrorMessage } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import type { TFile } from '../obsidian-mock';

const note = [
  '---',
  'tags: [lo]',
  '---',
  '# Airway pressure',
  'Learning outcome: explain PEEP.',
  '## Detail',
  'Detail text.',
  '# Next',
  'end',
].join('\n');

const vault = () => ({
  'Uni/LO/AP11AO402.md': note,
  'Uni/Other/AP11AO402 copy.md': 'other',
  'Data/table.csv': 'a,b\n1,2',
  'img.png': 'binary',
  'Dup/One.md': 'one',
  'Dup2/One.md': 'one again',
});

test('read_file reads by path, bare name, wikilink and "active", summary line first', async () => {
  const h = toolHarness(vault());
  for (const path of ['Uni/LO/AP11AO402.md', 'Uni/LO/AP11AO402', 'AP11AO402', '[[AP11AO402]]']) {
    const out = await h.run(ReadFileTool, { path });
    assert.ok(!isToolError(out), `${path}: ${out}`);
    assert.match(out.split('\n')[0], /^Read "AP11AO402": lines 1-9 of 9\.$/, path);
    assert.match(out, /Learning outcome: explain PEEP\./);
  }
  const file = h.app.vault.getFileByPath('Uni/LO/AP11AO402.md') as TFile;
  h.app.workspace.getActiveFile = () => file;
  const active = await h.run(ReadFileTool, { path: 'active' });
  assert.match(active, /^Read "AP11AO402"/);
});

test('read_file reads other text files, like csv', async () => {
  const h = toolHarness(vault());
  const out = await h.run(ReadFileTool, { path: 'Data/table.csv', format: 'json' });
  assert.equal(JSON.parse(out).content, 'a,b\n1,2');
});

test('read_file json has stable keys', async () => {
  const h = toolHarness(vault());
  const out = await h.run(ReadFileTool, { path: 'AP11AO402', format: 'json' });
  const data = JSON.parse(out);
  assert.deepEqual(Object.keys(data), [
    'path',
    'offset',
    'end',
    'total_lines',
    'truncated',
    'next_offset',
    'content',
  ]);
  assert.equal(data.path, 'Uni/LO/AP11AO402.md');
  assert.equal(data.offset, 0);
  assert.equal(data.end, 9);
  assert.equal(data.total_lines, 9);
  assert.equal(data.truncated, false);
  assert.equal(data.next_offset, null);
  assert.equal(data.content, note);
});

test('read_file caps characters at whole lines and pages back to the full text', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
  const h = toolHarness({ 'Big.md': lines.join('\n') });
  const first = await h.run(ReadFileTool, { path: 'Big', max_chars: 600 });
  assert.match(first.split('\n')[0], /truncated; continue with offset \d+\./);
  assert.match(first, /Truncated: continue with read_file\(path="Big\.md", offset=\d+\)\./);

  const pages: string[] = [];
  let offset: number | null = 0;
  let calls = 0;
  while (offset !== null && calls++ < 100) {
    const data = JSON.parse(
      await h.run(ReadFileTool, { path: 'Big.md', offset, max_chars: 600, format: 'json' }),
    ) as { content: string; next_offset: number | null; truncated: boolean };
    assert.ok(data.content.length <= 600);
    pages.push(data.content);
    assert.equal(data.truncated, data.next_offset !== null);
    offset = data.next_offset;
  }
  assert.equal(pages.join('\n'), lines.join('\n'));
});

test('read_file default cap: 5000 characters in voice, 20000 for workers', async () => {
  const text = Array.from({ length: 1000 }, () => 'y'.repeat(49)).join('\n'); // 50,000 chars
  const voice = toolHarness({ 'Long.md': text }, { role: 'voice' });
  const v = JSON.parse(await voice.run(ReadFileTool, { path: 'Long', format: 'json' }));
  assert.ok(v.content.length <= 5000 && v.content.length > 4500, String(v.content.length));
  assert.equal(v.truncated, true);
  const worker = toolHarness({ 'Long.md': text }, { role: 'subagent' });
  const w = JSON.parse(await worker.run(ReadFileTool, { path: 'Long', format: 'json' }));
  assert.ok(w.content.length <= 20000 && w.content.length > 19000, String(w.content.length));
});

test('read_file cuts a single line longer than the cap instead of returning nothing', async () => {
  const h = toolHarness({ 'One.md': `${'z'.repeat(3000)}\nsecond` });
  const data = JSON.parse(
    await h.run(ReadFileTool, { path: 'One', max_chars: 1000, format: 'json' }),
  );
  assert.equal(data.content.length, 1000);
  assert.equal(data.truncated, true);
  assert.equal(data.next_offset, 1);
});

test('read_file with [[Note#Heading]] reads only that section', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(ReadFileTool, { path: '[[AP11AO402#Airway pressure]]', format: 'json' }),
  );
  assert.equal(data.section, 'Airway pressure');
  assert.equal(data.offset, 3);
  assert.equal(data.end, 7);
  assert.match(data.content, /^# Airway pressure\n/);
  assert.doesNotMatch(data.content, /# Next/);
});

test('read_file failures are tool errors', async () => {
  const h = toolHarness(vault());
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ path: 'Nowhere/Missing.md' }, /^NotFound:/],
    [{ path: 'One' }, /^Ambiguous: .*Dup\/One\.md.*Dup2\/One\.md/],
    [{ path: 'img.png' }, /^NotText:/],
    [{ path: 'AP11AO402', offset: 99 }, /^OutOfRange:/],
    [{ path: 'active' }, /^NoActiveNote:/],
    [{ path: '[[AP11AO402#No such heading]]' }, /^SectionNotFound:/],
  ];
  for (const [args, pattern] of cases) {
    const out = await h.run(ReadFileTool, args as never);
    assert.ok(isToolError(out), out);
    assert.match(toolErrorMessage(out), pattern, out);
  }
});

test('read_file reports a read failure as a tool error', async () => {
  const h = toolHarness(vault());
  h.app.vault.cachedRead = async () => {
    throw new Error('disk gone');
  };
  const out = await h.run(ReadFileTool, { path: 'AP11AO402' });
  assert.ok(isToolError(out));
  assert.match(out, /ReadFailed: .*disk gone/);
});
