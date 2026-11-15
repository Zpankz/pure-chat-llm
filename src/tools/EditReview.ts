import { applyPatch, createPatch } from 'diff';
import { App, Modal, normalizePath, Setting, TextAreaComponent, TFile, TFolder } from 'obsidian';
import type { PureChatLLMChat } from '../core/Chat';
import { backupNote, buildProposal, peerReview, writeRoute } from '../agents/peerReview';
import type { WriteAction } from '../agents/peerReview';
import { jsonResult, toolError, wantsJson } from './toolContract';

/**
 * Every note write from a tool goes through `submitWrite`, which decides who reviews it, and
 * then `applyNoteWrite` or `applyNoteDelete`, which make the change.
 *
 * - A chat with the user present: the Edit Review window asks the user first.
 * - A background worker: the write policy in settings (write straight away, two independent
 *   reviewers, save as a proposal for the user, or refuse). A worker never opens a window,
 *   because nobody may be there to answer it.
 * - Deletes always go to the trash.
 */

/** Who decided a write, as reported in tool output. */
export type WriteReview = 'user' | 'policy:allow' | 'policy:reviewers' | 'policy:window' | 'denied';

/** A change a tool wants to make. */
export interface WriteRequest {
  /** `write` creates or edits (whichever the note needs); `delete` moves it to the trash. */
  kind: 'write' | 'delete';
  path: string;
  /** Full new content, for writes. */
  content?: string;
  /** Frontmatter properties to merge, for writes. */
  properties?: Record<string, unknown>;
  /** Whether an existing note may be changed. */
  overwrite?: boolean;
  /** What the change does, in a few words. Shown to reviewers and in the window. */
  instruction: string;
  /** Why the caller makes it, in its own words. Shown to reviewers. */
  reason?: string;
  /** The text the change was computed from. Read now when not given. */
  original?: string | null;
  /** The caller's signal (the chat's `abortSignal` is used too): once aborted, nothing is written. */
  signal?: AbortSignal;
}

/** What became of a write. */
export interface WriteOutcome {
  /** False when the call failed (`error` holds the tool error). */
  ok: boolean;
  /** Whether the vault was changed. */
  applied: boolean;
  action: WriteAction;
  path: string;
  review: WriteReview;
  /** Copy of the note saved before an edit. */
  backup?: string;
  /** Proposal note saved for the user's review instead of writing. */
  proposal?: string;
  /** Reviewer verdict lines. */
  verdicts?: string[];
  linesBefore?: number;
  linesAfter?: number;
  /** The user changed the content in the window before approving. */
  edited?: boolean;
  /** The note changed during review and the edit was applied on top of those changes. */
  merged?: boolean;
  /** Tool error text when `ok` is false. */
  error?: string;
}

/** The user's answer in a review window. */
interface Decision {
  approved: boolean;
  cancelled?: boolean;
  /** Content as approved (the user may edit it). */
  content?: string;
}

const lines = (text: string | null | undefined): number => (text ? text.split('\n').length : 0);

/**
 * Decides and makes one write. Writes to the same note take turns: a second one waits until
 * the first has been reviewed and applied, so two reviews of one note are never in flight.
 * @param chat - Chat the tool runs in (its role picks the review route).
 * @param request - The change.
 */
export async function submitWrite(
  chat: PureChatLLMChat,
  request: WriteRequest,
): Promise<WriteOutcome> {
  // A run that stops (code mode timing out, a worker cancelled) must not leave a write to land
  // later: the run's signal is checked while waiting, after review and right before writing.
  const signal = anySignal(
    request.signal,
    (chat as { abortSignal?: AbortSignal } | undefined)?.abortSignal,
  );
  return withNoteLock(normalizePath(request.path), signal, () =>
    decideAndWrite(chat, { ...request, signal }),
  );
}

/**
 * One signal that aborts when any of the given ones does.
 * @param signals - Signals, some possibly missing.
 */
function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => !!s);
  if (list.length < 2) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) controller.abort();
    else s.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Resolves when the signal aborts (never, without one).
 * @param signal - Signal.
 */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** The tool error for a write whose run stopped first. */
const cancelledError = (path: string) =>
  toolError('Cancelled', `The run stopped before "${path}" was written. Nothing changed.`);

