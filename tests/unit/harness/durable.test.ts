import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { layerRef, openDurable } from '../../../src/harness/durable';
import type { LayerSend, LayerSendRequest } from '../../../src/harness/layerProvider';
import { CTX, MemoryStorage } from '../../../src/harness/pi';
import type { ToolSource } from '../../../src/harness/toolsExtension';
import type { ChatResponse, ToolDefinition } from '../../../src/types';

const def = (name: string): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Note path' } },
      required: ['path'],
    },
  },
});

/** Answers each layer request from a script, and keeps every request it got. */
function scripted(answers: ((r: LayerSendRequest) => ChatResponse | Promise<ChatResponse>)[]) {
  const requests: LayerSendRequest[] = [];
  const send: LayerSend = async (_layer, request) => {
    requests.push(structuredClone(request));
    const next = answers.shift();
    if (!next) throw new Error('no more scripted answers');
    return next(request);
  };
  return { send, requests };
}

const callTool =
  (name: string, path: string, id = 'c1') =>
  (): ChatResponse => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify({ path }) } }],
  });
const say = (text: string) => (): ChatResponse => ({ role: 'assistant', content: text });

function tools(run: ToolSource['run'], gate?: ToolSource['gate']): ToolSource {
  return {
    definitions: () => [def('read_file'), def('write_note')],
    run,
    readOnly: name => name === 'read_file',
    gate,
  };
}

const lastToolMessage = (r: LayerSendRequest) =>
  [...r.messages].reverse().find(m => m.role === 'tool')?.content as string | undefined;

async function ask(session: Awaited<ReturnType<typeof openDurable>>, content: string) {
  const root = await session.harness.root(CTX, { agent: { model: layerRef('orchestrator') } });
  const submission = await root.submit({ type: 'input', content }, CTX);
  return submission.wait(CTX);
}

test('a durable turn calls a plugin tool through the layer provider and answers', async () => {
  const ran: string[] = [];
  const { send, requests } = scripted([callTool('read_file', 'Notes/a.md'), say('It says hello.')]);
  const session = await openDurable(
    {
      vaultKey: 'test',
      send,
      tools: tools(async (name, args) => {
        ran.push(`${name} ${String(args.path)}`);
        return 'hello';
      }),
    },
    { storage: new MemoryStorage() },
  );
  try {
    const settled = await ask(session, 'What does a.md say?');
    assert.equal(settled.status, 'done');
    assert.deepEqual(ran, ['read_file Notes/a.md']);
    assert.equal(requests.length, 2);
    // The first request carries the tools and the user's question; the second the tool's output.
    assert.ok(requests[0].tools?.some(t => t.function.name === 'write_note'));
    assert.ok(
      requests[0].messages.some(m => m.role === 'user' && m.content === 'What does a.md say?'),
    );
    assert.equal(lastToolMessage(requests[1]), 'hello');
    const assistant = requests[1].messages.find(m => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.[0].function.name, 'read_file');
  } finally {
    await session.close();
  }
});

test('the write gate blocks a call before it runs, and the model is told why', async () => {
  const ran: string[] = [];
  const { send, requests } = scripted([
    callTool('write_note', 'Notes/b.md'),
    say('I could not write it.'),
  ]);
  const session = await openDurable(
    {
      vaultKey: 'test',
      send,
      tools: tools(
        async name => {
          ran.push(name);
          return 'written';
        },
        name => (name === 'write_note' ? 'Both reviewers rejected the change.' : undefined),
      ),
    },
    { storage: new MemoryStorage() },
  );
  try {
    const settled = await ask(session, 'Write b.md');
    assert.equal(settled.status, 'done');
    assert.deepEqual(ran, []);
    assert.match(lastToolMessage(requests[1]) ?? '', /Both reviewers rejected the change/);
  } finally {
    await session.close();
  }
});

test('a tool error comes back to the model as an error result', async () => {
  const { send, requests } = scripted([callTool('read_file', 'missing.md'), say('Not found.')]);
  const session = await openDurable(
    {
      vaultKey: 'test',
      send,
      tools: tools(async () => 'Error: NotFound: missing.md does not exist.'),
    },
    { storage: new MemoryStorage() },
  );
  try {
    assert.equal((await ask(session, 'Read missing.md')).status, 'done');
    assert.match(lastToolMessage(requests[1]) ?? '', /NotFound/);
  } finally {
    await session.close();
  }
});

test('a layer failure ends the run unanswered with its message', async () => {
  const send: LayerSend = async () => {
    throw new Error('Sign in with ChatGPT in settings first.');
  };
  const session = await openDurable(
    { vaultKey: 'test', send, tools: tools(async () => '') },
    { storage: new MemoryStorage() },
  );
  try {
    const settled = await ask(session, 'Hi');
    assert.equal(settled.status, 'unanswered');
  } finally {
    await session.close();
  }
});

test('after a restart mid-call, a read-only call reruns once and a write is reported as interrupted', async () => {
  for (const tool of ['read_file', 'write_note']) {
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
    const runs: string[] = [];
    let release!: () => void;
    const stuck = new Promise<void>(r => (release = r));
    // First session: the tool starts and never finishes before the window closes.
    const first = scripted([callTool(tool, 'Notes/c.md')]);
    const s1 = await openDurable(
      {
        vaultKey: 'test',
        send: first.send,
        // Like the plugin's tools (withToolTimeout), it stops when its signal aborts.
        tools: tools(async (name, _args, signal) => {
          runs.push(`first ${name}`);
          await Promise.race([
            stuck,
            new Promise(r => signal?.addEventListener('abort', r, { once: true })),
          ]);
          return 'Error: Cancelled: closed.';
        }),
      },
      { storage },
    );
    const root = await s1.harness.root(CTX, { agent: { model: layerRef('orchestrator') } });
    const submission = await root.submit({ type: 'input', content: 'Go', requestId: 'go-1' }, CTX);
    while (runs.length === 0) await new Promise(r => setTimeout(r, 5));
    await s1.close();
    release();

    // Second session on the same storage: it resumes the same submission.
    const second = scripted([say('Finished.')]);
    const s2 = await openDurable(
      {
        vaultKey: 'test',
        send: second.send,
        tools: tools(async name => {
          runs.push(`second ${name}`);
          return 'fresh';
        }),
      },
      { storage },
    );
    try {
      const again = await s2.harness.submission(submission.id, CTX);
      const settled = await again!.wait(CTX);
      assert.equal(settled.status, 'done', `${tool}: ${JSON.stringify(settled)}`);
      const result = lastToolMessage(second.requests[0]) ?? '';
      if (tool === 'read_file') {
        assert.deepEqual(runs, ['first read_file', 'second read_file']);
        assert.equal(result, 'fresh');
      } else {
        assert.deepEqual(runs, ['first write_note']);
        assert.match(result, /interrupt/i);
      }
    } finally {
      await s2.close();
    }
  }
});
