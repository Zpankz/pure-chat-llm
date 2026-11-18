import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers';
import {
  callWithSignal,
  clipToolText,
  DEFAULT_TOOL_TIMEOUT_MS,
  isReadOnlyTool,
  isToolError,
  toolError,
  toolErrorLine,
  toolErrorReason,
  toolErrorRecovery,
  toolErrorType,
  toolTimeoutMs,
  TOOL_LAYERS,
  withToolTimeout,
} from '../../../src/tools/toolContract';
import { sleep } from './helpers';

test('error helpers read type, reason and recovery from new and old formats', () => {
  const out = toolError('NotFound', 'No note at a.md.', ['Use glob_vault_files.', 'Check case.']);
  assert.equal(toolErrorType(out), 'NotFound');
  assert.equal(toolErrorReason(out), 'No note at a.md.');
  assert.deepEqual(toolErrorRecovery(out), ['Use glob_vault_files.', 'Check case.']);
  assert.equal(
    toolErrorLine(out),
    'NotFound: No note at a.md. Try: Use glob_vault_files.; Check case.',
  );
  assert.equal(toolErrorType('ERROR: FileNotFound (Recoverable)\nmore'), 'FileNotFound');
  assert.equal(toolErrorType('Error: something broke'), 'Error');
  assert.equal(toolErrorReason('Error: something broke'), 'something broke');
  assert.equal(toolErrorType('All good'), undefined);
  assert.deepEqual(toolErrorRecovery('All good'), []);
});

test('timeouts: 60 s default, longer for slow tools, none for tools that wait for the user', () => {
  assert.equal(DEFAULT_TOOL_TIMEOUT_MS, 60_000);
  assert.equal(toolTimeoutMs('read_file'), 60_000);
  assert.equal(toolTimeoutMs('mcp__server__tool'), 120_000);
  assert.equal(toolTimeoutMs('generate_image'), 180_000);
  assert.equal(toolTimeoutMs('create_obsidian_note'), 0);
  assert.equal(toolTimeoutMs('codemode'), 0);
});

test('withToolTimeout: a hung call becomes a Timeout error and its signal is aborted', async () => {
  let seen: AbortSignal | undefined;
  const out = await withToolTimeout('slow_tool', 30, async signal => {
    seen = signal;
    await sleep(200);
    return 'late';
  });
  assert.ok(isToolError(out), out);
  assert.equal(toolErrorType(out), 'Timeout');
  assert.match(out, /slow_tool did not finish within/);
  assert.ok(seen?.aborted);
});

test('withToolTimeout: fast calls pass through, throws become ToolFailed, parent abort cancels', async () => {
  assert.equal(await withToolTimeout('t', 1000, async () => 'ok'), 'ok');
  assert.equal(await withToolTimeout('t', 0, async () => 'no limit'), 'no limit');
  const thrown = await withToolTimeout('t', 1000, async () => {
    throw new Error('boom');
  });
  assert.equal(toolErrorType(thrown), 'ToolFailed');
  assert.match(thrown, /boom/);

  const parent = new AbortController();
  let seen: AbortSignal | undefined;
  const pending = withToolTimeout(
    't',
    0,
    async signal => {
      seen = signal;
      await sleep(100);
      return 'late';
    },
    parent.signal,
  );
  parent.abort();
  const cancelled = await pending;
  assert.equal(toolErrorType(cancelled), 'Cancelled');
  assert.ok(seen?.aborted);
  assert.equal(
    toolErrorType(await withToolTimeout('t', 0, async () => 'x', parent.signal)),
    'Cancelled',
  );
});

test('callWithSignal gives each call its own signal and puts the old one back', async () => {
  const host: { abortSignal?: AbortSignal } = {};
  const base = new AbortController().signal;
  host.abortSignal = base;
  const a = new AbortController().signal;
  const b = new AbortController().signal;
  const seen: (AbortSignal | undefined)[] = [];
  const start = () => {
    seen.push(host.abortSignal);
    return sleep(5).then(() => 'done');
  };
  await Promise.all([callWithSignal(host, a, start), callWithSignal(host, b, start)]);
  assert.equal(seen[0], a);
  assert.equal(seen[1], b);
  assert.equal(host.abortSignal, base);
});

test('clipToolText keeps the summary line and an error whole and says how much was cut', () => {
  const long = `Found 500 notes\n${'x'.repeat(5000)}\nlast line`;
  const clipped = clipToolText(long, 1000);
  assert.ok(clipped.startsWith('Found 500 notes\n'));
  assert.ok(clipped.endsWith('last line'));
  assert.match(clipped, /characters cut/);
  assert.ok(clipped.length <= 1000, String(clipped.length));

  const err = `${toolError('NotFound', 'No note called "Alpha".', ['Search by title.'])}\n${'detail '.repeat(800)}`;
  const e = clipToolText(err, 300);
  assert.ok(e.startsWith('Error: NotFound: No note called "Alpha".\nTry:\n- Search by title.'));
  assert.equal(toolErrorType(e), 'NotFound');
  assert.equal(clipToolText('short', 100), 'short');
});

test('read-only tools agree with the layers: all of them may run in the orchestrator', () => {
  for (const [name, layers] of Object.entries(TOOL_LAYERS)) {
    if (isReadOnlyTool(name)) assert.ok(layers.includes('orchestrator'), name);
    if (!layers.includes('orchestrator')) assert.ok(!isReadOnlyTool(name), name);
  }
  assert.ok(isReadOnlyTool('search_vault'));
  assert.ok(!isReadOnlyTool('create_obsidian_note'));
  assert.ok(!isReadOnlyTool('codemode'));
  assert.ok(!isReadOnlyTool('mcp__x__y'));
  // No write tool is read-only.
  for (const name of [
    'write_note_section',
    'replace_in_note',
    'delete_obsidian_note',
    'manage_templates',
  ])
    assert.ok(!isReadOnlyTool(name), name);
});
