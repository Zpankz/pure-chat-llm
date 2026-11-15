import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolOutputBuilder } from '../../../src/tools/ToolOutputBuilder';
import { isToolError, toolErrorType } from '../../../src/tools/toolContract';

/**
 * Builds the same sample output in either mode.
 * @param json - JSON mode.
 */
function sample(json: boolean): ToolOutputBuilder {
  return new ToolOutputBuilder({ json })
    .addHeader('Search results', 'Success')
    .addKeyValue('Files searched', 42)
    .addKeyValue('Query', 'alpha')
    .addTable(['Path', 'Line'], [['a.md', '3']], 'matches')
    .addSection('Context', 'some text')
    .set('truncated', false)
    .addSuggestions('Narrow the query.');
}

test('text output keeps its layout', () => {
  assert.equal(
    sample(false).build(),
    [
      'Search results (Success)',
      '---',
      'Files searched: 42',
      'Query: alpha',
      '| Path | Line |',
      '|------|------|',
      '| a.md | 3    |',
      '\nContext:\n---\nsome text\n---',
      '\nSUGGESTED ACTIONS:',
      '1. Narrow the query.',
    ].join('\n'),
  );
  // The default constructor is text.
  assert.equal(new ToolOutputBuilder().addKeyValue('A', 'b').build(), 'A: b');
});

test('json mode builds one compact object from the same calls', () => {
  const out = sample(true).build();
  assert.ok(!out.includes('\n'));
  assert.deepEqual(JSON.parse(out), {
    title: 'Search results',
    status: 'Success',
    files_searched: 42,
    query: 'alpha',
    matches: [{ path: 'a.md', line: '3' }],
    context: 'some text',
    truncated: false,
    suggestions: ['Narrow the query.'],
  });
  // toJson works on a text builder too, and build stays text there.
  assert.equal(JSON.parse(sample(false).toJson()).files_searched, 42);
  assert.equal(
    ToolOutputBuilder.key('Notes whose title or path matches'),
    'notes_whose_title_or_path_matches',
  );
  assert.equal(ToolOutputBuilder.key('maxResults'), 'max_results');
});

test('errors stay in the toolError format in both modes', () => {
  for (const json of [false, true]) {
    const out = sample(json)
      .addError('NotFound', 'No note at a.md.', ['Use glob_vault_files.'])
      .build();
    assert.ok(isToolError(out), out);
    assert.equal(toolErrorType(out), 'NotFound');
    assert.equal(out, 'Error: NotFound: No note at a.md.\nTry:\n- Use glob_vault_files.');
  }
});
