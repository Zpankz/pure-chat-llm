import { createPatch } from 'diff';
import { normalizePath, TFile } from 'obsidian';
import type { PureChatLLMChat } from '../core/Chat';
import type PureChatLLM from '../main';
import type { SubAgentWritePolicy } from '../types';
import { layerForRole } from '../tools/toolContract';
import { layerFetch, parseModelRef, resolveLayer } from './layers';
import type { LayerRequest, ResolvedLayer } from './layers';

export type WriteAction = 'create' | 'edit' | 'delete';

/** How one write is decided; see `writeRoute`. */
export type WriteRoute = 'user' | 'allow' | 'peer' | 'queue' | 'deny';

/** A change a sub-agent wants to make, as the reviewers see it. */
export interface WriteProposal {
  action: WriteAction;
  path: string;
  /** What the change is for, in the sub-agent's words. */
  instruction?: string;
  /** Unified diff for edits, the new note for creates, the note being removed for deletes. */
  change: string;
}

export interface PeerVerdict {
  approved: boolean;
  /** One line per reviewer. */
  verdicts: string[];
}

const REVIEWER_PROMPT =
  'You review one proposed change to a note in an Obsidian vault and decide whether it should be made. You see only the change. Approve when it is clearly correct, careful and limited to what it says it does. Reject when it loses information that looks valuable, damages structure (frontmatter, links, headings), is broader than its stated purpose, looks like a mistake, or you cannot tell. First line: APPROVE or REJECT. Second line: one short reason.';

const MAX_CHANGE_CHARS = 12000;

/**
 * How a reviewer question is sent. One place, so tests can stand in a fake model.
 */
export const reviewerTransport = {
  /**
   * Sends one reviewer request and returns the answer text.
   * @param plugin - Plugin.
   * @param layer - Reviewer's resolved layer.
   * @param request - The request.
   */
  ask: async (plugin: PureChatLLM, layer: ResolvedLayer, request: LayerRequest): Promise<string> =>
    (await layerFetch(plugin, layer, request)).content ?? '',
};

/**
 * The configured policy for a background worker's write (`allow`, `peer`, `review`, `deny`).
 * Chats with the user present don't use it; see `writeRoute`.
 * @param plugin - Plugin.
 * @param chat - Chat the tool runs in.
 * @param action - Create, edit or delete.
 */
export function writePolicy(
  plugin: PureChatLLM,
  chat: PureChatLLMChat | undefined,
  action: WriteAction,
): SubAgentWritePolicy {
  if (chat?.role !== 'subagent') return 'review';
  return plugin.settings.orchestrator?.writes?.[action] ?? (action === 'create' ? 'allow' : 'peer');
}

/**
 * How a write is decided:
 * - `user`: the user is present (a note chat, direct voice, code mode run from either) and
 *   reviews it in the Edit Review window first.
 * - `allow`, `peer`, `deny`: a background worker's configured policy.
 * - `queue`: a background worker whose policy is "ask me". Nobody may be watching, so the
 *   change is saved as a proposal note for the user to review later; no window is opened.
 *
 * The orchestrator agent runs in the background too and has no write tools, so a write from it
 * is refused rather than shown in a window.
 * @param plugin - Plugin.
 * @param chat - Chat the tool runs in.
 * @param action - Create, edit or delete.
 */
export function writeRoute(
  plugin: PureChatLLM,
  chat: PureChatLLMChat | undefined,
  action: WriteAction,
): WriteRoute {
  switch (layerForRole(chat?.role)) {
    case 'worker': {
      const policy = writePolicy(plugin, chat, action);
      return policy === 'review' ? 'queue' : policy;
    }
    case 'orchestrator':
      return 'deny';
    default:
      return 'user';
  }
}

/**
 * Builds what the reviewers see for a proposed change.
 * @param plugin - Plugin.
 * @param path - Note path.
 * @param newContent - Proposed content (ignored for deletes).
 * @param instruction - Stated purpose.
 * @param action - Kind of change.
 */
export async function buildProposal(
  plugin: PureChatLLM,
  path: string,
  newContent: string,
  instruction: string | undefined,
  action: WriteAction,
): Promise<WriteProposal> {
  const file = plugin.app.vault.getAbstractFileByPath(normalizePath(path));
  const original = file instanceof TFile ? await plugin.app.vault.cachedRead(file) : '';
  const change =
    action === 'edit'
      ? createPatch(path, original, newContent)
      : action === 'delete'
        ? original
        : newContent;
  return { action, path, instruction, change: clip(change) };
}

