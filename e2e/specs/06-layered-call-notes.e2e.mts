// LAY-1, CALL-1..3: the layered pipeline behind a voice call, and how a call is saved.
// There is no audio here: the call is opened through the plugin's own call recorder with a
// written transcript, and the voice layer's relay is sent straight to the orchestrator agent.
// The orchestrator and the worker run on the fake model; delegation, sub-threads and the saved
// notes are real.
import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { check, encodeScript, expect, listFiles, readNote, traceMark, traceSince, useFakeServices, type TraceEntry } from '../support/harness.mts';

interface SavedCall {
  files: string[];
  folders: string[];
  links: Record<string, string[]>;
  task: Record<string, unknown> | null;
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

async function runLayeredCall(folder: string): Promise<SavedCall> {
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
  await browser.executeObsidian(
    async ({ plugins }, folder: string, orchestrator: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = plugins.voiceAgent as any;
      p.settings.voice.callsFolder = folder;
      p.settings.orchestrator.voiceRole = 'layered';
      await p.saveSettings();
      const lines = [
        { role: 'user', text: 'Perform multi hop traversal from AP11AO402.', at: Date.now() },
        { role: 'assistant', text: 'On it, I have asked a worker to map it.', at: Date.now() },
      ];
      p.calls.start('fake voice (scripted transcript, no audio)', () => lines);
      p.orchestrator.relay(`Hani asks for the local graph around AP11AO402. ${orchestrator}`);
    },
    folder,
    orchestrator,
  );
  let task: Record<string, unknown> | null = null;
  await browser.waitUntil(
    async () => {
      task = await browser.executeObsidian(({ plugins }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = (plugins.voiceAgent as any).agents.list().find((x: any) => x.title === 'Map AP11AO402 graph');
        return t ? { id: t.id, status: t.status, result: t.result, notePath: t.notePath, parentNote: t.parentNote, callNote: t.callNote } : null;
      });
      return !!task && ['done', 'failed'].includes(String(task.status));
    },
    { timeout: 120_000, interval: 500, timeoutMsg: 'The delegated worker did not finish' },
  );
  // Let the orchestrator take the worker's report, then end the call.
  await browser.pause(3000);
  await browser.executeObsidian(async ({ plugins }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugins.voiceAgent as any).calls.finish();
  });
  let saved = { files: [] as string[], folders: [] as string[] };
  await browser.waitUntil(
    async () => {
      saved = await walk(folder);
      return saved.files.filter(f => f.endsWith('.md')).length >= 3;
    },
    { timeout: 20_000, interval: 500, timeoutMsg: `Fewer than three notes saved under ${folder}` },
  ).catch(() => undefined);
  await browser.pause(1500);
  const links = await browser.executeObsidian(({ app }, folder: string) => {
    const out: Record<string, string[]> = {};
    for (const [from, to] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (from.startsWith(`${folder}/`)) out[from] = Object.keys(to);
    }
    return out;
  }, folder);
  return { ...saved, links, task, traffic: traceSince(mark) };
}

