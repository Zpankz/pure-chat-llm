import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DurableOrchestrator, withoutMemoryBlock } from '../../../src/harness/bridge';
import type { BridgeHost } from '../../../src/harness/bridge';
import { openDurable } from '../../../src/harness/durable';
import type { DurableSession } from '../../../src/harness/durable';
import type { LayerName, LayerSend, LayerSendRequest } from '../../../src/harness/layerProvider';
import { MemoryStorage } from '../../../src/harness/pi';
import type { ToolSource } from '../../../src/harness/toolsExtension';
import type { NoticeMode } from '../../../src/agents/types';
import type { ChatResponse, ToolDefinition } from '../../../src/types';

type Answer = (r: LayerSendRequest, signal?: AbortSignal) => ChatResponse | Promise<ChatResponse>;

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

const def = (name: string, property: string): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: { [property]: { type: 'string', description: property } },
      required: [],
    },
  },
});

const userTexts = (r: LayerSendRequest) =>
  r.messages.filter(m => m.role === 'user').map(m => String(m.content as string));

async function until(check: () => boolean, what: string, ms = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

/** A bridge over a durable session on memory storage, with `tell_user` wired to it. */
async function setup(send: LayerSend, overrides: Partial<BridgeHost> = {}) {
  const log: { kind: string; text: string; fromUser?: boolean }[] = [];
  const heard: { text: string; urgency: NoticeMode; answersUser: boolean }[] = [];
  let bridge!: DurableOrchestrator;
  const tools: ToolSource = {
    definitions: () => [def('read_file', 'path'), def('tell_user', 'message')],
    readOnly: () => true,
    run: async (name, args) => {
      if (name === 'tell_user') {
        const a = args as { message: string; urgency?: NoticeMode };
        return bridge.say(a.message, a.urgency ?? 'pause');
      }
      return 'contents';
    },
  };
  const session: DurableSession = await openDurable(
    { vaultKey: 'test', send, tools, workerInstructions: () => 'You are a worker.' },
    { storage: new MemoryStorage() },
  );
  bridge = new DurableOrchestrator({
    session: () => Promise.resolve(session),
    active: () => true,
    label: () => 'test orchestrator',
    problem: () => null,
    voiceContext: () => ({ mode: 'full', recentLines: 6 }),
    voiceSeesActivity: () => false,
    log: (kind, text, fromUser) => log.push({ kind, text, fromUser }),
    spokenError: m => m,
    ...overrides,
  });
  bridge.onSay((text, urgency, answersUser) => heard.push({ text, urgency, answersUser }));
  return { bridge, session, log, heard };
}

test('a relay reaches the durable orchestrator, and tell_user is heard as the answer', async () => {
  const { send, requests } = layers({
    orchestrator: [call('tell_user', { message: 'It says 42.' }), say('Told them.')],
  });
  const { bridge, session, log, heard } = await setup(send);
  try {
    const lines = ['User: what does a.md say?'];
    bridge.setTranscriptSource(() => lines);
    assert.match(bridge.relay('What does a.md say?', true), /^Passed to the orchestrator/);
    assert.equal(bridge.state, 'thinking');
    await until(() => bridge.state === 'idle', 'the turn to end');
    // The relay carries the call since the last relay, as on Classic.
    assert.deepEqual(userTexts(requests.orchestrator[0]), [
      '[Voice] The user is waiting for this: What does a.md say?\nConversation since your last relay:\nUser: what does a.md say?',
    ]);
    // Heard once: the final text is not spoken again, since tell_user already answered.
    assert.deepEqual(heard, [{ text: 'It says 42.', urgency: 'pause', answersUser: true }]);
    await until(() => log.some(l => l.kind === 'reply'), 'the log');
    assert.ok(log.some(l => l.kind === 'input' && l.fromUser));
    assert.ok(log.some(l => l.kind === 'tool' && l.text.startsWith('tell_user ')));
    // tell_user stays out of the activity feed, as on Classic.
    assert.deepEqual(bridge.recentActivity(), []);
  } finally {
    bridge.dispose();
    await session.close();
  }
});

test('an answer without tell_user is still spoken', async () => {
  const { send } = layers({ orchestrator: [say('It is Tuesday.')] });
  const { bridge, session, heard } = await setup(send);
  try {
    bridge.relay('What day is it?', true);
    await until(() => heard.length === 1, 'the answer');
    assert.equal(heard[0].text, 'It is Tuesday.');
    assert.equal(heard[0].answersUser, true);
  } finally {
    bridge.dispose();
    await session.close();
  }
});

test("a worker's report runs a turn whose tell_user reaches the call", async () => {
  const { send } = layers({
    orchestrator: [
      call('delegate_task', { title: 'Count notes', instructions: 'Count the notes.' }),
      call('tell_user', { message: 'On it.' }, 'c_ack'),
      say('Started.'),
      call('tell_user', { message: 'You have 12 notes.' }, 'c_done'),
      say('Told them.'),
    ],
    worker: [say('12 notes.')],
  });
  const { bridge, session, heard } = await setup(send);
  try {
    bridge.relay('How many notes do I have?', false);
    await until(() => heard.length === 2, 'the result');
    assert.deepEqual(
      heard.map(h => [h.text, h.answersUser]),
      [
        ['On it.', true],
        ['You have 12 notes.', false],
      ],
    );
    assert.match(bridge.recentActivity().join('\n'), /started a task "Count notes"/);
  } finally {
    bridge.dispose();
    await session.close();
  }
});

test('a failed turn is said in words, and the orchestrator cannot run without its layer', async () => {
  const { send } = layers({
    // The engine retries a failed request a few times before it gives up.
    orchestrator: Array.from({ length: 10 }, () => () => {
      throw new Error('429 rate limit');
    }),
  });
  const { bridge, session, heard } = await setup(send, { spokenError: () => 'try again soon.' });
  try {
    bridge.relay('Hello?', true);
    await until(() => heard.length === 1, 'the failure');
    assert.equal(heard[0].text, "I couldn't work on that: try again soon.");
    assert.match(bridge.lastError, /429/);
  } finally {
    bridge.dispose();
    await session.close();
  }
  const blocked = new DurableOrchestrator({
    session: () => Promise.reject(new Error('unused')),
    active: () => true,
    label: () => '',
    problem: () => 'Sign in with ChatGPT first.',
    voiceContext: () => ({ mode: 'full', recentLines: 6 }),
    voiceSeesActivity: () => false,
    spokenError: m => m,
  });
  assert.equal(
    blocked.relay('Hi'),
    "The orchestrator can't run: Sign in with ChatGPT first. Tell the user.",
  );
});

test('reset starts the orchestrator afresh', async () => {
  const { send, requests } = layers({
    orchestrator: [say('First.'), say('Second.')],
  });
  const { bridge, session, heard } = await setup(send);
  try {
    bridge.relay('One', true);
    await until(() => heard.length === 1, 'the first answer');
    bridge.reset();
    await new Promise(r => setTimeout(r, 30));
    bridge.relay('Two', true);
    await until(() => heard.length === 2, 'the second answer');
    const second = userTexts(requests.orchestrator[1]);
    assert.ok(!second.some(t => t.includes('One')), 'the first relay is gone');
    assert.ok(second.some(t => t.includes('Two')));
  } finally {
    bridge.dispose();
    await session.close();
  }
});

test('a relay carries recalled memory to the model, but the log shows only the request', async () => {
  const { send, requests } = layers({ orchestrator: [say('Done.')] });
  const recorded: { request: string; typed: boolean }[] = [];
  const { bridge, session, log } = await setup(send, {
    memoryContext: async request => `[Memory] Recalled for this message:\n- about ${request}`,
    recordRequest: (request, typed) => recorded.push({ request, typed }),
  });
  try {
    bridge.relay('Look up pele', false);
    await until(() => bridge.state === 'idle', 'the turn to end');
    const sent = userTexts(requests.orchestrator[0])[0];
    assert.match(
      sent,
      /Look up pele\n\n\[Memory\] Recalled for this message:\n- about Look up pele$/,
    );
    assert.deepEqual(recorded, [{ request: 'Look up pele', typed: false }]);
    await until(() => log.some(l => l.kind === 'input'), 'the log');
    assert.ok(log.filter(l => l.kind === 'input').every(l => !l.text.includes('[Memory]')));
    assert.equal(withoutMemoryBlock(sent).includes('[Memory]'), false);
  } finally {
    bridge.dispose();
    await session.close();
  }
});