/**
 * Two independent reviewers decide on a change. Each gets a fresh conversation holding only the
 * question and the change (no task brief, no history, nothing from the other reviewer), and
 * they run at the same time. The change is approved only when both answer APPROVE; an error, a
 * timeout or an unclear answer counts as a rejection.
 * @param plugin - Plugin.
 * @param proposal - The change.
 */
export async function peerReview(
  plugin: PureChatLLM,
  proposal: WriteProposal,
): Promise<PeerVerdict> {
  const settings = plugin.settings.orchestrator;
  const named = settings.reviewerModels
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
  const worker = settings.layers.worker;
  // `model@Endpoint name` picks another provider; a bare model runs on the worker's endpoint.
  const layerFor = (ref: string | undefined): ResolvedLayer => {
    if (!ref) return resolveLayer(plugin, 'worker');
    const { model, endpoint } = parseModelRef(ref);
    return resolveLayer(plugin, { ...worker, endpoint: endpoint || worker.endpoint }, model);
  };
  const layers = [layerFor(named[0]), layerFor(named[1] ?? named[0])];
  const question = describe(proposal);

  const ask = async (layer: ResolvedLayer, n: number): Promise<{ ok: boolean; line: string }> => {
    let timer = 0;
    try {
      // A fresh request each time: the reviewer sees only its instructions and the change.
      const answer = reviewerTransport
        .ask(plugin, layer, {
          max_completion_tokens: 200,
          messages: [
            { role: 'system', content: REVIEWER_PROMPT },
            { role: 'user', content: question },
          ],
        })
        .then(r => r.trim());
      const timeout = new Promise<string>(resolve => {
        timer = window.setTimeout(() => resolve('REJECT\nNo answer in time.'), 120_000);
      });
      const text = await Promise.race([answer, timeout]);
      const ok = /^\W*approve\b/i.test(text);
      const reason = text.split('\n').slice(1).join(' ').trim() || text.slice(0, 200);
      return {
        ok,
        line: `Reviewer ${n}: ${ok ? 'approved' : 'rejected'}${reason ? ` (${reason.slice(0, 240)})` : ''}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, line: `Reviewer ${n}: no verdict (${message.slice(0, 160)})` };
    } finally {
      window.clearTimeout(timer);
    }
  };

  const results = await Promise.all(layers.map((l, i) => ask(l, i + 1)));
  return { approved: results.every(r => r.ok), verdicts: results.map(r => r.line) };
}

/** @param proposal - The change. */
function describe(proposal: WriteProposal): string {
  const what =
    proposal.action === 'delete'
      ? `Should this note be deleted (moved to the trash)?\n\nNote: ${proposal.path}`
      : proposal.action === 'edit'
        ? `Should this edit be made?\n\nNote: ${proposal.path}`
        : `Should this note be created?\n\nNote: ${proposal.path}`;
  const purpose = proposal.instruction ? `\nStated purpose: ${proposal.instruction}` : '';
  const label =
    proposal.action === 'delete'
      ? 'Current content'
      : proposal.action === 'edit'
        ? 'Diff'
        : 'Content';
  return `${what}${purpose}\n\n${label}:\n${proposal.change}`;
}

/** @param text - Text to keep within the reviewers' budget. */
function clip(text: string): string {
  if (text.length <= MAX_CHANGE_CHARS) return text;
  const head = Math.floor(MAX_CHANGE_CHARS * 0.7);
  return `${text.slice(0, head)}\n…[${text.length - MAX_CHANGE_CHARS} characters omitted]…\n${text.slice(-(MAX_CHANGE_CHARS - head))}`;
}

/**
 * Copies a note into the task folder before an approved edit, so it can be restored.
 * @param plugin - Plugin.
 * @param path - Note path.
 */
export async function backupNote(plugin: PureChatLLM, path: string): Promise<string | null> {
  const { taskFolder, backupEdits } = plugin.settings.orchestrator;
  if (!backupEdits || !taskFolder.trim()) return null;
  const vault = plugin.app.vault;
  const file = vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) return null;
  const dir = normalizePath(`${taskFolder.trim()}/Backups`);
  if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => undefined);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = normalizePath(`${dir}/${stamp} ${file.basename}.${file.extension}`);
  await vault.create(target, await vault.read(file));
  return target;
}