/** Per-note queue of writes in review. */
const noteLocks = new Map<string, Promise<void>>();

/**
 * Runs `fn` once earlier writes to the same note have finished, or as soon as the signal
 * aborts (`fn` then sees the aborted signal and writes nothing).
 * @param path - Note path.
 * @param signal - The run's signal.
 * @param fn - The write.
 */
async function withNoteLock<T>(
  path: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.toLowerCase();
  const before = noteLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>(resolve => (release = resolve));
  const chain = before.then(() => mine);
  noteLocks.set(key, chain);
  try {
    await Promise.race([before, whenAborted(signal)]);
    return await fn();
  } finally {
    release();
    if (noteLocks.get(key) === chain) noteLocks.delete(key);
  }
}

/**
 * Routes one write and makes it.
 * @param chat - Chat the tool runs in.
 * @param request - The change.
 */
async function decideAndWrite(chat: PureChatLLMChat, request: WriteRequest): Promise<WriteOutcome> {
  const plugin = chat.plugin;
  const app = plugin.app;
  const path = normalizePath(request.path);
  const existing = app.vault.getAbstractFileByPath(path);
  const action: WriteAction = request.kind === 'delete' ? 'delete' : existing ? 'edit' : 'create';
  const fail = (review: WriteReview, error: string, extra: Partial<WriteOutcome> = {}) =>
    ({ ok: false, applied: false, action, path, review, error, ...extra }) as WriteOutcome;

  const signal = request.signal;
  if (signal?.aborted) return fail('denied', cancelledError(path));
  if (existing && !(existing instanceof TFile)) {
    return fail('denied', toolError('InvalidPath', `"${path}" is a folder, not a note.`));
  }
  if (action === 'delete' && !existing) {
    return fail('denied', toolError('NotFound', `No note at "${path}".`, ['glob_vault_files']));
  }
  if (action === 'edit' && request.kind === 'write' && !request.overwrite) {
    return fail(
      'denied',
      toolError('FileExists', `"${path}" already exists and overwrite is off.`, [
        `read_file("${path}") to see it`,
        'overwrite: true to replace it, or another path',
      ]),
    );
  }
  const original =
    request.original !== undefined
      ? request.original
      : existing instanceof TFile
        ? await app.vault.read(existing)
        : null;
  const content = request.content ?? '';
  const apply = (text: string) =>
    action === 'delete'
      ? applyNoteDelete(app, path, signal)
      : applyNoteWrite(app, {
          path,
          content: text,
          properties: request.properties,
          overwrite: !!request.overwrite,
          original,
          signal,
        });

  const route = writeRoute(plugin, chat, action);
  if (route === 'deny') {
    const what = { create: 'create notes', edit: 'edit existing notes', delete: 'delete notes' };
    return fail(
      'denied',
      toolError(
        'WriteDenied',
        `${chat.role === 'subagent' ? 'Background tasks' : 'This agent'} can't ${what[action]} (plugin setting). Nothing changed.`,
        ['Describe the change you wanted in your report instead.'],
      ),
    );
  }

  if (route === 'queue') {
    if (signal?.aborted) return fail('policy:window', cancelledError(path));
    const proposal = await queueProposal(chat, { ...request, path }, action, original);
    logReview(chat, `Saved the ${action} of ${path} as a proposal for the user: ${proposal}`);
    return { ok: true, applied: false, action, path, review: 'policy:window', proposal };
  }

  if (route === 'user') {
    const decision = await new Promise<Decision>(resolve => {
      const modal =
        action === 'delete'
          ? new DeleteReviewModal(app, path, request.instruction, resolve)
          : new EditReviewModal(app, path, original, content, request, resolve);
      modal.open();
      // If the run stops while the window is open, close it unanswered.
      void whenAborted(signal).then(() => modal.cancel());
    });
    if (signal?.aborted) return fail('user', cancelledError(path));
    if (decision.cancelled) {
      return fail(
        'user',
        toolError(
          'ReviewCancelled',
          `The review window for "${path}" was closed. Nothing changed.`,
        ),
      );
    }
    if (!decision.approved) {
      return fail(
        'user',
        toolError(
          'UserRejected',
          `The user rejected the ${action} of "${path}". Nothing changed.`,
          ['Ask the user what they want instead.'],
        ),
      );
    }
    const approved = decision.content ?? content;
    const result = await apply(approved);
    if (!result.ok) return fail('user', result.error);
    return {
      ok: true,
      applied: true,
      action,
      path,
      review: 'user',
      linesBefore: lines(original),
      linesAfter: action === 'delete' ? 0 : lines(result.content ?? approved),
      ...(approved !== content ? { edited: true } : {}),
      ...(result.merged ? { merged: true } : {}),
    };
  }

  let backup: string | undefined;
  let verdicts: string[] | undefined;
  if (route === 'peer') {
    const proposal = await buildProposal(plugin, path, content, request.instruction, action);
    const verdict = await peerReview(plugin, proposal);
    verdicts = verdict.verdicts;
    logReview(chat, `${action} ${path}`, verdict.approved, verdict.verdicts);
    if (!verdict.approved) {
      return fail(
        'policy:reviewers',
        toolError(
          'ReviewRejected',
          `The two reviewers did not both approve the ${action} of "${path}". Nothing changed.`,
          [...verdict.verdicts, 'Revise the change or ask the orchestrator.'],
        ),
        { verdicts },
      );
    }
    if (signal?.aborted) return fail('policy:reviewers', cancelledError(path), { verdicts });
    if (action === 'edit') backup = (await backupNote(plugin, path).catch(() => null)) ?? undefined;
  }
  const review: WriteReview = route === 'peer' ? 'policy:reviewers' : 'policy:allow';
  const result = await apply(content);
  if (!result.ok) return fail(review, result.error, { verdicts, backup });
  return {
    ok: true,
    applied: true,
    action,
    path,
    review,
    linesBefore: lines(original),
    linesAfter: action === 'delete' ? 0 : lines(result.content ?? content),
    ...(backup ? { backup } : {}),
    ...(verdicts ? { verdicts } : {}),
    ...(result.merged ? { merged: true } : {}),
  };
}

