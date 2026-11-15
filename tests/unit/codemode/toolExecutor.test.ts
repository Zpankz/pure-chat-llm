import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers';
import { ToolExecutor } from '../../../src/core/ToolExecutor';
import { toolErrorType, TOOL_TIMEOUT_MS } from '../../../src/tools/toolContract';
import type { ToolCall } from '../../../src/types';
import { addTool, sleep, testChat } from './helpers';

/**
 * A tool call.
 * @param id - Call id.
 * @param name - Tool name.
 * @param args - Arguments as JSON text.
 */
function call(id: string, name: string, args = '{}'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } } as ToolCall;
}

test('reads from one turn run side by side, writes one at a time, outputs stay in order', async () => {
  const chat = testChat();
  const log: string[] = [];
  const timed = (name: string) => async () => {
    log.push(`start ${name}`);
    await sleep(40);
    log.push(`end ${name}`);
    return `${name} done`;
  };
  addTool(chat, 'search_vault', timed('search_vault'));
  addTool(chat, 'read_file', timed('read_file'));
  addTool(chat, 'create_obsidian_note', timed('create_obsidian_note'));
  const executor = new ToolExecutor(chat.toolregistry);
  const outputs = await executor.runCalls([
    call('1', 'search_vault'),
    call('2', 'read_file'),
    call('3', 'create_obsidian_note'),
    call('4', 'read_file'),
  ]);
  assert.deepEqual(outputs, [
    'search_vault done',
    'read_file done',
    'create_obsidian_note done',
    'read_file done',
  ]);
  // The two reads started together; the write started after both ended.
  assert.deepEqual(log.slice(0, 2), ['start search_vault', 'start read_file']);
  assert.ok(log.indexOf('start create_obsidian_note') > log.indexOf('end read_file'));
  assert.ok(log.indexOf('start read_file', 3) > log.indexOf('end create_obsidian_note'));
});

test('a hung call becomes a Timeout error and sees an aborted signal', async () => {
  const chat = testChat();
  let seen: AbortSignal | undefined;
  addTool(chat, 'hangs', async (_args, tool) => {
    seen = tool.chatRef.abortSignal;
    await sleep(500);
    return 'late';
  });
  TOOL_TIMEOUT_MS.hangs = 30;
  try {
    const [out] = await new ToolExecutor(chat.toolregistry).runCalls([call('1', 'hangs')]);
    assert.equal(toolErrorType(out), 'Timeout');
    assert.ok(seen?.aborted);
    assert.equal(chat.abortSignal, undefined, 'the chat signal is put back');
  } finally {
    delete TOOL_TIMEOUT_MS.hangs;
  }
});

test('every call answers: unknown tools and bad JSON become errors; request abort cancels', async () => {
  const chat = testChat();
  addTool(chat, 'read_file', async () => {
    await sleep(100);
    return 'text';
  });
  const executor = new ToolExecutor(chat.toolregistry);
  const outputs = await executor.runCalls([
    call('1', 'nope'),
    call('2', 'read_file', '{bad'),
    call('3', 'read_file', '{"a":1}{"a":1}'.slice(0, 7)),
  ]);
  assert.equal(toolErrorType(outputs[0]), 'UnknownTool');
  assert.equal(toolErrorType(outputs[1]), 'InvalidArguments');
  assert.equal(outputs[2], 'text');

  const request = new AbortController();
  chat.abortSignal = request.signal;
  const pending = executor.runCalls([call('1', 'read_file')]);
  request.abort();
  assert.equal(toolErrorType((await pending)[0]), 'Cancelled');
});
