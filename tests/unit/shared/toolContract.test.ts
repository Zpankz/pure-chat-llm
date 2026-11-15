import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedIn,
  isToolError,
  jsonResult,
  layerForRole,
  offersJson,
  toolError,
  toolErrorMessage,
  wantsJson,
  FORMAT_PARAMETER,
} from '../../../src/tools/toolContract';
import { createApp, buildCache } from '../obsidian-mock';

test('toolError formats type, reason and recovery lines', () => {
  const out = toolError('NotFound', 'No note at a.md.', ['Use glob_vault_files.']);
  assert.equal(out, 'Error: NotFound: No note at a.md.\nTry:\n- Use glob_vault_files.');
  assert.ok(isToolError(out));
  assert.equal(toolErrorMessage(out), 'NotFound: No note at a.md.');
});

test('isToolError matches old and new headers only', () => {
  assert.ok(isToolError('ERROR: Validation'));
  assert.ok(isToolError('  Error: x'));
  assert.ok(!isToolError('Found 3 errors in notes'));
  assert.ok(!isToolError('{"ok":true}'));
});

test('layers keep modal and screen tools away from workers', () => {
  for (const t of ['manage_workspace', 'show_obsidian_notice', 'generate_image', 'suno_music_gen'])
    assert.ok(!allowedIn(t, 'worker'), t);
  assert.ok(allowedIn('read_file', 'worker'));
  assert.ok(allowedIn('some_mcp_tool', 'worker'));
  assert.ok(!allowedIn('manage_plugin_settings', 'voice'));
  assert.equal(layerForRole('subagent'), 'worker');
  assert.equal(layerForRole('orchestrator-agent'), 'orchestrator');
  assert.equal(layerForRole(undefined), 'chat');
});

test('JSON convention helpers', () => {
  assert.ok(wantsJson({ format: 'json' }));
  assert.ok(!wantsJson({}));
  assert.equal(jsonResult({ a: 1 }), '{"a":1}');
  assert.ok(offersJson({ properties: { format: FORMAT_PARAMETER } }));
  assert.ok(!offersJson({ properties: {} }));
});

test('mock vault and metadata cache behave like Obsidian for links and headings', async () => {
  const app = createApp();
  app.vault.put(
    'Projects/Alpha.md',
    '---\ntags: [x]\nup: "[[Index]]"\n---\n# Alpha\nSee [[Beta]] #topic\n## Notes\nbody',
  );
  app.vault.put('Projects/sub/Beta.md', '# Beta\nback to [[Alpha|A]]');
  app.vault.put('Index.md', 'root');
  const alpha = app.vault.getFileByPath('Projects/Alpha.md')!;
  const cache = app.metadataCache.getFileCache(alpha) as { headings: { heading: string }[] };
  assert.deepEqual(
    cache.headings.map(h => h.heading),
    ['Alpha', 'Notes'],
  );
  assert.equal(
    app.metadataCache.getFirstLinkpathDest('Beta', alpha.path)?.path,
    'Projects/sub/Beta.md',
  );
  assert.deepEqual(app.metadataCache.resolvedLinks['Projects/Alpha.md'], {
    'Index.md': 1,
    'Projects/sub/Beta.md': 1,
  });
  await app.fileManager.trashFile(alpha);
  assert.equal(app.vault.getFileByPath('Projects/Alpha.md'), null);
  assert.deepEqual(app.vault.trashed, ['Projects/Alpha.md']);
  assert.ok(buildCache('```\n# not a heading\n```').headings === undefined);
});
