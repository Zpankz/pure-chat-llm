// REL-2..5: reliability fixes from the system review (validation-scenarios.md §3): cancelling a
// thread mid-request and mid-review, a dropped connection, and a code mode timeout. The model and
// the reviewers are fake and can be told to stall or cut the connection; cancellation, retries,
// deadlines and the vault are real.
import { browser } from '@wdio/globals';
import {
  check,
  consoleLines,
  encodeScript,
  expect,
  readNote,
  readTask,
  setSettings,
  startWorker,
  traceMark,
  traceSince,
  useFakeServices,
  waitTask,
} from '../support/harness.mts';

describe('Reliability: cancel, dropped requests and code mode timeouts', () => {
  before(async () => {
    await useFakeServices();
  });

  check('REL-2', 'Cancel a worker while its model request is in flight (the fake model stalls 20 s)', async ev => {
    const mark = traceMark();
    const { taskId, scriptId } = await startWorker('Cancel mid request', 'Edit the note.', {
      delays: [20_000],
      rounds: [[{ name: 'replace_in_note', args: { path: 'Notes/cancel-request.md', search: 'Original text', replace: 'WRITTEN-AFTER-CANCEL' } }]],
    });
    await browser.pause(3000);
    const started = Date.now();
    const reply = await browser.executeObsidian(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ plugins }, taskId: string) => (plugins.voiceAgent as any).agents.cancel(taskId) as string,
      taskId,
    );
    const task = await waitTask(taskId, 15_000);
    const stoppedMs = Date.now() - started;
    await ev.shot('after-cancel');
    // Wait past the point the stalled reply would have arrived.
    await browser.pause(20_000);
    const traffic = traceSince(mark).filter(e => e.script === scriptId);
    ev.save('task', task);
    ev.save('traffic', traffic);
    expect(reply).toContain('Cancelling');
    expect(task.status).toBe('cancelled');
    expect(stoppedMs).toBeLessThan(5000);
    expect(traffic.some(e => e.service === 'llm-aborted')).toBe(true);
    expect(await readNote('Notes/cancel-request.md')).toContain('Original text');
    expect(await readNote('Notes/cancel-request.md')).not.toContain('WRITTEN-AFTER-CANCEL');
    ev.note(`Cancelled ${stoppedMs} ms after asking; the fake model saw the request aborted; 20 s later the note is unchanged.`);
  });

  check('REL-3', 'Cancel a worker while the two reviewers are deciding on its edit (they stall 15 s)', async ev => {
    const mark = traceMark();
    const { taskId, scriptId } = await startWorker('Cancel during review', 'Edit the note.', {
      rounds: [[{ name: 'replace_in_note', args: { path: 'Notes/cancel-review.md', search: 'Original text', replace: 'GHOST-WRITE REVIEW-SLOW-15000' } }]],
    });
    // Wait until the reviewers have the change.
    await browser.waitUntil(() => traceSince(mark).some(e => e.service === 'llm' && e.kind === 'reviewer'), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'The reviewers were never asked',
    });
    await browser.pause(1000);
    const started = Date.now();
    await browser.executeObsidian(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ plugins }, taskId: string) => (plugins.voiceAgent as any).agents.cancel(taskId),
      taskId,
    );
    const task = await waitTask(taskId, 20_000);
    const stoppedMs = Date.now() - started;
    await browser.pause(20_000);
    const after = await readTask(taskId);
    ev.save('task', after);
    ev.save('traffic', traceSince(mark).filter(e => e.script === scriptId || e.kind === 'reviewer'));
    const text = await readNote('Notes/cancel-review.md');
    ev.save('note-after', text);
    expect(task.status).toBe('cancelled');
    expect(text).toContain('Original text');
    expect(text).not.toContain('GHOST-WRITE');
    ev.note(`Cancelled during review in ${stoppedMs} ms; after the reviewers' stalled verdicts would have arrived, the note is unchanged (no ghost write).`);
  });

  check('REL-4', 'The orchestrator\'s model connection is cut on every request: one retry, then a plain spoken error', async ev => {
    const mark = traceMark();
    const timingBefore = (await consoleLines(/\[timing\] orchestrator request/)).length;
    const script = encodeScript({ id: 'dropped-orchestrator', rounds: [], final: 'never', drop: true });
    const said = await browser.executeObsidian(async ({ plugins }, script: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = plugins.voiceAgent as any;
      const said: string[] = [];
      const off = p.orchestrator.onSay((text: string) => said.push(text));
      p.orchestrator.relay(`Look something up. ${script}`, true);
      const until = Date.now() + 45_000;
      while (!said.length && Date.now() < until) await new Promise(r => setTimeout(r, 250));
      off();
      return said;
    }, script);
    const traffic = traceSince(mark).filter(e => e.script === 'dropped-orchestrator');
    const attempts = (await consoleLines(/\[timing\] orchestrator request/)).slice(timingBefore);
    ev.save('spoken', said);
    ev.save('traffic', traffic);
    ev.save('attempt-timing-lines', attempts);
    // The plugin's own attempts, from its timing log. The fake server counts connections, and the
    // browser may reopen a reset connection once on its own, so it can see more than this.
    expect(attempts.length).toBe(2);
    expect(attempts.every(l => /\(error\)/.test(l))).toBe(true);
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]).toMatch(/couldn't work on that|taking longer than expected/i);
    expect(said[0]).not.toMatch(/UND_ERR|ECONNRESET|stack|TypeError|at \w+ \(/);
    ev.note(`The plugin made 2 attempts (the fake server saw ${traffic.filter(e => e.dropped).length} cut-off connections), then the voice was given: "${said[0].slice(0, 200)}"`);
  });

  check('REL-5', 'A worker\'s code mode script runs past its time limit before writing: nothing is written afterwards', async ev => {
    await setSettings({ 'codeMode.enabled': true, 'codeMode.timeoutMs': 3000 });
    const js = `
const wait = ms => typeof setTimeout === 'function'
  ? new Promise(r => setTimeout(r, ms))
  : (() => { const end = Date.now() + ms; while (Date.now() < end) {} })();
await wait(8000);
await tools.create_obsidian_note({ path: 'Agent output/late-write.md', content: 'LATE-WRITE' });
return 'finished';`;
    const { taskId, scriptId } = await startWorker('Code mode timeout', 'Run the script.', { rounds: [[{ name: 'codemode', args: { code: js } }]] });
    const task = await waitTask(taskId, 60_000);
    await browser.pause(10_000);
    const late = await readNote('Agent output/late-write.md');
    const traffic = traceSince(0).filter(e => e.script === scriptId);
    const toolResult = JSON.stringify(traffic.at(-1)?.messages?.at(-1) ?? '').slice(0, 600);
    ev.save('task', task);
    ev.save('codemode-result', toolResult);
    await setSettings({ 'codeMode.timeoutMs': null });
    expect(late).toBeNull();
    expect(toolResult).toMatch(/time|limit|stopped|deadline/i);
    ev.note(`The script was stopped at its 3 s limit (${toolResult.slice(0, 160)}); 10 s later Agent output/late-write.md does not exist.`);
  });
});