/**
 * Records a reviewer decision or a queued proposal on the worker's task.
 * @param chat - Sub-agent chat.
 * @param what - The change.
 * @param approved - Outcome, for reviewer decisions.
 * @param verdicts - Reviewer lines.
 */
export function logReview(
  chat: PureChatLLMChat | undefined,
  what: string,
  approved = true,
  verdicts: string[] = [],
): void {
  const id = chat?.subAgentTaskId;
  if (!id || !chat) return;
  const line = verdicts.length
    ? `Review of ${what}: ${approved ? 'approved' : 'rejected'}. ${verdicts.join(' ')}`
    : what;
  chat.plugin.agents?.report(id, line);
}

/**
 * Formats a write's outcome for the model: a one-line summary first, then a few facts; or one
 * JSON object with stable keys when the caller asked for `format: "json"`. A failed write
 * returns its tool error (with the JSON object on the last line in JSON mode).
 * @param outcome - What happened.
 * @param args - Tool arguments (`format`).
 * @param done - Past-tense summary of the change, such as `Created "a.md"`.
 * @param extra - Tool-specific JSON keys.
 * @param next - Suggested next calls, for text output.
 */
export function renderWrite(
  outcome: WriteOutcome,
  args: { format?: unknown },
  done: string,
  extra: Record<string, unknown> = {},
  next: string[] = [],
): string {
  const json = {
    ok: outcome.ok,
    action: outcome.action,
    path: outcome.path,
    applied: outcome.applied,
    review: outcome.review,
    ...(outcome.backup ? { backup: outcome.backup } : {}),
    ...(outcome.proposal ? { proposal: outcome.proposal } : {}),
    ...(outcome.edited ? { edited: true } : {}),
    ...(outcome.merged ? { merged: true } : {}),
    ...(outcome.applied && outcome.action !== 'delete'
      ? { lines_before: outcome.linesBefore ?? 0, lines_after: outcome.linesAfter ?? 0 }
      : {}),
    ...extra,
  };
  if (!outcome.ok) {
    const error = outcome.error ?? toolError('WriteFailed', `Could not write "${outcome.path}".`);
    return wantsJson(args) ? `${error}\n${jsonResult(json)}` : error;
  }
  if (wantsJson(args)) return jsonResult(json);
  if (!outcome.applied) {
    return [
      `Not written yet: the ${outcome.action} of "${outcome.path}" was saved as a proposal for the user to review.`,
      `Proposal: ${outcome.proposal}`,
      'Mention it in your report; the note itself is unchanged.',
    ].join('\n');
  }
  const reviewed = {
    user: outcome.edited
      ? 'Approved by the user, who edited it first; read the note before changing it again.'
      : 'Approved by the user.',
    'policy:allow': 'Written directly (background write policy).',
    'policy:reviewers': 'Approved by both independent reviewers.',
    'policy:window': '',
    denied: '',
  }[outcome.review];
  const out = [`${done}.`, reviewed];
  if (outcome.action === 'delete') out.push('Moved to the trash, so it can be restored.');
  else out.push(`Lines: ${outcome.linesBefore ?? 0} -> ${outcome.linesAfter ?? 0}`);
  if (outcome.backup) out.push(`Backup: ${outcome.backup}`);
  if (next.length) out.push(`Next: ${next.join('; ')}`);
  return out.filter(Boolean).join('\n');
}

