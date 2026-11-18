// Orchestrator → worker path in the voice call panel, end to end in real Obsidian (requested by
// the "Voice models and tools upgrade" thread, 2026-11-18, for commit 69da42b). Not part of the
// validation suite: the side-panel workflow builds the plugin at one commit and runs this file.
//
// Real: Obsidian, the plugin as built, its voice call panel, the layered orchestrator (Classic
// engine), its delegate_task and tell_user tools, the worker sub-agent and its read_file tool.
// Faked: the orchestrator and worker models are the fake OpenAI-compatible service, which replays
// a script carried in the relay text; the voice events are fed to the panel's handler (no audio,
// no voice provider). GPT-Live never sends final transcripts, so every fed line has final: false.
import fs from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { consoleLines, encodeScript, setSettings, traceMark, traceSince, useFakeServices } from '../support/harness.mts';

const LABEL = process.env.SHOT_LABEL ?? 'build';
const OUT = path.join(process.env.E2E_OUT ?? 'e2e/.out', 'side-panel', LABEL);
const VIEW = 'voice-call-side-view';
const WIDTH = 380;

function log(line: string) {
  fs.appendFileSync(path.join(OUT, 'notes.txt'), `${line}\n`);
  console.log(`[orchestrator] ${LABEL}: ${line}`);
}

async function setTheme(theme: 'light' | 'dark') {
  await browser.executeObsidian(({ app }, theme: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = app as any;
    const id = theme === 'dark' ? 'obsidian' : 'moonstone';
    if (typeof a.changeTheme === 'function') a.changeTheme(id);
    else a.vault.setConfig('theme', id);
  }, theme);
  await browser.pause(300);
}

async function markLeaf() {
  return browser.executeObsidian(
    ({ app }, view: string, width: number) => {
      const leaf = app.workspace.getLeavesOfType(view)[0];
      if (!leaf) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = app.workspace as any;
      const split = ws.rightSplit?.containerEl?.contains(leaf.view.containerEl) ? ws.rightSplit : ws.leftSplit;
      if (split?.collapsed) split.expand();
      split?.setSize?.(width);
      app.workspace.revealLeaf(leaf);
      leaf.view.containerEl.setAttribute('data-e2e-shot', view);
      return Math.round(leaf.view.containerEl.getBoundingClientRect().width);
    },
    VIEW,
    WIDTH,
  );
}

