import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildRequest,
  displayMessage,
  findTrigger,
  NOTE_CONTEXT_CHARS,
  rank,
  replaceTrigger,
} from '../../../src/ui/composerModel';
import { clipPreview, prepareMarkdown } from '../../../src/ui/conversationModel';
import { relayLine } from '../../../src/agents/OrchestratorAgent';
import { contentImages, toResponsesBody } from '../../../src/core/ResponsesClient';

test('findTrigger: [[ opens a link query up to the caret', () => {
  const text = 'see [[Daily no';
  assert.deepEqual(findTrigger(text, text.length), {
    kind: 'link',
    query: 'Daily no',
    start: 4,
    end: text.length,
  });
  // A closed link is not a trigger any more.
  assert.equal(findTrigger('see [[Note]] now', 16), null);
});

test('findTrigger: @ and / only start at a word boundary', () => {
  assert.equal(findTrigger('mail me@host', 12), null);
  const at = findTrigger('ask @Proj', 9);
  assert.equal(at?.kind, 'mention');
  assert.equal(at?.query, 'Proj');
  assert.equal(at?.start, 4);
  assert.equal(findTrigger('a/b', 3), null);
  const slash = findTrigger('/st', 3);
  assert.equal(slash?.kind, 'slash');
  assert.equal(slash?.query, 'st');
  // "@ " is just an at sign.
  assert.equal(findTrigger('x @ y', 5), null);
});

test('replaceTrigger: inserts the choice, drops a trailing ]] and adds a space', () => {
  const text = 'see [[Dai]] later';
  const trigger = findTrigger(text, 9)!;
  const out = replaceTrigger(text, trigger, '[[Daily note]]');
  assert.equal(out.text, 'see [[Daily note]] later');
  assert.equal(out.caret, 'see [[Daily note]]'.length);
  const slash = findTrigger('/sto', 4)!;
  assert.deepEqual(replaceTrigger('/sto', slash, ''), { text: '', caret: 0 });
});

test('buildRequest: words first, then each attachment', () => {
  const long = 'x'.repeat(NOTE_CONTEXT_CHARS + 50);
  const request = buildRequest('  Summarise this  ', [
    { kind: 'note', path: 'A.md', label: 'A', content: 'has ``` fences' },
    { kind: 'note', path: 'B.pdf', label: 'B' },
    { kind: 'selection', path: 'C.md', label: 'C', content: long },
    { kind: 'skill', name: 'pdf', label: 'pdf' },
    { kind: 'tool', name: 'read_note', label: 'read_note' },
    { kind: 'image', label: 'shot', dataUrl: 'data:image/png;base64,AA', path: 'img/shot.png' },
  ]);
  const lines = request.split('\n');
  assert.equal(lines[0], 'Summarise this');
  assert.equal(lines[1], 'Attached by the user:');
  assert.ok(request.includes('- Note [[A.md]]:\n````markdown\nhas ``` fences\n````'));
  assert.ok(request.includes('- Note [[B.pdf]] (read it if you need it).'));
  assert.ok(request.includes('… (cut; read the note for the rest)'));
  assert.ok(!request.includes('x'.repeat(NOTE_CONTEXT_CHARS + 1)));
  assert.ok(request.includes('- Use the skill "pdf".'));
  assert.ok(request.includes('- Use the tool read_note.'));
  assert.ok(request.includes('saved at [[img/shot.png]]'));
  assert.equal(buildRequest('hi', []), 'hi');
});

test('displayMessage: images embed and notes link', () => {
  assert.equal(
    displayMessage('Look', [
      { kind: 'image', label: 'i', dataUrl: 'data:', path: 'i.png' },
      { kind: 'note', path: 'N.md', label: 'N' },
    ]),
    'Look\n\n![[i.png]] · [[N.md]]',
  );
  assert.equal(displayMessage('Only words', []), 'Only words');
});

test('rank: prefix of the file name first, then word starts, then anywhere', () => {
  const items = ['Projects/Voice Agent.md', 'Agenda.md', 'Notes/agent log.md', 'Magenta.md'];
  assert.deepEqual(
    rank(items, 'agen', s => s),
    ['Agenda.md', 'Notes/agent log.md', 'Projects/Voice Agent.md', 'Magenta.md'],
  );
  assert.deepEqual(
    rank(items, 'zzz', s => s),
    [],
  );
  assert.equal(rank(items, '', s => s, 2).length, 2);
});

test('prepareMarkdown: mermaid and pele fences become diagrams; \\[ \\] becomes $$', () => {
  const out = prepareMarkdown(
    'Flow:\n```mermaid\ngraph TD; A-->B\n```\n```pele\nx\n```\nMath \\(a^2\\) and\n\\[b\\]\n```js\nconst s = "\\(keep\\)";\n```',
  );
  assert.ok(out.includes('```va-diagram\ngraph TD; A-->B\n```'));
  assert.ok(out.includes('```va-diagram\nx\n```'));
  assert.ok(out.includes('Math $a^2$ and'));
  assert.ok(out.includes('$$b$$'));
  assert.ok(out.includes('"\\(keep\\)"'), 'code is left alone');
});

test('clipPreview never cuts inside a table or fence', () => {
  const table = '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(5);
  const text = 'intro line\n\n' + table + '\nafter';
  const clipped = clipPreview(text, 20);
  // Either the whole table or none of it.
  const rows = (clipped.match(/\| 1 \| 2 \|/g) ?? []).length;
  assert.ok(rows === 0 || rows === 5, `table cut mid-way: ${rows} rows`);
});

test('relayLine: a typed request says the answer is read in the panel', () => {
  assert.match(relayLine('[Voice]', 'hi', true, true), /typed this in the panel/);
  assert.match(relayLine('[Voice]', 'hi', false), /they may keep talking: hi$/);
});

test('Responses body sends attached images as input_image', () => {
  const content = [
    { type: 'text' as const, text: 'what is this' },
    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA' } },
  ];
  assert.deepEqual(contentImages(content), ['data:image/png;base64,AA']);
  const body = toResponsesBody(
    { model: 'm', messages: [{ role: 'user', content }] },
    undefined,
    false,
  ) as { input: { role: string; content: unknown }[] };
  assert.deepEqual(body.input[0].content, [
    { type: 'input_text', text: 'what is this' },
    { type: 'input_image', image_url: 'data:image/png;base64,AA' },
  ]);
  const plain = toResponsesBody(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    undefined,
    false,
  ) as {
    input: { content: unknown }[];
  };
  assert.equal(plain.input[0].content, 'hi');
});
