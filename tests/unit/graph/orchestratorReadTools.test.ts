import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORCHESTRATOR_READ_TOOLS } from '../../../src/agents/OrchestratorAgent';
import { allowedIn, TOOL_LAYERS } from '../../../src/tools/toolContract';

test('orchestrator read tools name the consolidated graph tools, and all may run there', () => {
  for (const name of [
    'traverse_graph',
    'vault_ontology',
    'read_file',
    'read_note_section',
    'search_vault',
    'glob_vault_files',
    'list_vault_folders',
    'smart_connections_rag',
    'get_active_context',
  ])
    assert.ok(ORCHESTRATOR_READ_TOOLS.includes(name), name);
  // Retired in favour of traverse_graph; graph_cli can run and save scripts, so workers keep it.
  assert.ok(!ORCHESTRATOR_READ_TOOLS.includes('get_backlinks'));
  assert.ok(!ORCHESTRATOR_READ_TOOLS.includes('graph_cli'));
  for (const name of ORCHESTRATOR_READ_TOOLS) assert.ok(allowedIn(name, 'orchestrator'), name);
  assert.equal(new Set(ORCHESTRATOR_READ_TOOLS).size, ORCHESTRATOR_READ_TOOLS.length);
});

test('graph tool layers: graph_cli stays out of code mode (it runs saved scripts)', () => {
  assert.ok(allowedIn('traverse_graph', 'codemode'));
  assert.ok(allowedIn('vault_ontology', 'worker'));
  assert.ok(allowedIn('get_backlinks', 'worker'));
  assert.ok(!TOOL_LAYERS.graph_cli.includes('codemode'));
});
