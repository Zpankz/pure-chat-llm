// MIG-1: the vault starts with only the old plugin's settings file (.obsidian/plugins/pure-chat-llm/data.json).
import { browser } from '@wdio/globals';
import { check, expect } from '../support/harness.mts';
import { LEGACY_MARKERS } from '../fake-services/vault-seed.mjs';

describe('Settings migration from pure-chat-llm', () => {
  check('MIG-1', 'Fresh vault holding only the old plugin settings file; load Voice Agent and read its settings and data file', async ev => {
    const notice = await browser.execute(() => [...document.querySelectorAll('.notice')].map(n => n.textContent ?? ''));
    await ev.shot('after-first-load');
    const state = await browser.executeObsidian(async ({ app, plugins }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = plugins.voiceAgent as any;
      const dir = `${app.vault.configDir}/plugins`;
      const ownPath = `${dir}/voice-agent/data.json`;
      // saveSettings runs during load; give the write a moment.
      for (let i = 0; i < 20 && !(await app.vault.adapter.exists(ownPath)); i++) await new Promise(r => setTimeout(r, 250));
      return {
        id: p?.manifest?.id,
        name: p?.manifest?.name,
        SystemPrompt: p?.settings?.SystemPrompt,
        defaultmaxTokens: p?.settings?.defaultmaxTokens,
        templates: Object.keys(p?.settings?.chatTemplates ?? {}),
        ownFileExists: await app.vault.adapter.exists(ownPath),
        ownFile: (await app.vault.adapter.exists(ownPath)) ? await app.vault.adapter.read(ownPath) : null,
        legacyStillThere: await app.vault.adapter.exists(`${dir}/pure-chat-llm/data.json`),
      };
    });
    ev.save('settings-after-load', { notice, ...state, ownFile: state.ownFile ? JSON.parse(state.ownFile) : null });
    expect(state.id).toBe('voice-agent');
    expect(state.name).toBe('Voice Agent');
    expect(state.SystemPrompt).toBe(LEGACY_MARKERS.SystemPrompt);
    expect(state.defaultmaxTokens).toBe(LEGACY_MARKERS.defaultmaxTokens);
    expect(state.templates.some((t: string) => /legacy template 7f3a/i.test(t))).toBe(true);
    expect(state.ownFileExists).toBe(true);
    expect(state.ownFile).toContain('LEGACY-SYSTEM-PROMPT-7f3a');
    ev.note(`Plugin id ${state.id}; legacy system prompt, max tokens and template carried over and written to voice-agent/data.json.`);
    if (notice.some(n => /carried your Pure Chat LLM settings/.test(n))) ev.note('The carry-over notice was on screen.');
    else ev.note('The carry-over notice had already closed or was not captured before the first screenshot.');
  });
});
