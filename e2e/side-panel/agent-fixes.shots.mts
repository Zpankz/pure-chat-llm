// Real-Obsidian check of the agent fixes in commit e82f368 (requested by the "Voice models and
// tools upgrade" thread, 2026-11-18; brief in validation/agent-fixes-e82f368.md). Not part of the
// validation suite: the side-panel workflow builds the plugin at one commit and runs this file.
//
// Real: Obsidian, the plugin as built, the call panel, the layered orchestrator (Classic), the
// worker sub-agents, their tools and the call notes. Faked: every model is the fake service
// (Chat Completions and Responses), which replays a script carried in the request text; voice
// events are fed to the panel's handler (no audio, no voice provider). The "OpenAI" endpoint is
// pointed at the fake service on 127.0.0.2, which the plugin treats as a remote endpoint that
// needs a key (it skips the key check only for localhost and 127.0.0.1).
import fs from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { consoleLines, encodeScript, FAKE_URL, installConsoleCapture, setSettings, traceMark, traceSince, useFakeServices, type TraceEntry } from '../support/harness.mts';

const LABEL = process.env.SHOT_LABEL ?? 'build';
const OUT = path.join(process.env.E2E_OUT ?? 'e2e/.out', 'side-panel', LABEL);
const VIEW = 'voice-agent-call';
const WIDTH = 380;
const ALT_URL = FAKE_URL.replace('127.0.0.1', '127.0.0.2');
const EMPTY_KEY = 'sk-XXXXXXXXX';
const results: Record<string, unknown> = {};
const allTraffic: TraceEntry[] = [];

function log(line: string) {
  fs.appendFileSync(path.join(OUT, 'notes.txt'), `${line}\n`);
  console.log(`[agent-fixes] ${line}`);
}

function verdict(id: string, pass: boolean | 'unverified', summary: string, detail: unknown = {}) {
  results[id] = { verdict: pass === 'unverified' ? 'UNVERIFIED' : pass ? 'PASS' : 'FAIL', summary, detail };
  log(`CHECK ${id} ${pass === 'unverified' ? 'UNVERIFIED' : pass ? 'PASS' : 'FAIL'}: ${summary}`);
}

/** A brief long enough that the task's started event (cut at 400-600 characters) never carries the script. */
function brief(text: string, script: string) {
  return `${text} ${'This brief is padded so the summary of it never carries the test script. '.repeat(10)}${script}`;
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

async function shootBoth(name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await browser.execute(() => document.querySelectorAll('.notice').forEach(n => n.remove()));
    await (await browser.$(`[data-e2e-shot="${VIEW}"]`)).saveScreenshot(path.join(OUT, `${name}-${theme}.png`));
    log(`saved ${name}-${theme}.png`);
  }
  await setTheme('light');
}

/** Starts listening to what the orchestrator gives the voice. */
async function listen() {
  await browser.executeObsidian(({ plugins }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__e2eOffSay?.();
    w.__e2eSaid = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w.__e2eOffSay = (plugins.voiceAgent as any).orchestrator.onSay((text: string, urgency: string) => w.__e2eSaid.push({ text, urgency }));
  });
}

async function said(): Promise<Array<{ text: string; urgency: string }>> {
  return browser.execute(() => ((window as unknown as { __e2eSaid?: Array<{ text: string; urgency: string }> }).__e2eSaid ?? []));
}

async function relay(text: string) {
  return browser.executeObsidian(({ plugins }, text: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (plugins.voiceAgent as any).orchestrator;
    o.reset?.();
    return String(o.relay(text, true));
  }, text);
}

async function task(title: string) {
  return browser.executeObsidian(({ plugins }, title: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = ((plugins.voiceAgent as any).agents.list() as any[]).filter(x => x.title === title).pop();
    return t ? { id: t.id, status: String(t.status), result: String(t.result ?? ''), error: t.error ? String(t.error) : null } : null;
  }, title);
}

async function waitFor(what: string, fn: () => Promise<boolean>, timeout = 60_000): Promise<boolean> {
  try {
    await browser.waitUntil(fn, { timeout, interval: 400, timeoutMsg: what });
    return true;
  } catch {
    log(`  stopped waiting: ${what} (${timeout / 1000} s)`);
    return false;
  }
}