/** Result of making a change. */
export type ApplyResult =
  | {
      ok: true;
      /** The text written, when it was a note write. */
      content?: string;
      /** The note had changed and the edit was applied on top of the changes. */
      merged?: boolean;
    }
  | { ok: false; error: string };

/**
 * Two lines of context: enough to place a hunk, few enough that edits to nearby sections
 * (two lines apart) still merge.
 */
const PATCH = { context: 2 };

/**
 * The text to write when an edit computed from `original` meets the note's `current` text:
 * the edit as is when nothing changed, the edit applied as a patch on top of the changes when
 * it applies cleanly, otherwise null (a conflict).
 * @param path - Note path, for the patch header.
 * @param original - Text the edit was computed from; undefined or null replaces outright.
 * @param content - Edited text.
 * @param current - The note's text now.
 */
export function rebase(
  path: string,
  original: string | null | undefined,
  content: string,
  current: string,
): string | null {
  if (original === undefined || original === null || current === original) return content;
  if (current === content) return content;
  const patched = applyPatch(
    current,
    createPatch(path, original, content, undefined, undefined, PATCH),
  );
  return patched === false ? null : patched;
}

/** A write to make. */
export interface NoteWrite {
  path: string;
  content: string;
  properties?: Record<string, unknown>;
  /** Whether an existing note may be replaced. */
  overwrite: boolean;
  /** The text the change was computed from (null for a new note). */
  original?: string | null;
  /** The run's signal: once aborted, nothing is written (Cancelled). */
  signal?: AbortSignal;
}

/**
 * Writes a note, creating folders as needed, and merges frontmatter properties. Checks the
 * run's signal right before writing, so a run that stopped during review leaves no write.
 * @param app - Obsidian app.
 * @param write - The write.
 */
