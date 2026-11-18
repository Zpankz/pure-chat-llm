// The librarian: a consolidation pass the harness runs in the background, on the worker model,
// so capture no longer depends on a talking model choosing to call `memory_remember` (audit
// item 1). It reads what is new (transcript lines of a call, or a finished task's result) with
// the existing facts that best match it, and answers with strict JSON operations:
//
//   ADD      a new fact                         UPDATE  a new text for an existing fact (supersedes)
//   CONFIRM  an existing fact was said again    CLOSE   an existing fact is no longer true
//   NOOP     nothing to do
//
// each with a quote as evidence. At the end of a call it also writes the call's summary. The
// prompt building, the parsing and the applying are pure here; MemoryService runs the model.
import type { Embedded, FactKind, FactRow, MemoryGraph } from './MemoryGraph';
import { FACT_KINDS } from './MemoryGraph';
import { clipLine, localDate } from './text';

export const LIBRARIAN_OPS = ['ADD', 'UPDATE', 'CONFIRM', 'NOOP', 'CLOSE'] as const;
export type LibrarianOpKind = (typeof LIBRARIAN_OPS)[number];

export interface LibrarianOp {
  op: LibrarianOpKind;
  /** The existing fact's id, for UPDATE, CONFIRM and CLOSE. */
  id?: string;
  text?: string;
  kind?: FactKind;
  slot?: string;
  about?: string[];
  importance?: number;
  /** A short quote from the input. */
  evidence?: string;
  /** The transcript line the quote is from (L-number). */
  line?: number;
  /** Why, for CLOSE. */
  reason?: string;
}

export interface LibrarianOutput {
  /** Three to five sentences on the whole call (call passes only). */
  summary?: string;
  decisions?: string[];
  looseEnds?: string[];
  ops: LibrarianOp[];
}

/** One transcript line as the librarian sees it. */
export interface LibrarianLine {
  /** 1-based L-number. */
  n: number;
  who: 'You' | 'Agent' | 'Tool';
  at?: number;
  text: string;
}

export interface LibrarianInput {
  /** `turns`: lines from a call in progress; `call`: the end of a call; `task`: a finished task. */
  kind: 'turns' | 'call' | 'task';
  /** Transcript lines (turns and call). */
  lines?: LibrarianLine[];
  /** Lines before this L-number were already read by an earlier pass (call). */
  newFrom?: number;
  /** What else the call did, for its summary: topics and tasks with their outcome. */
  callContext?: string[];
  /** The finished task (task). */
  task?: { title: string; brief?: string; result: string; status?: string };
  /** Existing facts that best match the input. */
  facts: FactRow[];
  /** Today's date for the prompt, `YYYY-MM-DD`. */
  today?: string;
}

/** Most operations applied from one pass. */
export const MAX_OPS = 12;
/** Longest transcript text sent in one pass. */
const MAX_TRANSCRIPT_CHARS = 16_000;

export const LIBRARIAN_SYSTEM = [
  'You are the librarian of a shared memory that a voice assistant, its orchestrator and its background workers keep about the user and their Obsidian vault across sessions. You read what just happened and decide what the memory should keep. You never talk to the user.',
  'Answer with one JSON object and nothing else:',
  '{"summary": string, "decisions": string[], "loose_ends": string[], "ops": [{"op": "ADD"|"UPDATE"|"CONFIRM"|"CLOSE"|"NOOP", "id": string, "text": string, "kind": "fact"|"preference"|"instruction"|"decision"|"todo"|"observation", "slot": string, "about": string[], "importance": 1|2, "evidence": string, "line": number, "reason": string}]}',
  '- ADD a new fact worth keeping. UPDATE {id, text}: an existing fact changed or was corrected; text is the whole new fact. CONFIRM {id}: the input says an existing fact again. CLOSE {id, reason}: the input says an existing fact is no longer true. Use the ids of the existing facts exactly as given; never invent one.',
  '- Keep what a later session needs: how the user wants things done (preference, instruction), decisions, facts about people, projects and notes, results of work, and things left to do (todo). One fact per op, in plain words that stand on their own; name notes as [[Note name]] in about.',
  '- Leave out small talk, greetings, how the conversation went, steps of work in progress, and observations that only say how someone felt ("the user likes the new UI") unless they decided something.',
  '- Never keep passwords, keys, card, account or ID numbers. Keep health, money, beliefs or other sensitive personal details only when the user asked for them to be remembered.',
  '- evidence is a short quote (under 20 words) from the input; line is its L-number when the input has numbered lines.',
  '- importance 2 only for what the user stressed or what changes how every agent works; otherwise 1.',
  `- At most ${MAX_OPS - 4} ops; often none or one is right. When nothing is worth keeping, answer {"ops": []}.`,
  '- summary, decisions and loose_ends only when asked for; otherwise leave them out.',
].join('\n');

