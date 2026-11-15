import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadFileTool } from '../../../src/tools/ReadFile';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';

test('harness runs a real tool against the mock vault', async () => {
  const h = toolHarness({ 'Notes/a.md': 'line one\nline two' });
  const out = await h.run(ReadFileTool, { path: 'Notes/a.md' });
  assert.match(out, /line two/);
  const missing = await h.run(ReadFileTool, { path: 'Notes/zzz.md' });
  assert.ok(isToolError(missing), missing);
});
