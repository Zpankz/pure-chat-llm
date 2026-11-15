// SET-1, SET-2: the Voice Agent settings tab in real Obsidian. SET-2 also takes the settings
// screenshots for skills (SKL-1) and MCP servers (MCP-1).
//
// The first run (commit cc4cf79) lost this whole spec: opening the tab left every later command
// without an answer for three minutes. The tab is now opened from a timer inside the page and
// every step is time-limited, so a frozen window is reported as a finding, not a hung suite.
import { browser } from '@wdio/globals';
import {
  armFreezeProbe,
  check,
  consoleLines,
  disarmFreezeProbe,
  expect,
  useFakeServices,
  windowResponds,
  withTimeout,
  type Evidence,
} from '../support/harness.mts';

const GROUPS = ['Voice', 'Orchestrator', 'Workers', 'Evaluator', 'Interruptions', 'Check-ins'];

/** Opens Settings > Voice Agent without waiting on the call itself, then waits for it to render. */
async function openTab(ev: Evidence) {
  // With the debugger on before the tab opens, a freeze can still be paused and its stack read.
  ev.save('freeze-probe', await armFreezeProbe());
  const before = Date.now();
  await withTimeout(
    browser.executeObsidian(({ app }) => {
      window.setTimeout(() => {
        const t0 = performance.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const setting = (app as any).setting;
        setting.open();
        setting.openTabById('voice-agent');
        console.log(`[e2e] settings tab rendered in ${Math.round(performance.now() - t0)} ms`);
      }, 0);
    }),
    10_000,
    'Scheduling the settings tab',
  );
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (!(await windowResponds(15_000))) {
      throw new Error(`Opening Settings > Voice Agent froze the Obsidian window: no answer for 15 s (${Math.round((Date.now() - before) / 1000)} s after opening)`);
    }
    const count = await browser.execute(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root: HTMLElement | undefined = (window as any).app?.setting?.activeTab?.containerEl;
      return root?.querySelectorAll('.setting-item').length ?? 0;
    });
    if (count > 0) break;
    await browser.pause(500);
  }
  // What actually rendered: the active tab and the outline of its first elements. Also printed to
  // the job log, which can be read without downloading the evidence.
  const rendered = await browser.execute(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = (window as any).app?.setting?.activeTab;
      const root: HTMLElement | undefined = tab?.containerEl;
      const outline = root
        ? [...root.querySelectorAll('*')].slice(0, 80).map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${(e.childElementCount ? '' : e.textContent ?? '').trim().slice(0, 40)}`)
        : [];
      return { id: tab?.id ?? null, rootClass: root?.className ?? null, items: root?.querySelectorAll('.setting-item').length ?? 0, outline };
  });
  ev.save('rendered-tab', rendered);
  console.log(`[e2e-settings] rendered ${JSON.stringify(rendered).slice(0, 4000)}`);
  ev.save('render-log', await consoleLines(/settings tab rendered|error|uncaught/i));
}

async function closeTab() {
  await withTimeout(
    browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).setting.close();
    }),
    10_000,
    'Closing settings',
  ).catch(() => undefined);
}

/** Every heading in the tab, with the names of the settings under it. */
async function sections(): Promise<Record<string, string[]>> {
  return withTimeout(
    browser.execute(() => {
      const out: Record<string, string[]> = {};
      let current = '(top)';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root: HTMLElement = (window as any).app?.setting?.activeTab?.containerEl ?? document.body;
      // Plain settings, Setting(...).setHeading() rows, and SettingGroup headings, in page order.
      const items = root.querySelectorAll('.setting-item, [class*="heading"]:not(.setting-item):not(.setting-item *)');
      items.forEach(item => {
        const isHeading = !item.classList.contains('setting-item') || item.classList.contains('setting-item-heading');
        const name = (isHeading && !item.classList.contains('setting-item')
          ? item.textContent
          : item.querySelector('.setting-item-name')?.textContent)?.trim() ?? '';
        if (isHeading) {
          if (!name) return;
          current = name;
          out[current] = out[current] ?? [];
        } else {
          (out[current] = out[current] ?? []).push(name);
        }
      });
      return out;
    }),
    15_000,
    'Reading the settings tab',
  );
}

async function scrollTo(heading: string) {
  await withTimeout(
    browser.execute((heading: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root: HTMLElement = (window as any).app?.setting?.activeTab?.containerEl ?? document.body;
      const h = [...root.querySelectorAll('.setting-item-heading .setting-item-name, [class*="heading"]:not(.setting-item):not(.setting-item *)')].find(el =>
        (el.textContent?.trim() ?? '').startsWith(heading),
      );
      h?.scrollIntoView({ block: 'start' });
    }, heading),
    10_000,
    `Scrolling to ${heading}`,
  );
  await browser.pause(300);
}

describe('Settings tab', () => {
  before(async () => {
    await useFakeServices();
  });

  check('SET-1', 'Open Settings > Voice Agent and list every heading; screenshot each of the six groups', async ev => {
    await openTab(ev);
    const s = await sections();
    ev.save('settings-sections', s);
    console.log(`[e2e-settings] sections ${JSON.stringify(s).slice(0, 4000)}`);
    await ev.shot('tab-top');
    const headings = Object.keys(s);
    for (const g of GROUPS) {
      expect(headings.some(h => h.startsWith(g))).toBe(true);
      await scrollTo(g);
      await ev.shot(`group-${g}`);
    }
    ev.note(`All six groups present: ${GROUPS.join(', ')}. ${headings.length} headings in all.`);
  });

  check('SET-2', 'Read the Orchestrator, Workers and Evaluator groups and the stored layer settings', async ev => {
    const s = await sections();
    const layers = await browser.executeObsidian(({ plugins }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      JSON.parse(JSON.stringify((plugins.voiceAgent as any).settings.orchestrator.layers)),
    );
    // Defaults as shipped: read them from a fresh copy of the defaults, since the suite points the
    // live layers at the fake model.
    const defaults = await browser.executeObsidian(({ plugins }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = plugins.voiceAgent as any;
      return JSON.parse(JSON.stringify(p.constructor?.DEFAULT_SETTINGS?.orchestrator?.layers ?? p.defaultSettings?.orchestrator?.layers ?? null));
    });
    ev.save('layer-settings', { ui: { Orchestrator: s.Orchestrator, Workers: s.Workers, Evaluator: s.Evaluator }, stored: layers, defaults });
    const groupOf = (sec: Record<string, string[]>, g: string) => sec[Object.keys(sec).find(h => h.startsWith(g)) ?? ''] ?? [];
    for (const g of ['Orchestrator', 'Workers']) {
      expect(groupOf(s, g)).toEqual(expect.arrayContaining(['Provider', 'Model', 'Reasoning effort']));
    }
    // The evaluator is off by default, and its group then shows only its switch. Turn it on, redraw
    // the tab, check its layer settings, then put it back.
    expect(groupOf(s, 'Evaluator')).toEqual(['Use an evaluator']);
    const wasOn = await browser.executeObsidian(({ plugins }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = plugins.voiceAgent as any;
      const before = !!p.settings.orchestrator.layers.evaluator.enabled;
      p.settings.orchestrator.layers.evaluator.enabled = true;
      return before;
    });
    await withTimeout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      browser.executeObsidian(({ app }) => (app as any).setting.activeTab.display()),
      15_000,
      'Redrawing the settings tab',
    );
    const on = await sections();
    await scrollTo('Evaluator');
    await ev.shot('evaluator-on');
    await browser.executeObsidian(({ app, plugins }, wasOn: boolean) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (plugins.voiceAgent as any).settings.orchestrator.layers.evaluator.enabled = wasOn;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).setting.activeTab.display();
    }, wasOn);
    ev.save('evaluator-group-when-on', groupOf(on, 'Evaluator'));
    expect(groupOf(on, 'Evaluator')).toEqual(expect.arrayContaining(['Provider', 'Model', 'Reasoning effort']));
    await scrollTo('Workers');
    await ev.shot('workers-layer');
    // Screenshots for SKL-1 and MCP-1, which check the behaviour itself in 03-tools.
    await scrollTo('Agent skills');
    await ev.shot('agent-skills-settings');
    await scrollTo('Remote MCP servers');
    await ev.shot('mcp-settings');
    ev.note('Orchestrator and Workers show Provider, Model and Reasoning effort; the Evaluator, off by default, shows only its switch until turned on, then the same three.');
  });

  after(async () => {
    await closeTab();
    await disarmFreezeProbe();
  });
});
