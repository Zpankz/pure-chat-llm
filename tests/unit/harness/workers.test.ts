import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { openDurable } from '../../../src/harness/durable';
import type { DurableSession } from '../../../src/harness/durable';
import type { LayerName, LayerSend, LayerSendRequest } from '../../../src/harness/layerProvider';
import { CTX, MemoryStorage } from '../../../src/harness/pi';
import type { Storage } from '../../../src/harness/pi';
import type { ToolSource } from '../../../src/harness/toolsExtension';
import { WorkersDoc } from '../../../src/harness/workers';
import type { ChatResponse, ToolDefinition } from '../../../src/types';

type Answer = (r: LayerSendRequest, signal?: AbortSignal) => ChatResponse | Promise<ChatResponse>;

/** Answers each layer's requests from its own script, and keeps every request per layer. */
function layers(script: Partial<Record<LayerName, Answer[]>>) {
  const requests: Record<LayerName, LayerSendRequest[]> = {
    orchestrator: [],
    worker: [],
    evaluator: [],
  };
  const send: LayerSend = async (layer, request, { signal }) => {
    requests[layer].push(structuredClone(request));
    const next = script[layer]?.shift();
    if (!next) throw new Error(`no more scripted ${layer} answers`);
    return next(request, signal);
  };
  return { send, requests };
}

const call =
  (name: string, args: Record<string, unknown>, id = `c_${name}`): Answer =>
  () => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
const say =
  (text: string): Answer =>
  () => ({ role: 'assistant', content: text });

const def = (name: string): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Note path' } },
      required: [],
    },
  },
});
const vaultTools: ToolSource = {
  definitions: () => [def('read_file')],
  run: async () => 'contents',
  readOnly: () => true,
};

const toolNames = (r: LayerSendRequest) => (r.tools ?? []).map(t => t.function.name).sort();
const lastTool = (r: LayerSendRequest) =>
  [...r.messages].reverse().find(m => m.role === 'tool')?.content as string | undefined;
const lastUser = (r: LayerSendRequest) =>
  [...r.messages].reverse().find(m => m.role === 'user')?.content as string | undefined;
const userTexts = (r: LayerSendRequest) =>
  r.messages.filter(m => m.role === 'user').map(m => String(m.content));

