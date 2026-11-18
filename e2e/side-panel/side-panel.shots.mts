// Side panel screenshots, before and after the redesign, in light and dark (requested by the
// "Voice models and tools upgrade" thread, 2026-11-18; brief in
// validation/side-panel-screenshots.md). Not part of the validation suite: the side-panel
// workflow builds the plugin at one commit, runs only this file and prints the pictures to the
// job log.
//
// Real: Obsidian, the plugin as built from the commit under test, its two side panels, the
// theme, the Page preview core plugin. Scripted: the voice call panel is fed voice events by
// calling its event handler directly, its background agent list is a stub, and the conversation
// overview reads a sample chat note. No voice call or model runs.
import fs from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';

const LABEL = process.env.SHOT_LABEL ?? 'build';
const OUT = path.join(process.env.E2E_OUT ?? 'e2e/.out', 'side-panel', LABEL);
const WIDTH = 380;
const notes: string[] = [];

function log(line: string) {
  notes.push(line);
  console.log(`[side-panel] ${LABEL}: ${line}`);
}

async function setTheme(theme: 'light' | 'dark') {
  await browser.executeObsidian(({ app }, theme: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = app as any;
    const id = theme === 'dark' ? 'obsidian' : 'moonstone';
    if (typeof a.changeTheme === 'function') a.changeTheme(id);
    else a.vault.setConfig('theme', id);
    document.body.toggleClass('theme-dark', theme === 'dark');
    document.body.toggleClass('theme-light', theme === 'light');
  }, theme);
  await browser.pause(600);
}

/** Marks a leaf's container for an element screenshot and sizes its sidebar. */
async function markLeaf(viewType: string): Promise<{ side: string; width: number } | null> {
  return browser.executeObsidian(
    ({ app }, viewType: string, width: number) => {
      document.querySelectorAll('[data-e2e-shot]').forEach(e => e.removeAttribute('data-e2e-shot'));
      const leaf = app.workspace.getLeavesOfType(viewType)[0];
      if (!leaf) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = app.workspace as any;
      const inRight = ws.rightSplit?.containerEl?.contains(leaf.view.containerEl);
      const split = inRight ? ws.rightSplit : ws.leftSplit;
      if (split?.collapsed) split.expand();
      if (typeof split?.setSize === 'function') split.setSize(width);
      else if (split?.containerEl) split.containerEl.style.width = `${width}px`;
      app.workspace.revealLeaf(leaf);
      leaf.view.containerEl.setAttribute('data-e2e-shot', viewType);
      return { side: inRight ? 'right' : 'left', width: Math.round(leaf.view.containerEl.getBoundingClientRect().width) };
    },
    viewType,
    WIDTH,
  );
}

async function shotLeaf(viewType: string, name: string) {
  await browser.pause(500);
  const el = await browser.$(`[data-e2e-shot="${viewType}"]`);
  const file = path.join(OUT, `${name}.png`);
  await el.saveScreenshot(file);
  log(`saved ${name}.png`);
}

async function shotWindow(name: string) {
  const file = path.join(OUT, `${name}.png`);
  await browser.saveScreenshot(file);
  log(`saved ${name}.png (whole window)`);
}

const CHAT_NOTE = `# role: system

You are a careful study assistant.

# role: user

What links [[Oxygen cascade]] to altitude?

# role: assistant

At altitude the inspired oxygen pressure falls, so every step of the cascade starts lower. See [[Altitude and hypoxia]].

# role: tool

{"notes": ["Oxygen cascade", "Altitude and hypoxia"]}

# role: user

Thanks, add that to my review list.
`;

