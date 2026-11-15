import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers';
import {
  clipToolOutput,
  geminiFunctionResponse,
  geminiNonBlockingMode,
  toGeminiFunctionDeclaration,
  toRealtimeFunctionTool,
  toResponsesFunctionTool,
  voiceDescription,
} from '../../../src/realtime/toolAdapters';
import { ChatToolExecutor } from '../../../src/realtime/ChatToolExecutor';
import { toolError, toolErrorType, TOOL_TIMEOUT_MS } from '../../../src/tools/toolContract';
import type { ToolDefinition } from '../../../src/types';
import { addTool, sleep, testChat } from './helpers';

/**
 * A tool definition.
 * @param name - Tool name.
 * @param description - Description.
 */
function def(name: string, description = 'Does a thing.'): ToolDefinition {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: {}, required: [] } },
  } as unknown as ToolDefinition;
}

test('voice output clipping keeps the summary line and says how much was cut', () => {
  const text = `Found 120 notes in Projects\n${'row\n'.repeat(3000)}end`;
  const out = clipToolOutput(text, 6000);
  assert.ok(out.startsWith('Found 120 notes in Projects\n'));
  assert.match(out, /…\[\d+ of \d+ characters cut\]…/);
  assert.ok(out.endsWith('end'));
  assert.ok(out.length <= 6000);
});

test('voice output clipping keeps the error type and reason intact', () => {
  const reason = `No note called "${'very long name '.repeat(30)}".`;
  const err = `${toolError('NotFound', reason, ['Search by title.'])}\n${'x'.repeat(9000)}`;
  const out = clipToolOutput(err, 200);
  assert.ok(out.startsWith(`Error: NotFound: ${reason}\nTry:\n- Search by title.`));
  assert.equal(toolErrorType(out), 'NotFound');
});

test('descriptions over 4000 characters keep their start and say how much was cut', () => {
  const desc = `Summary line.\n${'detail '.repeat(1000)}`;
  const out = voiceDescription(desc);
  assert.ok(out.length <= 4000);
  assert.ok(out.startsWith('Summary line.\n'));
  assert.match(out, /…\[\d+ characters cut\]$/);
  assert.equal(voiceDescription('short'), 'short');
  assert.equal(
    (toRealtimeFunctionTool(def('read_file', desc)).description as string).length <= 4000,
    true,
  );
  assert.equal(toResponsesFunctionTool(def('read_file')).strict, false);
});

test('Gemini NON_BLOCKING applies to read-only tools only', () => {
  const read = toGeminiFunctionDeclaration(def('search_vault'), true);
  const write = toGeminiFunctionDeclaration(def('create_obsidian_note'), true);
  const code = toGeminiFunctionDeclaration(def('codemode'), 'reads');
  const mcp = toGeminiFunctionDeclaration(def('mcp__srv__do'), true);
  assert.equal(read.behavior, 'NON_BLOCKING');
  assert.equal(write.behavior, undefined);
  assert.equal(code.behavior, undefined);
  assert.equal(mcp.behavior, undefined);
  assert.equal(toGeminiFunctionDeclaration(def('search_vault'), false).behavior, undefined);
  assert.equal(
    toGeminiFunctionDeclaration(def('create_obsidian_note'), 'all').behavior,
    'NON_BLOCKING',
  );
  assert.ok('parametersJsonSchema' in read);
  // Models without scheduling only accept NON_BLOCKING functions.
  assert.equal(geminiNonBlockingMode(false, false), 'all');
  assert.equal(geminiNonBlockingMode(true, true), 'reads');
  assert.equal(geminiNonBlockingMode(false, true), false);
});

test('Gemini function responses carry the error type for failed calls', () => {
  assert.deepEqual(geminiFunctionResponse('ok'), { output: 'ok' });
  assert.deepEqual(geminiFunctionResponse(toolError('Timeout', 'Too slow.', ['Retry.'])), {
    error: 'Timeout: Too slow. Try: Retry.',
    error_type: 'Timeout',
  });
});

test('voice tool calls time out as Timeout errors and cancel() aborts running calls', async () => {
  const chat = testChat();
  let seen: AbortSignal | undefined;
  addTool(chat, 'voice_slow', async (_args, tool) => {
    seen = tool.chatRef.abortSignal;
    await sleep(300);
    return 'late';
  });
  TOOL_TIMEOUT_MS.voice_slow = 30;
  const executor = new ChatToolExecutor(chat as never);
  const out = (await executor.executeTool('voice_slow', {})) as string;
  assert.equal(toolErrorType(out), 'Timeout');
  assert.ok(seen?.aborted);

  TOOL_TIMEOUT_MS.voice_slow = 10_000;
  const pending = executor.executeTool('voice_slow', {});
  await sleep(10);
  executor.cancel();
  assert.equal(toolErrorType((await pending) as string), 'Cancelled');
  assert.ok(seen?.aborted);
  delete TOOL_TIMEOUT_MS.voice_slow;
});
