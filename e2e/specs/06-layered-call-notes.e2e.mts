// LAY-1, CALL-1..7, REL-1: the layered pipeline behind a voice call, and how a call is saved.
//
// There is no audio here. The call is opened through the plugin's own call recorder with a
// written transcript. Where a real call has the voice model call new_topic, the harness calls the
// recorder's newTopic and returnToTopic itself, and the voice layer's relay is sent straight to the
// orchestrator agent. The orchestrator and the worker run on the fake model; delegation,
// sub-threads, timings and the saved notes are real.
import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import {
  check,
  consoleLines,
  encodeScript,
  expect,
  readNote,
  readTask,
  setSettings,
  traceMark,
  traceSince,
  useFakeServices,
  waitTask,
  type TraceEntry,
} from '../support/harness.mts';

interface CallInfo {
  stamp: string;
  folder: string;
  callPath: string;
  orchestratorPath: string | null;
  structure: string;
  topics: Array<{ id: number; title: string; kind: string; followsFrom: number[]; path: string }>;
  timings: Array<{ what: string; ms: number; outcome: string }>;
  /** How calls.finish() ended: 'done in N ms', 'error: …' or 'pending' after 30 s. */
  finish: string;
  /** Obsidian "Update links" prompts that came up while the call's notes were saved. */
  prompts: string[];
}

interface SavedCall {
  info: CallInfo;
  files: string[];
  folders: string[];
  links: Record<string, string[]>;
  notes: Record<string, string>;
  task: Record<string, unknown>;
  said: Array<{ text: string; urgency: string }>;
  traffic: TraceEntry[];
}

/** Every file and folder below a path, recursively. */
async function walk(root: string): Promise<{ files: string[]; folders: string[] }> {
  return browser.executeObsidian(async ({ app }, root: string) => {
    const files: string[] = [];
    const folders: string[] = [];
    const go = async (dir: string) => {
      if (!(await app.vault.adapter.exists(dir))) return;
      const l = await app.vault.adapter.list(dir);
      files.push(...l.files);
      for (const f of l.folders) {
        folders.push(f);
        await go(f);
      }
    };
    await go(root);
    return { files, folders };
  }, root);
}

/** Opens a call: a mutable transcript the recorder and the orchestrator both read. */
async function openCall(provider: string) {
  await browser.executeObsidian(({ plugins }, provider: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plugins.voiceAgent as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__e2eCall?.off?.();
    const lines: Array<{ role: string; text: string; at: number }> = [];
    const said: Array<{ text: string; urgency: string }> = [];
    const off = p.orchestrator.onSay((text: string, urgency: string) => said.push({ text, urgency }));
    p.orchestrator.setTranscriptSource(() => lines.map(l => `${l.role === 'user' ? 'User' : 'Agent'}: ${l.text}`));
    w.__e2eCall = { lines, said, off };
    p.calls.start(provider, () => lines);
  }, provider);
}

/** One step of a call, in the page: a spoken line, a topic switch or a relay. */
type Step =
  | { say: 'user' | 'assistant'; text: string }
  | { topic: string; kind: string; from?: string[] }
  | { back: string }
  | { relay: string };

