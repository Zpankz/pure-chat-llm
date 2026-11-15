/**
 * Code mode end to end with the Web Worker engine: the real worker source runs in a Node worker
 * thread standing in for a browser Web Worker. The djs engine needs djs.wasm, which is not in the
 * repository, so it is not run here (its loader's hash check is tested in djsLoader.test.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers';
import { CodeModeTool, formatRun } from '../../../src/tools/CodeMode';
import { isToolError, jsonResult, toolError, toolErrorType } from '../../../src/tools/toolContract';
import { addTool, nodeWorker, sleep, testChat, type TestChat } from './helpers';

CodeModeTool.makeWorker = nodeWorker;

/**
 * Runs a script through the code mode tool.
 * @param chat - Test chat with tools.
 * @param code - Script.
 * @param extra - Extra tool arguments.
 */
function run(chat: TestChat, code: string, extra: Record<string, unknown> = {}): Promise<string> {
  const tool = new CodeModeTool(chat as never, chat.toolregistry);
  return tool.execute({ code, ...extra });
}

test('scripts call tools with format json by default and get parsed results', async () => {
  const chat = testChat();
  const formats: unknown[] = [];
  addTool(
    chat,
    'search_vault',
    args => {
      formats.push(args.format);
      return args.format === 'json' ? jsonResult({ count: 2, paths: ['a.md', 'b.md'] }) : 'Found 2';
    },
    { json: true },
  );
  addTool(chat, 'plain_tool', args => `plain ${String(args.format)}`);
  const out = await run(
    chat,
    `const r = await tools.search_vault({ query: 'x' });
     const t = await tools.search_vault({ query: 'x', format: 'text' });
     const p = await tools.plain_tool({});
     return { n: r.count + 1, first: r.paths[0], t, p };`,
  );
  assert.ok(!isToolError(out), out);
  assert.deepEqual(formats, ['json', 'text']);
  assert.match(out, /"n": 3/);
  assert.match(out, /"first": "a.md"/);
  assert.match(out, /"t": "Found 2"/);
  assert.match(out, /"p": "plain undefined"/);
  assert.match(out, /^Script completed .*2 tool calls|^Script completed .*3 tool calls/);
  assert.match(out, /Web Worker fallback/);
});

test('a failed tool call throws a ToolError the script can catch', async () => {
  const chat = testChat();
  addTool(chat, 'read_file', () =>
    toolError('NotFound', 'No note at a.md.', ['Use glob_vault_files.']),
  );
  const out = await run(
    chat,
    `try { await tools.read_file({ path: 'a.md' }); }
     catch (e) { return [e.name, e.tool, e.type, e.message].join(' | '); }`,
  );
  assert.ok(!isToolError(out), out);
  assert.match(
    out,
    /ToolError \| read_file \| NotFound \| read_file failed: NotFound: No note at a\.md\. Try: Use glob_vault_files\./,
  );

  const uncaught = await run(chat, `text('before'); await tools.read_file({ path: 'a.md' });`);
  assert.ok(isToolError(uncaught), uncaught);
  assert.equal(toolErrorType(uncaught), 'ScriptError');
  assert.match(uncaught, /Uncaught tool failure: read_file failed: NotFound/);
  assert.match(uncaught, /before/);
});

test('script errors come back as ScriptError with the JavaScript error', async () => {
  const chat = testChat();
  const out = await run(chat, `const x = null; return x.y;`);
  assert.equal(toolErrorType(out), 'ScriptError');
  assert.match(out, /^Error: ScriptError: TypeError: /);
  const syntax = await run(chat, `return (;`);
  assert.equal(toolErrorType(syntax), 'ScriptError');
  assert.match(syntax, /SyntaxError/);
  const unknown = await run(chat, `await tools.call('missing_tool', {});`);
  assert.match(unknown, /UnknownTool/);
});