export async function applyNoteWrite(app: App, write: NoteWrite): Promise<ApplyResult> {
  const path = normalizePath(write.path);
  let written = write.content;
  let merged = false;
  if (write.signal?.aborted) return { ok: false, error: cancelledError(path) };
  try {
    const folders = path.split('/').slice(0, -1);
    let current = '';
    for (const folder of folders) {
      current = current ? `${current}/${folder}` : folder;
      const found = app.vault.getAbstractFileByPath(current);
      if (!found) await app.vault.createFolder(current);
      else if (!(found instanceof TFolder)) {
        return {
          ok: false,
          error: toolError('InvalidPath', `"${current}" is a file, so it can't hold "${path}".`, [
            'Choose another path.',
          ]),
        };
      }
    }
    const existing = app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing) {
      if (!(existing instanceof TFile)) {
        return { ok: false, error: toolError('InvalidPath', `"${path}" is a folder.`) };
      }
      if (!write.overwrite) {
        return {
          ok: false,
          error: toolError('FileExists', `"${path}" already exists and overwrite is off.`, [
            'overwrite: true to replace it, or another path',
          ]),
        };
      }
      // The note may have changed while the edit was in review (the user typing, another
      // tool). Apply the edit as a patch against the text it was made from; if that patch no
      // longer applies cleanly, refuse rather than overwrite the newer text.
      let conflict = false;
      let stopped = false;
      await app.vault.process(existing, current => {
        if (write.signal?.aborted) {
          stopped = true;
          return current;
        }
        const next = rebase(path, write.original, write.content, current);
        if (next === null) {
          conflict = true;
          return current;
        }
        if (next !== write.content) merged = true;
        written = next;
        return next;
      });
      if (stopped) return { ok: false, error: cancelledError(path) };
      if (conflict) {
        return {
          ok: false,
          error: toolError(
            'Conflict',
            `"${path}" changed during review and the edit no longer fits. Nothing was written.`,
            ['Read the note again and redo the change.'],
          ),
        };
      }
      file = existing;
    } else {
      if (write.signal?.aborted) return { ok: false, error: cancelledError(path) };
      file = await app.vault.create(path, write.content);
    }
    if (write.properties && Object.keys(write.properties).length) {
      await app.fileManager.processFrontMatter(file, frontmatter => {
        Object.assign(frontmatter, write.properties);
      });
    }
    return { ok: true, content: written, ...(merged ? { merged } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: toolError('FileSystemError', `Could not save "${path}": ${message}`, [
        'Check the path and try again.',
      ]),
    };
  }
}

/**
 * Moves a note to the trash (system or vault `.trash`, per the user's Obsidian setting).
 * @param app - Obsidian app.
 * @param path - Note path.
 * @param signal - The run's signal; once aborted, nothing is deleted.
 */
export async function applyNoteDelete(
  app: App,
  path: string,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  if (signal?.aborted) return { ok: false, error: cancelledError(path) };
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) {
    return { ok: false, error: toolError('NotFound', `No note at "${path}" any more.`) };
  }
  try {
    await app.fileManager.trashFile(file);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: toolError('DeleteError', `Could not trash "${path}": ${message}`) };
  }
}

const PROPOSAL_KEY = 'voice-agent-proposal';

/**
 * Saves a worker's change as a proposal note in the task folder, for the user to review later
 * with `reviewProposal`.
 * @param chat - Worker chat.
 * @param request - The change.
 * @param action - Create, edit or delete.
 * @param original - The note's text now.
 */
async function queueProposal(
  chat: PureChatLLMChat,
  request: WriteRequest,
  action: WriteAction,
  original: string | null,
): Promise<string> {
  const vault = chat.plugin.app.vault;
  const root = chat.plugin.settings.orchestrator?.taskFolder?.trim() || 'Agent tasks';
  const dir = normalizePath(`${root}/Proposals`);
  if (!vault.getAbstractFileByPath(root)) await vault.createFolder(root).catch(() => undefined);
  if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => undefined);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = request.path.split('/').pop()?.replace(/\.md$/, '') ?? 'note';
  let target = normalizePath(`${dir}/${stamp} ${action} ${name}.md`);
  for (let n = 2; vault.getAbstractFileByPath(target); n++) {
    target = normalizePath(`${dir}/${stamp} ${action} ${name} ${n}.md`);
  }
  const content = request.content ?? '';
  const parts = [
    '---',
    `${PROPOSAL_KEY}: ${action}`,
    `target: ${JSON.stringify(request.path)}`,
    'status: pending',
    '---',
    `# Proposed ${action} of ${request.path}`,
    '',
    `A background task wants to ${action} this note. Nothing has changed yet.`,
    `What it does: ${request.instruction}`,
  ];
  if (request.reason) parts.push(`Why: ${request.reason}`);
  if (action === 'edit') {
    parts.push(
      '',
      '## Diff',
      '',
      fenced(
        createPatch(request.path, original ?? '', content, undefined, undefined, PATCH),
        'diff',
      ),
    );
  }
  if (action !== 'delete') {
    if (request.properties && Object.keys(request.properties).length) {
      parts.push('', '## Properties', '', fenced(JSON.stringify(request.properties), 'json'));
    }
    parts.push('', '## Proposed content', '', fenced(content, 'markdown'));
  }
  await vault.create(target, parts.join('\n') + '\n');
  return target;
}

