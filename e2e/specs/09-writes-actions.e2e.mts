// WR-1..4 and ACT-1, ACT-2: the reworked write pipeline (validation-scenarios.md §4) and the
// action tools' guards (§5). Workers and reviewers run on the fake model; the write gate, the
// proposal queue, the stale-edit merge, the command allow-list and the workspace are real.
import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import {
  check,
  clickModalButton,
  expect,
  listFiles,
  openModalTitle,
  readNote,
  runChat,
  runWorker,
  setSettings,
  startWorker,
  toolCalls,
  traceMark,
  traceSince,
  useFakeServices,
  waitTask,
} from '../support/harness.mts';

async function writeNote(path: string, edit: [string, string]) {
  await browser.executeObsidian(
    async ({ app }, path: string, from: string, to: string) => {
      const f = app.vault.getFileByPath(path);
      if (f) await app.vault.process(f, t => t.replace(from, to));
    },
    path,
    edit[0],
    edit[1],
  );
}

/** Starts a worker edit the reviewers sit on for a while, edits the note meanwhile, and waits. */
async function editDuringReview(title: string, path: string, agent: [string, string], user: [string, string]) {
  const mark = traceMark();
  const { taskId, scriptId } = await startWorker(title, 'Edit the note.', {
    rounds: [[{ name: 'replace_in_note', args: { path, search: agent[0], replace: agent[1] } }]],
  });
  await browser.waitUntil(() => traceSince(mark).some(e => e.service === 'llm' && e.kind === 'reviewer'), {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: 'The reviewers were never asked',
  });
  await writeNote(path, user);
  const task = await waitTask(taskId, 60_000);
  return { task, calls: toolCalls(scriptId, mark), text: (await readNote(path)) ?? '' };
}

