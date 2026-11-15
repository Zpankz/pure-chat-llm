// SET-1, SET-2: the Voice Agent settings tab in real Obsidian.
import { browser } from '@wdio/globals';
import { check, expect } from '../support/harness.mts';

const GROUPS = ['Voice', 'Orchestrator', 'Workers', 'Evaluator', 'Interruptions', 'Check-ins'];

async function openTab() {
  await browser.executeObsidian(({ app }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setting = (app as any).setting;
    setting.open();
    setting.openTabById('voice-agent');
  });
  await browser.$('.vertical-tab-content .setting-item').waitForExist({ timeout: 15_000 });
}

/** Every heading in the tab, with the names of the settings under it. */
async function sections(): Promise<Record<string, string[]>> {
  return browser.execute(() => {
    const out: Record<string, string[]> = {};
    let current = '(top)';
    const items = document.querySelectorAll('.vertical-tab-content .setting-item');
    items.forEach(item => {
      const name = item.querySelector('.setting-item-name')?.textContent?.trim() ?? '';
      if (item.classList.contains('setting-item-heading')) {
        current = name;
        out[current] = out[current] ?? [];
      } else {
        (out[current] = out[current] ?? []).push(name);
      }
    });
    return out;
  });
}

async function scrollTo(heading: string) {
  await browser.execute((heading: string) => {
    const h = [...document.querySelectorAll('.vertical-tab-content .setting-item-heading')].find(
      el => el.querySelector('.setting-item-name')?.textContent?.trim() === heading,
    );
    h?.scrollIntoView({ block: 'start' });
  }, heading);
  await browser.pause(300);
}

describe('Settings tab', () => {
  before(openTab);

  check('SET-1', 'Open Settings > Voice Agent and list every heading; screenshot each of the six groups', async ev => {
    const s = await sections();
    ev.save('settings-sections', s);
    for (const g of GROUPS) {
      expect(Object.keys(s)).toContain(g);
      await scrollTo(g);
      await ev.shot(`group-${g}`);
    }
    ev.note(`All six groups present: ${GROUPS.join(', ')}.`);
  });

  check('SET-2', 'Read the Orchestrator, Workers and Evaluator groups and the stored layer settings', async ev => {
    const s = await sections();
    const layers = await browser.executeObsidian(({ plugins }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      JSON.parse(JSON.stringify((plugins.voiceAgent as any).settings.orchestrator.layers)),
    );
    ev.save('layer-settings', { ui: { Orchestrator: s.Orchestrator, Workers: s.Workers, Evaluator: s.Evaluator }, stored: layers });
    for (const g of ['Orchestrator', 'Workers', 'Evaluator']) {
      expect(s[g]).toEqual(expect.arrayContaining(['Provider', 'Model', 'Reasoning effort']));
    }
    expect(layers.orchestrator.model).toBe('gpt-6.1-sol');
    expect(layers.orchestrator.effort).toBe('medium');
    expect(layers.worker.model).toBe('muse-spark-1.3-contributor');
    expect(layers.worker.effort).toBe('xhigh');
    expect(layers.evaluator.model).toBe('gemini-4-argon');
    expect(layers.evaluator.enabled).toBe(false);
    await scrollTo('Workers');
    await ev.shot('workers-layer');
    ev.note('Each layer has Provider, Model and Reasoning effort; defaults are GPT 6.1 Sol (medium), muse-spark-1.3-contributor (xhigh), gemini-4-argon (evaluator off).');
  });

  after(async () => {
    await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).setting.close();
    });
  });
});