test('a script that runs too long times out, keeps its printed output, and aborts running calls', async () => {
  const chat = testChat();
  const signals: { start?: AbortSignal; late?: AbortSignal } = {};
  addTool(chat, 'slow_read', async (_args, tool) => {
    signals.start = tool.chatRef.abortSignal;
    await sleep(1500);
    signals.late = tool.chatRef.abortSignal;
    return 'late';
  });
  const out = await run(chat, `text('step 1 done'); await tools.slow_read({}); text('never');`, {
    timeout_ms: 1000,
  });
  assert.ok(isToolError(out), out);
  assert.equal(toolErrorType(out), 'Timeout');
  assert.match(out, /did not finish within 1 s/);
  assert.match(out, /step 1 done/);
  assert.doesNotMatch(out, /never/);
  // The call that was still running sees an aborted signal, whether it took it at the start or
  // reads the chat's signal right before it would write.
  assert.ok(signals.start?.aborted);
  await sleep(700);
  assert.ok(signals.late?.aborted, 'a late read of chat.abortSignal sees the aborted run');

  const endless = await run(chat, `while (true) {}`, { timeout_ms: 1000 });
  assert.equal(toolErrorType(endless), 'Timeout');
});

test('time waiting for the user does not count against the script', async () => {
  const chat = testChat();
  addTool(chat, 'create_obsidian_note', async () => {
    await sleep(1400);
    return 'Created a.md';
  });
  const out = await run(chat, `return await tools.create_obsidian_note({ path: 'a.md' });`, {
    timeout_ms: 1000,
  });
  assert.ok(!isToolError(out), out);
  assert.match(out, /Created a\.md/);
});

test('cancelling the request stops the script and its calls', async () => {
  const chat = testChat();
  let seen: AbortSignal | undefined;
  addTool(chat, 'slow_read', async (_args, tool) => {
    seen = tool.chatRef.abortSignal;
    await sleep(800);
    return 'late';
  });
  const request = new AbortController();
  chat.abortSignal = request.signal;
  const pending = run(chat, `await tools.slow_read({});`);
  await sleep(300);
  request.abort();
  const out = await pending;
  assert.equal(toolErrorType(out), 'Cancelled');
  assert.ok(seen?.aborted);
  await sleep(600);
  assert.equal(chat.abortSignal, request.signal, 'the request signal is put back');
});

test('output is capped and keeps the first line', async () => {
  const chat = testChat();
  const out = await run(chat, `text('x'.repeat(5000)); return 'end';`, { max_output_chars: 800 });
  assert.ok(out.length <= 800, String(out.length));
  assert.match(out, /^Script completed/);
  assert.match(out, /characters cut/);
});

test('engine set to djs without a module is an EngineUnavailable error', async () => {
  const chat = testChat({ engine: 'djs' });
  const vault = chat.plugin.app.vault as unknown as { adapter: Record<string, unknown> };
  vault.adapter.readBinary = async () => new ArrayBuffer(0);
  const out = await run(chat, `return 1;`);
  assert.equal(toolErrorType(out), 'EngineUnavailable');
  assert.match(out, /no djs module at/);
});

test('formatRun reports engine limits as ResourceLimit', () => {
  const out = formatRun(
    {
      ok: false,
      limit: 'fuel',
      error: 'The script used its whole instruction budget.',
      outputs: [],
      console: [],
    },
    { timeoutMs: 1000, stats: 'Script failed', partial: { outputs: ['partial'], console: [] } },
  );
  assert.equal(toolErrorType(out), 'ResourceLimit');
  assert.match(out, /partial/);
});

test('the description teaches JSON results and error throwing', () => {
  const chat = testChat();
  addTool(chat, 'search_vault', () => '', { json: true });
  const description = new CodeModeTool(chat as never, chat.toolregistry).description;
  assert.match(description, /tools\.search_vault \(json\)/);
  assert.match(description, /format:"json"/);
  assert.match(description, /ToolError/);
  assert.match(description, /Web Worker fallback/);
});
