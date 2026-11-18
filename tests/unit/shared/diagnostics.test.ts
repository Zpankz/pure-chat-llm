import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_DIAGNOSTICS,
  DiagnosticsLog,
  diagnostics,
  requestDetail,
} from '../../../src/diagnostics/DiagnosticsLog';
import type {
  DiagnosticsSettings,
  DiagnosticsStore,
} from '../../../src/diagnostics/DiagnosticsLog';
import { collectSecrets, redactText, redactValue, REDACTED } from '../../../src/diagnostics/redact';
import { ToolRegistry } from '../../../src/tools';

/** An in-memory vault adapter. */
function memoryStore() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const store: DiagnosticsStore = {
    exists: async path => folders.has(path) || files.has(path),
    mkdir: async path => {
      folders.add(path);
    },
    append: async (path, data) => {
      files.set(path, (files.get(path) ?? '') + data);
    },
    list: async path => ({
      files: [...files.keys()].filter(
        f => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/'),
      ),
      folders: [...folders].filter(
        f => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/'),
      ),
    }),
    rmdir: async path => {
      for (const f of [...files.keys()]) if (f.startsWith(`${path}/`)) files.delete(f);
      for (const f of [...folders]) if (f === path || f.startsWith(`${path}/`)) folders.delete(f);
    },
  };
  return { store, files, folders };
}

const lines = (text: string | undefined) =>
  (text ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);

function logWith(overrides: Partial<DiagnosticsSettings> = {}, secrets: unknown = {}) {
  const settings: DiagnosticsSettings = {
    ...DEFAULT_DIAGNOSTICS,
    enabled: true,
    appConsole: false,
    ...overrides,
  };
  const memory = memoryStore();
  const log = new DiagnosticsLog();
  log.configure({ settings: () => settings, store: memory.store, secretsFrom: () => secrets });
  return { log, settings, ...memory };
}

test('secrets are removed by field name, by known value and by shape', () => {
  const plugin = {
    endpoints: [{ name: 'OpenAI', apiKey: 'plain-key-1234567890' }],
    mcpServers: [{ bearerToken: 'mcp-token-abcdefgh', headers: 'X-Custom: header-secret-value' }],
  };
  const known = collectSecrets(plugin);
  assert.ok(known.includes('plain-key-1234567890'));
  assert.ok(known.includes('mcp-token-abcdefgh'));
  assert.ok(known.includes('header-secret-value'));

  const text = [
    'key plain-key-1234567890 in a sentence',
    'Authorization: Bearer abc.def.ghijklmnop',
    'sk-proj-ABCDEFGHIJKLMNOPQRSTUV',
    'https://x.test/v1?key=AIzaSyA-1234567890abcdefghijklmnopqrstu&alt=json',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWX12',
    'xai-ABCDEFGHIJKLMNOPQRSTUVWX12',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('\n');
  const clean = redactText(text, known);
  for (const leak of [
    'plain-key-1234567890',
    'abc.def.ghijklmnop',
    'sk-proj-',
    'AIzaSy',
    'ghp_',
    'xai-ABC',
    'eyJhbGci',
  ]) {
    assert.ok(!clean.includes(leak), `${leak} leaked: ${clean}`);
  }
  assert.ok(clean.includes('alt=json'), 'the rest of a URL stays');

  const value = redactValue(
    {
      apiKey: 'anything',
      access_token: 'zzzzzzzz',
      usage: { prompt_tokens: 12, max_tokens: 400 },
      nested: [{ password: 'pw' }, 'call with sk-ABCDEFGHIJKLMNOPQRSTUV'],
      long: 'x'.repeat(1000),
      error: new Error('401 for Bearer abcdefghijkl'),
    },
    { maxChars: 600 },
  ) as Record<string, unknown>;
  assert.equal(value.apiKey, REDACTED);
  assert.equal(value.access_token, REDACTED);
  assert.deepEqual(value.usage, { prompt_tokens: 12, max_tokens: 400 }, 'token counts stay');
  assert.deepEqual(value.nested, [{ password: REDACTED }, `call with ${REDACTED}`]);
  assert.match(String(value.long), /…\[\+400 chars\]$/);
  assert.ok(!JSON.stringify(value.error).includes('abcdefghijkl'));
});

test('nothing is written while the log is off', async () => {
  const { log, files } = logWith({ enabled: false });
  await log.start();
  log.record('tool', 'end', { name: 'read_file' });
  await log.flush();
  assert.equal(log.enabled, false);
  assert.equal(log.currentPath(), null);
  assert.equal(files.size, 0);
});

test('events are written as JSON lines in a day folder, tagged with the call', async () => {
  const { log, files } = logWith(
    { folder: '/Logs/' },
    { endpoints: [{ apiKey: 'secret-value-123' }] },
  );
  await log.start();
  const path = log.currentPath();
  assert.match(String(path), /^Logs\/\d{4}-\d{2}-\d{2}\/\d{6}-[a-z0-9]+\.jsonl$/);
  log.setCall({ id: '2026-11-18 0930', note: 'Calls/2026-11-18 0930/2026-11-18 0930.md' });
  log.record('tool', 'end', {
    name: 'read_file',
    args: { path: 'a.md' },
    result: 'has secret-value-123',
    ms: 4,
  });
  log.setCall(null);
  await log.stop();
  const events = lines(files.get(String(path)));
  assert.deepEqual(
    events.map(e => `${String(e.source)}/${String(e.kind)}`),
    ['session/start', 'call/start', 'tool/end', 'call/end', 'session/stop'],
  );
  const tool = events[2];
  assert.equal(tool.call, '2026-11-18 0930');
  assert.equal(tool.result, `has ${REDACTED}`);
  assert.equal(tool.ms, 4);
  assert.equal(typeof tool.ts, 'string');
  assert.equal(events[4].call, undefined, 'events after the call are not tagged');
});

test('a full file continues in a new part', async () => {
  const { log, files } = logWith({ maxFileMB: 0.1 });
  await log.start();
  const first = String(log.currentPath());
  for (let i = 0; i < 40; i++) log.record('console', 'log', { text: 'y'.repeat(5000) });
  await log.flush();
  const second = String(log.currentPath());
  assert.notEqual(first, second);
  assert.match(second, /-2\.jsonl$/);
  assert.ok((files.get(first) ?? '').length <= 0.1 * 1024 * 1024);
  const all = [...files.values()].flatMap(f => lines(f));
  assert.equal(all.filter(e => e.source === 'console').length, 40, 'no event is lost');
  await log.stop();
});

test('only day folders past the retention period are removed', async () => {
  const { log, folders, store } = logWith({ keepDays: 7 });
  await store.mkdir('Voice Agent');
  await store.mkdir('Voice Agent/Diagnostics');
  await store.mkdir('Voice Agent/Diagnostics/2020-01-01');
  await store.mkdir('Voice Agent/Diagnostics/Notes about logs');
  const today = new Date();
  const recent = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await store.mkdir(`Voice Agent/Diagnostics/${recent}`);
  await log.prune();
  assert.ok(!folders.has('Voice Agent/Diagnostics/2020-01-01'));
  assert.ok(folders.has('Voice Agent/Diagnostics/Notes about logs'));
  assert.ok(folders.has(`Voice Agent/Diagnostics/${recent}`));
});

test('a request writes its instructions once, then only what is new', async () => {
  const { log: shared, files } = (() => {
    const memory = memoryStore();
    const s: DiagnosticsSettings = { ...DEFAULT_DIAGNOSTICS, enabled: true, appConsole: false };
    diagnostics.configure({ settings: () => s, store: memory.store, secretsFrom: () => ({}) });
    return { log: diagnostics, files: memory.files };
  })();
  await shared.start();
  const system = { role: 'system', content: 'You are the orchestrator.' };
  const first = requestDetail({
    model: 'm',
    messages: [system, { role: 'user', content: 'hi' }],
    tools: [{}, {}],
  });
  assert.deepEqual(first.system, system);
  assert.equal(first.toolCount, 2);
  const second = requestDetail({
    model: 'm',
    messages: [
      system,
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null },
      { role: 'tool', content: 'result' },
    ],
  });
  assert.equal(second.system, undefined, 'the same instructions are not written again');
  assert.equal(second.systemId, first.systemId);
  assert.deepEqual(second.newMessages, [{ role: 'tool', content: 'result' }]);
  await shared.stop();
  assert.ok(files.size === 1);
});

