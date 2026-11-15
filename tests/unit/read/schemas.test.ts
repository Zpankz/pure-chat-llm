import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActiveContextTool } from '../../../src/tools/ActiveContext';
import { GlobFilesTool } from '../../../src/tools/GlobFiles';
import { ListFoldersTool } from '../../../src/tools/ListFolders';
import { ReadFileTool } from '../../../src/tools/ReadFile';
import { ReadNoteSectionTool } from '../../../src/tools/ReadNoteSection';
import { SearchVaultTool } from '../../../src/tools/SearchVault';
import { SmartConnectionsRetrievalTool } from '../../../src/tools/SmartConnectionsRetrieval';
import { allowedIn, offersJson, TOOL_LAYERS } from '../../../src/tools/toolContract';

const tools = [
  ReadFileTool,
  ReadNoteSectionTool,
  SearchVaultTool,
  GlobFilesTool,
  ListFoldersTool,
  SmartConnectionsRetrievalTool,
  ActiveContextTool,
].map(T => new T({ plugin: { app: {}, settings: {} } } as never, {} as never));

/** Every key used anywhere in a schema. */
function keys(node: unknown, out: string[] = []): string[] {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      keys(v, out);
    }
  }
  return out;
}

test('read and search schemas stay in the subset every voice provider accepts', () => {
  for (const tool of tools) {
    const p = tool.parameters as { type: string; properties: Record<string, unknown> };
    assert.equal(p.type, 'object', tool.name);
    const used = keys(p);
    for (const banned of ['oneOf', 'anyOf', 'allOf', '$ref', 'const', 'nullable']) {
      assert.ok(!used.includes(banned), `${tool.name} uses ${banned}`);
    }
    for (const [name, prop] of Object.entries(p.properties)) {
      const q = prop as { type?: string; description?: string };
      assert.ok(q.type, `${tool.name}.${name} has a type`);
      assert.ok(q.description, `${tool.name}.${name} has a description`);
    }
    assert.ok(offersJson(p), `${tool.name} offers format json`);
  }
});

test('descriptions open with a plain sentence and fit the voice cap', () => {
  for (const tool of tools) {
    assert.ok(tool.description.length < 1200, `${tool.name}: ${tool.description.length}`);
    const first = tool.description.split('. ')[0];
    assert.ok(first.length < 220, `${tool.name} first sentence: ${first}`);
    assert.match(first, /^[A-Z][a-z]+s /, `${tool.name} starts with a verb: ${first}`);
  }
});

test('folder-scoped tools share folder and recursive parameters', () => {
  for (const tool of tools) {
    if (!['search_vault', 'glob_vault_files', 'smart_connections_rag'].includes(tool.name))
      continue;
    const props = (tool.parameters as { properties: Record<string, { type: string }> }).properties;
    assert.equal(props.folder?.type, 'string', tool.name);
    assert.equal(props.recursive?.type, 'boolean', tool.name);
  }
});

test('layers: read tools everywhere; active context not for background workers', () => {
  for (const tool of tools) assert.ok(TOOL_LAYERS[tool.name], `${tool.name} has layers`);
  for (const name of ['read_file', 'read_note_section', 'search_vault', 'glob_vault_files']) {
    for (const layer of ['chat', 'voice', 'orchestrator', 'worker', 'codemode'] as const) {
      assert.ok(allowedIn(name, layer), `${name} in ${layer}`);
    }
  }
  assert.ok(allowedIn('get_active_context', 'orchestrator'));
  assert.ok(!allowedIn('get_active_context', 'worker'));
});