async function play(steps: Step[]): Promise<string[]> {
  return browser.executeObsidian(async ({ plugins }, steps: Step[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plugins.voiceAgent as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (window as any).__e2eCall;
    const out: string[] = [];
    for (const s of steps) {
      // Distinct timestamps, so each line falls in exactly one topic.
      await new Promise(r => setTimeout(r, 40));
      if ('say' in s) call.lines.push({ role: s.say, text: s.text, at: Date.now() });
      else if ('topic' in s) out.push(p.calls.newTopic(s.topic, s.kind, s.from ?? []));
      else if ('back' in s) out.push(p.calls.returnToTopic(s.back));
      else out.push(p.orchestrator.relay(s.relay, true));
    }
    return out;
  }, steps);
}

/** Text of an open "Update links" prompt, answered with "Just once"; '' when none is open. */
async function answerUpdateLinks(): Promise<string> {
  const text = await browser.execute(() => {
    const modal = [...document.querySelectorAll('.modal-container .modal')].find(m => /Update links/.test(m.textContent ?? ''));
    if (!modal) return '';
    const button = [...modal.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Just once');
    const text = modal.textContent?.trim() ?? '';
    (button as HTMLElement | undefined)?.click();
    return text;
  });
  return text;
}

/** Ends the call and reads back everything it saved. */
async function closeCall(root: string, task: Record<string, unknown> = {}, mark = 0): Promise<SavedCall> {
  // finish() is started, not awaited inside the page script: the first CI run's call never came
  // back from it within the script timeout, so its progress is polled and recorded instead.
  await browser.executeObsidian(({ plugins }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plugins.voiceAgent as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const started = Date.now();
    w.__e2eFinish = 'pending';
    Promise.resolve(p.calls.finish())
      .then(() => p.calls.flush?.())
      .then(() => (w.__e2eFinish = `done in ${Date.now() - started} ms`))
      .catch((e: unknown) => (w.__e2eFinish = `error: ${String(e)}`));
  });
  // Obsidian asks "Update links?" when a renamed note has links to it and its "Automatically
  // update internal links" setting is off (the default). The recorder's renames wait for that
  // answer, so answer "Just once" (the choice that changes no setting) and record each prompt.
  let finish = 'pending';
  const prompts: string[] = [];
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const prompt = await answerUpdateLinks();
    if (prompt) prompts.push(prompt);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    finish = await browser.executeObsidian(() => String((window as any).__e2eFinish));
    if (finish !== 'pending' && !prompt) break;
    await browser.pause(500);
  }
  const { info, said } = await browser.executeObsidian(({ plugins }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plugins.voiceAgent as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (window as any).__e2eCall;
    call?.off?.();
    p.orchestrator.setTranscriptSource(null);
    const r = p.calls.current;
    return JSON.parse(
      JSON.stringify({
        said: call?.said ?? [],
        info: r && {
          stamp: r.stamp,
          folder: r.folder,
          callPath: r.callPath,
          orchestratorPath: r.orchestratorPath,
          structure: r.structure,
          topics: r.topics,
          timings: r.timings,
          finish: '',
          prompts: [],
        },
      }),
    );
  });
  if (info) {
    info.finish = finish;
    info.prompts = prompts;
  }
  await browser.pause(2500);
  const saved = await walk(info?.folder ?? root);
  const md = saved.files.filter(f => f.endsWith('.md'));
  const notes: Record<string, string> = {};
  for (const f of md) notes[f] = (await readNote(f)) ?? '';
  const links = await browser.executeObsidian(({ app }, folder: string) => {
    const out: Record<string, string[]> = {};
    for (const [from, to] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (from.startsWith(`${folder}/`)) out[from] = Object.keys(to);
    }
    return out;
  }, info?.folder ?? root);
  return { info, ...saved, links, notes, task, said, traffic: traceSince(mark) };
}

const linked = (call: SavedCall, a: string, b: string) => (call.links[a] ?? []).includes(b);

describe('Layered call pipeline and saved call notes', () => {
  let call: SavedCall;
  const FOLDER = 'Voice Agent';

  before(async () => {
    await useFakeServices();
    await setSettings({
      'voice.saveCalls': true,
      'voice.callsFolder': FOLDER,
      'voice.callNotes': 'topics',
      'orchestrator.voiceRole': 'layered',
    });
    const mark = traceMark();
    const worker = encodeScript({
      id: 'call-worker',
      rounds: [[{ name: 'traverse_graph', args: { note: 'AP11AO402', depth: 2, direction: 'both' } }]],
      final: 'FINAL-call-worker: the local graph of AP11AO402 has eight notes.',
    });
    const orchestrator = encodeScript({
      id: 'call-orchestrator',
      rounds: [[{ name: 'delegate_task', args: { title: 'Map AP11AO402 graph', instructions: `Walk the graph around AP11AO402 and report the notes. ${worker}` } }]],
      final: 'FINAL-call-orchestrator: a worker is mapping it.',
    });
    await openCall('fake voice (scripted transcript, no audio)');
    await play([
      { say: 'user', text: 'Let us talk about the oxygen cascade first.' },
      { topic: 'Oxygen cascade', kind: 'concept' },
      { say: 'assistant', text: 'Sure, it runs from inspired gas down to the mitochondria.' },
      { say: 'user', text: 'New idea: save each call as folder notes.' },
      { topic: 'Folder notes for calls', kind: 'idea' },
      { say: 'assistant', text: 'One note per topic, with an index note.' },
      { say: 'user', text: 'Going back to the first thing, what about an alternative: dead space instead?' },
      { topic: 'Dead space alternative', kind: 'alternative', from: ['Oxygen cascade'] },
      { say: 'user', text: 'Map the graph around AP11AO402 for me.' },
      { relay: `Hani asks for the local graph around AP11AO402. ${orchestrator}` },
      { say: 'assistant', text: 'On it.' },
    ]);
    // The worker the orchestrator started, then the orchestrator's spoken answer.
    let taskId = '';
    await browser.waitUntil(
      async () => {
        taskId = await browser.executeObsidian(({ plugins }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = (plugins.voiceAgent as any).agents.list().find((x: any) => x.title === 'Map AP11AO402 graph');
          return t?.id ?? '';
        });
        return !!taskId;
      },
      { timeout: 60_000, interval: 500, timeoutMsg: 'The orchestrator did not start a worker' },
    );
    const task = await waitTask(taskId);
    await browser.pause(3000);
    await play([
      { back: 'Folder notes for calls' },
      { say: 'user', text: 'Back to folder notes: keep the index short.' },
    ]);
    call = await closeCall(FOLDER, task, mark);
  });

  check('LAY-1', 'Relay a request to the orchestrator agent; it delegates to a worker that runs traverse_graph', async ev => {
    ev.save('task', call.task);
    ev.save('spoken', call.said);
    const llm = call.traffic.filter(e => e.service === 'llm');
    const orch = llm.find(e => e.script === 'call-orchestrator');
    const work = llm.find(e => e.script === 'call-worker');
    ev.save('layer-requests', llm.map(e => ({ script: e.script, kind: e.kind, tools_offered: e.tools_offered, messages: (e.messages ?? []).length })));
    expect(orch).toBeDefined();
    expect(work).toBeDefined();
    expect(orch!.tools_offered as string[]).toContain('delegate_task');
    expect(work!.tools_offered as string[]).toContain('traverse_graph');
    expect(work!.tools_offered as string[]).not.toContain('delegate_task');
    expect(call.task?.status).toBe('done');
    expect(String(call.task?.result)).toContain('FINAL-call-worker');
    // The worker starts from its brief alone: no voice transcript or orchestrator history.
    expect(JSON.stringify(work?.messages ?? [])).not.toContain('Sure, it runs from inspired gas');
    // The orchestrator answered the relay through the voice.
    expect(call.said.some(s => s.text.includes('FINAL-call-orchestrator') || s.text.length > 0)).toBe(true);
    ev.note(`Orchestrator offered delegate_task; the worker had vault tools but not delegate_task, ran traverse_graph and finished from its brief alone. The voice was given ${call.said.length} thing(s) to say.`);
  });

  check('CALL-1', 'End the call and read the saved notes and their links', async ev => {
    ev.save('saved-call', { info: call.info, files: call.files, folders: call.folders, links: call.links });
    for (const [p, text] of Object.entries(call.notes)) ev.save(`note-${p.split('/').pop()}`, { path: p, text });
    const md = Object.keys(call.notes);
    const index = call.info.callPath;
    const orchNote = call.info.orchestratorPath ?? '';
    const taskNote = String(call.task?.notePath ?? '');
    // Ending the call has to finish writing its notes.
    expect(call.info.finish).toMatch(/^done/);
    expect(md).toContain(index);
    expect(md).toContain(orchNote);
    expect(md).toContain(taskNote);
    expect(linked(call, index, orchNote)).toBe(true);
    expect(linked(call, orchNote, index)).toBe(true);
    expect(linked(call, orchNote, taskNote)).toBe(true);
    expect(linked(call, taskNote, orchNote)).toBe(true);
    ev.note(`Saved ${md.length} notes: the index, ${call.info.topics.length} topics, the orchestrator and its thread, all linked both ways.`);
  });

  check('CALL-4', 'Read the index and topic notes: Map, Flow, Threads and Timings; the alternative branches under the first topic', async ev => {
    const index = call.notes[call.info.callPath] ?? '';
    ev.save('index-note', index);
    for (const h of ['## Map', '## Flow', '## Threads', '## Timings']) expect(index).toContain(h);
    const titles = call.info.topics.map(t => t.title);
    ev.save('topics', call.info.topics);
    expect(titles).toEqual(['Oxygen cascade', 'Folder notes for calls', 'Dead space alternative']);
    const alt = call.info.topics[2];
    expect(alt.followsFrom).toEqual([1]);
    // In the Map, the alternative sits indented under the first topic.
    const map = index.slice(index.indexOf('## Map'), index.indexOf('## Flow'));
    const mapLines = map.split('\n');
    const first = mapLines.findIndex(l => l.includes('Oxygen cascade'));
    const altLine = mapLines.find(l => l.includes('Dead space alternative')) ?? '';
    expect(first).toBeGreaterThanOrEqual(0);
    expect(altLine.match(/^\s*/)?.[0].length ?? 0).toBeGreaterThan(mapLines[first].match(/^\s*/)?.[0].length ?? 0);
    // Topic notes: type, follows_from and the user's words that opened them.
    const altNote = call.notes[alt.path] ?? '';
    ev.save('alternative-topic-note', altNote);
    expect(altNote).toContain('type: voice-topic');
    expect(altNote).toContain('follows_from');
    expect(altNote).toContain('Oxygen cascade');
    expect(altNote).toContain('what about an alternative');
    // The return to topic 2 put the closing words in its note.
    expect(call.notes[call.info.topics[1].path] ?? '').toContain('keep the index short');
    // The Flow records the return as a second visit.
    const flow = index.slice(index.indexOf('## Flow'), index.indexOf('## Threads'));
    ev.save('flow', flow);
    expect(flow.split('→').length).toBeGreaterThanOrEqual(4);
    ev.note('Index has Map, Flow, Threads and Timings; the alternative is a child of "Oxygen cascade" in the Map, and returning to "Folder notes for calls" shows in the Flow and its note.');
  });

  check('CALL-5', 'Follow the relay and spawn block links both ways; click the #^relay link', async ev => {
    const alt = call.info.topics[2];
    const altNote = call.notes[alt.path] ?? '';
    const orchPath = call.info.orchestratorPath ?? '';
    const orch = call.notes[orchPath] ?? '';
    const taskId = String(call.task.id);
    ev.save('orchestrator-note', orch);
    expect(altNote).toMatch(/Passed to the \[\[[^\]]*#\^relay-1\|orchestrator\]\]/);
    expect(orch).toContain('^relay-1');
    expect(orch).toMatch(/Relayed from \[\[[^\]]*Dead space alternative/);
    expect(orch).toContain(`^spawn-${taskId}`);
    const thread = call.notes[String(call.task.notePath)] ?? '';
    ev.save('thread-note', thread);
    expect(thread).toContain(`#^spawn-${taskId}`);
    expect(linked(call, alt.path, orchPath)).toBe(true);
    expect(linked(call, orchPath, alt.path)).toBe(true);
    // Click through: open the topic note and follow its link to the relay block.
    await obsidianPage.openFile(alt.path);
    await browser.pause(800);
    await ev.shot('topic-note');
    const target = `${orchPath.replace(/\.md$/, '')}#^relay-1`;
    await browser.executeObsidian(async ({ app }, target: string, from: string) => {
      await app.workspace.openLinkText(target, from, false);
    }, target, alt.path);
    await browser.pause(1200);
    const landed = await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = app.workspace.getMostRecentLeaf()?.view as any;
      const editor = view?.editor;
      const line = editor ? editor.getLine(editor.getCursor().line) : '';
      return { file: view?.file?.path ?? '', line };
    });
    ev.save('landed', landed);
    await ev.shot('relay-block');
    expect(landed.file).toBe(orchPath);
    ev.note(`The alternative topic links to ${orchPath}#^relay-1 and the orchestrator links back; the thread hangs off ^spawn-${taskId}. Following the link opened the orchestrator note (cursor line: "${landed.line.slice(0, 80)}").`);
  });

  check('REL-1', 'Read the latency timings from the developer console and from the call note', async ev => {
    const lines = await consoleLines(/\[timing\]/);
    ev.save('console-timing-lines', lines);
    ev.save('call-timings', call.info.timings);
    const index = call.notes[call.info.callPath] ?? '';
    const timings = index.slice(index.indexOf('## Timings'));
    ev.save('timings-section', timings);
    const pick = (what: RegExp) => call.info.timings.filter(t => what.test(t.what)).map(t => `${t.ms} ms (${t.outcome})`);
    const first = pick(/relay to first spoken answer/);
    expect(lines.some(l => l.includes('relay to first spoken answer'))).toBe(true);
    expect(first.length).toBeGreaterThan(0);
    expect(timings).toContain('relay to first spoken answer');
    ev.note(
      `Against the fake model on the CI runner: relay to first spoken answer ${first.join(', ')}; orchestrator turns ${pick(/orchestrator turn/).join(', ') || 'none'}; ` +
        `orchestrator requests ${pick(/^orchestrator request/).join(', ') || 'none'}; worker requests ${pick(/^worker request/).join(', ') || 'none'}. ` +
        'These measure the plugin\'s own overhead only; a real model adds its own latency. The [timing] lines print only with Debug on.',
    );
  });

  check('CALL-3', 'Check the call folder is a folder-note tree linked both ways; screenshot the file explorer and graph view', async ev => {
    const md = Object.keys(call.notes);
    const root = call.info.callPath;
    await browser.executeObsidian(async ({ app }, top: string) => {
      const folder = app.vault.getAbstractFileByPath(top);
      const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (leaf && folder) (leaf.view as any).revealInFolder(folder);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of (folder as any)?.children ?? []) if (f.children && leaf) (leaf.view as any).revealInFolder(f);
    }, call.info.folder);
    await browser.pause(800);
    await ev.shot('file-explorer');
    await obsidianPage.openFile(root);
    await browser.pause(800);
    await ev.shot('index-note');
    await browser.executeObsidianCommand('graph:open-local');
    await browser.pause(2500);
    await ev.shot('local-graph-of-call-root');
    const children = md.filter(f => f !== root);
    const report = {
      callFolder: call.info.folder,
      root,
      rootIsFolderNote: root === `${call.info.folder}/${call.info.folder.split('/').pop()}.md`,
      orchestratorIsFolderNote: !!call.info.orchestratorPath && call.info.orchestratorPath.split('/').slice(-2, -1)[0] === call.info.orchestratorPath.split('/').pop()?.replace(/\.md$/, ''),
      notes: md,
      childLinks: children.map(c => ({ note: c, links: call.links[c] ?? [] })),
    };
    ev.save('structure', report);
    expect(report.rootIsFolderNote).toBe(true);
    expect(report.orchestratorIsFolderNote).toBe(true);
    // Every node below the root is reachable from it and links back up.
    const reach = new Set([root]);
    for (let i = 0; i < 6; i++) for (const n of [...reach]) for (const to of call.links[n] ?? []) if (md.includes(to)) reach.add(to);
    for (const c of children) {
      expect(reach.has(c)).toBe(true);
      expect((call.links[c] ?? []).some(to => md.includes(to))).toBe(true);
    }
    const nested = children.filter(c => c.split('/').length > root.split('/').length);
    ev.note(`Root folder note ${root}; ${children.length} notes below it, ${nested.length} nested in the orchestrator's folder; all reachable from the root and linking back.`);
  });

  check('CALL-6', 'Switch Call layout to One transcript note and run a call with a relay', async ev => {
    await setSettings({ 'voice.callNotes': 'transcript' });
    const orchestrator = encodeScript({ id: 'transcript-orchestrator', rounds: [], final: 'FINAL-transcript-orchestrator: noted.' });
    await openCall('fake voice (scripted transcript, no audio)');
    await play([
      { say: 'user', text: 'Note that the cascade drops at every step.' },
      { relay: `Note the cascade point. ${orchestrator}` },
      { say: 'assistant', text: 'Passed on.' },
      { say: 'user', text: 'Thanks, that is all.' },
    ]);
    await browser.pause(4000);
    const t = await closeCall(FOLDER);
    await setSettings({ 'voice.callNotes': 'topics' });
    ev.save('saved', { info: t.info, files: t.files });
    const index = t.notes[t.info.callPath] ?? '';
    ev.save('transcript-note', index);
    await obsidianPage.openFile(t.info.callPath);
    await browser.pause(800);
    await ev.shot('transcript-note');
    expect(t.info.structure).toBe('transcript');
    expect(index).toContain('## Transcript');
    expect(index).toContain('the cascade drops at every step');
    expect(index).toContain('that is all');
    expect(index).toMatch(/Passed to the \[\[[^\]]*#\^relay-1\|orchestrator\]\]/);
    // The hand-off sits between what was said before and after it.
    expect(index.indexOf('drops at every step')).toBeLessThan(index.indexOf('#^relay-1'));
    expect(index.indexOf('#^relay-1')).toBeLessThan(index.indexOf('that is all'));
    expect(Object.values(t.notes).some(n => n.includes('type: voice-topic'))).toBe(false);
    ev.note('With One transcript note, the folder note holds the whole transcript with the hand-off linked inline at the point it happened; no topic notes were made.');
  });

  check('CALL-7', 'Voice role direct: a thread started from a topic hangs off that topic', async ev => {
    await setSettings({ 'orchestrator.voiceRole': 'direct', 'voice.callNotes': 'topics' });
    await openCall('fake voice (scripted transcript, no audio)');
    await play([
      { say: 'user', text: 'Tell me about the Bohr equation.' },
      { topic: 'Bohr equation', kind: 'concept' },
      { say: 'user', text: 'Find the notes that use it.' },
    ]);
    const script = encodeScript({ id: 'direct-worker', rounds: [[{ name: 'get_backlinks', args: { path: 'src/ontology/principles/bohr-equation.md' } }]], final: 'FINAL-direct-worker' });
    // What the direct voice's delegate does: a task with origin "voice".
    const taskId = await browser.executeObsidian(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ plugins }, prompt: string) => (plugins.voiceAgent as any).agents.spawn('Bohr equation users', prompt, 'voice').id as string,
      `Find the notes that use the Bohr equation. ${script}`,
    );
    const task = await waitTask(taskId);
    await browser.pause(1500);
    const d = await closeCall(FOLDER, await readTask(taskId));
    await setSettings({ 'orchestrator.voiceRole': 'layered' });
    ev.save('saved', { info: d.info, files: d.files, links: d.links, task });
    const topic = d.info.topics.find(t => t.title === 'Bohr equation');
    expect(topic).toBeDefined();
    expect(d.info.orchestratorPath).toBeNull();
    const threadNote = String(d.task.notePath ?? '');
    expect(d.task.parentNote).toBe(topic!.path);
    expect(Object.keys(d.notes)).toContain(threadNote);
    expect(linked(d, topic!.path, threadNote)).toBe(true);
    expect(linked(d, threadNote, topic!.path)).toBe(true);
    await obsidianPage.openFile(topic!.path);
    await browser.pause(800);
    await ev.shot('topic-with-thread');
    // The thread note says where it started with a block link into the topic note; that block has
    // to exist there, or the link opens the topic without landing on the hand-off line.
    const anchor = `spawn-${taskId}`;
    const threadLinksBlock = (d.notes[threadNote] ?? '').includes(`#^${anchor}`);
    const topicHasBlock = new RegExp(`\\^${anchor}\\s*$`, 'm').test(d.notes[topic!.path] ?? '');
    ev.save('block-link', { threadLinksBlock, topicHasBlock });
    if (threadLinksBlock && !topicHasBlock) {
      ev.note(`Finding: the thread note links to the topic at #^${anchor}, but the topic's "Started" line carries no ^${anchor} block id, so that link does not land on the hand-off.`);
    }
    expect(!threadLinksBlock || topicHasBlock).toBe(true);
    ev.note(`With the direct voice role there is no orchestrator note; the thread ${threadNote} hangs off the topic "Bohr equation" and links back to it.`);
  });

  check('CALL-8', 'With Obsidian\'s default links setting, saving a call never stops to ask the user anything', async ev => {
    const alwaysUpdate = await browser.executeObsidian(({ app }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      String((app.vault as any).getConfig?.('alwaysUpdateLinks')),
    );
    await openCall('fake voice (scripted transcript, no audio)');
    await play([
      { say: 'user', text: 'Start with the alveolar gas equation.' },
      { topic: 'Alveolar gas equation', kind: 'concept' },
    ]);
    await browser.pause(3000);
    const open = await browser.execute(() =>
      [...document.querySelectorAll('.modal-container .modal')].map(m => m.textContent?.trim() ?? '').find(t => /Update links/.test(t)) ?? '',
    );
    if (open) await ev.shot('update-links-prompt-during-call');
    const c = await closeCall(FOLDER);
    const all = [...call.info.prompts, ...(open ? [open] : []), ...c.info.prompts];
    ev.save('prompts', { alwaysUpdateLinks: alwaysUpdate, mainCall: call.info.prompts, thisCall: { duringCall: open, whileSaving: c.info.prompts } });
    ev.note(
      all.length
        ? `Obsidian's "Update links" prompt came up ${all.length} time(s) while call notes were renamed or moved (alwaysUpdateLinks is ${alwaysUpdate}); until someone answers it, every later save of the call waits.`
        : 'No prompt came up.',
    );
    expect(all).toEqual([]);
  });

  check('CALL-2', 'Change the calls folder in settings, run a second short call, and look where it was saved', async ev => {
    const other = 'Calls elsewhere';
    await setSettings({ 'voice.callsFolder': other });
    await openCall('fake voice (scripted transcript, no audio)');
    await play([{ say: 'user', text: 'Second call.' }]);
    const second = await closeCall(other);
    await setSettings({ 'voice.callsFolder': FOLDER });
    ev.save('second-call', { info: second.info, files: second.files });
    expect(second.info.folder.startsWith(`${other}/`)).toBe(true);
    expect(second.files.some(f => f.endsWith('.md'))).toBe(true);
    ev.note(`First call saved under "${FOLDER}", this one under "${second.info.folder}" after the setting changed.`);
  });
});
