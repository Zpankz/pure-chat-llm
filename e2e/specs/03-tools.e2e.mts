// TOOL-01..19, SKL-1, SKL-2, MCP-1: each original tool run from a real chat note through the
// plugin's "Complete chat response" command. The model is fake (it replays a script); the tools,
// the review modals and the vault are real.
import { browser } from '@wdio/globals';
import {
  check,
  clickModalButton,
  expect,
  listFiles,
  readNote,
  runChat,
  toolCalls,
  useFakeServices,
  type Evidence,
} from '../support/harness.mts';

/** Runs one scripted tool call in a chat and returns what the tool returned. */
async function callTool(ev: Evidence, id: string, name: string, args: Record<string, unknown>, modal?: { button: string }) {
  const run = await runChat(id, `Validation: call ${name}.`, { rounds: [[{ name, args }]] }, {
    onModal: modal
      ? async title => {
          await ev.shot(`modal-${title}`);
          await clickModalButton(modal.button);
        }
      : undefined,
  });
  const calls = toolCalls(id, ev.mark);
  ev.save('tool-calls', calls);
  await ev.shot('chat-after');
  const call = calls.find(c => c.name === name);
  expect(call).toBeDefined();
  ev.note(`${name} returned: ${call!.result.replace(/\s+/g, ' ').slice(0, 220)}`);
  return { ...call!, run };
}