async function orchState() {
  return browser.executeObsidian(({ plugins }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (plugins.voiceAgent as any).orchestrator;
    return { state: String(o.state), lastError: String(o.lastError ?? ''), label: String(o.label ?? '') };
  });
}

function traffic(mark: number): TraceEntry[] {
  const t = traceSince(mark).filter(e => e.service === 'llm');
  allTraffic.push(...t);
  return t;
}

function summarise(t: TraceEntry[]) {
  return t.map(e => ({ script: e.script, round: e.round, kind: e.kind, api: e.api ?? 'chat', host: e.host ?? '127.0.0.1 (chat)', model: e.model, at: String(e.at ?? '').slice(11, 23) }));
}

describe(`Agent fixes (${LABEL})`, () => {
  before(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'notes.txt'), '');
    const info = await browser.executeObsidian(async ({ app, plugins }) => {
      const make = async (p: string, text: string) => {
        if (!app.vault.getFileByPath(p)) await app.vault.create(p, text);
      };
      await make('Oxygen cascade.md', '# Oxygen cascade\n\nThe fall in oxygen partial pressure from inspired air to the mitochondria.\n');
      await make('Altitude and hypoxia.md', '# Altitude and hypoxia\n\nBarometric pressure falls with altitude, so inspired PO2 falls and the whole [[Oxygen cascade]] starts lower.\n');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = app as any;
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        version: String((plugins.voiceAgent as any).manifest?.version),
        enabled: [...(a.plugins.enabledPlugins ?? [])],
        loaded: Object.keys(a.plugins.plugins ?? {}),
      };
    });
    log(`plugin ${info.version}; enabled ${JSON.stringify(info.enabled)}; loaded ${JSON.stringify(info.loaded)}`);
    await useFakeServices();
    await setSettings({ 'orchestrator.voiceRole': 'layered', 'orchestrator.engine': 'classic', 'orchestrator.progressUpdateSeconds': 0 });
  });

  it('1 and 2: worker falls back to the orchestrator model; Responses tools carry strict: false', async function () {
    this.timeout(150_000);
    // An OpenAI key only (the OpenAI endpoint is the fake service on 127.0.0.2), no Meta key,
    // default layers. The orchestrator layer's api is set to responses, which is what "auto"
    // picks for api.openai.com.
    await browser.executeObsidian(
      async ({ plugins }, alt: string, empty: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = plugins.voiceAgent as any;
        const s = p.settings;
        const openai = s.endpoints.find((e: { name: string }) => e.name === 'OpenAI');
        openai.endpoint = `${alt}/v1`;
        openai.apiKey = 'fake-openai-key-not-a-secret';
        const meta = s.endpoints.find((e: { name: string }) => e.name === 'Meta');
        meta.apiKey = empty;
        Object.assign(s.orchestrator.layers.orchestrator, { endpoint: 'OpenAI', model: 'gpt-6.1-sol', effort: 'medium', api: 'responses' });
        Object.assign(s.orchestrator.layers.worker, { endpoint: 'Meta', model: 'muse-spark-1.3-contributor', effort: 'xhigh', api: 'auto' });
        await p.saveSettings();
      },
      ALT_URL,
      EMPTY_KEY,
    );
    await listen();
    const mark = traceMark();
    const worker = encodeScript({
      id: 'af-worker',
      rounds: [[{ name: 'read_file', args: { path: 'Altitude and hypoxia.md' } }]],
      final: 'Your altitude note says inspired PO2 falls with pressure, so the whole [[Oxygen cascade]] starts lower.',
    });
    const orchestrator = encodeScript({
      id: 'af-orchestrator',
      rounds: [
        [{ name: 'delegate_task', args: { title: 'Summarise altitude notes', instructions: brief('Read "Altitude and hypoxia" and summarise it in one sentence.', worker) } }],
        [{ name: 'tell_user', args: { message: 'On it.', urgency: 'pause' } }],
        [{ name: 'tell_user', args: { message: 'Your altitude note says inspired oxygen falls with pressure, so the whole oxygen cascade starts lower.', urgency: 'pause' } }],
      ],
      final: 'Done.',
    });
    log(`2: relay returned: ${await relay(`Summarise my altitude notes ${orchestrator}`)}`);
    await waitFor('the fallback worker to finish and the answer to be said', async () => {
      const t = await task('Summarise altitude notes');
      return !!t && ['done', 'failed', 'cancelled'].includes(t.status) && (await said()).some(s => /cascade starts lower/.test(s.text));
    });
    const t2 = await task('Summarise altitude notes');
    const s2 = await said();
    const tr = traffic(mark);
    const workerReqs = tr.filter(e => e.script === 'af-worker');
    const delegated = tr.find(e => e.script === 'af-orchestrator' && e.round === 1);
    const startedText = (delegated?.messages ?? []).filter(m => m.role === 'tool').map(m => String(m.content)).join(' | ');
    log(`2: traffic ${JSON.stringify(summarise(tr))}`);
    log(`2: delegate_task returned: ${startedText.slice(0, 300)}`);
    log(`2: task ${JSON.stringify(t2)}; said ${JSON.stringify(s2)}; orchestrator ${JSON.stringify(await orchState())}`);
    const fellBack =
      workerReqs.length > 0 &&
      workerReqs.every(e => e.api === 'responses' && String(e.host).startsWith('127.0.0.2') && e.model === 'gpt-6.1-sol');
    const pass2a = fellBack && t2?.status === 'done' && s2.some(s => /cascade starts lower/.test(s.text));

    // 1: every tool in every Responses request carries strict: false.
    const responses = tr.filter(e => e.api === 'responses');
    const bad: string[] = [];
    let toolCount = 0;
    for (const e of responses) {
      for (const tool of (e.tools as Array<Record<string, unknown>>) ?? []) {
        toolCount++;
        if (tool.strict !== false) bad.push(`${e.script} round ${e.round}: ${String(tool.name)} strict=${JSON.stringify(tool.strict)}`);
      }
    }
    const first = ((responses[0]?.tools as Array<Record<string, unknown>>) ?? [])[0];
    const quoted = first ? JSON.stringify({ ...first, description: `${String(first.description ?? '').slice(0, 80)}…`, parameters: '(omitted)' }) : '(none)';
    verdict(
      '1',
      responses.length > 0 && toolCount > 0 && bad.length === 0,
      `${responses.length} Responses requests (orchestrator and worker), ${toolCount} tools, ${bad.length} without strict: false. First tool of the first request: ${quoted}`,
      { bad, first },
    );

    // 2b: no key anywhere, then delegate_task once.
    const out2b = await browser.executeObsidian(
      async ({ plugins }, empty: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = plugins.voiceAgent as any;
        p.settings.endpoints.find((e: { name: string }) => e.name === 'OpenAI').apiKey = empty;
        const chat = p.orchestrator.ensureChat();
        try {
          return String(await chat.toolregistry.executeTool('delegate_task', { title: 'Probe with no keys', instructions: 'Say hello.' }));
        } catch (e) {
          return `threw: ${String(e)}`;
        } finally {
          p.settings.endpoints.find((e: { name: string }) => e.name === 'OpenAI').apiKey = 'fake-openai-key-not-a-secret';
        }
      },
      EMPTY_KEY,
    );
    const noTask = (await task('Probe with no keys')) === null;
    log(`2: with no OpenAI or Meta key, delegate_task returned: ${out2b}; a task was ${noTask ? 'not ' : ''}started`);
    verdict(
      '2',
      pass2a && /^Could not start/.test(out2b) && /Add an API key/.test(out2b) && noTask,
      `With only an OpenAI key the worker ran on gpt-6.1-sol at the OpenAI endpoint (${workerReqs.length} worker requests, all Responses to 127.0.0.2), the task ended ${t2?.status}, and the answer was said. delegate_task said: "${startedText.slice(0, 200)}". With no key at all, delegate_task returned: "${out2b}"`,
      { task: t2, said: s2, noKey: out2b },
    );
  });

  it('3: a failed task is always told', async function () {
    this.timeout(120_000);
    await useFakeServices();
    await setSettings({ 'orchestrator.voiceRole': 'layered', 'orchestrator.engine': 'classic' });
    await listen();
    const mark = traceMark();
    const worker = encodeScript({ id: 'af-fail-worker', rounds: [], fail: { status: 400, message: 'FAKE MODEL: this worker request is refused on purpose.' } });
    const orchestrator = encodeScript({
      id: 'af-fail-orchestrator',
      rounds: [
        [{ name: 'delegate_task', args: { title: 'Check citation format', instructions: brief('Check the citation format of my altitude notes.', worker) } }],
        [{ name: 'tell_user', args: { message: 'On it.', urgency: 'pause' } }],
      ],
      // The event turn after the failure answers with plain text and no tell_user.
      final: 'FINAL-af-fail-orchestrator: noted, nothing said.',
    });
    log(`3: relay returned: ${await relay(`Check my citation format ${orchestrator}`)}`);
    await waitFor('the task to fail and the failure to be said', async () => {
      const t = await task('Check citation format');
      return !!t && t.status === 'failed' && (await said()).some(s => /failed/.test(s.text));
    });
    await browser.pause(1500);
    const t3 = await task('Check citation format');
    const s3 = await said();
    const tr = traffic(mark);
    log(`3: traffic ${JSON.stringify(summarise(tr))}`);
    const eventTurn = tr.filter(e => e.script === 'af-fail-orchestrator').pop();
    log(`3: task ${JSON.stringify(t3)}; said ${JSON.stringify(s3)}; orchestrator's last reply ${JSON.stringify(eventTurn?.reply)}`);
    const told = s3.find(s => /^The background task "Check citation format" failed: /.test(s.text));
    verdict(
      '3',
      t3?.status === 'failed' && !!told && !(eventTurn?.reply as { tool_calls?: unknown })?.tool_calls,
      `The worker's model request was refused (HTTP 400), the task ended ${t3?.status}, the orchestrator's event turn answered with plain text and no tell_user, and the voice received: ${told ? `"${told.text}" (${told.urgency})` : 'nothing about the failure'}`,
      { task: t3, said: s3 },
    );
  });

  it('4: tool groups cannot remove the agent pipeline', async function () {
    this.timeout(120_000);
    const lists = async () =>
      browser.executeObsidian(({ plugins }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = plugins.voiceAgent as any;
        const orch = p.orchestrator.ensureChat();
        const Chat = orch.constructor;
        const names = (chat: { toolregistry: { getEnabledDefinitions(): Array<{ function: { name: string } }> } }) =>
          chat.toolregistry.getEnabledDefinitions().map(t => t.function.name).sort();
        const voice = new Chat(p);
        voice.role = 'voice';
        voice.registerAvailableTools();
        const worker = new Chat(p);
        worker.role = 'subagent';
        worker.subAgentTaskId = 'probe';
        worker.registerAvailableTools();
        // The voice layer's list as a layered call builds it (VOICE_LAYER_TOOL_NAMES at e82f368).
        const voiceLayer = ['new_topic', 'relay_to_orchestrator', 'orchestrator_activity', 'check_tasks', 'cancel_task', 'set_progress_updates'];
        return {
          voice: names(voice).filter(n => voiceLayer.includes(n) || n.startsWith('memory_')),
          orchestrator: names(orch),
          worker: names(worker),
        };
      });
    const on = await lists();
    await setSettings({ 'enabledToolClassifications.System': false, 'enabledToolClassifications.AI': false });
    const off = await lists();
    // The orchestrator and worker tool lists as the models actually received them, groups off.
    await listen();
    const mark = traceMark();
    const worker = encodeScript({ id: 'af-groups-worker', rounds: [], final: 'FINAL-af-groups-worker' });
    const orchestrator = encodeScript({
      id: 'af-groups-orchestrator',
      rounds: [
        [{ name: 'delegate_task', args: { title: 'Tool list probe', instructions: brief('Reply with one line.', worker) } }],
        [{ name: 'tell_user', args: { message: 'On it.', urgency: 'pause' } }],
      ],
      final: 'Done.',
    });
    log(`4: relay returned: ${await relay(`Probe the tool lists ${orchestrator}`)}`);
    await waitFor('the probe task to end', async () => {
      const t = await task('Tool list probe');
      return !!t && ['done', 'failed', 'cancelled'].includes(t.status);
    });
    await browser.pause(1500);
    const tr = traffic(mark);
    const sentOrch = ((tr.find(e => e.script === 'af-groups-orchestrator')?.tools_offered as string[]) ?? []).slice().sort();
    const sentWorker = ((tr.find(e => e.script === 'af-groups-worker')?.tools_offered as string[]) ?? []).slice().sort();
    await setSettings({ 'enabledToolClassifications.System': true, 'enabledToolClassifications.AI': true });
    const lost = (a: string[], b: string[]) => a.filter(x => !b.includes(x));
    const mem = (l: string[]) => l.filter(n => n.startsWith('memory_'));
    log(`4: groups on: ${JSON.stringify(on)}`);
    log(`4: groups off (System and AI): ${JSON.stringify(off)}`);
    log(`4: sent with groups off: orchestrator ${JSON.stringify(sentOrch)}; worker ${JSON.stringify(sentWorker)}`);
    log(`4: removed by switching System and AI off: voice ${JSON.stringify(lost(on.voice, off.voice))}; orchestrator ${JSON.stringify(lost(on.orchestrator, off.orchestrator))}; worker ${JSON.stringify(lost(on.worker, off.worker))}`);
    const everywhereOff = [...off.voice, ...off.orchestrator, ...off.worker, ...sentOrch, ...sentWorker];
    const checks = {
      voiceRelay: off.voice.includes('relay_to_orchestrator'),
      orchDelegate: off.orchestrator.includes('delegate_task') && sentOrch.includes('delegate_task'),
      orchTell: off.orchestrator.includes('tell_user') && sentOrch.includes('tell_user'),
      workerAsk: off.worker.includes('ask_orchestrator') && sentWorker.includes('ask_orchestrator'),
      memoryKept:
        JSON.stringify(mem(on.voice)) === JSON.stringify(mem(off.voice)) &&
        JSON.stringify(mem(on.orchestrator)) === JSON.stringify(mem(off.orchestrator)) &&
        JSON.stringify(mem(on.worker)) === JSON.stringify(mem(off.worker)),
      runCommandGone: !everywhereOff.includes('run_obsidian_command'),
      runCommandWasThere: [...on.voice, ...on.orchestrator, ...on.worker].includes('run_obsidian_command'),
    };
    verdict(
      '4',
      checks.voiceRelay && checks.orchDelegate && checks.orchTell && checks.workerAsk && checks.memoryKept && checks.runCommandGone,
      `With System and AI off: relay_to_orchestrator ${checks.voiceRelay ? 'kept' : 'MISSING'} for the voice; delegate_task ${checks.orchDelegate ? 'kept' : 'MISSING'} and tell_user ${checks.orchTell ? 'kept' : 'MISSING'} for the orchestrator (also in the request it sent); ask_orchestrator ${checks.workerAsk ? 'kept' : 'MISSING'} for the worker; memory tools ${checks.memoryKept ? 'unchanged' : 'CHANGED'} (voice ${JSON.stringify(mem(off.voice))}, orchestrator ${JSON.stringify(mem(off.orchestrator))}, worker ${JSON.stringify(mem(off.worker))}); run_obsidian_command ${checks.runCommandGone ? 'gone' : 'STILL OFFERED'}${checks.runCommandWasThere ? '' : ' (it was not in these lists with the groups on either)'}. The voice list is the one a layered call builds (a chat with the voice role), not read from a started call.`,
      { on, off, sentOrch, sentWorker, checks },
    );
  });

  it('6: interruptions and the caret', async function () {
    this.timeout(120_000);
    await setSettings({ 'voice.saveCalls': true, 'voice.callsFolder': 'Voice Agent' });
    await browser.executeObsidian(async ({ app, plugins }, view: string) => {
      for (const l of app.workspace.getLeavesOfType(view)) l.detach();
      const leaf = app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: view, active: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = leaf.view as any;
      // The call recorder reads the panel's transcript, as a started call does.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (plugins.voiceAgent as any).calls.start('fake voice (scripted events, no audio)', () => v.transcript);
    }, VIEW);
    await browser.pause(800);
    await markLeaf();
    await browser.pause(800);
    log(`6: panel width ${await markLeaf()} px`);

    const feed = (events: Array<Record<string, unknown>>) =>
      browser.executeObsidian(({ app }, view: string, events: Array<Record<string, unknown>>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = app.workspace.getLeavesOfType(view)[0].view as any;
        for (const e of events) v.onVoiceEvent(e);
      }, VIEW, events);
    const state = () =>
      browser.execute((view: string) => {
        const root = document.querySelector(`[data-e2e-shot="${view}"]`);
        const rows = [...(root?.querySelectorAll('.va-row') ?? [])];
        const bubbles = [...(root?.querySelectorAll('.va-bubble') ?? [])].map(b => (b.textContent ?? '').replace(/\s+/g, ' ').trim());
        const carets = [...(root?.querySelectorAll('.va-caret') ?? [])].map(c => (c.closest('.va-bubble')?.textContent ?? '').replace(/\s+/g, ' ').trim());
        return { rows: rows.length, bubbles, carets };
      }, VIEW);

    await feed([
      { type: 'status', text: 'Connected' },
      { type: 'transcript', role: 'user', text: 'Find my altitude notes', final: true },
      { type: 'transcript', role: 'assistant', text: 'Sure, I will look', final: false },
      { type: 'transcript', role: 'user', text: 'only the recent ones', final: true },
      { type: 'tool', name: 'relay_to_orchestrator', phase: 'start', id: 'r1', args: { request: 'recent altitude notes' } },
    ]);
    await browser.pause(400);
    const a = await state();
    log(`6: shot A: bubbles ${JSON.stringify(a.bubbles)}; carets on ${JSON.stringify(a.carets)}`);
    await shootBoth('shot-A');

    await feed([
      { type: 'transcript', role: 'assistant', text: 'Sure, I will look through them now.', final: true },
      { type: 'tool', name: 'relay_to_orchestrator', phase: 'end', id: 'r1', result: 'Passed to the orchestrator.', ms: 30 },
    ]);
    await browser.pause(300);
    const mid = await state();
    log(`6: after the agent finished its line: bubbles ${JSON.stringify(mid.bubbles)}; carets on ${JSON.stringify(mid.carets)}`);
    await feed([
      { type: 'transcript', role: 'assistant', text: 'Next answer start', final: false },
      { type: 'transcript', role: 'user', text: 'Hold on', final: false },
    ]);
    await browser.pause(400);
    const b = await state();
    log(`6: shot B: bubbles ${JSON.stringify(b.bubbles)}; carets on ${JSON.stringify(b.carets)}`);
    await shootBoth('shot-B');

    // End the call the way a hang-up does: the panel settles every line and saves the call.
    await browser.executeObsidian(({ app }, view: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = app.workspace.getLeavesOfType(view)[0].view as any;
      v.onCallStateChange({ status: 'disconnected' });
    }, VIEW);
    await waitFor('the call to be saved', async () =>
      browser.executeObsidian(({ plugins }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = (plugins.voiceAgent as any).calls;
        return !c.isLive && !!c.current?.callPath;
      }),
    30_000);
    // Answer an "Update links" prompt if one comes up while the notes are written.
    await browser.execute(() => {
      const m = [...document.querySelectorAll('.modal-container .modal')].find(x => /Update links/.test(x.textContent ?? ''));
      ([...(m?.querySelectorAll('button') ?? [])].find(x => x.textContent?.trim() === 'Just once') as HTMLElement | undefined)?.click();
    });
    await browser.pause(1500);
    const end = await state();
    log(`6: after the call ended: carets on ${JSON.stringify(end.carets)}`);
    await shootBoth('call-ended');
    const saved = await browser.executeObsidian(async ({ app, plugins }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (plugins.voiceAgent as any).calls.current;
      const files = app.vault.getMarkdownFiles().filter(f => f.path.startsWith('Voice Agent/') && !f.path.startsWith('Voice Agent/Calls/demo'));
      const texts: Record<string, string> = {};
      for (const f of files) texts[f.path] = await app.vault.read(f);
      return { callPath: String(c?.callPath ?? ''), texts };
    });
    const all = Object.values(saved.texts).join('\n');
    const full = (all.match(/Sure, I will look through them now\./g) ?? []).length;
    const fragment = all.split('\n').filter(l => /Sure, I will look\b/.test(l) && !/Sure, I will look through them now\./.test(l));
    const callNote = saved.texts[saved.callPath] ?? '';
    log(`6: call note ${saved.callPath}; files ${JSON.stringify(Object.keys(saved.texts))}`);
    log(`6: call note text:\n${callNote.slice(0, 2500)}`);
    fs.writeFileSync(path.join(OUT, 'call-notes.json'), JSON.stringify(saved, null, 2));

    const agentBubbles = (s: { bubbles: string[] }) => s.bubbles.filter(x => /^Sure, I will look/.test(x));
    const checks = {
      shotA: a.carets.length === 1 && a.carets[0] === 'Sure, I will look',
      oneAgentBubble: agentBubbles(b).length === 1 && agentBubbles(b)[0] === 'Sure, I will look through them now.',
      noCaretAfterFinish: mid.carets.length === 0,
      shotB: b.carets.length === 1 && b.carets[0] === 'Hold on',
      endedNoCaret: end.carets.length === 0,
      noteOnceNoFragment: full === 1 && fragment.length === 0,
    };
    verdict(
      '6',
      Object.values(checks).every(Boolean),
      `Shot A: caret on ${JSON.stringify(a.carets)}. After the agent finished: ${agentBubbles(mid).length} agent bubble(s) ${JSON.stringify(agentBubbles(mid))}, ${mid.carets.length} caret(s). Shot B: caret on ${JSON.stringify(b.carets)}. After hang-up: ${end.carets.length} caret(s). The saved call has the full agent sentence ${full} time(s) and ${fragment.length} fragment line(s).`,
      { a, mid, b, end, checks, fragment },
    );
  });

  it('5: beside Pure Chat LLM', async function () {
    this.timeout(120_000);
    await installConsoleCapture();
    const start = (await consoleLines()).length;
    const info = await browser.executeObsidian(async ({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = app as any;
      const installed = !!a.plugins.manifests?.['pure-chat-llm'];
      const views = () => Object.keys(a.viewRegistry?.viewByType ?? {}).filter(v => /pure-chat|voice-agent|voice-call|blue-resolution/.test(v)).sort();
      const before = {
        enabled: [...(a.plugins.enabledPlugins ?? [])].sort(),
        loaded: Object.keys(a.plugins.plugins ?? {}).sort(),
        pureVersion: a.plugins.manifests?.['pure-chat-llm']?.version ?? null,
        views: views(),
      };
      const steps: string[] = [];
      if (installed) {
        // Load each again while the console is watched: the other one is already loaded.
        for (const id of ['voice-agent', 'pure-chat-llm']) {
          try {
            await a.plugins.disablePlugin(id);
            const ok = await a.plugins.enablePlugin(id);
            steps.push(`${id} reloaded: enablePlugin returned ${String(ok)}, loaded=${!!a.plugins.plugins[id]?._loaded}`);
          } catch (e) {
            steps.push(`${id} reload threw: ${String(e)}`);
          }
        }
      }
      return { installed, before, after: { loaded: Object.keys(a.plugins.plugins ?? {}).sort(), views: views() }, steps };
    });
    await browser.pause(1500);
    const lines = (await consoleLines()).slice(start);
    const viewErrors = lines.filter(l => /existing view type|view type/i.test(l));
    const errors = lines.filter(l => / (error|uncaught|unhandled-rejection) /.test(l));
    log(`5: ${JSON.stringify(info)}`);
    log(`5: console during the reloads: ${errors.length} error line(s)${errors.length ? `: ${JSON.stringify(errors.slice(0, 8))}` : ''}`);
    if (!info.installed) {
      verdict('5', 'unverified', 'The community Pure Chat LLM could not be installed in this run.', info);
      return;
    }
    const bothLoaded = info.before.loaded.includes('pure-chat-llm') && info.before.loaded.includes('voice-agent') && info.after.loaded.includes('pure-chat-llm') && info.after.loaded.includes('voice-agent');
    verdict(
      '5',
      bothLoaded && viewErrors.length === 0 && info.steps.every(s => /loaded=true/.test(s)),
      `Community Pure Chat LLM ${info.before.pureVersion} installed and enabled beside Voice Agent; both loaded at startup and again after each was reloaded with the other running (${info.steps.join('; ')}). View types registered: ${JSON.stringify(info.after.views)}. "Existing view type" errors: ${viewErrors.length}.`,
      { info, viewErrors, errors },
    );
  });

  it('7: real model', () => {
    verdict('7', 'unverified', 'No real OpenAI key is available to this harness, so no request was sent to a real model.');
  });

  after(async () => {
    const errors = (await consoleLines().catch(() => [] as string[])).filter(l => / (error|uncaught|unhandled-rejection) /.test(l));
    log(`console errors in the whole run: ${errors.length}`);
    for (const e of errors.slice(0, 20)) log(`  ${e}`);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT, 'fake-traffic.json'), JSON.stringify(allTraffic, null, 2));
  });
});