async function until(check: () => boolean, what: string, ms = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

async function open(send: LayerSend, storage: Storage = new MemoryStorage()) {
  return openDurable(
    { vaultKey: 'test', send, tools: vaultTools, workerInstructions: () => 'You are a worker.' },
    { storage },
  );
}

async function workers(session: DurableSession) {
  const root = await session.root();
  return (await session.harness.snapshot(WorkersDoc, root.id, CTX))?.tasks ?? {};
}

test('a delegated task runs in the background and reports back to the orchestrator', async () => {
  const { send, requests } = layers({
    orchestrator: [
      call('delegate_task', {
        title: 'Find the answer',
        instructions: 'Read a.md and say what it says.',
      }),
      say('On it.'),
      call('get_task_result', { id: 't1' }),
      say('It says 42.'),
    ],
    worker: [call('read_file', { path: 'a.md' }), say('a.md says 42.')],
  });
  const session = await open(send);
  try {
    const root = await session.root();
    const first = await (
      await root.submit({ type: 'input', content: 'What does a.md say?' }, CTX)
    ).wait(CTX);
    assert.equal(first.status, 'done');
    await until(() => requests.orchestrator.length === 4, 'the orchestrator to answer the report');
    await session.harness.waitForIdle(CTX);

    // The orchestrator has the orchestration tools and not the worker's; the worker the reverse.
    assert.ok(toolNames(requests.orchestrator[0]).includes('delegate_task'));
    assert.ok(!toolNames(requests.orchestrator[0]).includes('ask_orchestrator'));
    assert.deepEqual(toolNames(requests.worker[0]), [
      'ask_orchestrator',
      'read_file',
      'report_progress',
    ]);
    // The worker sees only its brief and instructions, not the user's conversation.
    assert.deepEqual(userTexts(requests.worker[0]), ['Read a.md and say what it says.']);
    assert.match(String(requests.worker[0].messages[0].content), /You are a worker\./);
    // The report arrives as an input, then the result comes through get_task_result.
    assert.match(
      lastUser(requests.orchestrator[2]) ?? '',
      /^\[Agent update\] t1 "Find the answer" finished/,
    );
    assert.equal(lastTool(requests.orchestrator[3]), 'a.md says 42.');
    const t1 = (await workers(session)).t1;
    assert.equal(t1.status, 'done');
    assert.equal(t1.result, 'a.md says 42.');
  } finally {
    await session.close();
  }
});

test('a worker asks the orchestrator, gets the answer through message_task, and carries on', async () => {
  const { send, requests } = layers({
    orchestrator: [
      call('delegate_task', { title: 'Tidy notes', instructions: 'Tidy the notes.' }),
      say('Started.'),
      call('message_task', { id: 't1', message: 'Use Inbox.' }),
      say('Told it to use Inbox.'),
      say('Tidying is done.'),
    ],
    worker: [call('ask_orchestrator', { question: 'Which folder?' }), say('Tidied Inbox.')],
  });
  const session = await open(send);
  try {
    const root = await session.root();
    await (await root.submit({ type: 'input', content: 'Tidy my notes' }, CTX)).wait(CTX);
    await until(() => requests.orchestrator.length >= 3, 'the question to reach the orchestrator');
    assert.match(
      lastUser(requests.orchestrator[2]) ?? '',
      /t1 "Tidy notes" needs advice: Which folder\?/,
    );
    await until(() => requests.orchestrator.length === 5, 'the final report');
    await session.harness.waitForIdle(CTX);
    assert.equal(lastTool(requests.worker[1]), 'Use Inbox.');
    assert.match(lastUser(requests.orchestrator[4]) ?? '', /t1 "Tidy notes" finished/);
    const t1 = (await workers(session)).t1;
    assert.equal(t1.status, 'done');
    assert.equal(t1.question, null);
  } finally {
    await session.close();
  }
});

test('cancel_task stops a running worker and no finished report arrives', async () => {
  let workerStarted = false;
  const { send, requests } = layers({
    orchestrator: [
      call('delegate_task', { title: 'Long job', instructions: 'Take your time.' }),
      say('Started.'),
      call('cancel_task', { id: 'long job' }),
      say('Stopped it.'),
    ],
    worker: [
      (_r, signal) =>
        new Promise<ChatResponse>((_resolve, reject) => {
          workerStarted = true;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    ],
  });
  const session = await open(send);
  try {
    const root = await session.root();
    await (await root.submit({ type: 'input', content: 'Start the long job' }, CTX)).wait(CTX);
    await until(() => workerStarted, 'the worker to start');
    const [t1] = Object.values(await workers(session));
    // The user asks to stop it; the orchestrator finds it by title.
    await (await root.submit({ type: 'input', content: 'Stop the long job' }, CTX)).wait(CTX);
    assert.match(lastTool(requests.orchestrator[3]) ?? '', /Stopping t1 "Long job"/);
    await session.harness.waitForTask(t1.taskId as never, CTX);
    assert.equal((await workers(session)).t1.status, 'cancelled');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(requests.orchestrator.length, 4, 'no report reached the orchestrator');
  } finally {
    await session.close();
  }
});

test('after a restart mid-task the worker carries on, and the brief and report go once', async () => {
  // A process dies without closing its storage; the next one opens the same data.
  const memory = new MemoryStorage();
  const storage = new Proxy(memory, {
    get(target, key) {
      if (key === 'close') return async () => {};
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  let workerStarted = false;
  const first = layers({
    orchestrator: [
      call('delegate_task', { title: 'Survive', instructions: 'Answer after the restart.' }),
      say('Started.'),
    ],
    worker: [
      (_r, signal) =>
        new Promise<ChatResponse>((_resolve, reject) => {
          workerStarted = true;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    ],
  });
  const s1 = await open(first.send, storage);
  const root1 = await s1.root();
  await (await root1.submit({ type: 'input', content: 'Go' }, CTX)).wait(CTX);
  await until(() => workerStarted, 'the worker to start');
  await s1.close();

  const second = layers({
    worker: [say('Survived.')],
    orchestrator: [say('It survived.')],
  });
  const s2 = await open(second.send, storage);
  try {
    await until(() => second.requests.orchestrator.length === 1, 'the report after the restart');
    await s2.harness.waitForIdle(CTX);
    assert.equal((await workers(s2)).t1.status, 'done');
    assert.equal((await workers(s2)).t1.result, 'Survived.');
    // The worker's conversation holds the brief once.
    assert.deepEqual(userTexts(second.requests.worker[0]), ['Answer after the restart.']);
    // The orchestrator got exactly one report.
    const reports = userTexts(second.requests.orchestrator[0]).filter(t =>
      t.includes('t1 "Survive"'),
    );
    assert.equal(reports.length, 1);
  } finally {
    await s2.close();
  }
});

test('a question asked before a restart is answered after it, and asked once', async () => {
  const memory = new MemoryStorage();
  const storage = new Proxy(memory, {
    get(target, key) {
      if (key === 'close') return async () => {};
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  // First session: the worker asks, and the orchestrator's turn on the question never ends.
  let questionArrived = false;
  const first = layers({
    orchestrator: [
      call('delegate_task', { title: 'Pick a folder', instructions: 'Move the note.' }),
      say('Started.'),
      (_r, signal) =>
        new Promise<ChatResponse>((_resolve, reject) => {
          questionArrived = true;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    ],
    worker: [call('ask_orchestrator', { question: 'Which folder?' })],
  });
  const s1 = await open(first.send, storage);
  await (await (await s1.root()).submit({ type: 'input', content: 'Move it' }, CTX)).wait(CTX);
  await until(() => questionArrived, 'the question');
  await s1.close();

  // Second session: the orchestrator's turn on the question resumes and answers it.
  const second = layers({
    orchestrator: [
      call('message_task', { id: 't1', message: 'Archive.' }),
      say('Archive it is.'),
      say('Moved.'),
    ],
    worker: [say('Moved to Archive.')],
  });
  const s2 = await open(second.send, storage);
  try {
    await until(() => second.requests.orchestrator.length === 3, 'the final report');
    await s2.harness.waitForIdle(CTX);
    assert.equal((await workers(s2)).t1.status, 'done');
    assert.equal(lastTool(second.requests.worker[0]), 'Archive.');
    const asks = userTexts(second.requests.orchestrator[2]).filter(t => t.includes('needs advice'));
    assert.equal(asks.length, 1);
  } finally {
    await s2.close();
  }
});