test('every tool call is recorded with its role, arguments, result and duration', async () => {
  const memory = memoryStore();
  const s: DiagnosticsSettings = { ...DEFAULT_DIAGNOSTICS, enabled: true, appConsole: false };
  diagnostics.configure({ settings: () => s, store: memory.store, secretsFrom: () => ({}) });
  await diagnostics.start();
  const registry = new ToolRegistry({ role: 'voice', plugin: { settings: {} } } as never);
  registry.registerDynamic({
    name: 'read_file',
    isAvailable: () => true,
    execute: async () => 'contents',
  } as never);
  assert.equal(await registry.executeTool('read_file', { path: 'a.md' }), 'contents');
  const path = String(diagnostics.currentPath());
  await diagnostics.stop();
  const events = lines(memory.files.get(path)).filter(e => e.source === 'tool');
  assert.deepEqual(
    events.map(e => e.kind),
    ['start', 'end'],
  );
  assert.equal(events[1].name, 'read_file');
  assert.equal(events[1].role, 'voice');
  assert.deepEqual(events[0].args, { path: 'a.md' });
  assert.equal(events[1].result, 'contents');
  assert.equal(events[1].ok, true);
  assert.equal(typeof events[1].ms, 'number');
});

test('the app console is recorded while on, and put back when off', async () => {
  const { log, files } = logWith({ appConsole: true });
  const before = console.warn;
  const stub = () => undefined;
  console.warn = stub;
  try {
    await log.start();
    console.warn('disk nearly full', { token: 'abcdefghijk' });
    const path = String(log.currentPath());
    await log.stop();
    assert.equal(console.warn, stub, 'the original is back');
    const warn = lines(files.get(path)).find(e => e.source === 'app-console');
    assert.ok(warn);
    assert.deepEqual(warn.args, ['disk nearly full', { token: REDACTED }]);
  } finally {
    console.warn = before;
  }
});
