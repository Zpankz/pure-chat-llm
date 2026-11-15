import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadFileTool } from '../../../src/tools/ReadFile';
import { ReadNoteSectionTool } from '../../../src/tools/ReadNoteSection';
import { isToolError, toolErrorMessage } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';

const note = [
  '# Airway pressure', // 0
  'Intro line.', // 1
  '## PEEP, explained', // 2
  'Positive end-expiratory pressure. ^peep-def', // 3
  'More detail.', // 4
  '# Next topic', // 5
  'end', // 6
].join('\n');

const vault = () => ({ 'Uni/LO/AP11AO402.md': note, 'Data/x.csv': 'a,b' });

test('read_note_section outline: text summary and json with 0-based offsets', async () => {
  const h = toolHarness(vault());
  const text = await h.run(ReadNoteSectionTool, { link: 'AP11AO402', headings_only: true });
  assert.equal(text.split('\n')[0], 'Outline of "AP11AO402": 3 headings.');
  assert.match(text, /## PEEP, explained {2}\(line 3\)/);
  const data = JSON.parse(
    await h.run(ReadNoteSectionTool, {
      link: '[[AP11AO402]]',
      headings_only: true,
      format: 'json',
    }),
  );
  assert.deepEqual(Object.keys(data), ['path', 'total_lines', 'headings', 'truncated']);
  assert.deepEqual(data.headings[1], { level: 2, heading: 'PEEP, explained', offset: 2 });
  const shallow = JSON.parse(
    await h.run(ReadNoteSectionTool, {
      link: 'AP11AO402',
      headings_only: true,
      depth: 1,
      format: 'json',
    }),
  );
  assert.equal(shallow.headings.length, 2);
});

test('read_note_section reads a heading section, matching loosely', async () => {
  const h = toolHarness(vault());
  for (const link of ['[[AP11AO402#PEEP, explained]]', 'AP11AO402#peep explained']) {
    const data = JSON.parse(await h.run(ReadNoteSectionTool, { link, format: 'json' }));
    assert.deepEqual(Object.keys(data), [
      'path',
      'section',
      'kind',
      'offset',
      'end',
      'truncated',
      'next_offset',
      'content',
    ]);
    assert.equal(data.section, 'PEEP, explained', link);
    assert.equal(data.offset, 2);
    assert.equal(data.end, 5);
    assert.equal(
      data.content,
      '## PEEP, explained\nPositive end-expiratory pressure. ^peep-def\nMore detail.',
    );
  }
  const text = await h.run(ReadNoteSectionTool, { link: '[[AP11AO402#Airway pressure]]' });
  assert.match(text.split('\n')[0], /^Section "Airway pressure" of "AP11AO402": lines 1-5\.$/);
});

test('read_note_section reads a block reference', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(
    await h.run(ReadNoteSectionTool, { link: '[[AP11AO402#^peep-def]]', format: 'json' }),
  );
  assert.equal(data.kind, 'block');
  assert.equal(data.content, 'Positive end-expiratory pressure. ^peep-def');
});

test('read_note_section without a section reads the whole note', async () => {
  const h = toolHarness(vault());
  const data = JSON.parse(await h.run(ReadNoteSectionTool, { link: 'AP11AO402', format: 'json' }));
  assert.equal(data.kind, 'note');
  assert.equal(data.content, note);
});

test('a truncated section continues with read_file at next_offset', async () => {
  const long = [
    '# Big',
    ...Array.from({ length: 100 }, (_, i) => `row ${i} ${'q'.repeat(30)}`),
    '# After',
    'x',
  ];
  const h = toolHarness({ 'Big.md': long.join('\n') });
  const first = JSON.parse(
    await h.run(ReadNoteSectionTool, { link: '[[Big#Big]]', max_chars: 800, format: 'json' }),
  );
  assert.equal(first.truncated, true);
  assert.ok(first.content.length <= 800);
  const text = await h.run(ReadNoteSectionTool, { link: '[[Big#Big]]', max_chars: 800 });
  assert.match(text, new RegExp(`read_file\\(path="Big\\.md#Big", offset=${first.next_offset}\\)`));
  const rest = JSON.parse(
    await h.run(ReadFileTool, {
      path: 'Big.md#Big',
      offset: first.next_offset,
      max_chars: 100000,
      format: 'json',
    }),
  );
  assert.equal(rest.end, 101); // stays inside the section
  assert.equal(`${first.content}\n${rest.content}`, long.slice(0, 101).join('\n'));
});

test('read_note_section failures are tool errors', async () => {
  const h = toolHarness(vault());
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ link: '[[Missing note]]' }, /^NotFound:/],
    [{ link: '[[AP11AO402#Nope]]' }, /^SectionNotFound:/],
    [{ link: '[[AP11AO402#^nope]]' }, /^BlockNotFound:/],
    [{ link: 'Data/x.csv' }, /^NotANote:/],
    [{ link: '[[#Heading]]' }, /^NoActiveNote:/],
  ];
  for (const [args, pattern] of cases) {
    const out = await h.run(ReadNoteSectionTool, args as never);
    assert.ok(isToolError(out), out);
    assert.match(toolErrorMessage(out), pattern, out);
  }
  const missing = await h.run(ReadNoteSectionTool, { link: '[[AP11AO402#Nope]]' });
  assert.match(missing, /Headings in this note: Airway pressure \| PEEP, explained \| Next topic/);
});
