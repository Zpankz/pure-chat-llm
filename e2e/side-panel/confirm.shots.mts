/* eslint-disable @typescript-eslint/no-explicit-any */
// Real-Obsidian confirm round for 7759570 (2.0.0-beta.8), requested by the "Voice models and tools
// upgrade" thread on 2026-11-18: R1 background edits ask by default (and old settings move once),
// R2 pending proposals come back as cards, R3 a narrow panel links PDFs. Not part of the
// validation suite: the side-panel workflow builds the plugin at one commit and runs this file.
//
// Real: Obsidian, the plugin as built (disabled and enabled again for R1's settings move), the
// panel, its cards and buttons, the workers, the proposal notes, Obsidian's Markdown renderer and
// PDF viewer. Clicks are real WebDriver clicks.
//
// Faked or scripted (each is also written to notes.txt as it happens):
// - Every model is the fake model service. Workers run a scripted replace_in_note round, and a
//   typed message is answered with a "default script" set on the fake service before the send.
// - R1's old settings are written by the test into voice-agent/data.json while the plugin is off.
import fs from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { consoleLines, FAKE_URL, installConsoleCapture, runWorker, setSettings, traceMark, traceSince, useFakeServices, type TraceEntry } from '../support/harness.mts';

const LABEL = process.env.SHOT_LABEL ?? 'build';
const OUT = path.join(process.env.E2E_OUT ?? 'e2e/.out', 'side-panel', LABEL);
const VIEW = 'voice-agent-call';
const WIDTH = 380;
const ROOT = `[data-e2e-shot="${VIEW}"]`;
const ENTER = '';
const ESCAPE = '';
const results: Record<string, unknown> = {};
let consoleStart = 0;

function log(line: string) {
  fs.appendFileSync(path.join(OUT, 'notes.txt'), `${line}\n`);
  console.log(`[confirm] ${line}`);
}

function verdict(id: string, pass: boolean | 'unverified', summary: string, detail: unknown = {}) {
  const word = pass === 'unverified' ? 'UNVERIFIED' : pass ? 'PASS' : 'FAIL';
  results[id] = { verdict: word, summary, detail };
  log(`CHECK ${id} ${word}: ${summary}`);
}

/** A one-page PDF, built here so the vault has a real PDF to embed. */
function tinyPdf(): string {
  const stream = 'BT /F1 20 Tf 24 80 Td (some.pdf test page) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}

async function setDefaultScript(script: Record<string, unknown> | null) {
  const res = await fetch(`${FAKE_URL}/__default-script`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script }),
  });
  log(`scripted input: default script on the fake model ${script ? `set to ${JSON.stringify(script).slice(0, 2000)}` : 'cleared'} (${res.status})`);
}

async function setTheme(theme: 'light' | 'dark') {
  await browser.executeObsidian(({ app }, theme: string) => {
    const a = app as any;
    const id = theme === 'dark' ? 'obsidian' : 'moonstone';
    if (typeof a.changeTheme === 'function') a.changeTheme(id);
    else a.vault.setConfig('theme', id);
  }, theme);
  await browser.pause(300);
}

async function openPanel() {
  await browser.executeObsidian(async ({ app }, view: string) => {
    for (const l of app.workspace.getLeavesOfType(view)) l.detach();
    const leaf = app.workspace.getRightLeaf(false)!;
    await leaf.setViewState({ type: view, active: true });
  }, VIEW);
  await browser.pause(800);
  return markLeaf();
}

async function markLeaf() {
  return browser.executeObsidian(
    ({ app }, view: string, width: number) => {
      const leaf = app.workspace.getLeavesOfType(view)[0];
      if (!leaf) return null;
      const ws = app.workspace as any;
      const split = ws.rightSplit?.containerEl?.contains(leaf.view.containerEl) ? ws.rightSplit : ws.leftSplit;
      if (split?.collapsed) split.expand?.();
      split?.setSize?.(width);
      app.workspace.revealLeaf(leaf);
      leaf.view.containerEl.setAttribute('data-e2e-shot', view);
      return Math.round(leaf.view.containerEl.getBoundingClientRect().width);
    },
    VIEW,
    WIDTH,
  );
}