/**
 * A fenced block long enough to hold any backtick run in the text.
 * @param text - Block content.
 * @param lang - Info string.
 */
function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * Opens a proposal that a background task saved, in the review window, and applies it on
 * approval. Meant for a command the user runs; the user is present.
 * @param app - Obsidian app.
 * @param proposalPath - The proposal note.
 */
export async function reviewProposal(app: App, proposalPath: string): Promise<WriteOutcome> {
  const file = app.vault.getAbstractFileByPath(normalizePath(proposalPath));
  const base = { ok: false, applied: false, path: proposalPath, review: 'user' as const };
  if (!(file instanceof TFile)) {
    return { ...base, action: 'edit', error: toolError('NotFound', 'No such proposal.') };
  }
  const text = await app.vault.read(file);
  const action = /^voice-agent-proposal: (create|edit|delete)$/m.exec(text)?.[1] as
    | WriteAction
    | undefined;
  const targetLine = /^target: (.*)$/m.exec(text)?.[1];
  if (!action || !targetLine || !/^status: pending$/m.test(text)) {
    return {
      ...base,
      action: action ?? 'edit',
      error: toolError('NotPending', 'This note is not a pending proposal.'),
    };
  }
  const path = String(JSON.parse(targetLine));
  let content = /## Proposed content\n\n(`{3,})markdown\n([\s\S]*)\n\1\s*$/.exec(text)?.[2] ?? '';
  const propsText = /## Properties\n\n(`{3,})json\n([\s\S]*?)\n\1/.exec(text)?.[2];
  const properties = propsText ? (JSON.parse(propsText) as Record<string, unknown>) : undefined;
  const target = app.vault.getAbstractFileByPath(path);
  const original = target instanceof TFile ? await app.vault.read(target) : null;
  const diff = /## Diff\n\n(`{3,})diff\n([\s\S]*?)\n\1/.exec(text)?.[2];
  if (action === 'edit' && diff && original !== null) {
    // The note may have changed since the proposal was saved: replay the diff on today's text.
    const patched = applyPatch(original, `${diff}\n`);
    if (patched === false) {
      return {
        ...base,
        action,
        path,
        error: toolError('Conflict', `"${path}" has changed and the proposal no longer fits.`),
      };
    }
    content = patched;
  }
  const instruction = /^What it does: (.*)$/m.exec(text)?.[1] ?? 'Proposed by a background task';
  const decision = await new Promise<Decision>(resolve => {
    const modal =
      action === 'delete'
        ? new DeleteReviewModal(app, path, instruction, resolve)
        : new EditReviewModal(app, path, original, content, { properties, instruction }, resolve);
    modal.open();
  });
  const mark = (status: string) =>
    app.vault.process(file, data => data.replace(/^status: pending$/m, `status: ${status}`));
  if (!decision.approved) {
    if (!decision.cancelled) await mark('rejected');
    return {
      ...base,
      action,
      path,
      error: toolError(decision.cancelled ? 'ReviewCancelled' : 'UserRejected', 'Not applied.'),
    };
  }
  const approved = decision.content ?? content;
  const result =
    action === 'delete'
      ? await applyNoteDelete(app, path)
      : await applyNoteWrite(app, {
          path,
          content: approved,
          properties,
          overwrite: true,
          original,
        });
  if (!result.ok) return { ...base, action, path, error: result.error };
  await mark('applied');
  return { ok: true, applied: true, action, path, review: 'user' };
}

/** A review window that resolves once, whichever way it closes. */
abstract class ReviewModal extends Modal {
  private settled = false;

  /**
   * @param app - Obsidian app.
   * @param onDecision - Receives the user's answer.
   */
  constructor(
    app: App,
    private onDecision: (decision: Decision) => void,
  ) {
    super(app);
  }

  /**
   * Records the answer and closes the window.
   * @param decision - The answer.
   */
  protected settle(decision: Decision): void {
    if (this.settled) return;
    this.settled = true;
    this.onDecision(decision);
    this.close();
  }

  /** Approves the change as shown. */
  abstract approve(): void;

  /** Rejects the change. */
  reject(): void {
    this.settle({ approved: false });
  }

