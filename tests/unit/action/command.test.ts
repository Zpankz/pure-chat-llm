import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandAllowList, isNeverRun, RunCommandTool } from '../../../src/tools/RunCommand';
import { isToolError } from '../../../src/tools/toolContract';
import { actionChat } from './fixtures';

/** Gives the mock app a command manager like Obsidian's `app.commands`. */
function withCommands(c: ReturnType<typeof actionChat>, runnable = true) {
  const ran: string[] = [];
  (c.app as unknown as { commands: unknown }).commands = {
    commands: {
      'dataview:dataview-force-refresh-views': {
        id: 'dataview:dataview-force-refresh-views',
        name: 'Dataview: Force refresh all views',
      },
      'templater-obsidian:insert-templater': {
        id: 'templater-obsidian:insert-templater',
        name: 'Templater: Open insert template modal',
      },
      'app:delete-file': { id: 'app:delete-file', name: 'Delete current file' },
      'my:sneaky': { id: 'my:sneaky', name: 'Quit everything' },
    },
    executeCommandById: (id: string) => {
      ran.push(id);
      return runnable;
    },
  };
  return ran;
}

const allow = (list: unknown) => ({ commandAllowList: list });

test('off by default: an empty allow-list makes the tool unavailable', async () => {
  const c = actionChat({ settings: {} });
  withCommands(c);
  const tool = c.tool(RunCommandTool);
  assert.equal(tool.isAvailable(), false);
  const out = await tool.execute({ action: 'list' });
  assert.ok(isToolError(out), out);
  // Only never-run commands on the list still counts as empty.
  const blocked = actionChat({ settings: allow(['app:delete-file']) });
  withCommands(blocked);
  assert.equal(blocked.tool(RunCommandTool).isAvailable(), false);
});

test('lists the allowed commands with their names', async () => {
  const c = actionChat({
    settings: allow('dataview:dataview-force-refresh-views\nmissing:cmd, app:delete-file'),
  });
  withCommands(c);
  const tool = c.tool(RunCommandTool);
  assert.equal(tool.isAvailable(), true);
  const out = JSON.parse(await tool.execute({ action: 'list', format: 'json' })) as unknown;
  assert.deepEqual(out, {
    action: 'list',
    commands: [
      {
        id: 'dataview:dataview-force-refresh-views',
        name: 'Dataview: Force refresh all views',
        installed: true,
      },
      { id: 'missing:cmd', name: null, installed: false },
    ],
  });
  assert.match(await tool.execute({ action: 'list' }), /^2 commands allowed\./);
});

test('runs only allow-listed commands, never deleting or quitting ones', async () => {
  const c = actionChat({
    role: 'voice',
    settings: allow([
      'dataview:dataview-force-refresh-views',
      'app:delete-file',
      'my:sneaky',
      'missing:cmd',
    ]),
  });
  const ran = withCommands(c);
  const tool = c.tool(RunCommandTool);

  assert.equal(
    await tool.execute({ action: 'run', id: 'dataview:dataview-force-refresh-views' }),
    'Ran "Dataview: Force refresh all views".',
  );
  const json = JSON.parse(
    await tool.execute({
      action: 'run',
      id: 'dataview:dataview-force-refresh-views',
      format: 'json',
    }),
  ) as unknown;
  assert.deepEqual(json, {
    action: 'run',
    id: 'dataview:dataview-force-refresh-views',
    name: 'Dataview: Force refresh all views',
    ran: true,
  });

  for (const id of [
    'templater-obsidian:insert-templater',
    'app:delete-file',
    'my:sneaky',
    'missing:cmd',
    '',
  ]) {
    const out = await tool.execute({ action: 'run', id });
    assert.ok(isToolError(out), `${id} -> ${out}`);
  }
  assert.ok(isToolError(await tool.execute({ action: 'explode' })));
  assert.deepEqual(ran, [
    'dataview:dataview-force-refresh-views',
    'dataview:dataview-force-refresh-views',
  ]);
});

test('a command that cannot run now, and background layers, are errors', async () => {
  const c = actionChat({ settings: allow(['dataview:dataview-force-refresh-views']) });
  withCommands(c, false);
  const out = await c
    .tool(RunCommandTool)
    .execute({ action: 'run', id: 'dataview:dataview-force-refresh-views' });
  assert.ok(isToolError(out), out);
  assert.match(out, /NotRun/);

  const worker = actionChat({
    role: 'subagent',
    settings: allow(['dataview:dataview-force-refresh-views']),
  });
  const ran = withCommands(worker);
  const refused = await worker
    .tool(RunCommandTool)
    .execute({ action: 'run', id: 'dataview:dataview-force-refresh-views' });
  assert.ok(isToolError(refused), refused);
  assert.deepEqual(ran, []);
});

test('allow-list parsing and the never-run rule', () => {
  assert.deepEqual(commandAllowList({ commandAllowList: [' a:b ', 'a:b', '', 3] }), ['a:b']);
  assert.deepEqual(commandAllowList({}), []);
  assert.deepEqual(commandAllowList(undefined), []);
  assert.ok(isNeverRun('workspace:close'));
  assert.ok(isNeverRun('app:reload'));
  assert.ok(isNeverRun('x:y', 'Delete note'));
  assert.ok(
    !isNeverRun('dataview:dataview-force-refresh-views', 'Dataview: Force refresh all views'),
  );
});