/** Saves a picture of an element in light and dark. */
async function shootBoth(name: string, selector = ROOT, themes: Array<'light' | 'dark'> = ['light', 'dark']) {
  for (const theme of themes) {
    await setTheme(theme);
    await browser.execute(() => document.querySelectorAll('.notice').forEach(n => n.remove()));
    try {
      await (await browser.$(selector)).saveScreenshot(path.join(OUT, `${name}-${theme}.png`));
      log(`saved ${name}-${theme}.png`);
    } catch (e) {
      log(`could not save ${name}-${theme}.png: ${String(e).slice(0, 300)}`);
    }
  }
  await setTheme('light');
}

async function waitFor(what: string, fn: () => Promise<boolean>, timeout = 20_000): Promise<boolean> {
  let lastError = '';
  try {
    await browser.waitUntil(
      async () => {
        try {
          return await fn();
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          return false;
        }
      },
      { timeout, interval: 300, timeoutMsg: what },
    );
    return true;
  } catch {
    log(`  stopped waiting: ${what} (${timeout / 1000} s)${lastError ? `; the last read threw: ${lastError.slice(0, 300)}` : ''}`);
    return false;
  }
}

/** Everything the box shows right now. */
async function box() {
  return browser.execute((root: string) => {
    const r = document.querySelector(root);
    const rect = (el: Element | null | undefined) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const input = r?.querySelector('.va-composer__input') as HTMLTextAreaElement | null;
    const send = r?.querySelector('.va-composer__send') as HTMLButtonElement | null;
    const suggest = r?.querySelector('.va-suggest') as HTMLElement | null;
    const shown = !!suggest && getComputedStyle(suggest).display !== 'none' && suggest.getBoundingClientRect().height > 0;
    return {
      composer: !!r?.querySelector('.va-composer'),
      value: input?.value ?? null,
      focused: document.activeElement === input,
      sendDisabled: send?.disabled ?? null,
      sendStop: send?.classList.contains('is-stop') ?? null,
      sendLabel: send?.getAttribute('aria-label') ?? null,
      chips: [...(r?.querySelectorAll('.va-chip') ?? [])].map(c => ({
        cls: c.className,
        label: c.querySelector('.va-chip__label')?.textContent ?? '',
        img: (c.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? null,
      })),
      suggestShown: shown,
      suggestions: shown ? [...suggest!.querySelectorAll('.va-suggest__item')].map(i => ({ label: i.querySelector('.va-suggest__label')?.textContent ?? '', detail: i.querySelector('.va-suggest__detail')?.textContent ?? '', selected: i.classList.contains('is-selected') })) : [],
      rects: { suggest: shown ? rect(suggest) : null, input: rect(input), composer: rect(r?.querySelector('.va-composer')), conversation: rect(r?.querySelector('.va-conversation')), send: rect(send), plus: rect(r?.querySelector('.va-composer__plus')), view: rect(r) },
      rows: [...(r?.querySelectorAll('.va-conversation .va-row') ?? [])].map(row => ({ cls: row.className, text: (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) })),
    };
  }, ROOT);
}

/** Scrolls the conversation to its end, so a picture shows the newest rows. */
async function toBottom() {
  await browser.execute((root: string) => {
    const rows = document.querySelectorAll(`${root} .va-conversation .va-row`);
    rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
  }, ROOT);
  await browser.pause(200);
}

async function focusBox() {
  await (await browser.$(`${ROOT} .va-composer__input`)).click();
  await browser.pause(150);
}

async function type(text: string) {
  await browser.keys(text.split(''));
  await browser.pause(400);
}

/** Empties the box and removes every chip (test housekeeping between checks). */
async function resetBox() {
  await browser.execute((root: string) => {
    const r = document.querySelector(root);
    const input = r?.querySelector('.va-composer__input') as HTMLTextAreaElement | null;
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (let i = 0; i < 20; i++) {
      const x = r?.querySelector('.va-chip__remove') as HTMLButtonElement | null;
      if (!x) break;
      x.click();
    }
  }, ROOT);
  await browser.keys([ESCAPE]);
  await browser.pause(200);
}

/** Clicks a + menu item whose title starts with the text. */
async function menuItem(start: string): Promise<boolean> {
  const marked = await browser.execute((start: string) => {
    const item = [...document.querySelectorAll('.menu .menu-item')].find(i => (i.querySelector('.menu-item-title')?.textContent ?? '').startsWith(start));
    if (!item) return false;
    item.setAttribute('data-e2e-menu', 'pick');
    return true;
  }, start);
  if (!marked) return false;
  await (await browser.$('[data-e2e-menu="pick"]')).click();
  await browser.pause(400);
  return true;
}

async function openPlus() {
  await (await browser.$(`${ROOT} .va-composer__plus`)).click();
  await waitFor('the + menu', async () => (await browser.execute(() => document.querySelectorAll('.menu .menu-item').length)) > 0, 5000);
  return browser.execute(() => [...document.querySelectorAll('.menu .menu-item')].map(i => i.querySelector('.menu-item-title')?.textContent ?? ''));
}

function llm(mark: number): TraceEntry[] {
  return traceSince(mark).filter(e => e.service === 'llm');
}

async function lastAnswer() {
  return browser.execute((root: string) => {
    const rows = document.querySelectorAll(`${root} .va-row.va-by-orchestrator`);
    const last = rows[rows.length - 1];
    return last ? (last.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
  }, ROOT);
}


const PDF_ANSWER = ['Here is the PDF you asked for.', '', '![[some.pdf]]'].join('\n');

/** Every proposal note about a target, with its status. */
async function proposals(target: string) {
  return browser.executeObsidian(async ({ app }, target: string) => {
    const out: Array<{ path: string; status: string }> = [];
    for (const f of app.vault.getMarkdownFiles()) {
      const t = await app.vault.cachedRead(f);
      if (/voice-agent-proposal/.test(t) && t.includes(target)) out.push({ path: f.path, status: /^status: (\w+)$/m.exec(t)?.[1] ?? '' });
    }
    return out;
  }, target);
}

async function note(p: string): Promise<string> {
  return browser.executeObsidian(async ({ app }, p: string) => app.vault.read(app.vault.getFileByPath(p)!), p);
}

async function cards() {
  return browser.execute((root: string) =>
    [...document.querySelectorAll(`${root} .va-review`)].map(c => ({
      cls: c.className,
      title: (c.querySelector('.va-review__title')?.textContent ?? '').trim(),
      state: (c.querySelector('.va-review__state')?.textContent ?? '').trim(),
      buttons: [...c.querySelectorAll('.va-review__actions button')].map(b => b.textContent),
    })),
  ROOT);
}

async function clickCard(title: RegExp, text: string): Promise<boolean> {
  const ok = await browser.execute(
    (root: string, title: string, text: string) => {
      const card = [...document.querySelectorAll(`${root} .va-review`)].reverse().find(c => new RegExp(title).test(c.querySelector('.va-review__title')?.textContent ?? ''));
      const b = [...(card?.querySelectorAll('.va-review__actions button') ?? [])].find(x => x.textContent === text);
      b?.setAttribute('data-e2e-review', 'go');
      card?.scrollIntoView({ block: 'center' });
      return !!b;
    },
    ROOT,
    title.source,
    text,
  );
  if (!ok) return false;
  await (await browser.$('[data-e2e-review="go"]')).click();
  await browser.execute(() => document.querySelector('[data-e2e-review="go"]')?.removeAttribute('data-e2e-review'));
  return true;
}

async function closePanel() {
  await browser.executeObsidian(({ app }, view: string) => {
    for (const l of app.workspace.getLeavesOfType(view)) l.detach();
  }, VIEW);
  await browser.pause(800);
}

async function modalTitle(): Promise<string> {
  return browser.execute(() => {
    const m = document.querySelector('.modal-container .modal');
    return m ? ((m.querySelector('.modal-title, h2, h1')?.textContent ?? m.textContent ?? '').trim().slice(0, 120) || 'a window with no title') : '';
  });
}

async function workerEdit(target: string, search: string, replace: string) {
  log(`scripted input: a worker whose fake model calls replace_in_note on ${target} (${JSON.stringify(search)} → ${JSON.stringify(replace)}), then answers "Done."`);
  const { task } = await runWorker(`Edit ${target}`, `Change ${search} in ${target}.`, {
    rounds: [[{ name: 'replace_in_note', args: { path: target, search, replace, expected_matches: 1, reason: `Test edit of ${target}` } }]],
    final: 'Done.',
  });
  log(`worker for ${target} ended ${String(task.status)}`);
  return task;
}

/** What the last orchestrator answer shows for the PDF: the link, the viewer, and the panel width. */
async function pdfState() {
  return browser.execute((root: string) => {
    const r = document.querySelector(root);
    const rows = r?.querySelectorAll('.va-row.va-by-orchestrator') ?? [];
    const row = rows[rows.length - 1] as HTMLElement | undefined;
    row?.setAttribute('data-e2e-shot', 'pdf-answer');
    const link = row?.querySelector('.va-pdf-link') as HTMLElement | null;
    const embed = row?.querySelector('.internal-embed[src$=".pdf"]') as HTMLElement | null;
    const shown = (el: HTMLElement | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { display: getComputedStyle(el).display, w: Math.round(b.width), h: Math.round(b.height), visible: getComputedStyle(el).display !== 'none' && b.width > 0 && b.height > 0 };
    };
    return {
      panelWidth: Math.round((r as HTMLElement | null)?.getBoundingClientRect().width ?? 0),
      bubbleWidth: Math.round((row?.querySelector('.va-bubble') as HTMLElement | null)?.getBoundingClientRect().width ?? 0),
      text: (row?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      link: link ? { ...shown(link), text: (link.textContent ?? '').trim(), href: link.getAttribute('data-href'), icon: !!link.querySelector('.va-pdf-link__icon svg'), cls: link.className } : null,
      embed: embed ? { ...shown(embed), cls: embed.className, viewer: !!embed.querySelector('canvas, .pdf-container, .pdf-viewer, .pdfViewer') } : null,
    };
  }, ROOT);
}

const NARROW = 300;
const WIDE = 700;

/** Sets the right sidebar (holding the panel) to a width; returns the panel's width. */
async function sizePanel(width: number): Promise<number> {
  return browser.executeObsidian(
    ({ app }, view: string, width: number) => {
      const ws = app.workspace as any;
      if (width > 480 && !ws.leftSplit?.collapsed) ws.leftSplit?.collapse?.();
      if (width <= 480 && ws.leftSplit?.collapsed) ws.leftSplit?.expand?.();
      if (ws.rightSplit?.collapsed) ws.rightSplit.expand?.();
      ws.rightSplit?.setSize?.(width);
      const leaf = app.workspace.getLeavesOfType(view)[0];
      if (!leaf) return 0;
      app.workspace.revealLeaf(leaf);
      leaf.view.containerEl.setAttribute('data-e2e-shot', view);
      return Math.round(leaf.view.containerEl.getBoundingClientRect().width);
    },
    VIEW,
    width,
  );
}

describe(`Confirm round (${LABEL})`, () => {
  before(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'notes.txt'), '');
    const info = await browser.executeObsidian(
      async ({ app, plugins }, pdf: string) => {
        const make = async (p: string, text: string) => {
          if (!app.vault.getAbstractFileByPath(p)) await app.vault.create(p, text);
        };
        await make('Proposal target D.md', 'Delta one\nDelta two\n');
        await make('Proposal target E.md', 'Echo one\nEcho two\n');
        const bytes = Uint8Array.from(atob(pdf), ch => ch.charCodeAt(0));
        if (!app.vault.getAbstractFileByPath('some.pdf')) await app.vault.createBinary('some.pdf', bytes.buffer);
        const p = plugins.voiceAgent as any;
        return { version: String(p.manifest?.version), writes: JSON.stringify(p.settings.orchestrator.writes), askDefault: p.settings.orchestrator.writesAskDefault ?? null };
      },
      tinyPdf(),
    );
    log(`plugin ${info.version}; fresh install (only the old plugin's settings file was in the vault): orchestrator.writes ${info.writes}, writesAskDefault ${info.askDefault}`);
    results.fresh = info;
    log('vault set up by the test: Proposal target D.md, Proposal target E.md, some.pdf (a one-page PDF built by the test)');
    await useFakeServices();
    await setSettings({ 'orchestrator.voiceRole': 'layered', 'orchestrator.engine': 'classic', 'orchestrator.progressUpdateSeconds': 0 });
    await setDefaultScript(null);
    consoleStart = (await consoleLines()).length;
  });

  it('R1 and R2: a worker edit asks by default; the card comes back once after the panel reopens', async function () {
    this.timeout(300_000);
    await openPanel();
    const writes = await browser.executeObsidian(({ plugins }) => JSON.stringify((plugins.voiceAgent as any).settings.orchestrator.writes));
    log(`R1: settings untouched by the test: orchestrator.writes ${writes}`);
    await workerEdit('Proposal target D.md', 'Delta two', 'Delta two, approved after reopening');
    const shown = await waitFor('a card for the proposal', async () => (await cards()).some(c => /Proposal target D/.test(c.title)), 15_000);
    const cards1 = (await cards()).filter(c => /Proposal target D/.test(c.title));
    const prop1 = await proposals('Proposal target D.md');
    const note1 = await note('Proposal target D.md');
    log(`R1: cards ${JSON.stringify(cards1)}; proposals ${JSON.stringify(prop1)}; note ${JSON.stringify(note1)}`);
    await browser.execute((root: string) => {
      const c = [...document.querySelectorAll(`${root} .va-review`)].find(x => /Proposal target D/.test(x.textContent ?? ''));
      c?.closest('.va-row')?.setAttribute('data-e2e-shot', 'proposal');
      c?.scrollIntoView({ block: 'center' });
    }, ROOT);
    await shootBoth('r1-default-card', '[data-e2e-shot="proposal"]');
    verdict(
      'R1-default',
      /"edit":"review"/.test(writes) && /"delete":"review"/.test(writes) && shown && cards1.length === 1 && prop1.some(p => p.status === 'pending') && !note1.includes('approved after'),
      `With the settings as a fresh install has them (orchestrator.writes ${writes}), the worker's edit made a proposal (${JSON.stringify(prop1.map(p => p.status))}) ${shown ? 'and a card' : 'but NO card'} ("${cards1[0]?.title ?? ''}", ${cards1[0]?.state ?? ''}, buttons ${JSON.stringify(cards1[0]?.buttons ?? [])}); the note is ${note1.includes('approved after') ? 'CHANGED' : 'unchanged'}.`,
      { writes, cards1, prop1, note1 },
    );

    // R2: close with the card pending, reopen, approve from the restored card.
    await closePanel();
    await browser.pause(2000);
    const modal = await modalTitle();
    const prop2 = await proposals('Proposal target D.md');
    const note2 = await note('Proposal target D.md');
    log(`R2: panel closed with the card pending → proposal ${JSON.stringify(prop2)}; note ${JSON.stringify(note2)}; window: ${JSON.stringify(modal)}`);
    await openPanel();
    const back = await waitFor('the card to come back', async () => (await cards()).some(c => /Proposal target D/.test(c.title)), 15_000);
    await browser.pause(3000);
    const cards3 = (await cards()).filter(c => /Proposal target D/.test(c.title));
    log(`R2: after reopening (and 3 s more): ${cards3.length} card(s) ${JSON.stringify(cards3)}`);
    await browser.execute((root: string) => {
      const c = [...document.querySelectorAll(`${root} .va-review`)].find(x => /Proposal target D/.test(x.textContent ?? ''));
      c?.closest('.va-row')?.setAttribute('data-e2e-shot', 'proposal-back');
      c?.scrollIntoView({ block: 'center' });
    }, ROOT);
    await shootBoth('r2-card-back', '[data-e2e-shot="proposal-back"]');
    await shootBoth('r2-panel-reopened');
    // Close and reopen once more: still one card.
    await closePanel();
    await openPanel();
    await waitFor('the card again', async () => (await cards()).some(c => /Proposal target D/.test(c.title)), 15_000);
    await browser.pause(2000);
    const cards4 = (await cards()).filter(c => /Proposal target D/.test(c.title));
    log(`R2: after a second close and reopen: ${cards4.length} card(s)`);
    await clickCard(/Proposal target D/, 'Approve');
    await waitFor('the proposal applied', async () => (await proposals('Proposal target D.md')).some(p => p.status !== 'pending'), 10_000);
    const prop5 = await proposals('Proposal target D.md');
    const note5 = await note('Proposal target D.md');
    const cards5 = (await cards()).filter(c => /Proposal target D/.test(c.title));
    log(`R2: Approve → note ${JSON.stringify(note5)}; proposal ${JSON.stringify(prop5)}; card ${JSON.stringify(cards5)}`);
    await shootBoth('r2-after-approve', '[data-e2e-shot="proposal-back"]');
    verdict(
      'R2',
      !modal && prop2.every(p => p.status === 'pending') && !note2.includes('approved after') && back && cards3.length === 1 && cards4.length === 1 && note5.includes('Delta two, approved after reopening') && prop5.some(p => p.status === 'applied'),
      `Closing the panel with the card pending ${modal ? `opened a window "${modal}"` : 'opened no window'}, and the proposal stayed ${JSON.stringify(prop2.map(p => p.status))} with the note ${note2.includes('approved after') ? 'CHANGED' : 'unchanged'}. On reopening, the card ${back ? 'came back' : 'did NOT come back'}: ${cards3.length} card(s) for it, and ${cards4.length} after a second close and reopen. Approve on the restored card ${note5.includes('approved after') ? 'wrote the note' : 'did NOT write the note'} and the proposal reads ${JSON.stringify(prop5.map(p => p.status))}.`,
      { modal, prop2, cards3, cards4, prop5, note5, cards5 },
    );
  });

  it('R3: a narrow panel links the PDF; a wide one shows the viewer', async function () {
    this.timeout(240_000);
    await openPanel();
    log(`R3: right sidebar set to ${NARROW} px: panel ${await sizePanel(NARROW)} px wide`);
    await setDefaultScript({ id: 'pdf-answer', final: PDF_ANSWER });
    await focusBox();
    await type('Show me the PDF');
    await browser.keys([ENTER]);
    await waitFor('the PDF answer', async () => /Here is the PDF/.test(await lastAnswer()), 30_000);
    await setDefaultScript(null);
    await browser.pause(2500);
    const narrow = await pdfState();
    log(`R3: narrow panel ${JSON.stringify(narrow)}`);
    await browser.execute(() => document.querySelector('[data-e2e-shot="pdf-answer"]')?.scrollIntoView({ block: 'center' }));
    await shootBoth('r3-narrow-answer', '[data-e2e-shot="pdf-answer"]');
    await shootBoth('r3-narrow-panel');
    // Click the link: the PDF should open.
    const marked = await browser.execute((root: string) => {
      const rows = document.querySelectorAll(`${root} .va-row.va-by-orchestrator`);
      const link = rows[rows.length - 1]?.querySelector('.va-pdf-link');
      link?.setAttribute('data-e2e-click', 'pdf');
      return !!link;
    }, ROOT);
    let clickHow = 'no link to click';
    if (marked) {
      try {
        await (await browser.$('[data-e2e-click="pdf"]')).click();
        clickHow = 'a real click';
      } catch (e) {
        clickHow = `the real click failed: ${String(e).slice(0, 200)}`;
      }
    }
    await browser.pause(2500);
    const opened = await browser.executeObsidian(({ app }) => {
      const leaves = app.workspace.getLeavesOfType('pdf');
      const active = app.workspace.getActiveFile();
      return { pdfLeaves: leaves.map(l => (l.view as any).file?.path ?? ''), active: active?.path ?? null };
    });
    log(`R3: clicked the "some.pdf" link (${clickHow}) → PDF views open ${JSON.stringify(opened.pdfLeaves)}; active file ${opened.active}`);
    await browser.saveScreenshot(path.join(OUT, 'r3-pdf-opened-light.png')).catch(e => log(`could not save r3-pdf-opened-light.png: ${String(e).slice(0, 200)}`));
    // Wide: the same panel in the right sidebar, widened to 700 px (the left sidebar is collapsed to
    // make room in the 1024 px window).
    await openPanel();
    log(`R3: right sidebar set to ${WIDE} px: panel ${await sizePanel(WIDE)} px wide`);
    await browser.pause(1500);
    const hasAnswer = /Here is the PDF/.test(await lastAnswer());
    if (!hasAnswer) {
      log('R3: the wide panel did not show the earlier answer, so the same scripted answer is sent again there');
      await setDefaultScript({ id: 'pdf-answer-wide', final: PDF_ANSWER });
      await focusBox();
      await type('Show me the PDF');
      await browser.keys([ENTER]);
      await waitFor('the PDF answer in the wide panel', async () => /Here is the PDF/.test(await lastAnswer()), 30_000);
      await setDefaultScript(null);
    }
    await waitFor('the PDF viewer drawn', async () => !!(await pdfState()).embed?.viewer, 15_000);
    await browser.pause(1500);
    const wide = await pdfState();
    log(`R3: wide panel ${JSON.stringify(wide)}`);
    await browser.execute(() => document.querySelector('[data-e2e-shot="pdf-answer"]')?.scrollIntoView({ block: 'center' }));
    await shootBoth('r3-wide-answer', '[data-e2e-shot="pdf-answer"]');
    await closePanel();
    verdict(
      'R3',
      !!narrow.link?.visible && !!narrow.link.icon && /some\.pdf/.test(narrow.link.text) && !narrow.embed?.visible && opened.pdfLeaves.includes('some.pdf') && !!wide.embed?.visible && !!wide.embed.viewer && !wide.link?.visible,
      `Narrow (panel ${narrow.panelWidth} px): the link ${narrow.link ? `"${narrow.link.text}" is ${narrow.link.visible ? 'shown' : 'HIDDEN'}${narrow.link.icon ? ' with an icon' : ' WITHOUT an icon'}` : 'is MISSING'}, and the viewer is ${narrow.embed ? (narrow.embed.visible ? 'ALSO SHOWN' : 'hidden') : 'missing'}. Clicking the link (${clickHow}) ${opened.pdfLeaves.includes('some.pdf') ? 'opened some.pdf in a PDF view' : `did NOT open the PDF (PDF views ${JSON.stringify(opened.pdfLeaves)})`}. Wide (panel ${wide.panelWidth} px, the right sidebar widened): the viewer is ${wide.embed ? (wide.embed.visible ? `shown (${wide.embed.w}x${wide.embed.h} px${wide.embed.viewer ? ', with its page' : ', with NO page'})` : 'HIDDEN') : 'MISSING'}, and the link is ${wide.link ? (wide.link.visible ? 'ALSO SHOWN' : 'hidden') : 'missing'}.`,
      { narrow, opened, wide, clickHow },
    );
  });

  it('R1: old settings with "peer" edits and deletions move to "review" once', async function () {
    this.timeout(180_000);
    const before = await browser.executeObsidian(async ({ app }) => {
      const a = app as any;
      const file = `${app.vault.configDir}/plugins/voice-agent/data.json`;
      await a.plugins.disablePlugin('voice-agent');
      const raw = JSON.parse(await app.vault.adapter.read(file));
      raw.orchestrator ??= {};
      raw.orchestrator.writes = { create: 'allow', edit: 'peer', delete: 'peer' };
      delete raw.orchestrator.writesAskDefault;
      await app.vault.adapter.write(file, JSON.stringify(raw, null, 2));
      const written = JSON.parse(await app.vault.adapter.read(file)).orchestrator;
      await a.plugins.enablePlugin('voice-agent');
      return { writes: written.writes, writesAskDefault: written.writesAskDefault ?? null };
    });
    log(`R1-move: scripted input: with the plugin off, the test wrote orchestrator.writes ${JSON.stringify(before.writes)} and no writesAskDefault into voice-agent/data.json, then turned the plugin on`);
    await waitFor('the plugin loaded again', async () => browser.execute(() => !!(window as any).app?.plugins?.plugins?.['voice-agent']?.settings), 30_000);
    await browser.pause(2500);
    const after = await browser.executeObsidian(async ({ app }) => {
      const p = (app as any).plugins.plugins['voice-agent'];
      const file = `${app.vault.configDir}/plugins/voice-agent/data.json`;
      const onDisk = JSON.parse(await app.vault.adapter.read(file)).orchestrator;
      return {
        loaded: { writes: p.settings.orchestrator.writes, writesAskDefault: p.settings.orchestrator.writesAskDefault ?? null },
        onDisk: { writes: onDisk.writes, writesAskDefault: onDisk.writesAskDefault ?? null },
      };
    });
    log(`R1-move: after loading, settings ${JSON.stringify(after.loaded)}; data.json ${JSON.stringify(after.onDisk)}`);
    verdict(
      'R1-move',
      after.loaded.writes.edit === 'review' && after.loaded.writes.delete === 'review' && after.loaded.writes.create === 'allow' && after.onDisk.writes.edit === 'review' && after.onDisk.writes.delete === 'review' && after.onDisk.writesAskDefault === true,
      `Old settings {edit: "peer", delete: "peer"} with no writesAskDefault loaded as ${JSON.stringify(after.loaded.writes)}; data.json now holds ${JSON.stringify(after.onDisk.writes)} and writesAskDefault ${after.onDisk.writesAskDefault}.`,
      { before, after },
    );
  });

  it('console', async function () {
    this.timeout(30_000);
    const lines = (await consoleLines()).slice(consoleStart);
    const errors = lines.filter(l => / (error|uncaught|unhandled-rejection) /.test(l));
    for (const e of errors.slice(0, 30)) log(`  error: ${e}`);
    verdict('console', errors.length === 0, `${lines.length} console lines during the run, ${errors.length} errors.`, { errors });
  });

  after(async () => {
    await setDefaultScript(null).catch(() => {});
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT, 'fake-traffic.json'), JSON.stringify(traceSince(0).filter(e => e.service === 'llm' || e.service === 'control' || e.service === 'llm-aborted'), null, 2));
  });
});