/**
 * The transcript, clipped to fit: the start and the newest part when it is long.
 * @param lines - Lines.
 */
function transcriptText(lines: LibrarianLine[]): string {
  const time = (at?: number) => {
    if (!at) return '';
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const rendered = lines.map(
    l => `L${l.n} ${l.who}${time(l.at)}: ${l.text.replace(/\s+/g, ' ').trim()}`,
  );
  let total = rendered.reduce((n, l) => n + l.length + 1, 0);
  if (total <= MAX_TRANSCRIPT_CHARS) return rendered.join('\n');
  // Keep the first lines (how the call started) and as many of the newest as fit.
  const head = rendered.slice(0, 4);
  const tail: string[] = [];
  total = head.reduce((n, l) => n + l.length + 1, 0) + 40;
  for (let i = rendered.length - 1; i >= head.length; i--) {
    const line = clipLine(rendered[i], 600);
    if (total + line.length + 1 > MAX_TRANSCRIPT_CHARS) break;
    tail.unshift(line);
    total += line.length + 1;
  }
  return [...head, '[… earlier lines left out …]', ...tail].join('\n');
}

/**
 * The librarian's messages for one pass.
 * @param input - What is new, and the facts it may repeat or change.
 */
export function librarianMessages(input: LibrarianInput): { system: string; user: string } {
  const parts: string[] = [`Today is ${input.today ?? localDate(Date.now())}.`];
  parts.push(
    input.facts.length
      ? [
          'Existing facts that may be repeated or changed (id in brackets):',
          ...input.facts.map(
            f =>
              `- [${f.key}] ${f.kind}: ${clipLine(f.text, 300)}${
                f.about.length ? ` (about ${f.about.slice(0, 4).join(', ')})` : ''
              }`,
          ),
        ].join('\n')
      : 'Existing facts that may be repeated or changed: none.',
  );
  if (input.kind === 'task' && input.task) {
    parts.push(
      [
        `A background task ${input.task.status === 'failed' ? 'failed' : 'finished'}: "${clipLine(input.task.title, 120)}".`,
        ...(input.task.brief ? [`Brief: ${clipLine(input.task.brief, 1500)}`] : []),
        `Result:\n${input.task.result.slice(0, 8000)}`,
        'Keep its findings that a later session needs (as facts about what it looked at), and any decisions or things left to do. No summary.',
      ].join('\n'),
    );
  } else {
    const lines = input.lines ?? [];
    parts.push(`Transcript of a voice call (You is the user):\n${transcriptText(lines)}`);
    if (input.kind === 'call') {
      if (input.callContext?.length)
        parts.push(['What else happened in the call:', ...input.callContext].join('\n'));
      parts.push(
        [
          input.newFrom && input.newFrom > 1
            ? `Lines before L${input.newFrom} were read by an earlier pass: take ops only from L${input.newFrom} on (CONFIRM is fine for earlier ones).`
            : 'Take ops from the whole call.',
          'The call has ended. Also write: summary (3 to 5 sentences: what the call was about, what was done, what was found), decisions (each a short sentence), loose_ends (what was left open or promised, each a short sentence).',
        ].join('\n'),
      );
    } else {
      parts.push('The call is still going. No summary.');
    }
  }
  return { system: LIBRARIAN_SYSTEM, user: parts.join('\n\n') };
}

/**
 * The JSON object in a model's answer: the whole text, a fenced block, or the outermost braces.
 * @param text - Model answer.
 */
function jsonObject(text: string): unknown {
  const trimmed = text.trim();
  const tries = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) tries.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) tries.push(trimmed.slice(first, last + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      // Try the next form.
    }
  }
  throw new Error('The librarian did not answer with JSON.');
}

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .map(v => clipLine(v, 300))
        .slice(0, max)
    : [];