  /** Closes the window without an answer. */
  cancel(): void {
    this.settle({ approved: false, cancelled: true });
  }

  /** Closing the window without an answer cancels. */
  onClose(): void {
    this.contentEl?.empty();
    this.cancel();
  }
}

/** The Edit Review window: a diff and the proposed content, which the user may edit. */
class EditReviewModal extends ReviewModal {
  /**
   * @param app - Obsidian app.
   * @param path - Note path.
   * @param original - Current text, or null for a new note.
   * @param content - Proposed text.
   * @param details - Properties and what the change does.
   * @param details.properties - Frontmatter properties to merge.
   * @param details.instruction - What the change does.
   * @param onDecision - Receives the user's answer.
   */
  constructor(
    app: App,
    private path: string,
    private original: string | null,
    private content: string,
    private details: { properties?: Record<string, unknown>; instruction?: string },
    onDecision: (decision: Decision) => void,
  ) {
    super(app, onDecision);
  }

  /** Approves the (possibly edited) content. */
  approve(): void {
    this.settle({ approved: true, content: this.content });
  }

  /** Shows the change. */
  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Review proposed edit' });
    if (this.details.instruction) {
      contentEl.createEl('p', {
        text: `Goal: ${this.details.instruction}`,
        cls: 'edit-instruction',
      });
    }
    contentEl.createEl('h4', { text: `File: ${this.path}` });
    const properties = this.details.properties;
    if (properties && Object.keys(properties).length > 0) {
      new Setting(contentEl)
        .setName('Frontmatter properties')
        .setDesc('These properties will be added or updated.')
        .setHeading();
      contentEl.createEl('pre').createEl('code', { text: JSON.stringify(properties, null, 2) });
    }
    new Setting(contentEl).setName('Changes').setHeading();
    const diff = contentEl.createEl('div');
    diff.addClass('diff-container');
    if (this.original !== null) {
      for (const line of createPatch(this.path, this.original, this.content).split('\n')) {
        const div = diff.createEl('div');
        div.addClass(
          line.startsWith('+')
            ? 'diff-added'
            : line.startsWith('-')
              ? 'diff-removed'
              : line.startsWith('@@')
                ? 'diff-hunk'
                : 'diff-equal',
        );
        div.setText(line);
      }
    } else {
      diff.createEl('div').setText('New file - no diff available');
    }
    new Setting(contentEl).setName('Proposed content').setHeading();
    const area = new TextAreaComponent(contentEl);
    area.setValue(this.content);
    area.inputEl.addClass('PUREcodePreview');
    area.onChange(value => {
      this.content = value;
    });
    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Approve and apply')
          .setCta()
          .onClick(() => this.approve()),
      )
      .addButton(btn => btn.setButtonText('Reject edit').onClick(() => this.reject()));
  }
}

/** Asks the user to confirm moving a note to the trash. */
class DeleteReviewModal extends ReviewModal {
  /**
   * @param app - Obsidian app.
   * @param path - Note path.
   * @param instruction - Why it is being deleted.
   * @param onDecision - Receives the user's answer.
   */
  constructor(
    app: App,
    private path: string,
    private instruction: string,
    onDecision: (decision: Decision) => void,
  ) {
    super(app, onDecision);
  }

  /** Approves the delete. */
  approve(): void {
    this.settle({ approved: true });
  }

  /** Shows the note's details. */
  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Confirm deletion' });
    const file = this.app.vault.getAbstractFileByPath(this.path);
    const details = contentEl.createEl('div', { cls: 'delete-details' });
    details.createEl('p', { text: `File: ${this.path}` });
    if (this.instruction) details.createEl('p', { text: `Goal: ${this.instruction}` });
    if (file instanceof TFile) {
      details.createEl('p', { text: `Size: ${formatSize(file.stat.size)}` });
      details.createEl('p', {
        text: `Last modified: ${new Date(file.stat.mtime).toLocaleString()}`,
      });
    }
    contentEl.createEl('p', {
      text: 'The note will be moved to the trash, where you can restore it.',
      cls: 'mod-warning',
    });
    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Delete')
          .setWarning()
          .onClick(() => this.approve()),
      )
      .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.reject()));
  }
}

/** @param bytes - Size in bytes. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
