// REV-1..5 and CM-1..3: background workers (sub-agents) writing to the vault. Workers and both
// reviewers run on the fake model; the reviewers' verdicts are scripted (APPROVE unless the change
// carries the REVIEW-REJECT marker). The write gate, backups, trash and code mode are real.
import { browser } from '@wdio/globals';
import {
  FAKE_URL,
  check,
  expect,
  listFiles,
  readNote,
  runWorker,
  toolCalls,
  traceMark,
  traceSince,
  useFakeServices,
  type ToolCallTrace,
  type TraceEntry,
} from '../support/harness.mts';

const BRIEF_MARKER = 'WORKER-BRIEF-MARKER-5d1e';

function reviewerRequests(entries: TraceEntry[]) {
  return entries
    .filter(e => e.service === 'llm' && e.kind === 'reviewer')
    .map(e => ({
      roles: (e.messages ?? []).map(m => m.role),
      question: String((e.messages ?? []).find(m => m.role === 'user')?.content ?? ''),
      verdict: e.reply?.content ?? '',
    }));
}

describe('Worker writes: two independent reviewers, backup, trash and code mode', () => {
  let writes: { task: Record<string, unknown>; calls: ToolCallTrace[]; traffic: TraceEntry[] };
  let code: { task: Record<string, unknown>; calls: ToolCallTrace[]; traffic: TraceEntry[]; output: Record<string, unknown> };

  before(async () => {
    await useFakeServices();
    let mark = traceMark();
    const w = await runWorker('Review gate test', `${BRIEF_MARKER} Make four changes.`, {
      rounds: [
        [{ name: 'replace_in_note', args: { path: 'Notes/edit-approve.md', search: 'Line B', replace: 'Line B, edited by a worker' } }],
        [{ name: 'replace_in_note', args: { path: 'Notes/edit-reject.md', search: 'Line B', replace: 'REVIEW-REJECT wipe' } }],
        [{ name: 'delete_obsidian_note', args: { path: 'Notes/delete-approve.md' } }],
        [{ name: 'delete_obsidian_note', args: { path: 'Notes/delete-reject.md' } }],
      ],
    });
    writes = { task: w.task, calls: toolCalls(w.scriptId, mark), traffic: traceSince(mark) };

    const bridged = await browser.executeObsidian(({ plugins }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (plugins.voiceAgent as any).mcp.bridgedTools().map((b: any) => ({ name: b.exposedName, server: b.server.name })),
    );
    const mcp = bridged.find((b: { server: string }) => b.server === 'fake-modern')?.name ?? 'missing_mcp_tool';
    const js = `
const out = {};
// Tools return structured values in code mode; keep text as is and serialise the rest.
const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v));
out.read = fmt(await tools.read_file({ path: 'Notes/scratch.md' })).slice(0, 300);
out.created = fmt(await tools.create_obsidian_note({ path: 'Agent output/codemode-created.md', content: 'CREATED-BY-CODEMODE' })).slice(0, 300);
try { out.edited = fmt(await tools.replace_in_note({ path: 'Notes/codemode-edit.md', search: 'Original line', replace: 'EDITED-BY-CODEMODE' })).slice(0, 600); } catch (e) { out.edited = 'THREW: ' + String(e); }
out.net = {};
const probes = {
  fetch: async () => { await fetch('${FAKE_URL}/v1/models'); },
  xhr: async () => { const x = new XMLHttpRequest(); x.open('GET', '${FAKE_URL}/v1/models'); x.send(); },
  websocket: async () => { new WebSocket('ws://127.0.0.1:1'); },
  importScripts: async () => { importScripts('${FAKE_URL}/v1/models'); },
};
for (const [k, f] of Object.entries(probes)) { try { await f(); out.net[k] = 'ALLOWED'; } catch (e) { out.net[k] = 'BLOCKED: ' + String(e).slice(0, 120); } }
try { out.mcp = fmt(await tools.call(${JSON.stringify(mcp)}, { term: 'codemode' })).slice(0, 300); } catch (e) { out.mcp = 'THREW: ' + String(e); }
return JSON.stringify(out);`;
    mark = traceMark();
    const c = await runWorker('Code mode limits test', 'Run the script.', { rounds: [[{ name: 'codemode', args: { code: js } }]] });
    const calls = toolCalls(c.scriptId, mark);
    const raw = calls.find(x => x.name === 'codemode')?.result ?? '';
    let output: Record<string, unknown> = {};
    try {
      const start = raw.indexOf('{');
      output = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
    } catch {
      output = { unparsed: raw };
    }
    code = { task: c.task, calls, traffic: traceSince(mark), output };
  });

  check('REV-1', 'Worker replaces a line in Notes/edit-approve.md; both fake reviewers approve', async ev => {
    ev.save('worker', writes);
    const call = writes.calls[0];
    expect(call?.result).toContain('Approved by both independent reviewers');
    expect(await readNote('Notes/edit-approve.md')).toContain('Line B, edited by a worker');
    const backups = await listFiles('Agent tasks/Backups');
    ev.save('backups', backups);
    const backup = backups.find(p => p.includes('edit-approve'));
    expect(backup).toBeDefined();
    const original = await readNote(backup!);
    expect(original).toContain('Line B');
    expect(original).not.toContain('edited by a worker');
    ev.note(`Edit applied after two approvals; the original was saved to ${backup}.`);
  });

  check('REV-2', 'Worker edit carrying the REVIEW-REJECT marker; the fake reviewers reject it', async ev => {
    const call = writes.calls[1];
    ev.save('tool-call', call);
    expect(call?.result).toMatch(/ReviewRejected|did not both approve/);
    expect(await readNote('Notes/edit-reject.md')).not.toContain('REVIEW-REJECT');
  });

  check('REV-3', 'Worker deletes Notes/delete-approve.md; both approve; it lands in the vault trash', async ev => {
    const call = writes.calls[2];
    ev.save('tool-call', call);
    expect(call?.result).toContain('Approved by both independent reviewers');
    expect(call?.result).toContain('Moved to the trash');
    expect(await readNote('Notes/delete-approve.md')).toBeNull();
    const trash = await listFiles('.trash');
    ev.save('trash', trash);
    expect(trash.some(p => p.includes('delete-approve'))).toBe(true);
  });

  check('REV-4', 'Worker tries to delete Notes/delete-reject.md (content carries REVIEW-REJECT)', async ev => {
    const call = writes.calls[3];
    ev.save('tool-call', call);
    expect(call?.result).toMatch(/ReviewRejected|did not both approve/);
    expect(await readNote('Notes/delete-reject.md')).toContain('must survive');
  });

  check('REV-5', 'Inspect every reviewer request the plugin sent for the four changes', async ev => {
    const reviews = reviewerRequests(writes.traffic);
    ev.save('reviewer-requests', reviews);
    expect(reviews.length).toBe(8);
    for (const r of reviews) {
      expect(r.roles).toEqual(['system', 'user']);
      expect(r.question).not.toContain(BRIEF_MARKER);
    }
    for (const note of ['edit-approve', 'edit-reject', 'delete-approve', 'delete-reject']) {
      expect(reviews.filter(r => r.question.includes(note)).length).toBe(2);
    }
    ev.note('Each change went to two separate requests holding only the reviewer instructions and the change; none saw the worker brief or history.');
  });

  check('CM-1', 'A code-mode script in a worker reads Notes/scratch.md and creates a note', async ev => {
    ev.save('codemode', code);
    expect(String(code.output.read)).toContain('alpha beta gamma');
    expect(await readNote('Agent output/codemode-created.md')).toContain('CREATED-BY-CODEMODE');
  });

  check('CM-2', 'The same script edits Notes/codemode-edit.md; the edit goes to the two reviewers', async ev => {
    const reviews = reviewerRequests(code.traffic).filter(r => r.question.includes('codemode-edit'));
    ev.save('codemode-reviews', reviews);
    // Code mode gets the structured result: review "policy:reviewers" is the two-reviewer approval.
    expect(String(code.output.edited)).toMatch(/"review":"policy:reviewers"|Approved by both independent reviewers/);
    expect(String(code.output.edited)).toContain('"applied":true');
    expect(reviews.length).toBe(2);
    expect(await readNote('Notes/codemode-edit.md')).toContain('EDITED-BY-CODEMODE');
  });

  check('CM-3', 'The script tries fetch, XMLHttpRequest, WebSocket and importScripts, then calls an MCP tool', async ev => {
    ev.save('network-probes', { net: code.output.net, mcp: code.output.mcp });
    const net = (code.output.net ?? {}) as Record<string, string>;
    for (const k of ['fetch', 'xhr', 'websocket', 'importScripts']) expect(net[k]).toMatch(/^BLOCKED/);
    expect(code.traffic.filter(e => e.service === 'llm-models').length).toBe(0);
    expect(String(code.output.mcp)).toContain('FAKE-MCP-RESULT');
    ev.note('All four network routes were blocked and no request reached the fake server; the MCP call went through.');
  });

  check('CM-4', 'In a plain build (no djs module embedded) the code mode result says it ran in the Web Worker fallback', async ev => {
    const raw = code.calls.find(x => x.name === 'codemode')?.result ?? '';
    ev.save('codemode-result', raw.slice(0, 1500));
    expect(raw).toMatch(/Web Worker fallback/);
    expect(raw).toMatch(/djs not used/);
    ev.note(`The result names its engine: ${(raw.match(/Web Worker fallback[^\n]*/)?.[0] ?? '').slice(0, 200)}`);
  });
});
