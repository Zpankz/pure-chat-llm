/* eslint-disable @typescript-eslint/no-explicit-any */
// Real-Obsidian check of the typed message box in the Voice Agent panel (commit 890596e,
// requested by the "Voice models and tools upgrade" thread on 2026-11-18). Not part of the
// validation suite: the side-panel workflow builds the plugin at one commit and runs this file.
//
// Real: Obsidian, the plugin as built, the panel and its message box, the + menu, the pickers, the
// Classic orchestrator, the write tools and their review card, Obsidian's Markdown renderer, pele
// and MathJax. Key presses in the box are real WebDriver key presses and clicks are real clicks.
//
// Faked or scripted (each is also written to notes.txt as it happens):
// - Every model is the fake model service. Typed messages carry no script text: the test sets a
//   "default script" on the fake service before each send (POST /__default-script), and the fake
//   answers the next unscripted request with it. Each request it answered that way is marked
//   default_script: true in the traffic.
// - Images: a pasted image is a ClipboardEvent built in the page with a File made on a canvas, and
//   "Photo…" gets a File from a stand-in for the file picker (HTMLInputElement.click is replaced
//   for file inputs while the menu item runs), because WebDriver can't drive the OS file dialog.
// - The review card's edits: the orchestrator has no write tools and a worker's writes go to
//   proposal notes, so the edit is a replace_in_note call made from a voice-role chat (a chat the
//   user is present in, which routes writes to the user), called directly by the test.
// - Mobile is Obsidian's own app.emulateMobile(true) on the desktop app, not a phone.
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
  console.log(`[composer] ${line}`);
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

const ANSWER = [
  'Here is the overview. The main note is [[Oxygen cascade]], and [[Altitude and hypoxia]] covers the low end.',
  '',
  '| Stage | PO2 (mmHg) |',
  '|---|---|',
  '| Inspired air | 150 |',
  '| Alveolar gas | 100 |',
  '| Mitochondria | 1 to 10 |',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Inspired air] --> B[Alveolar gas]',
  '  B --> C[Arterial blood]',
  '  C --> D[Mitochondria]',
  '```',
  '',
  '```pele',
  'sequenceDiagram',
  '  Lung->>Blood: O2 diffuses',
  '  Blood->>Tissue: O2 is delivered',
  '```',
  '',
  'Inline maths with dollars: $P_AO_2 = F_IO_2 (P_B - P_{H_2O}) - P_ACO_2 / R$, and with brackets: \\(S_aO_2 \\approx 0.98\\).',
  '',
  '$$C_aO_2 = 1.34 \\times Hb \\times S_aO_2 + 0.003 \\times P_aO_2$$',
  '',
  '\\[ DO_2 = Q \\times C_aO_2 \\]',
  '',
  '![[image.png]]',
  '',
  '![[some.pdf]]',
].join('\n');