describe(`Side panels (${LABEL})`, () => {
  before(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    try {
      await browser.setWindowSize(1440, 960);
    } catch {
      // keep the default size
    }
    const info = await browser.executeObsidian(async ({ app }, chat: string) => {
      const make = async (p: string, text: string) => {
        if (!app.vault.getFileByPath(p)) {
          const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
          if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
          await app.vault.create(p, text);
        }
      };
      await make('Oxygen cascade.md', '# Oxygen cascade\n\nThe fall in oxygen partial pressure from inspired air to the mitochondria: inspired, alveolar, arterial, capillary, cellular.\n');
      await make('Respiratory physiology.md', '# Respiratory physiology\n\nLinks: [[Oxygen cascade]], [[Altitude and hypoxia]].\n');
      await make('Altitude and hypoxia.md', '# Altitude and hypoxia\n\nBarometric pressure falls with altitude, so inspired PO2 falls and the whole [[Oxygen cascade]] starts lower.\n');
      await make('Voice Agent/Calls/demo.md', '# Demo call\n');
      await make('Chat demo.md', chat);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = app as any;
      a.internalPlugins?.getPluginById?.('page-preview')?.enable?.(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin = (a.plugins.plugins['voice-agent'] ?? null) as any;
      return { version: plugin?.manifest?.version ?? null, obsidian: a.appVersion ?? null };
    }, CHAT_NOTE);
    log(`plugin ${info.version}, Obsidian ${info.obsidian}`);
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`voice call panel, ${theme}`, async () => {
      await setTheme(theme);
      const opened = await browser.executeObsidian(async ({ app }) => {
        for (const l of app.workspace.getLeavesOfType('voice-call-side-view')) l.detach();
        const leaf = app.workspace.getRightLeaf(false);
        await leaf?.setViewState({ type: 'voice-call-side-view', active: true });
        await new Promise(r => setTimeout(r, 300));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const view = app.workspace.getLeavesOfType('voice-call-side-view')[0]?.view as any;
        if (!view) return 'no voice call view';
        const ev = (e: unknown) => view.onVoiceEvent(e);
        ev({ type: 'status', text: 'Connected' });
        ev({ type: 'transcript', role: 'user', text: 'What did I write about [[Oxygen cascade]] last week?', final: true });
        ev({ type: 'tool', name: 'activate_skill', phase: 'start', id: 't1', args: { name: 'literature-review' } });
        ev({ type: 'tool', name: 'activate_skill', phase: 'end', id: 't1', result: 'Loaded the skill.', ms: 120 });
        ev({ type: 'tool', name: 'search_vault', phase: 'start', id: 't2', args: { query: 'oxygen cascade' } });
        ev({ type: 'tool', name: 'search_vault', phase: 'end', id: 't2', result: '- [[Oxygen cascade]]\n- [[Respiratory physiology]]', ms: 840 });
        ev({ type: 'tool', name: 'memory_recall', phase: 'start', id: 't3', args: { query: 'oxygen cascade' } });
        ev({ type: 'tool', name: 'delete_obsidian_note', phase: 'start', id: 't4', args: { path: 'Scratch.md' } });
        ev({ type: 'tool', name: 'delete_obsidian_note', phase: 'end', id: 't4', error: 'The user declined.', ms: 2300 });
        ev({ type: 'transcript', role: 'assistant', text: 'You linked it from [[Respiratory physiology]] and added two notes on altitude.', final: true });
        ev({ type: 'transcript', role: 'user', text: 'Can you summarise both', final: false });
        let update = 'no update card (this build has none)';
        if (view.plugin?.manifest?.version !== '2.0.0-beta.4') {
          view.transcript.push({ role: 'tool', text: 'Find altitude notes: finished', final: true, at: Date.now(), kind: 'update', detail: 'Found 3 notes; the main one is [[Altitude and hypoxia]].', rev: 0 });
          view.renderTranscript();
          update = 'update card added';
        }
        const now = Date.now();
        view.plugin.agents.list = () => [
          { id: 'a1', title: 'Summarise altitude notes', prompt: '', status: 'running', createdAt: now - 95000, startedAt: now - 95000, model: 'worker', steps: [{ at: now - 60000, kind: 'tool', text: 'read_file Altitude and hypoxia.md' }, { at: now - 5000, kind: 'response', text: 'Drafting the summary of the three notes' }], notePath: 'Voice Agent/Calls/demo.md' },
          { id: 'a2', title: 'Check citation format', prompt: '', status: 'waiting', createdAt: now - 300000, startedAt: now - 300000, model: 'worker', steps: [{ at: now - 20000, kind: 'advice', text: 'Asked which style' }], question: 'APA or Vancouver?' },
          { id: 'a3', title: 'Find altitude notes', prompt: '', status: 'done', createdAt: now - 600000, startedAt: now - 600000, finishedAt: now - 540000, model: 'worker', steps: [], result: 'Found [[Altitude and hypoxia]], [[Oxygen cascade]] and one more.' },
        ];
        view.renderTasks();
        return `fed 11 scripted voice events, ${update}, stubbed 3 agents`;
      });
      log(`voice call panel (${theme}): ${opened}`);
      const sized = await markLeaf('voice-call-side-view');
      log(`voice call panel sits in the ${sized?.side} sidebar, ${sized?.width} px wide`);
      await shotLeaf('voice-call-side-view', `voice-call-${theme}`);

      // After build only: open the "Searched the vault" card, then hover a wikilink with Ctrl.
      const card = await browser.execute(() => {
        const root = document.querySelector('[data-e2e-shot="voice-call-side-view"]');
        const hit = [...(root?.querySelectorAll('*') ?? [])].find(
          e => e.childElementCount === 0 && (e.textContent ?? '').trim() === 'Searched the vault',
        ) as HTMLElement | undefined;
        if (!hit) return false;
        const row = (hit.closest('summary, button, [role="button"], .va-card__head, .va-tool__head') as HTMLElement | null) ?? hit;
        row.click();
        return true;
      });
      if (!card) {
        log(`voice call panel (${theme}): no "Searched the vault" card in this build, so no card or hover shots`);
        return;
      }
      await shotLeaf('voice-call-side-view', `voice-call-${theme}-search-card-open`);

      const link = await browser.$('[data-e2e-shot="voice-call-side-view"] a.internal-link');
      if (!(await link.isExisting())) {
        log(`voice call panel (${theme}): no wikilink to hover`);
        return;
      }
      const linkText = await link.getText();
      await link.scrollIntoView({ block: 'center' });
      await browser.action('key').down('').perform(true);
      await link.moveTo();
      let popover = await browser.$('.popover.hover-popover');
      try {
        await popover.waitForDisplayed({ timeout: 4000 });
      } catch {
        // WebDriver's held Ctrl may not reach the hover event; send Obsidian's hover with Ctrl set.
        await browser.execute(el => {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ctrlKey: true, metaKey: false, clientX: r.x + 4, clientY: r.y + 4 }));
        }, link);
        popover = await browser.$('.popover.hover-popover');
        await popover.waitForDisplayed({ timeout: 6000 }).catch(() => undefined);
      }
      await browser.pause(800);
      const shown = await popover.isDisplayed().catch(() => false);
      await shotWindow(`voice-call-${theme}-link-preview`);
      log(`voice call panel (${theme}): hovering [[${linkText}]] with Ctrl ${shown ? 'showed the page preview' : 'showed no page preview'}`);
      await browser.action('key').up('').perform();
      await browser.$('body').moveTo({ xOffset: 10, yOffset: 10 }).catch(() => undefined);
      await browser.keys('Escape');
      await browser.pause(400);
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`conversation overview, ${theme}`, async () => {
      await setTheme(theme);
      const opened = await browser.executeObsidian(async ({ app }) => {
        const file = app.vault.getFileByPath('Chat demo.md');
        await app.workspace.getLeaf(false).openFile(file!);
        await new Promise(r => setTimeout(r, 300));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const plugin = (app as any).plugins.plugins['voice-agent'];
        if (!app.workspace.getLeavesOfType('pure-chat-llm-left-pane').length) {
          if (typeof plugin?.activateChatView === 'function') await plugin.activateChatView();
          else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cmd = (app as any).commands.listCommands().find((c: { name: string }) => /conversation overview/i.test(c.name));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (cmd) (app as any).commands.executeCommandById(cmd.id);
          }
        }
        await new Promise(r => setTimeout(r, 800));
        // Focus the note again so the overview shows it.
        const md = app.workspace.getLeavesOfType('markdown').find(l => (l.view as { file?: { path: string } }).file?.path === 'Chat demo.md');
        if (md) app.workspace.setActiveLeaf(md, { focus: true });
        await new Promise(r => setTimeout(r, 800));
        return app.workspace.getLeavesOfType('pure-chat-llm-left-pane').length ? 'opened' : 'did not open';
      });
      log(`conversation overview (${theme}): ${opened}, showing Chat demo.md`);
      const sized = await markLeaf('pure-chat-llm-left-pane');
      log(`conversation overview sits in the ${sized?.side} sidebar, ${sized?.width} px wide`);
      await shotLeaf('pure-chat-llm-left-pane', `conversation-overview-${theme}`);
    });
  }

  after(() => {
    fs.writeFileSync(path.join(OUT, 'notes.txt'), `${notes.join('\n')}\n`);
  });
});
