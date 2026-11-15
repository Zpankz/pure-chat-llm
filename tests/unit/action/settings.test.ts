import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  PluginSettingsTool,
  SettingsConfirmationModal,
  redactSecrets,
} from '../../../src/tools/PluginSettings';
import { isToolError } from '../../../src/tools/toolContract';
import { actionChat, flush, openedModals, resetModals } from './fixtures';

const settings = () => ({
  defaultmaxTokens: 4096,
  agentMode: true,
  endpoint: 0,
  endpoints: [
    { name: 'OpenAI', apiKey: 'sk-real-secret', endpoint: 'https://api.openai.com/v1' },
    { name: 'xAI', apiKey: '', endpoint: 'https://api.x.ai/v1' },
  ],
  mcpServers: [{ name: 'm', bearerToken: 'tok-123', headers: 'X-Key: abc' }],
  voice: { provider: 'openai-live', maxToolOutputChars: 6000 },
});

beforeEach(resetModals);

test('read hides API keys and tokens but keeps ordinary values', async () => {
  const c = actionChat({ settings: settings() });
  const tool = c.tool(PluginSettingsTool);
  const all = await tool.execute({ action: 'read' });
  assert.match(all, /^Read all \d+ settings \(secrets hidden\)\./);
  assert.doesNotMatch(all, /sk-real-secret|tok-123|X-Key/);
  assert.match(all, /"defaultmaxTokens": 4096/);

  const json = JSON.parse(
    await tool.execute({ action: 'read', key: 'endpoints', format: 'json' }),
  ) as {
    key: string;
    value: { apiKey: string }[];
  };
  assert.equal(json.key, 'endpoints');
  assert.equal(json.value[0].apiKey, '[hidden]');
  assert.equal(json.value[1].apiKey, '');

  assert.equal(
    await tool.execute({ action: 'read', key: 'voice.provider' }),
    'Setting "voice.provider" is "openai-live".',
  );
  assert.ok(isToolError(await tool.execute({ action: 'read', key: 'nope' })));
  assert.ok(isToolError(await tool.execute({ action: 'read', key: 'voice.__proto__' })));
  assert.deepEqual(redactSecrets({ a: { refreshToken: 'r', n: 1 } }), {
    a: { refreshToken: '[hidden]', n: 1 },
  });
});

test('voice: an update without confirm changes nothing and opens no modal', async () => {
  const c = actionChat({ role: 'voice', settings: settings() });
  const out = await c
    .tool(PluginSettingsTool)
    .execute({ action: 'update', key: 'defaultmaxTokens', value: '8000' });
  assert.ok(isToolError(out), out);
  assert.match(out, /ConfirmationNeeded/);
  assert.match(out, /4096 to 8000/);
  assert.equal(openedModals.length, 0);
  assert.equal(c.plugin.settings.defaultmaxTokens, 4096);
  assert.equal(c.saves, 0);
});

test('voice: confirm true applies the change without a modal', async () => {
  const c = actionChat({ role: 'voice', settings: settings() });
  const out = JSON.parse(
    await c.tool(PluginSettingsTool).execute({
      action: 'update',
      key: 'voice.provider',
      value: 'gemini-live',
      confirm: true,
      format: 'json',
    }),
  ) as Record<string, unknown>;
  assert.deepEqual(out, {
    key: 'voice.provider',
    changed: true,
    old_value: 'openai-live',
    new_value: 'gemini-live',
  });
  assert.equal(openedModals.length, 0);
  assert.equal((c.plugin.settings.voice as { provider: string }).provider, 'gemini-live');
  assert.equal(c.saves, 1);
});

test('note chat: the modal decides, and confirm alone is not enough', async () => {
  const c = actionChat({ settings: settings() });
  const tool = c.tool(PluginSettingsTool);

  const pending = tool.execute({
    action: 'update',
    key: 'agentMode',
    value: 'false',
    confirm: true,
  });
  await flush();
  assert.equal(openedModals.length, 1);
  assert.equal(c.plugin.settings.agentMode, true, 'nothing changes before the user answers');
  (openedModals[0] as SettingsConfirmationModal).finish(false);
  const declined = await pending;
  assert.ok(isToolError(declined), declined);
  assert.equal(c.plugin.settings.agentMode, true);

  const approved = tool.execute({ action: 'update', key: 'agentMode', value: 'false' });
  await flush();
  (openedModals[1] as SettingsConfirmationModal).finish(true);
  assert.equal(await approved, 'Changed "agentMode" from true to false.');
  assert.equal(c.plugin.settings.agentMode, false);
  assert.equal(c.saves, 1);
});

test('update refuses secrets, groups, wrong types, bad endpoints and background layers', async () => {
  const c = actionChat({ role: 'voice', settings: settings() });
  const tool = c.tool(PluginSettingsTool);
  const bad = [
    { action: 'update', key: 'endpoints', value: '[]', confirm: true },
    { action: 'update', key: 'mcpServers', value: '[]', confirm: true },
    { action: 'update', key: 'voice', value: '{}', confirm: true },
    { action: 'update', key: 'defaultmaxTokens', value: 'lots', confirm: true },
    { action: 'update', key: 'agentMode', value: 'yes', confirm: true },
    { action: 'update', key: 'endpoint', value: '7', confirm: true },
    { action: 'update', key: 'missing', value: '1', confirm: true },
    { action: 'update', key: 'defaultmaxTokens', confirm: true },
    { action: 'update', value: '1', confirm: true },
    { action: 'remove' },
  ];
  for (const args of bad) {
    const out = await tool.execute(args as never);
    assert.ok(isToolError(out), `${JSON.stringify(args)} -> ${out}`);
  }
  assert.equal(c.saves, 0);

  const same = await tool.execute({ action: 'update', key: 'defaultmaxTokens', value: '4096' });
  assert.match(same, /already 4096/);

  const worker = actionChat({ role: 'subagent', settings: settings() });
  const out = await worker
    .tool(PluginSettingsTool)
    .execute({ action: 'update', key: 'defaultmaxTokens', value: '1', confirm: true });
  assert.ok(isToolError(out), out);
  assert.equal(openedModals.length, 0);
  assert.equal(worker.saves, 0);
});