describe('Original tools, skills and MCP from a chat note', () => {
  before(async () => {
    await useFakeServices();
  });

  check('TOOL-01', 'Chat calls get_active_context with the chat note open', async ev => {
    const c = await callTool(ev, 'TOOL-01', 'get_active_context', {});
    expect(c.result).toContain('TOOL-01');
  });

  check('TOOL-02', 'Chat calls get_backlinks on AP11AO401 (the SAQ AP11B05 links to it)', async ev => {
    const c = await callTool(ev, 'TOOL-02', 'get_backlinks', { path: 'src/lo/anzca/LO/AP11AO401.md' });
    expect(c.result).toContain('AP11B05');
  });

  check('TOOL-03', 'Chat calls create_obsidian_note; the review modal appears and is approved', async ev => {
    await callTool(ev, 'TOOL-03', 'create_obsidian_note', { path: 'Agent output/created-by-chat.md', content: 'CREATED-BY-TOOL-03' }, { button: 'Approve and apply' });
    expect(await readNote('Agent output/created-by-chat.md')).toContain('CREATED-BY-TOOL-03');
  });

  check('TOOL-04', 'Chat calls delete_obsidian_note; the confirmation modal appears and the note goes to the trash', async ev => {
    await callTool(ev, 'TOOL-04', 'delete_obsidian_note', { path: 'Notes/chat-delete.md' }, { button: 'Delete' });
    expect(await readNote('Notes/chat-delete.md')).toBeNull();
    const trash = await listFiles('.trash');
    ev.save('trash', trash);
    expect(trash.some(p => p.includes('chat-delete'))).toBe(true);
  });

  check('TOOL-05', 'Chat calls glob_vault_files with **/LO/*.md', async ev => {
    const c = await callTool(ev, 'TOOL-05', 'glob_vault_files', { pattern: '**/LO/*.md' });
    expect(c.result).toContain('AP11AO402');
  });

  check('TOOL-07', 'Chat calls list_vault_folders on src/lo', async ev => {
    const c = await callTool(ev, 'TOOL-07', 'list_vault_folders', { path: 'src/lo' });
    expect(c.result).toContain('LO');
  });

  check('TOOL-08', 'Chat calls manage_workspace to open AP11AO401 in a new tab', async ev => {
    await callTool(ev, 'TOOL-08', 'manage_workspace', { action: 'open', path: 'src/lo/anzca/LO/AP11AO401.md', new_leaf: true });
    const open = await browser.executeObsidian(({ app }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.workspace.getLeavesOfType('markdown').map(l => (l.view as any).file?.path),
    );
    ev.save('open-tabs', open);
    expect(open).toContain('src/lo/anzca/LO/AP11AO401.md');
  });

  check('TOOL-09', 'Chat calls patch_note under ## Section; the review modal is approved', async ev => {
    await callTool(ev, 'TOOL-09', 'patch_note', { path: 'Notes/chat-edit.md', heading: 'Section', new_content: 'PATCHED-BY-TOOL-09' }, { button: 'Approve and apply' });
    expect(await readNote('Notes/chat-edit.md')).toContain('PATCHED-BY-TOOL-09');
  });

  check('TOOL-10', 'Chat calls manage_plugin_settings to read skillsFolder', async ev => {
    const c = await callTool(ev, 'TOOL-10', 'manage_plugin_settings', { action: 'read', key: 'skillsFolder' });
    expect(c.result).toContain('Skills');
  });

  check('TOOL-11', 'Chat calls read_file on Notes/scratch.md', async ev => {
    const c = await callTool(ev, 'TOOL-11', 'read_file', { path: 'Notes/scratch.md' });
    expect(c.result).toContain('alpha beta gamma');
  });

  check('TOOL-12', 'Chat calls read_note_section for [[sections#Beta]]', async ev => {
    const c = await callTool(ev, 'TOOL-12', 'read_note_section', { link: '[[sections#Beta]]' });
    expect(c.result).toContain('beta body');
  });

  check('TOOL-13', 'Chat calls replace_in_note; the review modal is approved', async ev => {
    await callTool(ev, 'TOOL-13', 'replace_in_note', { path: 'Notes/scratch.md', search: 'gamma', replace: 'REPLACED-BY-TOOL-13' }, { button: 'Approve and apply' });
    expect(await readNote('Notes/scratch.md')).toContain('REPLACED-BY-TOOL-13');
  });

  check('TOOL-14', 'Chat calls search_vault for "oxygen cascade"', async ev => {
    const c = await callTool(ev, 'TOOL-14', 'search_vault', { query: 'oxygen cascade' });
    expect(c.result).toContain('AP11AO401');
  });

  check('TOOL-15', 'Chat calls show_obsidian_notice; the notice appears on screen', async ev => {
    await runChat('TOOL-15', 'Validation: show a notice.', { rounds: [[{ name: 'show_obsidian_notice', args: { message: 'NOTICE-FROM-TOOL-15', duration: 30000 } }]] });
    const notices = await browser.execute(() => [...document.querySelectorAll('.notice')].map(n => n.textContent ?? ''));
    await ev.shot('notice');
    ev.save('notices', notices);
    ev.save('tool-calls', toolCalls('TOOL-15', ev.mark));
    expect(notices.some(n => n.includes('NOTICE-FROM-TOOL-15'))).toBe(true);
  });

  check('TOOL-18', 'Chat calls manage_templates list (core Templates folder set to Templates/)', async ev => {
    const c = await callTool(ev, 'TOOL-18', 'manage_templates', { action: 'list' });
    expect(c.result).toContain('Daily');
  });

  check('TOOL-19', 'Chat calls write_note_section to replace ## Alpha; the review modal is approved', async ev => {
    await callTool(ev, 'TOOL-19', 'write_note_section', { link: '[[sections#Alpha]]', content: 'WRITTEN-BY-TOOL-19', mode: 'replace' }, { button: 'Approve and apply' });
    const text = await readNote('Notes/sections.md');
    expect(text).toContain('WRITTEN-BY-TOOL-19');
    expect(text).toContain('beta body');
  });

  check('SKL-1', 'Refresh the skills catalogue and screenshot the Agent skills settings', async ev => {
    const skills = await browser.executeObsidian(async ({ plugins }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = await (plugins.voiceAgent as any).skills.refresh();
      return list.map((s: { name: string; mainFile: string; dir: string; warnings: string[] }) => ({ name: s.name, mainFile: s.mainFile, dir: s.dir, warnings: s.warnings }));
    });
    ev.save('skills', skills);
    const byName = Object.fromEntries(skills.map((s: { name: string }) => [s.name, s]));
    expect(byName['vault-search']?.mainFile).toBe('vault-search.md');
    expect(byName['legacy-format']?.mainFile).toBe('SKILL.md');
    expect(byName['no-description']).toBeUndefined();
    await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setting = (app as any).setting;
      setting.open();
      setting.openTabById('voice-agent');
    });
    await browser.execute(() => {
      [...document.querySelectorAll('.vertical-tab-content .setting-item-heading')]
        .find(el => el.textContent?.includes('Agent skills'))
        ?.scrollIntoView({ block: 'start' });
    });
    await browser.pause(300);
    await ev.shot('agent-skills-settings');
    await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).setting.close();
    });
    ev.note('vault-search loads from vault-search.md, legacy-format from SKILL.md, and the skill without a description is skipped.');
  });

  check('SKL-2', 'Chat calls activate_skill then read_skill_file for vault-search', async ev => {
    await runChat('SKL-2', 'Validation: use a skill.', {
      rounds: [[{ name: 'activate_skill', args: { name: 'vault-search' } }], [{ name: 'read_skill_file', args: { name: 'vault-search', path: 'reference.md' } }]],
    });
    const calls = toolCalls('SKL-2', ev.mark);
    ev.save('tool-calls', calls);
    await ev.shot('chat-after');
    expect(calls[0]?.result).toContain('Vault search skill');
    expect(calls[1]?.result).toContain('SKILL-REFERENCE-MARKER-91c2');
  });

  check('MCP-1', 'Two fake MCP servers in settings (stateless and session-based); a chat calls one tool from each', async ev => {
    const bridged = await browser.executeObsidian(({ plugins }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (plugins.voiceAgent as any).mcp.bridgedTools().map((b: any) => ({ name: b.exposedName, server: b.server.name, tool: b.tool.name })),
    );
    ev.save('bridged-tools', bridged);
    const modern = bridged.find((b: { server: string }) => b.server === 'fake-modern');
    const legacy = bridged.find((b: { server: string }) => b.server === 'fake-legacy');
    expect(modern).toBeDefined();
    expect(legacy).toBeDefined();
    await runChat('MCP-1', 'Validation: call both MCP servers.', {
      rounds: [[{ name: modern.name, args: { term: 'shunt' } }], [{ name: legacy.name, args: { term: 'shunt' } }]],
    });
    const calls = toolCalls('MCP-1', ev.mark);
    ev.save('tool-calls', calls);
    expect(calls[0]?.result).toContain('FAKE-MCP-RESULT');
    expect(calls[1]?.result).toContain('FAKE-MCP-RESULT');
    await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setting = (app as any).setting;
      setting.open();
      setting.openTabById('voice-agent');
    });
    await browser.execute(() => {
      [...document.querySelectorAll('.vertical-tab-content .setting-item-heading')]
        .find(el => el.textContent?.includes('Remote MCP servers'))
        ?.scrollIntoView({ block: 'start' });
    });
    await browser.pause(300);
    await ev.shot('mcp-settings');
    await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).setting.close();
    });
    ev.note(`Bridged ${bridged.length} MCP tools; both fake servers answered (the session-based one after initialize).`);
  });
});