describe('Layered call pipeline and saved call notes', () => {
  let call: SavedCall;
  const FOLDER = 'Voice Agent';

  before(async () => {
    await useFakeServices();
    call = await runLayeredCall(FOLDER);
  });

  check('LAY-1', 'Relay a request to the orchestrator agent; it delegates to a worker that runs traverse_graph', async ev => {
    ev.save('task', call.task);
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
    const first = traceSince(0).find(e => e.script === 'call-worker');
    const workerText = JSON.stringify(first?.messages ?? []);
    expect(workerText).not.toContain('On it, I have asked a worker');
    ev.note('Orchestrator offered delegate_task; the worker had vault tools but not delegate_task, ran traverse_graph and finished; its context held the brief, not the call transcript.');
  });

  check('CALL-1', 'End the call and read the saved notes and their links', async ev => {
    ev.save('saved-call', { files: call.files, folders: call.folders, links: call.links });
    const md = call.files.filter(f => f.endsWith('.md'));
    const callNote = md.find(f => /call\.md$/.test(f) || f === `${call.folders[0]}/${call.folders[0]?.split('/').pop()}.md`);
    const orchNote = md.find(f => /orchestrator\.md$/.test(f));
    const taskNote = String(call.task?.notePath ?? '');
    for (const f of md.slice(0, 3)) ev.save(`note-${f.split('/').pop()}`, { path: f, text: await readNote(f) });
    expect(callNote).toBeDefined();
    expect(orchNote).toBeDefined();
    expect(md).toContain(taskNote);
    const linked = (a: string, b: string) => (call.links[a] ?? []).includes(b);
    expect(linked(callNote!, orchNote!) || linked(orchNote!, callNote!)).toBe(true);
    expect(linked(orchNote!, taskNote) || linked(callNote!, taskNote)).toBe(true);
    expect(linked(taskNote, orchNote!) || linked(taskNote, callNote!)).toBe(true);
    ev.note(`Saved ${md.length} notes; call, orchestrator and sub-thread notes link to each other.`);
  });

  check('CALL-2', 'Change the calls folder in settings, run a second short call, and look where it was saved', async ev => {
    const other = 'Calls elsewhere';
    await browser.executeObsidian(async ({ plugins }, other: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = plugins.voiceAgent as any;
      p.settings.voice.callsFolder = other;
      await p.saveSettings();
      p.calls.start('fake voice (scripted transcript, no audio)', () => [{ role: 'user', text: 'Second call.' }]);
      await p.calls.finish();
    }, other);
    await browser.pause(1000);
    const there = await walk(other);
    ev.save('second-call', there);
    expect(call.files.length).toBeGreaterThan(0);
    expect(there.files.some(f => f.endsWith('.md'))).toBe(true);
    ev.note(`First call saved under "${FOLDER}", second under "${other}" after the setting changed.`);
  });

  check('CALL-3', 'Check the call folder is a folder-note tree linked both ways; screenshot the file explorer and graph view', async ev => {
    const md = call.files.filter(f => f.endsWith('.md'));
    const top = call.folders.find(f => f.split('/').length === FOLDER.split('/').length + 1) ?? '';
    const name = top.split('/').pop() ?? '';
    const root = `${top}/${name}.md`;
    // Evidence first, so the screenshots exist whether or not the structure matches.
    await browser.executeObsidian(async ({ app }, top: string) => {
      const folder = app.vault.getAbstractFileByPath(top);
      const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (leaf && folder) (leaf.view as any).revealInFolder(folder);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const f of (folder as any)?.children ?? []) if (f.children && leaf) (leaf.view as any).revealInFolder(f);
    }, top);
    await browser.pause(800);
    await ev.shot('file-explorer');
    const open = md.includes(root) ? root : (md.find(f => /call\.md$/.test(f)) ?? md[0]);
    if (open) {
      await obsidianPage.openFile(open);
      await browser.executeObsidianCommand('graph:open-local');
      await browser.pause(2500);
      await ev.shot('local-graph-of-call-root');
    }
    const children = md.filter(f => f !== root);
    const linked = (a: string, b: string) => (call.links[a] ?? []).includes(b);
    const report = {
      callFolder: top,
      expectedRoot: root,
      rootExists: md.includes(root),
      notes: md,
      childLinks: children.map(c => ({ note: c, rootLinksToIt: linked(root, c), linksBackToParent: Object.keys(call.links).length ? (call.links[c] ?? []) : [] })),
    };
    ev.save('structure', report);
    expect(report.rootExists).toBe(true);
    // Every node below the root is reachable from it and links back up to a parent.
    const reach = new Set([root]);
    for (let i = 0; i < 5; i++) for (const n of [...reach]) for (const to of call.links[n] ?? []) if (md.includes(to)) reach.add(to);
    for (const c of children) {
      expect(reach.has(c)).toBe(true);
      expect((call.links[c] ?? []).some(to => md.includes(to))).toBe(true);
    }
    const nested = children.filter(c => c.split('/').length > root.split('/').length);
    ev.note(`Root folder note ${root}; ${children.length} child notes, ${nested.length} nested in sub-folders; all reachable from the root and linking back.`);
  });
});
