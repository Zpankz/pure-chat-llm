import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImageGenerationTool } from '../../../src/tools/ImageGen';
import { ManageWorkspaceTool } from '../../../src/tools/ManageWorkspace';
import { PluginSettingsTool } from '../../../src/tools/PluginSettings';
import { RunCommandTool } from '../../../src/tools/RunCommand';
import { ShowNoticeTool } from '../../../src/tools/ShowNotice';
import { SunoTool } from '../../../src/tools/Suno';
import { allowedIn, offersJson } from '../../../src/tools/toolContract';
import type { ToolDefinition } from '../../../src/types';
import { actionChat } from './fixtures';

const TOOLS: (new (chat: never, registry: never) => { getDefinition(): ToolDefinition })[] = [
  ManageWorkspaceTool,
  ShowNoticeTool,
  PluginSettingsTool,
  ImageGenerationTool,
  SunoTool,
  RunCommandTool,
];

/** Keys that some realtime providers reject in a function schema. */
const UNSUPPORTED = ['oneOf', 'anyOf', 'allOf', '$ref', '$defs', 'not', 'if'];

/** @param schema - JSON Schema node. */
function walk(schema: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  visit(node);
  for (const v of Object.values((node.properties as object) ?? {})) walk(v, visit);
  if (node.items) walk(node.items, visit);
}

test('every action tool has a provider-safe schema, json format and a plain description', () => {
  const c = actionChat({ settings: { endpoint: 0, endpoints: [] } });
  for (const ToolClass of TOOLS) {
    const tool = c.tool(ToolClass);
    const def = tool.getDefinition().function;
    assert.equal(def.parameters.type, 'object', def.name);
    assert.ok(offersJson(def.parameters), `${def.name} offers format json`);
    for (const r of def.parameters.required) assert.ok(r in def.parameters.properties, def.name);
    walk(def.parameters, node => {
      for (const k of UNSUPPORTED) assert.ok(!(k in node), `${def.name}: ${k}`);
      assert.ok(typeof node.type === 'string', `${def.name}: every node has one type`);
      if (node.enum)
        assert.ok(Array.isArray(node.enum) && node.enum.every(e => typeof e === 'string'));
    });
    assert.ok(def.description.length < 1200, `${def.name} description is concise`);
    const first = def.description.split('. ')[0];
    assert.ok(first.length < 200, `${def.name}: first sentence says what it does`);
  }
});

test('layers: the action tools stay in the foreground', () => {
  for (const name of [
    'manage_workspace',
    'show_obsidian_notice',
    'generate_image',
    'suno_music_gen',
  ]) {
    assert.ok(allowedIn(name, 'chat') && allowedIn(name, 'voice'), name);
    assert.ok(!allowedIn(name, 'worker') && !allowedIn(name, 'codemode'), name);
  }
  assert.ok(allowedIn('manage_plugin_settings', 'chat'));
  assert.ok(!allowedIn('manage_plugin_settings', 'voice'));
});