/** What the panel shows right now. */
async function panelState() {
  return browser.execute((view: string) => {
    const root = document.querySelector(`[data-e2e-shot="${view}"]`);
    const t = (s: string) => [...(root?.querySelectorAll(s) ?? [])].map(e => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
    const carets = [...(root?.querySelectorAll('.va-caret') ?? [])];
    const rows = [...(root?.querySelectorAll('.va-row') ?? [])];
    const caretRows = carets.map(c => rows.indexOf(c.closest('.va-row') as Element));
    return {
      strip: t('.va-orch')[0] ?? '(no orchestrator strip)',
      orchestratorRows: t('.va-by-orchestrator'),
      carets: carets.length,
      caretRows,
      rowCount: rows.length,
      lastRow: (rows[rows.length - 1]?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      agents: t('.va-task, .va-agent, [class*="task-card"]').slice(0, 5),
    };
  }, VIEW);
}

/** Both themes at this moment, then back to light. */
async function shootBoth(name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await browser.execute(() => document.querySelectorAll('.notice').forEach(n => n.remove()));
    const file = path.join(OUT, `${name}-${theme}.png`);
    await (await browser.$(`[data-e2e-shot="${VIEW}"]`)).saveScreenshot(file);
    log(`saved ${name}-${theme}.png`);
  }
  await setTheme('light');
}

async function orch() {
  return browser.executeObsidian(({ plugins }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (plugins.voiceAgent as any).orchestrator;
    return { state: String(o.state), lastError: String(o.lastError ?? ''), label: String(o.label ?? '') };
  });
}

async function tasks() {
  return browser.executeObsidian(({ plugins }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (plugins.voiceAgent as any).agents;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (a.list?.() ?? a.tasks ?? []) as any[];
    return list.map(t => ({ id: t.id, title: t.title, status: t.status, result: String(t.result ?? '').slice(0, 300), error: t.error ?? null, steps: (t.steps ?? []).length }));
  });
}

describe(`Orchestrator to worker in the call panel (${LABEL})`, () => {
  it('runs the layered path and records it', async function () {
    this.timeout(180_000);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'notes.txt'), '');
    try {
      await browser.setWindowSize(1440, 960);
    } catch {
      // keep the default size
    }
    const version = await browser.executeObsidian(async ({ app, plugins }) => {
      const make = async (p: string, text: string) => {
        if (!app.vault.getFileByPath(p)) await app.vault.create(p, text);
      };
      await make('Oxygen cascade.md', '# Oxygen cascade\n\nThe fall in oxygen partial pressure from inspired air to the mitochondria.\n');
      await make('Altitude and hypoxia.md', '# Altitude and hypoxia\n\nBarometric pressure falls with altitude, so inspired PO2 falls and the whole [[Oxygen cascade]] starts lower.\n');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return String((plugins.voiceAgent as any).manifest?.version);
    });
    log(`plugin ${version}`);

    await useFakeServices();
    await setSettings({ 'orchestrator.voiceRole': 'layered', 'orchestrator.engine': 'classic', 'orchestrator.progressUpdateSeconds': 0 });
    const consoleStart = (await consoleLines()).length;

    // The worker reads a note and finishes with a short answer; it runs for a few seconds so the
    // panel can be shot while it works.
    const worker = encodeScript({
      id: 'orch-worker',
      rounds: [[{ name: 'read_file', args: { path: 'Altitude and hypoxia.md' } }]],
      delays: [9000],
      finalDelayMs: 5000,
      final: 'Your altitude note says inspired PO2 falls with barometric pressure, so the whole [[Oxygen cascade]] starts lower.',
    });
    // The orchestrator delegates, then says it is on it (that step is held for a few seconds so
    // the "working" strip can be shot), then, on the worker's result, says the answer.
    const orchestrator = encodeScript({
      id: 'orch-orchestrator',
      rounds: [
        [{ name: 'delegate_task', args: { title: 'Summarise altitude notes', instructions: `Read the note "Altitude and hypoxia" and summarise it in one sentence, linking the notes it relies on. ${worker}` } }],
        [{ name: 'tell_user', args: { message: 'I have started summarising your altitude notes.', urgency: 'pause' } }],
        [{ name: 'tell_user', args: { message: 'Your altitude note says inspired oxygen falls with pressure, so the whole oxygen cascade starts lower.', urgency: 'pause' } }],
      ],
      delays: [0, 6000, 0],
      final: 'Done.',
    });
    const mark = traceMark();

    // 1. Open the panel and watch agents the way a started layered call does.
    await browser.executeObsidian(async ({ app, plugins }, view: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (plugins.voiceAgent as any).orchestrator.reset?.();
      for (const l of app.workspace.getLeavesOfType(view)) l.detach();
      const leaf = app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: view, active: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (leaf.view as any).watchAgents(true);
    }, VIEW);
    await browser.pause(800);
    log(`panel width ${await markLeaf()} px`);

    // 2. GPT-Live-style lines, never final.
    await browser.executeObsidian(({ app }, view: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = app.workspace.getLeavesOfType(view)[0].view as any;
      v.onVoiceEvent({ type: 'transcript', role: 'user', text: 'Summarise my altitude notes', final: false });
      v.onVoiceEvent({ type: 'transcript', role: 'assistant', text: 'On it', final: false });
    }, VIEW);
    await browser.pause(300);
    const afterFeed = await panelState();
    log(`after the two lines: ${afterFeed.carets} caret(s), on row(s) ${JSON.stringify(afterFeed.caretRows)} of ${afterFeed.rowCount}; strip: ${afterFeed.strip}`);

    // 3. The relay. The fake model's script rides on the request text.
    const ack = await browser.executeObsidian(({ plugins }, text: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return String((plugins.voiceAgent as any).orchestrator.relay(text, true));
    }, `Summarise my altitude notes ${orchestrator}`);
    log(`relay returned: ${ack}`);

    // While the worker runs: the orchestrator's "on it" step is held, so it is still working.
    let running = false;
    await browser.waitUntil(
      async () => {
        const list = await tasks();
        running = list.some(t => t.title === 'Summarise altitude notes' && ['running', 'queued'].includes(String(t.status)));
        return running;
      },
      { timeout: 20_000, interval: 200, timeoutMsg: 'No worker started within 20 s' },
    ).catch(e => log(`STOPPED waiting for the worker to start: ${String(e)}`));
    await browser.pause(600);
    const during = await panelState();
    log(`while the worker runs: orchestrator ${JSON.stringify(await orch())}; strip: ${during.strip}; orchestrator rows: ${JSON.stringify(during.orchestratorRows)}; carets ${during.carets}`);
    log(`tasks: ${JSON.stringify(await tasks())}`);
    await shootBoth('worker-running');

    // 4. Wait for the worker to finish and the orchestrator to say the answer.
    let done: Array<Record<string, unknown>> = [];
    await browser.waitUntil(
      async () => {
        done = await tasks();
        const t = done.find(x => x.title === 'Summarise altitude notes');
        const o = await orch();
        const said = (await panelState()).orchestratorRows.some(r => /oxygen cascade starts lower/i.test(r));
        return !!t && ['done', 'failed', 'cancelled'].includes(String(t.status)) && o.state !== 'thinking' && said;
      },
      { timeout: 60_000, interval: 500, timeoutMsg: 'The worker or the orchestrator did not finish within 60 s' },
    ).catch(e => log(`STOPPED waiting for the finish: ${String(e)}`));
    await browser.pause(800);
    const after = await panelState();
    log(`after it finishes: orchestrator ${JSON.stringify(await orch())}; strip: ${after.strip}`);
    log(`orchestrator rows: ${JSON.stringify(after.orchestratorRows)}`);
    log(`carets ${after.carets} on row(s) ${JSON.stringify(after.caretRows)} of ${after.rowCount}; last row: ${after.lastRow}`);
    log(`tasks: ${JSON.stringify(done)}`);
    await shootBoth('worker-done');

    // Fake-service traffic for this run.
    const traffic = traceSince(mark).filter(e => e.service === 'llm');
    for (const e of traffic) {
      const reply = e.reply as { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } | undefined;
      const calls = (reply?.tool_calls ?? []).map(c => `${c.function.name}(${c.function.arguments.slice(0, 120)})`).join(', ');
      const lastUser = [...(e.messages ?? [])].reverse().find(m => m.role === 'user' || m.role === 'tool');
      const lastText = typeof lastUser?.content === 'string' ? lastUser.content.replace(/<<FAKE:[^>]+>>/g, '<script>').replace(/\s+/g, ' ').slice(0, 220) : '';
      log(`fake model: script ${e.script ?? '-'} round ${e.round ?? '-'} ${e.kind}: ${calls || (reply?.content ?? '').slice(0, 160)} | last ${lastUser?.role}: ${lastText}`);
    }
    fs.writeFileSync(path.join(OUT, 'fake-traffic.json'), JSON.stringify(traffic, null, 2));

    const errors = (await consoleLines()).slice(consoleStart).filter(l => / (error|uncaught|unhandled-rejection) /.test(l));
    log(`console errors: ${errors.length ? '' : 'none'}`);
    for (const e of errors) log(`  ${e}`);
  });
});
