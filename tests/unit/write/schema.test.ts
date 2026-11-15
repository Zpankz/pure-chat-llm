import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateNoteTool } from '../../../src/tools/CreateNote';
import { DeleteNoteTool } from '../../../src/tools/DeleteNote';
import { PatchNoteTool } from '../../../src/tools/PatchNote';
import { ReplaceInNoteTool } from '../../../src/tools/ReplaceInNote';
import { TemplatesTool } from '../../../src/tools/Templates';
import { WriteNoteSectionTool } from '../../../src/tools/WriteNoteSection';
import { allowedIn, offersJson } from '../../../src/tools/toolContract';

const TOOLS = [
  CreateNoteTool,
  WriteNoteSectionTool,
  PatchNoteTool,
  ReplaceInNoteTool,
  DeleteNoteTool,
  TemplatesTool,
].map(T => new T({} as never, {} as never));

const SIMPLE_TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array'];

test('schemas stay in the subset every provider accepts, and offer JSON', () => {
  for (const tool of TOOLS) {
    const p = tool.parameters as unknown as Record<string, unknown>;
    assert.equal(p.type, 'object', tool.name);
    for (const banned of ['oneOf', 'anyOf', 'allOf', '$ref', '$defs'])
      assert.ok(!JSON.stringify(p).includes(`"${banned}"`), `${tool.name} uses ${banned}`);
    for (const [key, prop] of Object.entries(tool.parameters.properties)) {
      assert.ok(SIMPLE_TYPES.includes(prop.type), `${tool.name}.${key}: ${String(prop.type)}`);
      assert.ok(prop.description, `${tool.name}.${key} has no description`);
    }
    assert.ok(offersJson(tool.parameters), `${tool.name} offers format: json`);
  }
});

test('descriptions: plain first sentence, say what review happens, fit voice limits', () => {
  for (const tool of TOOLS) {
    const d = tool.description;
    assert.ok(d.length < 800, `${tool.name}: ${d.length} chars`);
    assert.ok(!/triggers a user|confirmation modal/i.test(d), `${tool.name} is stale`);
    if (tool.name !== 'patch_note') {
      assert.match(d, /background workers follow the write policy/, tool.name);
      assert.match(d, /In a chat the user (reviews|confirms)/, tool.name);
    }
  }
  assert.match(new DeleteNoteTool({} as never, {} as never).description, /trash/);
});

test('layers: write tools are not offered to the orchestrator', () => {
  for (const name of [
    'create_obsidian_note',
    'write_note_section',
    'replace_in_note',
    'delete_obsidian_note',
    'manage_templates',
  ]) {
    assert.ok(allowedIn(name, 'worker') && allowedIn(name, 'chat'), name);
    assert.ok(!allowedIn(name, 'orchestrator'), name);
  }
});