describe('Writes after the rework, and action tool guards', () => {
  before(async () => {
    await useFakeServices();
  });

  check('WR-1', 'A worker on "peer" rewrites Notes/big-note.md down to one line: held as a proposal, not sent to the reviewers', async ev => {
    const mark = traceMark();
    const w = await runWorker('Big removal', 'Shorten the note.', {
      rounds: [[{ name: 'write_note_section', args: { path: 'Notes/big-note.md', heading: 'Big note', content: 'Short.', mode: 'replace' } }]],
    });
    const calls = toolCalls(w.scriptId, mark);
    ev.save('tool-calls', calls);
    const reviewers = traceSince(mark).filter(e => e.kind === 'reviewer');
    const proposals = await listFiles('Agent tasks/Proposals');
    ev.save('proposals', proposals);
    expect(calls[0]?.result).toMatch(/Not written yet/);
    expect(reviewers.length).toBe(0);
    expect(proposals.some(p => p.includes('big-note'))).toBe(true);
    expect(await readNote('Notes/big-note.md')).toContain('Paragraph 12');
    ev.note(`Held as a proposal without asking the reviewers: ${calls[0]?.result.replace(/\s+/g, ' ').slice(0, 200)}`);
  });

  check('WR-2', 'A worker on "Save as a proposal" edits a note; the Review proposals command opens it and applies it on approval', async ev => {
    await setSettings({ 'orchestrator.writes.edit': 'review' });
    const mark = traceMark();
    const w = await runWorker('Queued edit', 'Mark the note approved.', {
      rounds: [[{ name: 'replace_in_note', args: { path: 'Notes/proposal-target.md', search: 'Status: draft', replace: 'Status: approved by the user' } }]],
    });
    await setSettings({ 'orchestrator.writes.edit': null });
    const calls = toolCalls(w.scriptId, mark);
    ev.save('tool-calls', calls);
    const proposals = await listFiles('Agent tasks/Proposals');
    ev.save('proposals', proposals);
    const proposal = proposals.find(p => p.includes('proposal-target'));
    expect(proposal).toBeDefined();
    expect(await readNote('Notes/proposal-target.md')).toContain('Status: draft');
    ev.save('proposal-note', await readNote(proposal!));
    await obsidianPage.openFile(proposal!);
    await browser.pause(600);
    await ev.shot('proposal-note');
    await browser.executeObsidianCommand('voice-agent:review-proposals');
    const input = await browser.$('.prompt .prompt-input');
    await input.waitForDisplayed({ timeout: 10_000 });
    await input.setValue('proposal-target');
    await browser.pause(500);
    await ev.shot('proposal-picker');
    await browser.keys('Enter');
    await browser.waitUntil(async () => (await openModalTitle()) === 'Review proposed edit', { timeout: 15_000, timeoutMsg: 'The review window did not open' });
    await ev.shot('review-window');
    await clickModalButton('Approve and apply');
    await browser.waitUntil(async () => ((await readNote('Notes/proposal-target.md')) ?? '').includes('approved by the user'), {
      timeout: 15_000,
      timeoutMsg: 'The approved proposal was not applied',
    });
    await browser.pause(800);
    await ev.shot('after-approval');
    ev.save('proposal-after', await readNote(proposal!));
    ev.note('The edit waited as a proposal note; the command listed it, the review window showed it, and approving applied it.');
  });

  check('WR-3', 'The user edits another part of a note while the reviewers decide: the agent\'s edit is merged and the user\'s text kept', async ev => {
    const r = await editDuringReview(
      'Stale merge',
      'Notes/stale-merge.md',
      ['Agent line', 'Agent line, edited by the agent REVIEW-SLOW-6000'],
      ['User line', 'User line, typed by the user meanwhile'],
    );
    ev.save('task', r.task);
    ev.save('tool-calls', r.calls);
    ev.save('note-after', r.text);
    expect(r.text).toContain('edited by the agent');
    expect(r.text).toContain('typed by the user meanwhile');
    ev.note(`Both edits are in the note. Tool said: ${(r.calls[0]?.result ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
  });

  check('WR-4', 'The user rewrites the same line while the reviewers decide: the agent\'s edit is refused as a conflict', async ev => {
    const r = await editDuringReview(
      'Stale conflict',
      'Notes/stale-conflict.md',
      ['Shared line', 'Shared line, edited by the agent REVIEW-SLOW-6000'],
      ['Shared line', 'Rewritten by the user meanwhile'],
    );
    ev.save('task', r.task);
    ev.save('tool-calls', r.calls);
    ev.save('note-after', r.text);
    expect(r.calls[0]?.result).toMatch(/Conflict|no longer fits/);
    expect(r.text).toContain('Rewritten by the user meanwhile');
    expect(r.text).not.toContain('edited by the agent');
  });

  check('ACT-1', 'run_obsidian_command: off with an empty allow-list; runs a listed command; refuses a destructive or unlisted one', async ev => {
    await setSettings({ commandAllowList: [] });
    const mark = traceMark();
    await runChat('ACT-1-off', 'Toggle the left sidebar.', { rounds: [] });
    const offered = traceSince(mark).find(e => e.script === 'ACT-1-off')?.tools_offered as string[] | undefined;
    ev.save('tools-offered-when-off', offered);
    expect(offered ?? []).not.toContain('run_obsidian_command');
    await setSettings({ commandAllowList: ['app:toggle-left-sidebar', 'app:delete-file'] });
    const before = await browser.executeObsidian(({ app }) => app.workspace.leftSplit.collapsed);
    await runChat('ACT-1', 'Run some commands.', {
      rounds: [
        [{ name: 'run_obsidian_command', args: { action: 'list' } }],
        [{ name: 'run_obsidian_command', args: { action: 'run', id: 'app:toggle-left-sidebar' } }],
        [{ name: 'run_obsidian_command', args: { action: 'run', id: 'app:delete-file' } }],
        [{ name: 'run_obsidian_command', args: { action: 'run', id: 'editor:toggle-bold' } }],
      ],
    });
    const after = await browser.executeObsidian(({ app }) => app.workspace.leftSplit.collapsed);
    const calls = toolCalls('ACT-1', mark);
    ev.save('tool-calls', calls);
    await ev.shot('chat-after');
    await setSettings({ commandAllowList: [] });
    expect(calls[0]?.result).toContain('app:toggle-left-sidebar');
    expect(after).toBe(!before);
    expect(calls[2]?.result).toMatch(/NotAllowed/);
    expect(calls[2]?.result).toMatch(/never run/);
    expect(calls[3]?.result).toMatch(/NotAllowed/);
    expect(calls[3]?.result).toMatch(/allow-list/);
    ev.note('Not offered with an empty list; the listed sidebar command ran; app:delete-file was refused although listed; an unlisted command was refused.');
  });

  check('ACT-2', 'manage_workspace close: a pinned tab stays open and the Voice Agent panels are untouched', async ev => {
    const setup = await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getFileByPath('Notes/workspace-pinned.md');
      const a = app.workspace.getLeaf('tab');
      await a.openFile(file!);
      a.setPinned(true);
      const b = app.workspace.getLeaf('tab');
      await b.openFile(file!);
      const views: string[] = [];
      app.workspace.iterateAllLeaves(l => views.push(l.view.getViewType()));
      return { views };
    });
    const mark = traceMark();
    await runChat('ACT-2', 'Close the pinned note everywhere.', {
      rounds: [[{ name: 'manage_workspace', args: { action: 'close', path: 'Notes/workspace-pinned.md', all: true } }]],
    });
    const after = await browser.executeObsidian(({ app }) => {
      const views: string[] = [];
      app.workspace.iterateAllLeaves(l => views.push(l.view.getViewType()));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const showing = app.workspace.getLeavesOfType('markdown').filter(l => (l.view as any).file?.path === 'Notes/workspace-pinned.md');
      return { views, showing: showing.length, pinned: showing.filter(l => l.getViewState().pinned).length };
    });
    const calls = toolCalls('ACT-2', mark);
    ev.save('tool-calls', calls);
    ev.save('workspace', { before: setup.views, after });
    await ev.shot('after-close');
    const nonNote = (v: string[]) => v.filter(t => t !== 'markdown').sort();
    expect(calls[0]?.result).toMatch(/Closed 1 tab/);
    expect(after.showing).toBe(1);
    expect(after.pinned).toBe(1);
    expect(nonNote(after.views)).toEqual(nonNote(setup.views));
    ev.note(`One unpinned tab closed, the pinned one kept, and every non-note panel (${nonNote(setup.views).join(', ')}) still open.`);
  });
});
