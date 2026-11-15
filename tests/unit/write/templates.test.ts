import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TemplatesTool } from '../../../src/tools/Templates';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';
import { nextModal, takeModals, writeSettings } from './helpers';

const TEMPLATE =
  '---\ntype: meeting\nstatus: open\n---\n# {{title}}\nDate: {{date}} {{date:YYYY}}\n## Notes\n';

/** A vault with a core Templates folder, run as a worker with the given policy. */
function vault(writes: Parameters<typeof writeSettings>[0] = { create: 'allow', edit: 'allow' }) {
  const h = toolHarness(
    {
      '_tpl/Meeting.md': TEMPLATE,
      '_tpl/Daily/Day.md': '# Day\n<% tp.date.now() %>\n',
      'People/Sam.md': '---\nstatus: active\n---\n# Sam\n',
    },
    { role: 'subagent', settings: writeSettings(writes) },
  );
  (h.app as unknown as Record<string, unknown>).internalPlugins = {
    getPluginById: (id: string) =>
      id === 'templates'
        ? { enabled: true, instance: { options: { folder: '_tpl', dateFormat: 'YYYY-MM-DD' } } }
        : null,
  };
  return h;
}

test('list reads the core Templates folder; JSON has stable keys', async () => {
  const h = vault();
  const text = await h.run(TemplatesTool, { action: 'list' });
  assert.equal(text.split('\n')[0], '2 templates in "_tpl":');
  assert.deepEqual(JSON.parse(await h.run(TemplatesTool, { action: 'list', format: 'json' })), {
    ok: true,
    action: 'list',
    folders: ['_tpl'],
    count: 2,
    templates: ['_tpl/Daily/Day.md', '_tpl/Meeting.md'],
  });
});

test('apply makes a new note from a template, found by name', async () => {
  const h = vault();
  const out = await h.run(TemplatesTool, {
    action: 'apply',
    template_path: 'meeting',
    target_path: 'Meetings/Kickoff',
    format: 'json',
  });
  const json = JSON.parse(out);
  assert.equal(json.applied, true);
  assert.equal(json.action, 'create');
  assert.equal(json.template, '_tpl/Meeting.md');
  assert.equal(
    await h.app.vault.adapter.read('Meetings/Kickoff.md'),
    '---\ntype: meeting\nstatus: open\n---\n# Kickoff\nDate: 2026-11-15 2026-11-15\n## Notes\n',
  );
  assert.equal(takeModals().length, 0);
});

test('apply into an existing note fills missing properties and keeps the note', async () => {
  const h = vault();
  await h.run(TemplatesTool, {
    action: 'apply',
    template_path: '_tpl/Meeting.md',
    target_path: 'People/Sam.md',
    mode: 'append',
  });
  const text = await h.app.vault.adapter.read('People/Sam.md');
  // status was there, so it stays; type was missing, so it is added. The body is appended.
  assert.match(text, /^---\nstatus: active\ntype: meeting\n---\n# Sam\n\n# Sam\nDate: /);
});

test('apply: errors for an existing target, a missing note to add to, a missing template', async () => {
  const h = vault();
  for (const args of [
    { action: 'apply', template_path: 'Meeting', target_path: 'People/Sam.md' },
    { action: 'apply', template_path: 'Meeting', target_path: 'Nope.md', mode: 'append' },
    { action: 'apply', template_path: 'Missing', target_path: 'x.md' },
    { action: 'apply', target_path: 'x.md' },
    { action: 'explode' },
  ]) {
    const out = await h.run(TemplatesTool, args);
    assert.ok(isToolError(out), `${JSON.stringify(args)} -> ${out}`);
  }
});

test('apply follows the write policy: deny refuses, a chat reviews', async () => {
  const denied = vault({ create: 'deny' });
  const out = await denied.run(TemplatesTool, {
    action: 'apply',
    template_path: 'Meeting',
    target_path: 'New.md',
  });
  assert.ok(isToolError(out), out);
  assert.match(out, /WriteDenied/);
  assert.equal(denied.app.vault.getAbstractFileByPath('New.md'), null);

  const chat = toolHarness({ 'Templates/T.md': 'hello {{title}}' });
  const pending = chat.run(TemplatesTool, {
    action: 'apply',
    template_path: 'T',
    target_path: 'Greeting',
  });
  (await nextModal()).approve();
  assert.match(await pending, /^Created "Greeting.md" from template "T"/);
  assert.equal(await chat.app.vault.adapter.read('Greeting.md'), 'hello Greeting');
});

test('Templater commands are left as written, and said so', async () => {
  const h = vault();
  const out = await h.run(TemplatesTool, {
    action: 'apply',
    template_path: 'Day',
    target_path: 'Today.md',
  });
  assert.match(out, /Templater commands/);
  assert.match(await h.app.vault.adapter.read('Today.md'), /<% tp\.date\.now\(\) %>/);
});