/**
 * Parses and checks the librarian's answer. Unknown ops, ops without what they need and extra
 * fields are dropped; a text that isn't JSON throws.
 * @param text - Model answer.
 */
export function parseLibrarianOutput(text: string): LibrarianOutput {
  const raw = jsonObject(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('The librarian did not answer with a JSON object.');
  const o = raw as Record<string, unknown>;
  const ops: LibrarianOp[] = [];
  for (const item of Array.isArray(o.ops) ? o.ops : []) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const op = (typeof r.op === 'string' ? r.op : '').trim().toUpperCase() as LibrarianOpKind;
    if (!LIBRARIAN_OPS.includes(op) || op === 'NOOP') continue;
    const id = typeof r.id === 'string' ? r.id.trim().replace(/^\[|\]$/g, '') : undefined;
    const textValue = typeof r.text === 'string' ? r.text.trim() : '';
    if ((op === 'ADD' || op === 'UPDATE') && !textValue) continue;
    if (op !== 'ADD' && !id) continue;
    const kind = FACT_KINDS.includes(r.kind as FactKind) ? (r.kind as FactKind) : undefined;
    const line = Number(typeof r.line === 'string' ? r.line.replace(/^L/i, '') : r.line);
    ops.push({
      op,
      ...(id ? { id } : {}),
      ...(textValue ? { text: textValue.slice(0, 600) } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof r.slot === 'string' && r.slot.trim() ? { slot: r.slot.trim().slice(0, 80) } : {}),
      ...(strings(r.about, 8).length ? { about: strings(r.about, 8) } : {}),
      ...(typeof r.importance === 'number'
        ? { importance: Math.min(2, Math.max(1, Math.round(r.importance))) }
        : {}),
      ...(typeof r.evidence === 'string' && r.evidence.trim()
        ? { evidence: clipLine(r.evidence, 240) }
        : {}),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(typeof r.reason === 'string' && r.reason.trim()
        ? { reason: clipLine(r.reason, 200) }
        : {}),
    });
    if (ops.length >= MAX_OPS) break;
  }
  const summary = typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : '';
  return {
    ...(summary ? { summary: summary.slice(0, 1500) } : {}),
    ...(strings(o.decisions, 8).length ? { decisions: strings(o.decisions, 8) } : {}),
    ...(strings(o.loose_ends ?? o.looseEnds, 8).length
      ? { looseEnds: strings(o.loose_ends ?? o.looseEnds, 8) }
      : {}),
    ops,
  };
}