describe(`Typed message box (${LABEL})`, () => {
  before(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'notes.txt'), '');
    const info = await browser.executeObsidian(
      async ({ app, plugins }, pdf: string) => {
        const make = async (p: string, text: string) => {
          if (!app.vault.getAbstractFileByPath(p)) await app.vault.create(p, text);
        };
        await make('Oxygen cascade.md', '# Oxygen cascade\n\nThe fall in oxygen partial pressure from inspired air to the mitochondria.\n');
        await make('Altitude and hypoxia.md', '# Altitude and hypoxia\n\nBarometric pressure falls with altitude, so inspired PO2 falls.\nThe whole [[Oxygen cascade]] starts lower.\n');
        await make('Review target.md', 'Line one\nLine two\nLine three\n');
        if (!app.vault.getAbstractFileByPath('Skills')) await app.vault.createFolder('Skills');
        if (!app.vault.getAbstractFileByPath('Skills/summarise-note')) await app.vault.createFolder('Skills/summarise-note');
        await make('Skills/summarise-note/SKILL.md', '---\nname: summarise-note\ndescription: Summarise a note in three lines\n---\n\nRead the note and write three lines.\n');
        // image.png: a canvas picture, so the vault has a real image to embed.
        const c = document.createElement('canvas');
        c.width = 240;
        c.height = 140;
        const g = c.getContext('2d')!;
        const grad = g.createLinearGradient(0, 0, 240, 140);
        grad.addColorStop(0, '#2b6cb0');
        grad.addColorStop(1, '#38a169');
        g.fillStyle = grad;
        g.fillRect(0, 0, 240, 140);
        g.fillStyle = '#fff';
        g.font = 'bold 22px sans-serif';
        g.fillText('image.png', 60, 78);
        const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
        if (!app.vault.getAbstractFileByPath('image.png')) await app.vault.createBinary('image.png', await blob.arrayBuffer());
        const bytes = Uint8Array.from(atob(pdf), ch => ch.charCodeAt(0));
        if (!app.vault.getAbstractFileByPath('some.pdf')) await app.vault.createBinary('some.pdf', bytes.buffer);
        const p = plugins.voiceAgent as any;
        await p.skills?.refresh?.();
        const file = app.vault.getFileByPath('Altitude and hypoxia.md')!;
        await app.workspace.getLeaf(false).openFile(file);
        return { version: String(p.manifest?.version), skills: (p.skills?.skills ?? []).map((s: any) => s.name) };
      },
      tinyPdf(),
    );
    log(`plugin ${info.version}; skills ${JSON.stringify(info.skills)}`);
    log('vault set up by the test: Oxygen cascade.md, Altitude and hypoxia.md, Review target.md, Skills/summarise-note/SKILL.md, image.png (a 240x140 canvas picture), some.pdf (a one-page PDF built by the test)');
    await useFakeServices();
    await setSettings({ 'orchestrator.voiceRole': 'layered', 'orchestrator.engine': 'classic', 'orchestrator.progressUpdateSeconds': 0 });
    await setDefaultScript(null);
    consoleStart = (await consoleLines()).length;
  });

  it('1: the box is below the conversation, no call, send disabled', async function () {
    this.timeout(60_000);
    const width = await openPanel();
    await browser.pause(600);
    const s = await box();
    const call = await browser.executeObsidian(({ plugins }) => {
      const p = plugins.voiceAgent as any;
      return { live: !!p.calls?.isLive, state: String(p.orchestrator?.state) };
    });
    log(`1: panel ${width} px; ${JSON.stringify({ ...s, call })}`);
    await shootBoth('1-panel-open');
    const below = !!s.rects.composer && !!s.rects.conversation && s.rects.composer.top >= s.rects.conversation.bottom - 1;
    const visible = !!s.rects.composer && !!s.rects.view && s.rects.composer.bottom <= s.rects.view.bottom + 1 && s.rects.composer.h > 0;
    verdict(
      '1',
      s.composer && below && visible && !call.live && s.sendDisabled === true && s.sendStop === false,
      `The box is drawn (${s.rects.composer?.h ?? 0} px high) with its top at ${s.rects.composer?.top} px, below the conversation's bottom at ${s.rects.conversation?.bottom} px, inside the panel. No call is live (orchestrator ${call.state}). With the box empty the send button is ${s.sendDisabled ? 'disabled' : 'ENABLED'} and labelled "${s.sendLabel}".`,
      { s, call },
    );
  });

  it('2: [[, @ and / suggestions', async function () {
    this.timeout(120_000);
    await resetBox();
    // [[
    await focusBox();
    await type('[[Oxy');
    await waitFor('the [[ suggestions', async () => (await box()).suggestShown, 5000);
    const link = await box();
    log(`2: after typing "[[Oxy": ${JSON.stringify({ suggestions: link.suggestions, rects: { suggest: link.rects.suggest, input: link.rects.input } })}`);
    await shootBoth('2-link-suggestions');
    await focusBox();
    await browser.keys([ENTER]);
    await browser.pause(400);
    const linked = await box();
    log(`2: after Enter: value ${JSON.stringify(linked.value)}, rows ${linked.rows.length}`);
    // @
    await resetBox();
    await focusBox();
    await type('@Alt');
    await waitFor('the @ suggestions', async () => (await box()).suggestShown, 5000);
    const mention = await box();
    log(`2: after typing "@Alt": ${JSON.stringify(mention.suggestions)}`);
    await shootBoth('2-mention-suggestions');
    await focusBox();
    await browser.keys([ENTER]);
    await waitFor('the note chip', async () => (await box()).chips.length > 0, 5000);
    const chipped = await box();
    log(`2: after Enter: value ${JSON.stringify(chipped.value)}, chips ${JSON.stringify(chipped.chips)}`);
    await shootBoth('2-mention-chip');
    // /
    await resetBox();
    await focusBox();
    await type('/');
    await waitFor('the / suggestions', async () => (await box()).suggestShown, 5000);
    const slash = await box();
    log(`2: after typing "/": ${JSON.stringify(slash.suggestions)}`);
    await shootBoth('2-slash-suggestions');
    await resetBox();

    const above = (b: Awaited<ReturnType<typeof box>>) => !!b.rects.suggest && !!b.rects.input && b.rects.suggest.bottom <= b.rects.input.top + 2;
    const linkOk = link.suggestShown && above(link) && link.suggestions.some(x => x.label === 'Oxygen cascade') && /\[\[Oxygen cascade\]\]/.test(linked.value ?? '');
    const mentionOk = mention.suggestShown && above(mention) && chipped.chips.some(c => /va-chip--note/.test(c.cls) && c.label === 'Altitude and hypoxia') && !/@/.test(chipped.value ?? '');
    const labels = slash.suggestions.map(x => x.label);
    const slashOk = slash.suggestShown && above(slash) && labels[0] === '/stop' && labels[1] === '/new' && labels[2] === '/clear' && labels.slice(3).includes('summarise-note');
    verdict(
      '2',
      linkOk && mentionOk && slashOk,
      `[[: "[[Oxy" showed ${link.suggestions.length} vault entries (${link.suggestions.map(x => x.label).join(', ')}) ${above(link) ? 'above' : 'NOT above'} the box; Enter left ${JSON.stringify(linked.value)}. @: "@Alt" showed ${mention.suggestions.map(x => x.label).join(', ')}; Enter attached ${chipped.chips.map(c => `${c.label} (${c.cls})`).join(', ') || 'NO chip'} and left the box ${JSON.stringify(chipped.value)}. /: the list read ${labels.join(', ')}.`,
      { link, linked: linked.value, mention, chipped: chipped.chips, slash },
    );
  });

  it('3: the + menu, chips and removing one', async function () {
    this.timeout(120_000);
    await resetBox();
    // A selection in the open note, then a real click on +, as a user would do.
    const before = await browser.executeObsidian(({ app }) => {
      const leaf = app.workspace.getLeavesOfType('markdown')[0];
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const editor = (leaf.view as any).editor;
      editor.setSelection({ line: 2, ch: 0 }, { line: 2, ch: 26 });
      return { selection: editor.getSelection(), active: (app.workspace as any).activeLeaf?.view?.getViewType?.() };
    });
    log(`3: selected ${JSON.stringify(before.selection)} in "Altitude and hypoxia.md"; active view ${before.active}`);
    const items = await openPlus();
    const activeAtMenu = await browser.executeObsidian(({ app }) => (app.workspace as any).activeLeaf?.view?.getViewType?.() ?? null);
    log(`3: + menu items ${JSON.stringify(items)}; active view when the menu opened: ${activeAtMenu}`);
    await browser.execute(() => {
      const menu = document.querySelector('.menu');
      menu?.setAttribute('data-e2e-shot', 'menu');
    });
    await shootBoth('3-plus-menu', '[data-e2e-shot="menu"]', ['light']);
    await (await browser.$(`${ROOT}`)).saveScreenshot(path.join(OUT, '3-plus-menu-panel-light.png')).catch(() => {});
    const picked = await menuItem('Current note');
    await waitFor('the current-note chip', async () => (await box()).chips.length > 0, 5000);
    // Skill… opens a picker: type part of the name, then Enter.
    await openPlus();
    const skillItem = await menuItem('Skill');
    const picker = await waitFor('the skill picker', async () => browser.execute(() => !!document.querySelector('.prompt .prompt-input')), 5000);
    if (picker) {
      await type('summ');
      await browser.keys([ENTER]);
    }
    await waitFor('the skill chip', async () => (await box()).chips.some(c => /va-chip--skill/.test(c.cls)), 5000);
    const both = await box();
    log(`3: chips ${JSON.stringify(both.chips)} (current note picked ${picked}, skill item ${skillItem}, picker ${picker})`);
    await shootBoth('3-chips');
    // Remove the note chip with its own x.
    await browser.execute((root: string) => {
      const chip = [...document.querySelectorAll(`${root} .va-chip`)].find(c => c.classList.contains('va-chip--note'));
      chip?.querySelector('.va-chip__remove')?.setAttribute('data-e2e-remove', 'note');
    }, ROOT);
    const x = await browser.$('[data-e2e-remove="note"]');
    if (await x.isExisting()) await x.click();
    await browser.pause(400);
    const after = await box();
    log(`3: after removing the note chip: ${JSON.stringify(after.chips)}`);
    await shootBoth('3-chip-removed', ROOT, ['light']);
    await resetBox();
    const want = ['Current note', 'Selected text', 'Note or file…', 'Skill…', 'Tool…', 'Photo…', 'Take a photo'];
    const missing = want.filter(w => !items.some(i => i.startsWith(w)));
    const chipsOk = both.chips.some(c => /va-chip--note/.test(c.cls)) && both.chips.some(c => /va-chip--skill/.test(c.cls) && c.label === 'summarise-note');
    const removedOk = after.chips.length === both.chips.length - 1 && !after.chips.some(c => /va-chip--note/.test(c.cls));
    verdict(
      '3',
      missing.length === 0 && chipsOk && removedOk,
      `The + menu listed ${items.map(i => `"${i}"`).join(', ')}${missing.length ? `; MISSING ${missing.join(', ')}` : ''}. Current note and the skill gave chips ${both.chips.map(c => `${c.label} (${c.cls.replace('va-chip ', '')})`).join(', ')}; removing the note chip left ${after.chips.map(c => c.label).join(', ') || 'none'}.`,
      { items, before, activeAtMenu, both: both.chips, after: after.chips },
    );
  });

  it('4: a pasted image is saved, embedded and sent', async function () {
    this.timeout(150_000);
    await resetBox();
    await focusBox();
    // A pasted image: a ClipboardEvent made in the page with a canvas PNG as its file.
    const paste = await browser.execute(async (root: string) => {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 120;
      const g = c.getContext('2d')!;
      g.fillStyle = '#c05621';
      g.fillRect(0, 0, 200, 120);
      g.fillStyle = '#fff';
      g.font = 'bold 18px sans-serif';
      g.fillText('pasted test image', 18, 66);
      const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
      const file = new File([blob], 'pasted test image.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector(`${root} .va-composer__input`)!;
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      return { files: ev.clipboardData?.files.length ?? 0, prevented: ev.defaultPrevented, size: blob.size };
    }, ROOT);
    log(`4: scripted input: pasted a ${paste.size}-byte PNG through a ClipboardEvent made in the page; ${JSON.stringify(paste)}`);
    let how = 'paste';
    if (!(await waitFor('the pasted image chip', async () => (await box()).chips.some(c => /va-chip--image/.test(c.cls)), 6000))) {
      how = 'drop';
      const drop = await browser.execute(async (root: string) => {
        const c = document.createElement('canvas');
        c.width = 200;
        c.height = 120;
        c.getContext('2d')!.fillRect(0, 0, 200, 120);
        const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'dropped test image.png', { type: 'image/png' }));
        const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        document.querySelector(`${root} .va-composer`)!.dispatchEvent(ev);
        return { prevented: ev.defaultPrevented };
      }, ROOT);
      log(`4: the paste gave no chip; scripted input: a DragEvent drop made in the page ${JSON.stringify(drop)}`);
      await waitFor('the dropped image chip', async () => (await box()).chips.some(c => /va-chip--image/.test(c.cls)), 6000);
    }
    const chip = await box();
    log(`4: chips after the ${how}: ${JSON.stringify(chip.chips)}`);
    await shootBoth('4-image-chip', ROOT, ['light']);

    // Photo…: the file picker is stood in for, so the menu item's own code path runs.
    await browser.execute(() => {
      const w = window as any;
      const original = HTMLInputElement.prototype.click;
      w.__e2eRestoreClick = () => (HTMLInputElement.prototype.click = original);
      HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        if (this.type !== 'file') return original.call(this);
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 100;
        const g = c.getContext('2d')!;
        g.fillStyle = '#6b46c1';
        g.fillRect(0, 0, 160, 100);
        c.toBlob(b => {
          const dt = new DataTransfer();
          dt.items.add(new File([b!], 'photo test image.png', { type: 'image/png' }));
          this.files = dt.files;
          this.dispatchEvent(new Event('change'));
          w.__e2ePicked = { accept: this.accept, multiple: this.multiple, capture: this.getAttribute('capture') };
        }, 'image/png');
      };
    });
    await openPlus();
    const photoItem = await menuItem('Photo');
    await waitFor('the Photo… chip', async () => (await box()).chips.filter(c => /va-chip--image/.test(c.cls)).length >= 2, 6000);
    const picked = await browser.execute(() => {
      const w = window as any;
      w.__e2eRestoreClick?.();
      return w.__e2ePicked ?? null;
    });
    const withPhoto = await box();
    log(`4: scripted input: Photo… (menu item ${photoItem}) got "photo test image.png" from a stand-in file picker ${JSON.stringify(picked)}; chips ${JSON.stringify(withPhoto.chips)}`);
    // Keep only the pasted image for the send.
    await browser.execute((root: string) => {
      const chips = [...document.querySelectorAll(`${root} .va-chip--image`)];
      (chips[chips.length - 1]?.querySelector('.va-chip__remove') as HTMLButtonElement | null)?.click();
    }, ROOT);
    await browser.pause(300);

    await setDefaultScript({ id: 'typed-image', final: 'FAKE ANSWER: the attached picture is the orange test image the harness pasted.' });
    const mark = traceMark();
    await focusBox();
    await type('What is in this picture?');
    await browser.keys([ENTER]);
    await waitFor('the answer to the image message', async () => /orange test image/.test(await lastAnswer()), 30_000);
    await browser.pause(1500);
    const sent = await browser.executeObsidian(({ app }, root: string) => {
      const files = app.vault.getFiles().filter(f => /^Voice Agent image \d+\.png$/.test(f.name)).map(f => ({ path: f.path, size: f.stat.size }));
      const rows = document.querySelectorAll(`${root} .va-row--user`);
      const last = rows[rows.length - 1];
      const embed = last?.querySelector('.internal-embed');
      const img = last?.querySelector('img') as HTMLImageElement | null;
      return {
        files,
        bubble: (last?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        embedSrc: embed?.getAttribute('src') ?? null,
        img: img ? { w: img.naturalWidth, h: img.naturalHeight, src: (img.getAttribute('src') ?? '').slice(0, 80) } : null,
      };
    }, ROOT);
    const reqs = llm(mark);
    const withImage = reqs.filter(e => (e.messages ?? []).some(m => Array.isArray(m.content) && (m.content as any[]).some(p => p?.type === 'image_url')));
    const record = withImage.slice(0, 1).map(e => ({
      api: e.api ?? 'chat completions',
      model: e.model,
      default_script: e.default_script,
      user_message: (e.messages ?? [])
        .filter(m => Array.isArray(m.content))
        .map(m => ({ role: m.role, parts: (m.content as any[]).map(p => (p.type === 'image_url' ? { type: p.type, image_url: { url: `${String(p.image_url?.url).slice(0, 40)}… (${String(p.image_url?.url).length} chars)` } } : { type: p.type, text: String(p.text).slice(0, 700) })) })),
    }));
    log(`4: saved ${JSON.stringify(sent)}; ${reqs.length} model request(s), ${withImage.length} with an image part; the request: ${JSON.stringify(record)}`);
    await browser.execute((root: string) => {
      const rows = document.querySelectorAll(`${root} .va-row--user`);
      rows[rows.length - 1]?.scrollIntoView({ block: 'start' });
    }, ROOT);
    await shootBoth('4-image-sent', ROOT, ['light']);
    const savedOk = sent.files.length === 1;
    const embedOk = !!sent.img && sent.img.w > 0 && !!sent.embedSrc && /Voice Agent image/.test(sent.embedSrc);
    const partOk = record.length > 0 && JSON.stringify(record).includes('data:image/png;base64');
    verdict(
      '4',
      chip.chips.some(c => /va-chip--image/.test(c.cls) && (c.img ?? 0) > 0) && savedOk && embedOk && partOk,
      `The ${how} gave an image chip with a ${chip.chips.find(c => /image/.test(c.cls))?.img ?? 0}-px-wide thumbnail${photoItem ? '; Photo… with a stand-in picker gave a second one' : ''}. On send the image was saved as ${sent.files.map(f => `"${f.path}" (${f.size} bytes)`).join(', ') || 'NOTHING'}; the user bubble embeds ${sent.embedSrc ?? 'nothing'} as a ${sent.img ? `${sent.img.w}x${sent.img.h} img` : 'MISSING img'}. ${withImage.length} of ${reqs.length} orchestrator request(s) carried an image_url part (Classic, Chat Completions), with a PNG data URL.`,
      { paste, how, chip: chip.chips, withPhoto: withPhoto.chips, picked, sent, record },
    );
  });

  it('5: an answer renders natively', async function () {
    this.timeout(150_000);
    await resetBox();
    await setDefaultScript({ id: 'typed-markdown', final: ANSWER });
    const mark = traceMark();
    await focusBox();
    await type('Give me the oxygen cascade overview');
    await browser.keys([ENTER]);
    await waitFor('the Markdown answer', async () => /Here is the overview/.test(await lastAnswer()), 30_000);
    await waitFor('diagrams and maths drawn', async () =>
      browser.execute((root: string) => {
        const rows = document.querySelectorAll(`${root} .va-row.va-by-orchestrator`);
        const b = rows[rows.length - 1];
        return (b?.querySelectorAll('.va-diagram svg').length ?? 0) >= 2 && (b?.querySelectorAll('mjx-container').length ?? 0) >= 4;
      }, ROOT),
      20_000,
    );
    await browser.pause(3000);
    const r = await browser.execute((root: string) => {
      const rows = document.querySelectorAll(`${root} .va-row.va-by-orchestrator`);
      const row = rows[rows.length - 1] as HTMLElement;
      row.setAttribute('data-e2e-shot', 'answer');
      const b = row.querySelector('.va-bubble') ?? row;
      const tags = (el: Element) => [...new Set([...el.querySelectorAll('*')].map(x => x.tagName.toLowerCase()))].slice(0, 25);
      return {
        tables: b.querySelectorAll('table').length,
        tableRows: b.querySelectorAll('table tr').length,
        diagrams: [...b.querySelectorAll('.va-diagram')].map(d => ({ svg: !!d.querySelector('svg'), w: Math.round(d.querySelector('svg')?.getBoundingClientRect().width ?? 0), h: Math.round(d.querySelector('svg')?.getBoundingClientRect().height ?? 0), text: (d.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) })),
        diagramErrors: [...b.querySelectorAll('.va-muted.va-small')].map(t => t.textContent),
        codeLeft: [...b.querySelectorAll('pre code')].map(c => `${c.className}: ${(c.textContent ?? '').slice(0, 60)}`),
        math: b.querySelectorAll('mjx-container').length,
        mathDisplay: b.querySelectorAll('mjx-container[display="true"]').length,
        mathBlocks: b.querySelectorAll('.math.math-block').length,
        mathInline: b.querySelectorAll('.math.math-inline').length,
        links: [...b.querySelectorAll('a.internal-link')].map(a => a.getAttribute('data-href')),
        embeds: [...b.querySelectorAll('.internal-embed')].map(e => ({
          src: e.getAttribute('src'),
          cls: e.className,
          img: (e.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? null,
          h: Math.round(e.getBoundingClientRect().height),
          tags: tags(e),
        })),
        rawLeft: (b as HTMLElement).innerText.match(/\$\$|\\\(|\\\[|```|!\[\[|\|---/g) ?? [],
        height: Math.round(row.getBoundingClientRect().height),
      };
    }, ROOT);
    const reqs = llm(mark);
    log(`5: ${reqs.length} model request(s) (${reqs.map(e => `${e.kind}${e.default_script ? ' default script' : ''}`).join(', ')}); rendered ${JSON.stringify(r)}`);
    await browser.execute(() => document.querySelector('[data-e2e-shot="answer"]')?.scrollIntoView({ block: 'start' }));
    await shootBoth('5-answer', '[data-e2e-shot="answer"]');
    await shootBoth('5-panel');
    // The answer is taller than the conversation's scroll area, so it is also shot in slices,
    // scrolling the conversation (the nearest scrolling box around the answer) a step at a time.
    const slices = await browser.execute(() => {
      const row = document.querySelector('[data-e2e-shot="answer"]') as HTMLElement | null;
      let box: HTMLElement | null = row?.parentElement ?? null;
      while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!row || !box) return { n: 0, view: 0, cls: '' };
      box.setAttribute('data-e2e-shot', 'scroller');
      const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      (window as any).__e2eSlice = { box, top, h: row.getBoundingClientRect().height, view: box.clientHeight };
      return { n: Math.ceil(row.getBoundingClientRect().height / Math.max(1, box.clientHeight - 30)), view: box.clientHeight, cls: box.className };
    });
    log(`5: the answer is shot in ${slices.n} slice(s) of the scroll area "${slices.cls}" (${slices.view} px high)`);
    for (let i = 0; i < Math.min(slices.n, 8); i++) {
      await browser.execute((i: number) => {
        const s = (window as any).__e2eSlice;
        s.box.scrollTop = s.top + i * (s.view - 30);
      }, i);
      await browser.pause(300);
      await shootBoth(`5-answer-slice-${i + 1}`, '[data-e2e-shot="scroller"]');
    }
    const img = r.embeds.find(e => e.src === 'image.png');
    const pdf = r.embeds.find(e => e.src === 'some.pdf');
    const pdfOk = !!pdf && /pdf/.test(pdf.cls + pdf.tags.join(' ')) && pdf.h > 40;
    const ok =
      r.tables === 1 &&
      r.diagrams.length === 2 &&
      r.diagrams.every(d => d.svg) &&
      r.codeLeft.length === 0 &&
      r.math >= 4 &&
      r.mathDisplay >= 2 &&
      r.links.includes('Oxygen cascade') &&
      !!img &&
      (img.img ?? 0) > 0 &&
      pdfOk &&
      r.rawLeft.length === 0;
    verdict(
      '5',
      ok,
      `Table: ${r.tables} (${r.tableRows} rows). Diagrams: ${r.diagrams.length} drawn by pele (${r.diagrams.map(d => (d.svg ? `SVG ${d.w}x${d.h}` : 'NO SVG')).join(', ')}), ${r.codeLeft.length} code block(s) left${r.diagramErrors.length ? `, errors ${JSON.stringify(r.diagramErrors)}` : ''}. Maths: ${r.math} MathJax elements, ${r.mathDisplay} of them display. Links: ${r.links.join(', ')}. Embeds: ${r.embeds.map(e => `${e.src} (${e.cls}; ${e.img ? `img ${e.img} px wide` : `tags ${e.tags.slice(0, 6).join(',')}`}; ${e.h} px high)`).join('; ')}. Raw Markdown left in the text: ${r.rawLeft.length ? JSON.stringify(r.rawLeft) : 'none'}.`,
      r,
    );
  });

  it('6: stop while the orchestrator works; /new and /clear', async function () {
    this.timeout(180_000);
    await resetBox();
    await setDefaultScript({ id: 'typed-slow', final: 'FAKE ANSWER: this one is late and should never show.', finalDelayMs: 25_000 });
    const mark = traceMark();
    await focusBox();
    await type('Take your time with this one');
    await browser.keys([ENTER]);
    const busy = await waitFor('the stop button', async () => (await box()).sendStop === true, 10_000);
    const during = await box();
    const stateDuring = await browser.executeObsidian(({ plugins }) => String((plugins.voiceAgent as any).orchestrator.state));
    log(`6: while working: orchestrator ${stateDuring}, send button stop=${during.sendStop} disabled=${during.sendDisabled} label "${during.sendLabel}"`);
    await toBottom();
    await shootBoth('6-busy-stop');
    await (await browser.$(`${ROOT} .va-composer__send`)).click();
    await waitFor('the stopped status line', async () => (await box()).rows.some(row => /va-row--status/.test(row.cls) && /Stopped the orchestrator/.test(row.text)), 8000);
    await browser.pause(800);
    const stopped = await box();
    const stateAfter = await browser.executeObsidian(({ plugins }) => String((plugins.voiceAgent as any).orchestrator.state));
    log(`6: after stop: orchestrator ${stateAfter}, send stop=${stopped.sendStop} disabled=${stopped.sendDisabled}; last rows ${JSON.stringify(stopped.rows.slice(-3))}`);
    // The earlier build showed a stop as a 90 s timeout: a red "failed" card and "taking longer".
    const stopProbe = await browser.executeObsidian(({ plugins }) => {
      const o = (plugins.voiceAgent as any).orchestrator;
      return { lastError: String(o.lastError ?? ''), state: String(o.state) };
    });
    const timeoutWords = stopped.rows.filter(r => /took longer than|taking longer than expected|failed/i.test(r.text));
    const redCards = await browser.execute((root: string) => [...document.querySelectorAll(`${root} .is-failed, ${root} .is-error, ${root} .va-card.is-failed`)].map(e => (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)), ROOT);
    log(`6: after stop: orchestrator lastError ${JSON.stringify(stopProbe.lastError)}; rows naming a timeout or failure ${JSON.stringify(timeoutWords)}; failed or error elements ${JSON.stringify(redCards)}`);
    await toBottom();
    await shootBoth('6-stopped');
    // Wait past the fake model's delay: the late answer must not appear.
    await browser.pause(27_000);
    const late = (await box()).rows.some(row => /should never show/.test(row.text));
    const reqs = traceSince(mark).filter(e => e.service === 'llm' || e.service === 'llm-aborted');
    log(`6: after 27 s the late answer ${late ? 'APPEARED' : 'did not appear'}; trace ${JSON.stringify(reqs.map(e => ({ service: e.service, kind: e.kind, delay: e.delay_ms ?? e.after_ms })))}`);
    await setDefaultScript(null);

    // /new: the suggestion is chosen with Enter, then Enter sends the command.
    const rowsBefore = (await box()).rows.length;
    await focusBox();
    await type('/new');
    await browser.keys([ENTER]);
    await browser.pause(300);
    const afterPick = (await box()).value;
    await browser.keys([ENTER]);
    await browser.pause(800);
    const afterNew = await box();
    log(`6: "/new": after choosing the suggestion the box read ${JSON.stringify(afterPick)}; then ${JSON.stringify(afterNew.rows.slice(-1))}, box ${JSON.stringify(afterNew.value)}`);
    const newOk = afterNew.rows.length === rowsBefore + 1 && /New topic/.test(afterNew.rows[afterNew.rows.length - 1]?.text ?? '');
    // /clear
    await focusBox();
    await type('/clear');
    await browser.keys([ENTER]);
    await browser.pause(300);
    await browser.keys([ENTER]);
    await browser.pause(800);
    const afterClear = await box();
    log(`6: "/clear": ${afterClear.rows.length} rows left, box ${JSON.stringify(afterClear.value)}`);
    await shootBoth('6-after-clear');
    verdict(
      '6',
      busy && during.sendStop === true && stopped.rows.some(r => /va-row--status/.test(r.cls) && /Stopped the orchestrator/.test(r.text)) && stateAfter !== 'thinking' && !late && newOk && afterClear.rows.length === 0 && timeoutWords.length === 0 && redCards.length === 0 && !stopProbe.lastError,
      `After the stop: ${timeoutWords.length ? `rows naming a timeout or failure: ${JSON.stringify(timeoutWords.map(r => r.text))}` : 'no row names a timeout or failure'}; ${redCards.length ? `failed/error elements: ${JSON.stringify(redCards)}` : 'no failed or error card'}; the orchestrator's last error is ${stopProbe.lastError ? JSON.stringify(stopProbe.lastError) : 'empty'}. While the fake model held its answer (25 s), the orchestrator was ${stateDuring} and the send button showed stop ("${during.sendLabel}"). Pressing it added "${stopped.rows.filter(r => /Stopped/.test(r.text)).map(r => r.text).join('')}" and left the orchestrator ${stateAfter}; the late answer ${late ? 'STILL APPEARED' : 'never appeared'}. /new added "${afterNew.rows[afterNew.rows.length - 1]?.text ?? ''}"; /clear left ${afterClear.rows.length} rows.`,
      { during, stateDuring, stopped: stopped.rows.slice(-3), stateAfter, late, timeoutWords, redCards, stopProbe, afterPick, afterNew: afterNew.rows.slice(-2), afterClear: afterClear.rows },
    );
  });

  it('7: an edit waits for approval in the panel', async function () {
    this.timeout(180_000);
    await resetBox();
    const start = (key: string, search: string, replace: string, reason: string) =>
      browser.executeObsidian(
        async ({ plugins }, key: string, search: string, replace: string, reason: string) => {
          const p = plugins.voiceAgent as any;
          const w = window as any;
          w.__e2eWrites ??= {};
          w.__e2eWrites[key] = 'pending';
          const Chat = p.classicOrchestrator.ensureChat().constructor;
          const chat = new Chat(p);
          chat.role = 'voice';
          chat.registerAvailableTools?.();
          chat.toolregistry
            .executeTool('replace_in_note', { path: 'Review target.md', search, replace, expected_matches: 1, reason })
            .then((r: unknown) => (w.__e2eWrites[key] = String(r)))
            .catch((e: unknown) => (w.__e2eWrites[key] = `threw: ${String(e)}`));
        },
        key,
        search,
        replace,
        reason,
      );
    const result = (key: string) => browser.execute((key: string) => String((window as any).__e2eWrites?.[key] ?? ''), key);
    const note = () => browser.executeObsidian(async ({ app }) => app.vault.read(app.vault.getFileByPath('Review target.md')!));
    const cards = () =>
      browser.execute((root: string) =>
        [...document.querySelectorAll(`${root} .va-review`)].map(c => ({
          cls: c.className,
          title: (c.querySelector('.va-review__title')?.textContent ?? '').trim(),
          state: (c.querySelector('.va-review__state')?.textContent ?? '').trim(),
          added: c.querySelector('.va-review__added')?.textContent ?? null,
          removed: c.querySelector('.va-review__removed')?.textContent ?? null,
          diff: [...c.querySelectorAll('.va-diff')].map(d => d.textContent),
          buttons: [...c.querySelectorAll('.va-review__actions button')].map(b => b.textContent),
          preview: !!c.querySelector('.va-review__preview'),
        })),
      ROOT);
    const click = async (index: number, text: string) => {
      await browser.execute(
        (root: string, index: number, text: string) => {
          const card = document.querySelectorAll(`${root} .va-review`)[index];
          const b = [...(card?.querySelectorAll('.va-review__actions button') ?? [])].find(x => x.textContent === text);
          b?.setAttribute('data-e2e-review', 'go');
          card?.scrollIntoView({ block: 'center' });
        },
        ROOT,
        index,
        text,
      );
      const b = await browser.$('[data-e2e-review="go"]');
      if (await b.isExisting()) {
        await b.click();
        await browser.execute(() => document.querySelector('[data-e2e-review="go"]')?.removeAttribute('data-e2e-review'));
        return true;
      }
      return false;
    };

    const original = await note();
    log('7: scripted input: replace_in_note called from a voice-role chat (writes route to the user), not chosen by a model');
    // 1. Approve.
    await start('a', 'Line two', 'Line two, approved in the panel', 'Test edit one');
    const shown = await waitFor('the first review card', async () => (await cards()).length >= 1, 10_000);
    const first = await cards();
    log(`7: first card ${JSON.stringify(first)}`);
    await browser.execute((root: string) => {
      const c = document.querySelector(`${root} .va-review`);
      c?.closest('.va-row')?.setAttribute('data-e2e-shot', 'review');
      c?.scrollIntoView({ block: 'center' });
    }, ROOT);
    await shootBoth('7-review-card', '[data-e2e-shot="review"]');
    await shootBoth('7-review-panel');
    await click(0, 'Approve');
    await waitFor('the approved write', async () => (await result('a')) !== 'pending', 10_000);
    const afterApprove = await note();
    const ra = await result('a');
    const approvedCards = await cards();
    log(`7: Approve → tool result ${JSON.stringify(ra.slice(0, 300))}; note ${JSON.stringify(afterApprove)}; card ${JSON.stringify(approvedCards[0]?.state)}`);
    // 2. Reject.
    await start('b', 'Line three', 'Line three, should be rejected', 'Test edit two');
    await waitFor('the second review card', async () => (await cards()).length >= 2, 10_000);
    await click(1, 'Reject');
    await waitFor('the rejected write', async () => (await result('b')) !== 'pending', 10_000);
    const afterReject = await note();
    const rb = await result('b');
    log(`7: Reject → tool result ${JSON.stringify(rb.slice(0, 300))}; note ${JSON.stringify(afterReject)}`);
    // 3. Open in window, then close it.
    await start('c', 'Line one', 'Line one, opened in a window', 'Test edit three');
    await waitFor('the third review card', async () => (await cards()).length >= 3, 10_000);
    await click(2, 'Open in window');
    const modalOpen = await waitFor('the review window', async () => browser.execute(() => !!document.querySelector('.modal-container .modal')), 6000);
    const modalInfo = await browser.execute(() => {
      const m = document.querySelector('.modal-container .modal');
      m?.setAttribute('data-e2e-shot', 'modal');
      return { title: (m?.querySelector('.modal-title')?.textContent ?? '').trim(), buttons: [...(m?.querySelectorAll('button') ?? [])].map(b => b.textContent) };
    });
    log(`7: Open in window → modal ${modalOpen} ${JSON.stringify(modalInfo)}`);
    await shootBoth('7-review-window', '[data-e2e-shot="modal"]');
    const closeBtn = await browser.$('.modal-container .modal .modal-close-button');
    if (await closeBtn.isExisting()) await closeBtn.click();
    else await browser.keys([ESCAPE]);
    await browser.pause(800);
    const modalGone = await browser.execute(() => !document.querySelector('.modal-container .modal'));
    const rc = await result('c');
    const afterClose = await cards();
    const noteAfterClose = await note();
    log(`7: window closed ${modalGone}; tool result still ${JSON.stringify(rc)}; third card ${JSON.stringify(afterClose[2])}; note ${JSON.stringify(noteAfterClose)}`);
    await shootBoth('7-after-window-closed');
    // Housekeeping: answer the waiting card.
    await click(2, 'Reject');
    await browser.pause(500);
    const c1 = first[0];
    verdict(
      '7',
      shown &&
        !!c1 &&
        c1.added === '+1' &&
        c1.removed === '−1' &&
        c1.buttons.join('|') === 'Approve|Reject|Open in window' &&
        afterApprove.includes('Line two, approved in the panel') &&
        afterReject === afterApprove &&
        modalOpen &&
        modalGone &&
        rc === 'pending' &&
        afterClose[2]?.state === 'Waiting for you' &&
        afterClose[2]?.buttons.length === 3 &&
        noteAfterClose === afterReject,
      `A card "${c1?.title}" appeared in the panel (${c1?.state}) with ${c1?.added}/${c1?.removed} and a ${c1?.diff.length}-line diff, preview ${c1?.preview ? 'present' : 'MISSING'}, buttons ${c1?.buttons.join(', ')}. Approve wrote the note (now "${afterApprove.replace(/\n/g, ' / ')}") and the card read ${approvedCards[0]?.state}. The second card, Rejected, left the note unchanged (${afterReject === afterApprove ? 'same text' : 'CHANGED'}). "Open in window" opened "${modalInfo.title}"; closing it left the third card "${afterClose[2]?.state}" with ${afterClose[2]?.buttons.length} buttons and the tool still waiting. The note before any of this: "${original.replace(/\n/g, ' / ')}".`,
      { first, ra, rb, rc, afterApprove, afterReject, modalInfo, afterClose, noteAfterClose },
    );
  });

  it('9: console during checks 1 to 7', async function () {
    this.timeout(30_000);
    const lines = (await consoleLines()).slice(consoleStart);
    const errors = lines.filter(l => / (error|uncaught|unhandled-rejection) /.test(l));
    const warnings = lines.filter(l => / warn /.test(l));
    const panel = errors.filter(l => /voice-agent|va-|Composer|composer|VoiceCallSideView|pele|review/i.test(l));
    log(`9: ${lines.length} console lines since the panel opened; ${errors.length} error line(s), ${panel.length} that name the plugin or panel; ${warnings.length} warning(s)`);
    for (const e of errors.slice(0, 30)) log(`  error: ${e}`);
    for (const w of warnings.slice(0, 15)) log(`  warn: ${w.slice(0, 300)}`);
    verdict('9', errors.length === 0, `${errors.length} console error line(s) between opening the panel and the end of check 7 (${panel.length} naming the plugin or panel). Mobile (check 8) is reported there.`, { errors, warnings: warnings.slice(0, 30) });
  });

  it('10: a background task proposal shows as a card in the open panel', async function () {
    this.timeout(300_000);
    await resetBox();
    await openPanel();
    await browser.executeObsidian(async ({ app }) => {
      for (const [name, text] of [['Proposal target A.md', 'Alpha one\nAlpha two\n'], ['Proposal target B.md', 'Beta one\nBeta two\n'], ['Proposal target C.md', 'Gamma one\nGamma two\n']]) {
        const f = app.vault.getFileByPath(name);
        if (f) await app.vault.modify(f, text);
        else await app.vault.create(name, text);
      }
    });
    const note = (p: string) => browser.executeObsidian(async ({ app }, p: string) => app.vault.read(app.vault.getFileByPath(p)!), p);
    const proposals = (target: string) =>
      browser.executeObsidian(async ({ app }, target: string) => {
        const out: Array<{ path: string; status: string }> = [];
        for (const f of app.vault.getMarkdownFiles()) {
          const t = await app.vault.cachedRead(f);
          if (/voice-agent-proposal/.test(t) && t.includes(target)) out.push({ path: f.path, status: /^status: (\w+)$/m.exec(t)?.[1] ?? '' });
        }
        return out;
      }, target);
    const cards = () =>
      browser.execute((root: string) =>
        [...document.querySelectorAll(`${root} .va-review`)].map(c => ({
          cls: c.className,
          title: (c.querySelector('.va-review__title')?.textContent ?? '').trim(),
          state: (c.querySelector('.va-review__state')?.textContent ?? '').trim(),
          buttons: [...c.querySelectorAll('.va-review__actions button')].map(b => b.textContent),
        })),
      ROOT);
    const click = async (title: RegExp, text: string) => {
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
    };
    const runEdit = async (target: string, search: string, replace: string) => {
      log(`10: scripted input: a worker whose fake model calls replace_in_note on ${target} (${JSON.stringify(search)} → ${JSON.stringify(replace)}), then answers "Done."`);
      const { task } = await runWorker(`Edit ${target}`, `Change ${search} in ${target}.`, {
        rounds: [[{ name: 'replace_in_note', args: { path: target, search, replace, expected_matches: 1, reason: `Test edit of ${target}` } }]],
        final: 'Done.',
      });
      log(`10: worker for ${target} ended ${String(task.status)}`);
      return task;
    };
    // A: approve in the panel.
    await runEdit('Proposal target A.md', 'Alpha two', 'Alpha two, approved from a task');
    const cardA = await waitFor('a card for the first proposal', async () => (await cards()).some(c => /Proposal target A/.test(c.title)), 15_000);
    const cardsA = await cards();
    log(`10: cards after the first task ${JSON.stringify(cardsA)}; proposals ${JSON.stringify(await proposals('Proposal target A.md'))}`);
    await browser.execute((root: string) => {
      const c = [...document.querySelectorAll(`${root} .va-review`)].find(x => /Proposal target A/.test(x.textContent ?? ''));
      c?.closest('.va-row')?.setAttribute('data-e2e-shot', 'proposal');
      c?.scrollIntoView({ block: 'center' });
    }, ROOT);
    await shootBoth('10-proposal-card', '[data-e2e-shot="proposal"]');
    await shootBoth('10-proposal-panel');
    await click(/Proposal target A/, 'Approve');
    await waitFor('the first proposal applied', async () => (await proposals('Proposal target A.md')).some(p => p.status !== 'pending'), 10_000);
    const noteA = await note('Proposal target A.md');
    const propA = await proposals('Proposal target A.md');
    log(`10: Approve → note ${JSON.stringify(noteA)}; proposal ${JSON.stringify(propA)}`);
    // B: reject in the panel.
    await runEdit('Proposal target B.md', 'Beta two', 'Beta two, should be rejected');
    const cardB = await waitFor('a card for the second proposal', async () => (await cards()).some(c => /Proposal target B/.test(c.title)), 15_000);
    await click(/Proposal target B/, 'Reject');
    await waitFor('the second proposal answered', async () => (await proposals('Proposal target B.md')).some(p => p.status !== 'pending'), 10_000);
    const noteB = await note('Proposal target B.md');
    const propB = await proposals('Proposal target B.md');
    log(`10: Reject → note ${JSON.stringify(noteB)}; proposal ${JSON.stringify(propB)}`);
    await toBottom();
    await shootBoth('10-after-answers');
    // C: with the panel closed, the proposal waits.
    await browser.executeObsidian(({ app }, view: string) => {
      for (const l of app.workspace.getLeavesOfType(view)) l.detach();
    }, VIEW);
    await browser.pause(800);
    const hostClosed = await browser.executeObsidian(({ plugins }) => !(plugins.voiceAgent as any).reviewHost);
    await runEdit('Proposal target C.md', 'Gamma two', 'Gamma two, panel closed');
    await browser.pause(3000);
    const noteC = await note('Proposal target C.md');
    const propC = await proposals('Proposal target C.md');
    const modal = await browser.execute(() => (document.querySelector('.modal-container .modal .modal-title')?.textContent ?? '').trim());
    log(`10: panel closed (review host ${hostClosed ? 'gone' : 'STILL SET'}) → note ${JSON.stringify(noteC)}; proposal ${JSON.stringify(propC)}; a window opened: ${JSON.stringify(modal)}`);
    await openPanel();
    await browser.pause(800);
    const cardsReopened = await cards();
    log(`10: after reopening the panel: cards ${JSON.stringify(cardsReopened.map(c => c.title))}`);
    verdict(
      '10',
      cardA && cardB && noteA.includes('Alpha two, approved from a task') && propA.some(p => p.status === 'applied') && !noteB.includes('rejected') && propB.some(p => p.status === 'rejected') && !noteC.includes('panel closed') && propC.some(p => p.status === 'pending') && !modal,
      `With the panel open, the first task's proposal ${cardA ? 'appeared as a card' : 'did NOT appear as a card'} ("${cardsA.find(c => /Proposal target A/.test(c.title))?.title ?? ''}", buttons ${JSON.stringify(cardsA.find(c => /Proposal target A/.test(c.title))?.buttons ?? [])}); Approve ${noteA.includes('approved from a task') ? 'wrote the note' : 'did NOT write the note'} and the proposal reads status ${JSON.stringify(propA.map(p => p.status))}. The second ${cardB ? 'appeared' : 'did NOT appear'}; Reject left the note ${noteB.includes('rejected') ? 'CHANGED' : 'unchanged'} and the proposal reads ${JSON.stringify(propB.map(p => p.status))}. With the panel closed, the third left the note ${noteC.includes('panel closed') ? 'CHANGED' : 'unchanged'}, its proposal reads ${JSON.stringify(propC.map(p => p.status))}, and ${modal ? `a window "${modal}" opened` : 'no window opened'}.`,
      { cardsA, noteA, propA, noteB, propB, noteC, propC, hostClosed, modal, cardsReopened: cardsReopened.map(c => c.title) },
    );
  });

  it('8: mobile emulation', async function () {
    this.timeout(240_000);
    // Obsidian's own mobile emulation. It is read at startup, so the app is reloaded if the call
    // does not reload it by itself.
    await browser.execute(() => {
      (window as any).__e2eBeforeMobile = 1;
      try {
        (window as any).app.emulateMobile(true);
      } catch (e) {
        (window as any).__e2eEmulateError = String(e);
      }
    }).catch(e => log(`8: emulateMobile call ended with ${String(e).slice(0, 200)}`));
    await browser.pause(6000);
    const reloaded = await browser.execute(() => !(window as any).__e2eBeforeMobile).catch(() => false);
    if (!reloaded) {
      log('8: emulateMobile(true) did not reload the app; reloading it so the plugin starts in mobile mode');
      await browser.execute(() => location.reload()).catch(() => {});
      await browser.pause(4000);
    }
    const ready = await waitFor(
      'Obsidian ready in mobile mode',
      async () =>
        browser.execute(() => {
          const a = (window as any).app;
          return !!a?.workspace?.layoutReady && !!a?.plugins?.plugins?.['voice-agent'] && document.body.classList.contains('is-mobile');
        }),
      90_000,
    );
    await browser.setWindowSize(430, 900).catch(e => log(`8: could not resize the window: ${String(e).slice(0, 200)}`));
    await browser.pause(1500);
    await installConsoleCapture();
    const env = await browser.execute(() => ({ isMobile: !!(window as any).app?.isMobile, bodyMobile: document.body.classList.contains('is-mobile'), phone: document.body.classList.contains('is-phone'), w: innerWidth, h: innerHeight }));
    log(`8: ready ${ready}; ${JSON.stringify(env)}`);
    await openPanel();
    await browser.pause(1500);
    await markLeaf();
    await browser.pause(800);
    const reach = await browser.execute((root: string) => {
      const hit = (sel: string) => {
        const el = document.querySelector(`${root} ${sel}`) as HTMLElement | null;
        if (!el) return { found: false };
        const b = el.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        const top = document.elementFromPoint(x, y);
        return { found: true, w: Math.round(b.width), h: Math.round(b.height), x: Math.round(x), y: Math.round(y), inViewport: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth, onTop: !!top && (top === el || el.contains(top)) };
      };
      return { send: hit('.va-composer__send'), plus: hit('.va-composer__plus'), input: hit('.va-composer__input') };
    }, ROOT);
    log(`8: reachability ${JSON.stringify(reach)}`);
    const probe = () =>
      browser.execute((root: string) => {
        const send = document.querySelector(`${root} .va-composer__send`) as HTMLElement | null;
        const svg = send?.querySelector('svg') as SVGElement | null;
        const sb = svg?.getBoundingClientRect();
        const cs = svg ? getComputedStyle(svg) : null;
        const input = document.querySelector(`${root} .va-composer__input`) as HTMLTextAreaElement | null;
        const ib = input?.getBoundingClientRect();
        return {
          sendIcon: svg ? { w: Math.round(sb!.width), h: Math.round(sb!.height), display: cs!.display, visibility: cs!.visibility, color: cs!.color, stroke: cs!.stroke, fill: cs!.fill, opacity: cs!.opacity, paths: svg.querySelectorAll('path, line, polyline, polygon, circle').length } : null,
          sendBg: send ? getComputedStyle(send).backgroundColor : null,
          sendDisabled: (send as HTMLButtonElement | null)?.disabled ?? null,
          placeholder: input?.placeholder ?? null,
          input: input ? { w: Math.round(ib!.width), h: Math.round(ib!.height), clientHeight: input.clientHeight, scrollHeight: input.scrollHeight, lineHeight: getComputedStyle(input).lineHeight, whiteSpace: getComputedStyle(input).whiteSpace } : null,
        };
      }, ROOT);
    const emptyProbe = await probe();
    log(`8: empty box: send icon ${JSON.stringify(emptyProbe.sendIcon)}, send background ${emptyProbe.sendBg}, disabled ${emptyProbe.sendDisabled}; placeholder ${JSON.stringify(emptyProbe.placeholder)}; input ${JSON.stringify(emptyProbe.input)}`);
    await shootBoth('8-mobile-panel');
    await browser.execute((root: string) => document.querySelector(`${root} .va-composer`)?.setAttribute('data-e2e-composer', '1'), ROOT);
    await shootBoth('8-mobile-composer-empty', `${ROOT} [data-e2e-composer="1"]`);
    await browser.saveScreenshot(path.join(OUT, '8-mobile-window-light.png')).catch(() => {});
    const rowsBefore = (await box()).rows.length;
    const mark = traceMark();
    await setDefaultScript({ id: 'mobile-should-not-send', final: 'FAKE ANSWER: Enter sent the message on mobile.' });
    await focusBox();
    await type('line one');
    await browser.keys([ENTER]);
    await type('line two');
    await browser.pause(1500);
    const after = await box();
    const sent = llm(mark).length;
    await setDefaultScript(null);
    log(`8: typed "line one", Enter, "line two": box ${JSON.stringify(after.value)}; rows ${rowsBefore} → ${after.rows.length}; model requests ${sent}`);
    const typedProbe = await probe();
    log(`8: typed box: send icon ${JSON.stringify(typedProbe.sendIcon)}, send background ${typedProbe.sendBg}, disabled ${typedProbe.sendDisabled}`);
    await shootBoth('8-mobile-newline', ROOT, ['light']);
    await shootBoth('8-mobile-composer-typed', `${ROOT} [data-e2e-composer="1"]`);
    const iconShown = (p: typeof emptyProbe) => !!p.sendIcon && p.sendIcon.w > 0 && p.sendIcon.h > 0 && p.sendIcon.display !== 'none' && p.sendIcon.visibility !== 'hidden' && Number(p.sendIcon.opacity) > 0;
    const placeholderFits = !!emptyProbe.input && emptyProbe.input.scrollHeight <= emptyProbe.input.clientHeight + 1;
    log(`8: send icon drawn: empty ${iconShown(emptyProbe)}, typed ${iconShown(typedProbe)}; placeholder fits without clipping: ${placeholderFits}`);
    results['8-visual'] = { verdict: iconShown(emptyProbe) && iconShown(typedProbe) && placeholderFits ? 'PASS' : 'FAIL', summary: `Send icon drawn in the empty box: ${iconShown(emptyProbe)}; with text: ${iconShown(typedProbe)}. Placeholder ${JSON.stringify(emptyProbe.placeholder)} ${placeholderFits ? 'fits' : 'is CLIPPED'} (scrollHeight ${emptyProbe.input?.scrollHeight}, clientHeight ${emptyProbe.input?.clientHeight}).`, detail: { emptyProbe, typedProbe } };
    log(`CHECK 8-visual ${(results['8-visual'] as any).verdict}: ${(results['8-visual'] as any).summary}`);
    const errors = (await consoleLines()).filter(l => / (error|uncaught|unhandled-rejection) /.test(l));
    log(`8: console errors after the mobile reload: ${errors.length}${errors.length ? ` ${JSON.stringify(errors.slice(0, 10))}` : ''}`);
    verdict(
      '8',
      ready && env.bodyMobile && reach.send.found && !!(reach.send as any).onTop && !!(reach.send as any).inViewport && reach.plus.found && !!(reach.plus as any).onTop && !!(reach.plus as any).inViewport && after.value === 'line one\nline two' && after.rows.length === rowsBefore && sent === 0,
      `Under app.emulateMobile(true) (window ${env.w}x${env.h}, body is-mobile ${env.bodyMobile}), send is ${(reach.send as any).inViewport ? 'in view' : 'NOT in view'} and ${(reach.send as any).onTop ? 'on top' : 'COVERED'} (${(reach.send as any).w}x${(reach.send as any).h} px), + is ${(reach.plus as any).inViewport ? 'in view' : 'NOT in view'} and ${(reach.plus as any).onTop ? 'on top' : 'COVERED'}. Enter put a line break in the box (${JSON.stringify(after.value)}) and sent nothing (${sent} model requests, ${after.rows.length - rowsBefore} new rows). Console errors after the reload: ${errors.length}.`,
      { env, reach, value: after.value, sent, errors },
    );
  });

  after(async () => {
    await setDefaultScript(null).catch(() => {});
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT, 'fake-traffic.json'), JSON.stringify(traceSince(0).filter(e => e.service === 'llm' || e.service === 'control' || e.service === 'llm-aborted'), null, 2));
  });
});
