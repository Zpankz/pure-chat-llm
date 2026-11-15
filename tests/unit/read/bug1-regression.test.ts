/**
 * Regression tests for bug #1 from the 8:20 PM voice test (15 Nov): the agent could not find the
 * notes in a folder the user named ("They are all under the sub-directory LO"), and could not
 * find a note by its name. The folder sits below the root, so a bare name has to resolve.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListFoldersTool } from '../../../src/tools/ListFolders';
import { SearchVaultTool } from '../../../src/tools/SearchVault';
import { isToolError } from '../../../src/tools/toolContract';
import { toolHarness } from '../harness';

const vault = {
  'Uni/LO/AP11AO402.md': '# Airway pressure\nLearning outcome: explain the objective of PEEP.',
  'Uni/LO/CV02.md': '# Cardiac output\nThe objective is to describe preload.',
  'Uni/LO/Sub/Deep.md': '# Deep\nnested objective note',
  'Uni/Other/Elsewhere.md': '# Elsewhere\nAnother objective outside the folder.',
  'Inbox.md': 'objective in the root',
};

test('bug 1: search_vault scoped by bare folder name "LO" finds the notes inside it', async () => {
  const h = toolHarness(vault);
  const out = await h.run(SearchVaultTool, { query: 'objective', folder: 'LO' });
  assert.ok(!isToolError(out), out);
  assert.match(out, /Uni\/LO\/AP11AO402\.md/);
  assert.match(out, /Uni\/LO\/CV02\.md/);
  assert.match(out, /Uni\/LO\/Sub\/Deep\.md/);
  assert.doesNotMatch(out, /Elsewhere\.md/);
  assert.doesNotMatch(out, /Inbox\.md/);
});

test('bug 1: search_vault folder scope is case-insensitive and takes a partial path', async () => {
  const h = toolHarness(vault);
  for (const folder of ['lo', 'Uni/LO', '/LO/', 'uni/lo']) {
    const out = await h.run(SearchVaultTool, { query: 'preload', folder });
    assert.match(out, /Uni\/LO\/CV02\.md/, `folder ${folder}: ${out}`);
  }
});

test('bug 1: search_vault with an unknown folder fails as a tool error', async () => {
  const h = toolHarness(vault);
  const out = await h.run(SearchVaultTool, { query: 'objective', folder: 'Nope' });
  assert.ok(isToolError(out), out);
});

test('bug 1: list_vault_folders with bare name "LO" lists the notes inside it', async () => {
  const h = toolHarness(vault);
  const out = await h.run(ListFoldersTool, { path: 'LO' });
  assert.ok(!isToolError(out), out);
  assert.match(out, /Uni\/LO\/AP11AO402\.md/);
  assert.match(out, /Uni\/LO\/CV02\.md/);
  assert.match(out, /Uni\/LO\/Sub/);
  assert.doesNotMatch(out, /Elsewhere\.md/);
});

test('bug 1: list_vault_folders recursive includes notes in subfolders', async () => {
  const h = toolHarness(vault);
  const out = await h.run(ListFoldersTool, { path: 'lo', recursive: true });
  assert.match(out, /Uni\/LO\/Sub\/Deep\.md/);
});

test('bug 1: search_vault finds a note by its name even when the text does not contain it', async () => {
  const h = toolHarness(vault);
  const out = await h.run(SearchVaultTool, { query: 'AP11AO402' });
  assert.ok(!isToolError(out), out);
  assert.match(out, /Uni\/LO\/AP11AO402\.md/);
});

test('bug 1: a phrase with no hits falls back to all of its words', async () => {
  const h = toolHarness(vault);
  // "learning objective" never appears as a phrase; both words appear in one note.
  const out = await h.run(SearchVaultTool, { query: 'learning objective' });
  assert.ok(!isToolError(out), out);
  assert.match(out, /Uni\/LO\/AP11AO402\.md/);
});