/** Text that looks like a key, a token or a card number. */
export function looksSecret(text: string): boolean {
  return /\b(sk-[A-Za-z0-9]{8,}|AIza[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[\w-]{10,}|\d{13,19}|password\s*[:=])/i.test(
    text,
  );
}

/**
 * An observation that only says how someone felt, with no decision in it (audit item 10).
 * @param text - Fact text.
 * @param kind - Its kind.
 */
export function isSentimentOnly(text: string, kind: string | undefined): boolean {
  if (kind && kind !== 'observation' && kind !== 'fact') return false;
  const feeling =
    /\b(likes?|liked|loves?|loved|enjoy(s|ed)?|happy|pleased|satisfied|glad|frustrat\w*|annoy\w*|impressed|excited|dislikes?|hates?|unhappy|confus\w*)\b/i;
  const action =
    /\b(decid\w*|chose|choose|will|plans?|wants? to|asked|switch\w*|prefer\w*|always|never|should)\b/i;
  return feeling.test(text) && !action.test(text);
}

export interface ApplyContext {
  /** Ids of the existing facts given to the librarian; UPDATE, CONFIRM and CLOSE need one. */
  candidates: Set<string>;
  session?: string;
  task?: string;
  /** A note link and time for an L-number, for the fact's source. */
  sourceFor?: (line: number | undefined) => string | undefined;
  /** Embeddings of the texts to be added, made beforehand. */
  embeddings?: Map<string, Embedded>;
  /**
   * The input is not the user's own words (a task's result, which may quote web pages or files):
   * it may add facts, but never a preference or instruction that every agent would then follow.
   */
  notUserWords?: boolean;
}

export interface ApplyResult {
  added: string[];
  updated: string[];
  confirmed: string[];
  closed: string[];
  skipped: { op: LibrarianOp; why: string }[];
  /** Facts added or changed with importance 2 or more, for a mid-call notice. */
  important: { key: string; text: string }[];
}

/**
 * Applies the librarian's operations to the graph.
 * @param graph - Memory.
 * @param output - Parsed answer.
 * @param ctx - Candidates, provenance and embeddings.
 */
export function applyLibrarianOps(
  graph: MemoryGraph,
  output: LibrarianOutput,
  ctx: ApplyContext,
): ApplyResult {
  const result: ApplyResult = {
    added: [],
    updated: [],
    confirmed: [],
    closed: [],
    skipped: [],
    important: [],
  };
  for (const op of output.ops.slice(0, MAX_OPS)) {
    const source = ctx.sourceFor?.(op.line);
    const known = !!op.id && ctx.candidates.has(op.id);
    if (op.text && looksSecret(op.text)) {
      result.skipped.push({ op, why: 'looks like a secret' });
      continue;
    }
    switch (op.op) {
      case 'ADD':
      case 'UPDATE': {
        const text = op.text as string;
        if (op.op === 'ADD' && isSentimentOnly(text, op.kind)) {
          result.skipped.push({ op, why: 'sentiment only' });
          continue;
        }
        if (op.op === 'UPDATE' && !known) {
          result.skipped.push({ op, why: 'unknown id' });
          continue;
        }
        const standing = op.kind === 'preference' || op.kind === 'instruction';
        if (ctx.notUserWords && standing) {
          result.skipped.push({ op, why: 'a rule can only come from the user' });
          continue;
        }
        const saved = graph.remember({
          text,
          kind: op.kind,
          about: op.about,
          slot: op.slot,
          importance: op.importance,
          supersedes: op.op === 'UPDATE' ? [op.id as string] : undefined,
          agent: 'librarian',
          session: ctx.session,
          task: ctx.task,
          evidence: op.evidence,
          source,
          embedding: ctx.embeddings?.get(text),
        });
        if (saved.confirmed) result.confirmed.push(saved.key);
        else (op.op === 'ADD' ? result.added : result.updated).push(saved.key);
        if (!saved.confirmed && (op.importance ?? 1) >= 2)
          result.important.push({ key: saved.key, text });
        break;
      }
      case 'CONFIRM':
        if (!known) {
          result.skipped.push({ op, why: 'unknown id' });
          continue;
        }
        if (
          graph.confirm(op.id as string, {
            session: ctx.session,
            task: ctx.task,
            evidence: op.evidence,
            source,
          })
        )
          result.confirmed.push(op.id as string);
        break;
      case 'CLOSE':
        if (!known) {
          result.skipped.push({ op, why: 'unknown id' });
          continue;
        }
        if (graph.forget(op.id as string, op.reason || 'no longer true', 'librarian'))
          result.closed.push(op.id as string);
        break;
      default:
        break;
    }
  }
  return result;
}

/**
 * The call's summary as stored on its session: the summary, then decisions and loose ends.
 * @param output - Parsed answer.
 * @param fallback - Used when the librarian wrote none (the list of topics).
 */
export function summaryText(output: LibrarianOutput, fallback = ''): string {
  if (!output.summary) return fallback;
  return [
    output.summary,
    ...(output.decisions?.length ? [`Decisions: ${output.decisions.join(' ')}`] : []),
    ...(output.looseEnds?.length ? [`Left open: ${output.looseEnds.join(' ')}`] : []),
  ].join('\n');
}
