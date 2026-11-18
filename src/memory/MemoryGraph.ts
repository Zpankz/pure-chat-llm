// The agents' shared memory: one relate graph that the voice agent, the orchestrator, workers and
// note chats all read and write, saved in the vault so a new session starts with what earlier
// ones learned. The model follows relate's agent-memory guide (Entity, Fact, SUPERSEDES; nothing
// is deleted, a correction closes the old fact), with sessions, tasks, requests, agents and a
// shared key/value state added for the plugin's own agents.
//
// Schema (every node has a unique `key`):
//   (:Agent   {key: voice|orchestrator|worker|chat|librarian, name})
//   (:Session {key, kind: call|app, title, startedAt, endedAt, summary, embedding})
//   (:Task    {key, title, status, progress, question, lastUpdate, startedAt, endedAt, result,
//              embedding})
//   (:Request {key, text, at, by, typed})                      a relay from the user to the agents
//   (:Entity  {key: kind:name, name, kind, norm, aliases, createdAt, updatedAt})
//   (:Note    {key: vault path, path, name})
//   (:Fact    {key, text, kind, slot, importance, recordedAt, closedAt, closedReason, by,
//              confirmations, lastSeenAt, evidence, source, embedding, embedModel})
//   (:State   {key: scope/name, scope, name, value, updatedAt, by})
//   (Fact)-[:ABOUT]->(Entity|Note)      (Fact)-[:FROM]->(Session|Task)
//   (Fact)-[:BY]->(Agent)               (Fact)-[:SUPERSEDES]->(Fact)
//   (Task)-[:IN]->(Session)             (Task)-[:BY]->(Agent)
//   (Request)-[:IN]->(Session)          (Request)-[:SPAWNED]->(Task)
//   (Session)-[:FOLLOWS]->(Session)     (Entity)-[:RELATED {kind}]->(Entity)
//   (State)-[:IN]->(Session)            (State)-[:SET_BY]->(Agent)   (State)-[:ABOUT]->(Note)
//
// Entities are matched by their normalised name or an alias whatever kind they were given, so
// "Voice Agent" and "project:Voice Agent" are one entity. A fact that repeats a current one
// confirms it instead of adding a copy. Observations fade with time; instructions and
// preferences don't. Embeddings, when an embeddings endpoint is set up, are kept on Fact, Task
// and Session nodes and searched with relate's vector index; without them recall is by words.
//
// Agents write only through the methods here, with bound parameters; their own Cypher goes
// through `query`, which refuses anything that writes.
import { GraphEngine } from './relateEngine';
import type { CypherResult } from './relateEngine';
import {
  clipLine,
  contentTerms,
  decayScore,
  FADED_SCORE,
  fitBlock,
  fulltextQuery,
  localTime,
  matchedTerms,
  normName,
  recency,
  termOverlap,
  termsNeeded,
} from './text';

export const LABELS = [
  'Agent',
  'Session',
  'Task',
  'Request',
  'Entity',
  'Note',
  'Fact',
  'State',
] as const;
export type Label = (typeof LABELS)[number];
export const REL_TYPES = [
  'ABOUT',
  'FROM',
  'BY',
  'SUPERSEDES',
  'IN',
  'FOLLOWS',
  'RELATED',
  'SET_BY',
  'SPAWNED',
] as const;
export type RelType = (typeof REL_TYPES)[number];

export const FACT_KINDS = [
  'fact',
  'preference',
  'instruction',
  'decision',
  'todo',
  'summary',
  'observation',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export type AgentName = 'voice' | 'orchestrator' | 'worker' | 'chat' | 'librarian';

/** The vault file format: nodes by label, relationships by their endpoints' keys. */
export interface MemorySnapshot {
  format: 'voice-agent-memory';
  version: 1;
  savedAt: number;
  nodes: Partial<Record<Label, Record<string, unknown>[]>>;
  relationships: {
    type: RelType;
    from: [Label, string];
    to: [Label, string];
    props?: Record<string, unknown>;
  }[];
}

/** An embedding and the model that made it. */
export interface Embedded {
  model: string;
  vector: number[];
}

export interface RememberInput {
  text: string;
  kind?: FactKind;
  /** Entities or notes it is about: `[[Note path]]`, `kind:name` or a plain name. */
  about?: string[];
  /** One current fact per slot: a new fact closes the slot's old one. */
  slot?: string;
  /** 1 normal, 2 important, 3 pinned (always in the brief). */
  importance?: number;
  /** Fact keys this one corrects. */
  supersedes?: string[];
  agent: AgentName;
  session?: string;
  task?: string;
  /** Where it was said: a quote. */
  evidence?: string;
  /** Where it was said: a note link and time, like `[[Calls/2026-11-18 0950]] 09:51:02`. */
  source?: string;
  /** Its embedding, when one was made. */
  embedding?: Embedded;
  /** Check for a current copy first and confirm it instead (default true). */
  dedupe?: boolean;
}

export interface RememberResult {
  key: string;
  closed: string[];
  /** The fact repeated a current one, which was confirmed instead of copied. */
  confirmed?: boolean;
}

export interface FactRow {
  key: string;
  text: string;
  kind: string;
  slot: string | null;
  importance: number;
  recordedAt: number;
  closedAt: number | null;
  by: string | null;
  about: string[];
  session: string | null;
  confirmations: number;
  lastSeenAt: number | null;
  score?: number;
}

export interface RecallInput {
  query?: string;
  about?: string;
  kinds?: string[];
  limit?: number;
  includeClosed?: boolean;
  since?: number;
  /** The query's embedding, for search by meaning. */
  embedding?: Embedded;
}

/** One search result: a fact, a task's result, or a session's summary. */
export interface MemoryHit {
  type: 'fact' | 'task' | 'session';
  key: string;
  /** The fact, the task's result or the session's summary. */
  text: string;
  /** A task's or session's title. */
  title?: string;
  at: number;
  score: number;
  fact?: FactRow;
}

const SCHEMA = [
  ...LABELS.map(
    l =>
      `CREATE CONSTRAINT ${l.toLowerCase()}_key IF NOT EXISTS FOR (n:${l}) REQUIRE n.key IS UNIQUE`,
  ),
  'CREATE FULLTEXT INDEX fact_text IF NOT EXISTS FOR (f:Fact) ON EACH [f.text]',
  'CREATE FULLTEXT INDEX entity_text IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.search]',
  'CREATE FULLTEXT INDEX task_text IF NOT EXISTS FOR (t:Task) ON EACH [t.title, t.result]',
  'CREATE FULLTEXT INDEX session_text IF NOT EXISTS FOR (s:Session) ON EACH [s.title, s.summary]',
  'CREATE INDEX fact_slot IF NOT EXISTS FOR (f:Fact) ON (f.slot)',
  'CREATE INDEX fact_kind IF NOT EXISTS FOR (f:Fact) ON (f.kind)',
];

/** Vector indexes, one per searchable label. */
const VECTOR_INDEXES: [Label, string][] = [
  ['Fact', 'fact_vec'],
  ['Task', 'task_vec'],
  ['Session', 'session_vec'],
];

const MAX_TEXT = 2000;
const MAX_LIMIT = 50;
/** Word overlap at which a new fact is the same as a current one. */
export const DUPLICATE_OVERLAP = 0.75;
/** Cosine similarity at which a new fact is the same as a current one. */
export const DUPLICATE_COSINE = 0.9;
/** Word overlap at which a preference or instruction replaces an earlier one on the same thing. */
export const SAME_SLOT_OVERLAP = 0.5;
/** Cosine similarity a vector hit needs to count without matching words. */
export const VECTOR_MIN_COSINE = 0.3;
/** Words left out when deciding whether two preferences are about the same thing. */
const PREFERENCE_WORDS = new Set([
  'prefer',
  'prefers',
  'preferred',
  'likes',
  'always',
  'never',
  'should',
  'wants',
  'wanted',
  'loves',
  'hates',
  'dislikes',
]);

/** A short, sortable, unique key. */
export function newKey(prefix: string, now = Date.now()): string {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** `kind:name` for an entity, lower-case with single spaces. */
export function entityKey(kind: string, name: string): string {
  const clean = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${clean(kind) || 'thing'}:${clean(name)}`;
}

/** A reference an agent gave: a note link, a typed entity, or a plain name. */
export function parseRef(ref: string): {
  label: 'Note' | 'Entity';
  key: string;
  name: string;
  kind: string;
} {
  const text = ref.trim();
  const link = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(text);
  if (link) {
    const path = link[1].trim().replace(/\.md$/i, '');
    return { label: 'Note', key: `${path}.md`, name: path, kind: 'note' };
  }
  const typed = /^([A-Za-z][\w-]{0,30}):(.+)$/.exec(text);
  if (typed) {
    return {
      label: 'Entity',
      key: entityKey(typed[1], typed[2]),
      name: typed[2].trim(),
      kind: typed[1].toLowerCase(),
    };
  }
  return { label: 'Entity', key: entityKey('thing', text), name: text, kind: 'thing' };
}

function clip(text: string, max = MAX_TEXT): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : JSON.stringify(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Text without the words that only say someone likes something, for comparing preferences. */
function preferenceCore(text: string): string {
  return text
    .split(/\s+/)
    .filter(w => !PREFERENCE_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, '')))
    .join(' ');
}

/** Largest `range()` an agent's own query may build (review M1: a huge one froze the app). */
const MAX_RANGE = 10_000;

/**
 * Why a read-only statement would run without bound, if it would.
 * @param cypher - Statement.
 */
export function unboundedReason(cypher: string): string {
  for (const m of cypher.matchAll(/\brange\s*\(\s*[^,()]+,\s*([-\d.eE+]+)/gi)) {
    if (Math.abs(Number(m[1])) > MAX_RANGE)
      return `range() is limited to ${MAX_RANGE} values in memory queries.`;
  }
  return '';
}

/**
 * Adds a LIMIT to a statement that returns rows and has none, so the engine stops early.
 * @param cypher - Statement.
 * @param maxRows - Rows wanted; one more is fetched to tell whether there were more.
 */
export function withRowLimit(cypher: string, maxRows: number): string {
  if (!/\bRETURN\b/i.test(cypher) || /\bLIMIT\b/i.test(cypher)) return cypher;
  return `${cypher} LIMIT ${Math.max(1, maxRows) + 1}`;
}

export class MemoryGraph {
  private engine: GraphEngine;
  /** Changes not yet saved. */
  dirty = false;
  /** Goes up whenever a fact changes, so a cached brief knows when to rebuild. */
  factVersion = 0;
  private now: () => number;
  /** Dimensions of the vector indexes, once made. */
  private vectorDims: number | null = null;

  constructor(options: { now?: () => number } = {}) {
    this.engine = new GraphEngine();
    this.now = options.now ?? (() => Date.now());
    for (const statement of SCHEMA) this.engine.must(statement);
  }

  private write(query: string, params?: Record<string, unknown>): CypherResult {
    const result = this.engine.must(query, params);
    this.dirty = true;
    return result;
  }

  private factWrite(query: string, params?: Record<string, unknown>): CypherResult {
    this.factVersion++;
    return this.write(query, params);
  }

  /** Counts of each label, and of relationships. */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of LABELS) {
      out[l] = num(this.engine.must(`MATCH (n:${l}) RETURN count(n) AS c`).rows[0]?.c, 0);
    }
    out.relationships = num(
      this.engine.must('MATCH ()-[r]->() RETURN count(r) AS c').rows[0]?.c,
      0,
    );
    return out;
  }

  // ── Agents, sessions, tasks and requests (written by the plugin, not by models) ──

  private ensureAgent(agent: AgentName): void {
    this.write('MERGE (a:Agent {key: $key}) ON CREATE SET a.name = $key', { key: agent });
  }

  /**
   * Starts a session (a voice call, or the app's time between loads) and links it to the last.
   * @param key - Session key.
   * @param kind - `call` or `app`.
   * @param title - Short title.
   */
  startSession(key: string, kind: 'call' | 'app', title: string): void {
    const at = this.now();
    const previous = this.engine.must(
      'MATCH (s:Session) WHERE s.key <> $key RETURN s.key AS key ORDER BY s.startedAt DESC LIMIT 1',
      { key },
    ).rows[0]?.key;
    this.write(
      'MERGE (s:Session {key: $key}) ON CREATE SET s.kind = $kind, s.title = $title, s.startedAt = $at',
      { key, kind, title: clip(title, 200), at },
    );
    if (typeof previous === 'string') {
      this.write(
        'MATCH (s:Session {key: $key}), (p:Session {key: $previous}) MERGE (s)-[:FOLLOWS]->(p)',
        { key, previous },
      );
    }
  }

  /**
   * Ends a session, with an optional summary.
   * @param key - Session key.
   * @param summary - What happened.
   */
  endSession(key: string, summary?: string): void {
    this.write(
      'MATCH (s:Session {key: $key}) SET s.endedAt = $at' +
        (summary ? ', s.summary = $summary, s.embedding = null' : ''),
      { key, at: this.now(), ...(summary ? { summary: clip(summary) } : {}) },
    );
  }

  /**
   * Sets a session's summary (the librarian's, which replaces the list of topics).
   * @param key - Session key.
   * @param summary - Summary.
   */
  setSessionSummary(key: string, summary: string): void {
    if (!summary.trim()) return;
    this.write(
      'MATCH (s:Session {key: $key}) SET s.summary = $summary, s.summarizedAt = $at, s.embedding = null',
      { key, summary: clip(summary), at: this.now() },
    );
  }

  /** A session's title and summary, if it exists. */
  session(key: string): { title: string; summary: string | null; startedAt: number } | null {
    const row = this.engine.must(
      'MATCH (s:Session {key: $key}) RETURN s.title AS title, s.summary AS summary, s.startedAt AS at',
      { key },
    ).rows[0];
    return row
      ? {
          title: str(row.title),
          summary: (row.summary as string | null) ?? null,
          startedAt: num(row.at, 0),
        }
      : null;
  }

  /**
   * Classic tasks live only while the app runs, so one still open from an earlier app session
   * was cut off by a reload or quit: mark it interrupted, or every brief lists it forever (M4).
   * Durable tasks survive restarts and are left alone.
   * @param appSession - This app session's key; its own tasks are kept open.
   */
  closeStaleTasks(appSession: string): number {
    const rows = this.engine.must(
      `MATCH (t:Task) WHERE t.endedAt IS NULL AND t.key STARTS WITH 'app-'
       AND NOT t.key STARTS WITH $mine RETURN t.key AS key`,
      { mine: `${appSession}-` },
    ).rows;
    if (!rows.length) return 0;
    this.write(
      `MATCH (t:Task) WHERE t.endedAt IS NULL AND t.key STARTS WITH 'app-'
       AND NOT t.key STARTS WITH $mine SET t.status = 'interrupted', t.endedAt = $at`,
      { mine: `${appSession}-`, at: this.now() },
    );
    return rows.length;
  }

  /**
   * Records a task's start or its outcome.
   * @param task - Task fields.
   * @param task.key - Task key.
   * @param task.title - Title.
   * @param task.status - Status.
   * @param task.result - Result text, when it ended.
   * @param task.session - Session it ran in.
   * @param agent - Who runs it.
   */
  recordTask(
    task: { key: string; title: string; status: string; result?: string; session?: string },
    agent: AgentName = 'worker',
  ): void {
    this.ensureAgent(agent);
    const at = this.now();
    const ended = /done|failed|cancel|timed/i.test(task.status);
    this.write(
      `MERGE (t:Task {key: $key})
       ON CREATE SET t.startedAt = $at
       SET t.title = $title, t.status = $status, t.lastUpdate = $at${
         ended ? ', t.endedAt = $at, t.question = null' : ''
       }${task.result ? ', t.result = $result, t.embedding = null' : ''}
       WITH t MATCH (a:Agent {key: $agent}) MERGE (t)-[:BY]->(a)`,
      {
        key: task.key,
        title: clip(task.title, 200),
        status: task.status,
        at,
        agent,
        ...(task.result ? { result: clip(task.result, 4000) } : {}),
      },
    );
    if (task.session) {
      this.write('MATCH (t:Task {key: $key}), (s:Session {key: $session}) MERGE (t)-[:IN]->(s)', {
        key: task.key,
        session: task.session,
      });
    }
  }

  /**
   * Marks a task's result as read by the librarian. False when it already was (the durable
   * engine may report a task's end again after a restart).
   * @param key - Task key.
   * @param digest - Identifies the result read (a follow-up round brings a new one).
   */
  markConsolidated(key: string, digest: string): boolean {
    const row = this.engine.must('MATCH (t:Task {key: $key}) RETURN t.consolidated AS d', {
      key,
    }).rows[0];
    if (row && row.d === digest) return false;
    this.write(
      `MERGE (t:Task {key: $key}) ON CREATE SET t.startedAt = $at
       SET t.consolidated = $digest, t.consolidatedAt = $at`,
      { key, digest, at: this.now() },
    );
    return true;
  }

  /**
   * A running task's live state: its status, its last progress line, a question it waits on.
   * @param key - Task key.
   * @param update - What changed.
   * @param update.status - New status.
   * @param update.progress - Last progress line.
   * @param update.question - Question it waits on; empty clears it.
   */
  taskProgress(key: string, update: { status?: string; progress?: string; question?: string }) {
    const sets = ['t.lastUpdate = $at'];
    const params: Record<string, unknown> = { key, at: this.now() };
    if (update.status) {
      sets.push('t.status = $status');
      params.status = update.status;
    }
    if (update.progress !== undefined) {
      sets.push('t.progress = $progress');
      params.progress = clipLine(update.progress, 300);
    }
    if (update.question !== undefined) {
      sets.push('t.question = $question');
      params.question = update.question ? clipLine(update.question, 400) : null;
    }
    this.write(`MATCH (t:Task {key: $key}) WHERE t.endedAt IS NULL SET ${sets.join(', ')}`, params);
  }

  /**
   * Records what the user asked the agents (a relay), in its session.
   * @param request - Its text and source.
   * @param request.text - What the user asked.
   * @param request.session - Session it was asked in.
   * @param request.agent - Who passed it on.
   * @param request.typed - Typed in the panel rather than said.
   * @param request.key - Its key, when the caller made one.
   * @returns The request's key.
   */
  recordRequest(request: {
    text: string;
    session?: string;
    agent: AgentName;
    typed?: boolean;
    key?: string;
  }): string {
    const at = this.now();
    const key = request.key ?? newKey('r', at);
    this.write('CREATE (r:Request {key: $key, text: $text, at: $at, by: $agent, typed: $typed})', {
      key,
      text: clip(request.text, 1000),
      at,
      agent: request.agent,
      typed: !!request.typed,
    });
    if (request.session) {
      this.write(
        'MATCH (r:Request {key: $key}), (s:Session {key: $session}) MERGE (r)-[:IN]->(s)',
        {
          key,
          session: request.session,
        },
      );
    }
    return key;
  }

  /**
   * Links a request to a task it started. The task node is made if it isn't there yet.
   * @param requestKey - Request.
   * @param taskKey - Task.
   */
  linkSpawn(requestKey: string, taskKey: string): void {
    this.write(
      `MATCH (r:Request {key: $request}) MERGE (t:Task {key: $task})
       ON CREATE SET t.startedAt = $at MERGE (r)-[:SPAWNED]->(t)`,
      { request: requestKey, task: taskKey, at: this.now() },
    );
  }

  /**
   * The newest request of a session, if any.
   * @param session - Session key.
   */
  lastRequest(session: string): string | null {
    const row = this.engine.must(
      'MATCH (r:Request)-[:IN]->(:Session {key: $session}) RETURN r.key AS key ORDER BY r.at DESC LIMIT 1',
      { session },
    ).rows[0];
    return typeof row?.key === 'string' ? row.key : null;
  }

  // ── Entities and notes ──

  /**
   * The key of the entity a name refers to: one whose normalised name or alias matches, of any
   * kind (the first kind stays canonical), or a new one.
   * @param r - Parsed reference.
   */
  private resolveEntity(r: { key: string; name: string; kind: string }): string {
    const norm = normName(r.name);
    const at = this.now();
    const rows = this.engine.must(
      `MATCH (e:Entity) WHERE e.key = $key OR coalesce(e.norm, toLower(e.name)) = $norm
         OR $norm IN coalesce(e.aliases, [])
       RETURN e.key AS key, e.createdAt AS at ORDER BY at LIMIT 5`,
      { key: r.key, norm },
    ).rows;
    const found = rows.find(row => row.key === r.key) ?? rows[0];
    if (found) {
      this.write('MATCH (e:Entity {key: $key}) SET e.updatedAt = $at', {
        key: found.key,
        at,
      });
      return String(found.key);
    }
    this.write(
      `MERGE (e:Entity {key: $key})
       ON CREATE SET e.name = $name, e.kind = $kind, e.norm = $norm, e.createdAt = $at,
         e.aliases = [], e.search = $name
       SET e.updatedAt = $at`,
      { key: r.key, name: r.name, kind: r.kind, norm, at },
    );
    return r.key;
  }

  private ensureRef(ref: string): { label: 'Note' | 'Entity'; key: string } {
    const r = parseRef(ref);
    if (r.label === 'Note') {
      this.write('MERGE (n:Note {key: $key}) ON CREATE SET n.path = $key, n.name = $name', {
        key: r.key,
        name: r.name,
      });
      return r;
    }
    return { label: 'Entity', key: this.resolveEntity(r) };
  }

  /**
   * Gives an entity another name it is known by, so either finds it.
   * @param ref - The entity (any of its names).
   * @param alias - The other name.
   */
  addAlias(ref: string, alias: string): string {
    const target = this.ensureRef(ref);
    if (target.label !== 'Entity') throw new Error('Only entities take aliases, not notes.');
    const norm = normName(alias);
    if (!norm) throw new Error('The alias is empty.');
    this.write(
      `MATCH (e:Entity {key: $key})
       WITH e, coalesce(e.aliases, []) AS aliases
       SET e.aliases = CASE WHEN $norm IN aliases OR coalesce(e.norm, toLower(e.name)) = $norm
         THEN aliases ELSE aliases + $norm END,
         e.search = coalesce(e.name, '') + ' ' + $alias + ' ' + coalesce(e.search, ''),
         e.updatedAt = $at`,
      { key: target.key, norm, alias: clip(alias, 120), at: this.now() },
    );
    return target.key;
  }

  /**
   * Relates two entities (or notes).
   * @param from - Reference.
   * @param kind - How they relate, in a word or two.
   * @param to - Reference.
   */
  relate(from: string, kind: string, to: string): void {
    const a = this.ensureRef(from);
    const b = this.ensureRef(to);
    this.write(
      `MATCH (a:${a.label} {key: $a}), (b:${b.label} {key: $b})
       MERGE (a)-[r:RELATED {kind: $kind}]->(b) ON CREATE SET r.at = $at`,
      { a: a.key, b: b.key, kind: clip(kind.toLowerCase(), 60), at: this.now() },
    );
  }

  // ── Facts ──

  /** Current facts that may repeat or replace a new one: same things, same words, or close. */
  private similarFacts(
    text: string,
    aboutKeys: string[],
    embedding?: Embedded,
  ): { row: FactRow; overlap: number; cosine: number }[] {
    const keys = new Set<string>();
    if (aboutKeys.length) {
      for (const r of this.engine.must(
        `MATCH (f:Fact)-[:ABOUT]->(t) WHERE f.closedAt IS NULL AND t.key IN $about
         RETURN DISTINCT f.key AS key LIMIT 200`,
        { about: aboutKeys },
      ).rows)
        keys.add(String(r.key));
    }
    const terms = contentTerms(text);
    if (terms.length) {
      const hits = this.engine.run(
        `CALL db.index.fulltext.queryNodes('fact_text', $terms) YIELD node, score
         RETURN node.key AS key, score ORDER BY score DESC LIMIT 30`,
        { terms: fulltextQuery(terms) },
      );
      for (const r of hits.error ? [] : hits.rows) keys.add(String(r.key));
    }
    const cosines = new Map<string, number>();
    if (embedding) {
      for (const hit of this.vectorHits('Fact', embedding, 10)) {
        keys.add(hit.key);
        cosines.set(hit.key, hit.cosine);
      }
    }
    if (!keys.size) return [];
    return this.factRows(
      'f.closedAt IS NULL AND f.key IN $keys',
      { keys: [...keys] },
      'f.recordedAt DESC',
      300,
    ).map(row => ({
      row,
      overlap: termOverlap(text, row.text),
      cosine: cosines.get(row.key) ?? 0,
    }));
  }

  /**
   * A current fact that says the same as this text, if there is one.
   * @param text - New fact's text.
   * @param kind - Its kind.
   * @param aboutKeys - Keys of what it is about.
   * @param embedding - Its embedding.
   */
  findDuplicate(
    text: string,
    kind: string,
    aboutKeys: string[] = [],
    embedding?: Embedded,
  ): FactRow | null {
    const compatible = (k: string) => k === kind || k === 'fact' || kind === 'fact';
    let best: { row: FactRow; score: number } | null = null;
    for (const c of this.similarFacts(text, aboutKeys, embedding)) {
      if (!compatible(c.row.kind)) continue;
      const same =
        c.row.text.trim().toLowerCase() === text.trim().toLowerCase() ||
        c.overlap >= DUPLICATE_OVERLAP ||
        c.cosine >= DUPLICATE_COSINE;
      if (!same) continue;
      const score = Math.max(c.overlap, c.cosine);
      if (!best || score > best.score) best = { row: c.row, score };
    }
    return best?.row ?? null;
  }

  /**
   * A current preference or instruction this one replaces: same kind, about the same thing, and
   * on the same subject in other words ("morning check-ins" → "evening check-ins").
   */
  private inferredSlotFor(
    text: string,
    kind: string,
    aboutKeys: string[],
    embedding?: Embedded,
  ): FactRow | null {
    if ((kind !== 'preference' && kind !== 'instruction') || !aboutKeys.length) return null;
    const core = preferenceCore(text);
    let best: { row: FactRow; overlap: number } | null = null;
    for (const c of this.similarFacts(text, aboutKeys, embedding)) {
      if (c.row.kind !== kind) continue;
      const shares = this.engine.must(
        `MATCH (f:Fact {key: $key})-[:ABOUT]->(t) WHERE t.key IN $about RETURN count(t) AS n`,
        { key: c.row.key, about: aboutKeys },
      ).rows[0]?.n;
      if (!num(shares, 0)) continue;
      const overlap = termOverlap(core, preferenceCore(c.row.text));
      if (overlap < SAME_SLOT_OVERLAP) continue;
      if (!best || overlap > best.overlap) best = { row: c.row, overlap };
    }
    return best?.row ?? null;
  }

  /**
   * Confirms a current fact: one more confirmation, seen now, linked to where it was said again.
   * @param key - Fact key.
   * @param context - Where it was said.
   * @param context.session - Session.
   * @param context.task - Task.
   * @param context.evidence - Quote.
   * @param context.source - Note link and time.
   * @param context.about - More things it is about.
   * @returns Whether a current fact had that key.
   */
  confirm(
    key: string,
    context: {
      session?: string;
      task?: string;
      evidence?: string;
      source?: string;
      about?: string[];
    } = {},
  ): boolean {
    const r = this.factWrite(
      `MATCH (f:Fact {key: $key}) WHERE f.closedAt IS NULL
       SET f.confirmations = coalesce(f.confirmations, 1) + 1, f.lastSeenAt = $at${
         context.evidence ? ', f.lastEvidence = $evidence' : ''
       }${context.source ? ', f.lastSource = $source' : ''}
       RETURN f.key AS key`,
      {
        key,
        at: this.now(),
        ...(context.evidence ? { evidence: clip(context.evidence, 500) } : {}),
        ...(context.source ? { source: clip(context.source, 300) } : {}),
      },
    );
    if (!r.rows.length) return false;
    this.linkFact(key, context.about, context.task, context.session);
    return true;
  }

  private linkFact(key: string, about?: string[], task?: string, session?: string): void {
    for (const ref of (about ?? []).filter(r => typeof r === 'string' && r.trim()).slice(0, 12)) {
      const target = this.ensureRef(ref);
      this.write(
        `MATCH (f:Fact {key: $key}), (t:${target.label} {key: $target}) MERGE (f)-[:ABOUT]->(t)`,
        { key, target: target.key },
      );
    }
    if (task) {
      this.write('MATCH (f:Fact {key: $key}), (t:Task {key: $task}) MERGE (f)-[:FROM]->(t)', {
        key,
        task,
      });
    }
    if (session) {
      this.write('MATCH (f:Fact {key: $key}), (s:Session {key: $session}) MERGE (f)-[:FROM]->(s)', {
        key,
        session,
      });
    }
  }

  /** Keys of references, resolved without creating anything new. */
  private peekRefs(about: string[] | undefined): string[] {
    const keys: string[] = [];
    for (const ref of (about ?? []).filter(r => typeof r === 'string' && r.trim()).slice(0, 12)) {
      const r = parseRef(ref);
      if (r.label === 'Note') {
        keys.push(r.key);
        continue;
      }
      const norm = normName(r.name);
      const row = this.engine.must(
        `MATCH (e:Entity) WHERE e.key = $key OR coalesce(e.norm, toLower(e.name)) = $norm
           OR $norm IN coalesce(e.aliases, [])
         RETURN e.key AS key ORDER BY e.createdAt LIMIT 1`,
        { key: r.key, norm },
      ).rows[0];
      keys.push(row ? String(row.key) : r.key);
    }
    return keys;
  }

  /**
   * Saves a fact. One that repeats a current fact confirms it instead. With a slot (given, or
   * inferred for a preference or instruction that replaces one on the same subject), the slot's
   * current fact is closed and superseded.
   * @param input - The fact.
   * @returns Its key, and the keys it closed.
   */
  remember(input: RememberInput): RememberResult {
    const text = clip(input.text ?? '');
    if (!text) throw new Error('The memory is empty.');
    const kind = FACT_KINDS.includes(input.kind as FactKind) ? (input.kind as FactKind) : 'fact';
    const importance = Math.min(3, Math.max(1, Math.round(num(input.importance, 1))));
    let slot = input.slot?.trim().toLowerCase() || null;
    const aboutKeys = this.peekRefs(input.about);
    if (input.dedupe !== false && !input.supersedes?.length) {
      const same = this.findDuplicate(text, kind, aboutKeys, input.embedding);
      if (same && (!slot || same.slot === slot || !same.slot)) {
        this.confirm(same.key, {
          session: input.session,
          task: input.task,
          evidence: input.evidence,
          source: input.source,
          about: input.about,
        });
        if (importance > same.importance) {
          this.factWrite('MATCH (f:Fact {key: $key}) SET f.importance = $importance', {
            key: same.key,
            importance,
          });
        }
        return { key: same.key, closed: [], confirmed: true };
      }
    }
    let inferred = false;
    const replaced = new Set<string>(input.supersedes ?? []);
    if (!slot && !input.supersedes?.length) {
      const earlier = this.inferredSlotFor(text, kind, aboutKeys, input.embedding);
      if (earlier) {
        slot = earlier.slot ?? `auto:${earlier.key}`;
        inferred = !earlier.slot;
        replaced.add(earlier.key);
      }
    }
    const at = this.now();
    const key = newKey('f', at);
    this.ensureAgent(input.agent);
    this.factWrite(
      `CREATE (f:Fact {key: $key, text: $text, kind: $kind, slot: $slot, importance: $importance,
         recordedAt: $at, by: $agent, confirmations: 1, lastSeenAt: $at})
       WITH f MATCH (a:Agent {key: $agent}) CREATE (f)-[:BY]->(a)`,
      { key, text, kind, slot, importance, at, agent: input.agent },
    );
    const extra: string[] = [];
    const params: Record<string, unknown> = { key };
    if (inferred) extra.push('f.inferredSlot = true');
    if (input.evidence) {
      extra.push('f.evidence = $evidence');
      params.evidence = clip(input.evidence, 500);
    }
    if (input.source) {
      extra.push('f.source = $source');
      params.source = clip(input.source, 300);
    }
    if (input.embedding?.vector.length) {
      extra.push('f.embedding = $vector, f.embedModel = $model');
      params.vector = input.embedding.vector;
      params.model = input.embedding.model;
      this.ensureVectorIndex(input.embedding.vector.length);
    }
    if (extra.length) this.write(`MATCH (f:Fact {key: $key}) SET ${extra.join(', ')}`, params);
    this.linkFact(key, input.about, input.task, input.session);
    if (slot) {
      for (const row of this.engine.must(
        'MATCH (f:Fact {slot: $slot}) WHERE f.closedAt IS NULL AND f.key <> $key RETURN f.key AS key',
        { slot, key },
      ).rows) {
        replaced.add(String(row.key));
      }
    }
    const closed: string[] = [];
    for (const old of replaced) {
      const r = this.factWrite(
        `MATCH (f:Fact {key: $key}), (o:Fact {key: $old}) WHERE o.closedAt IS NULL
         SET o.closedAt = $at, o.closedReason = 'superseded'
         MERGE (f)-[:SUPERSEDES]->(o) RETURN o.key AS key`,
        { key, old, at },
      );
      if (r.rows.length) closed.push(old);
    }
    return { key, closed };
  }

  /**
   * Closes a fact (nothing is deleted).
   * @param key - Fact key.
   * @param reason - Why.
   * @param agent - Who.
   */
  forget(key: string, reason: string, agent: AgentName): boolean {
    const r = this.factWrite(
      `MATCH (f:Fact {key: $key}) WHERE f.closedAt IS NULL
       SET f.closedAt = $at, f.closedReason = $reason, f.closedBy = $agent RETURN f.key AS key`,
      { key, at: this.now(), reason: clip(reason || 'retracted', 300), agent },
    );
    return r.rows.length > 0;
  }

  /**
   * Closes observations that have faded (low importance, unconfirmed, long unseen), so they
   * stay in the history but leave the brief and recall. Returns how many were closed.
   */
  fadeObservations(): number {
    const now = this.now();
    const rows = this.engine.must(
      `MATCH (f:Fact) WHERE f.closedAt IS NULL AND f.kind = 'observation'
       RETURN f.key AS key, f.importance AS importance, f.confirmations AS confirmations,
         f.recordedAt AS recordedAt, f.lastSeenAt AS lastSeenAt`,
    ).rows;
    const faded = rows
      .filter(
        r =>
          decayScore(
            {
              kind: 'observation',
              importance: num(r.importance, 1),
              confirmations: num(r.confirmations, 1),
              recordedAt: num(r.recordedAt, now),
              lastSeenAt: (r.lastSeenAt as number | null) ?? null,
            },
            now,
          ) < FADED_SCORE,
      )
      .map(r => String(r.key));
    if (!faded.length) return 0;
    this.factWrite(
      `MATCH (f:Fact) WHERE f.key IN $keys
       SET f.closedAt = $at, f.closedReason = 'faded', f.closedBy = 'librarian'`,
      { keys: faded, at: now },
    );
    return faded.length;
  }

  private factRows(
    where: string,
    params: Record<string, unknown>,
    order: string,
    limit: number,
  ): FactRow[] {
    return this.engine
      .must(
        `MATCH (f:Fact) WHERE ${where}
         OPTIONAL MATCH (f)-[:ABOUT]->(t)
         OPTIONAL MATCH (f)-[:FROM]->(s:Session)
         WITH f, collect(DISTINCT coalesce(t.name, t.path)) AS about, head(collect(s.key)) AS session
         RETURN f.key AS key, f.text AS text, f.kind AS kind, f.slot AS slot,
           f.importance AS importance, f.recordedAt AS recordedAt, f.closedAt AS closedAt,
           f.by AS by, about, session, f.confirmations AS confirmations, f.lastSeenAt AS lastSeenAt
         ORDER BY ${order} LIMIT $limit`,
        { ...params, limit },
      )
      .rows.map(r => ({
        key: String(r.key),
        text: str(r.text),
        kind: str(r.kind, 'fact'),
        slot: (r.slot as string | null) ?? null,
        importance: num(r.importance, 1),
        recordedAt: num(r.recordedAt, 0),
        closedAt: (r.closedAt as number | null) ?? null,
        by: (r.by as string | null) ?? null,
        about: (r.about as string[] | null) ?? [],
        session: (r.session as string | null) ?? null,
        confirmations: num(r.confirmations, 1),
        lastSeenAt: (r.lastSeenAt as number | null) ?? null,
      }));
  }

  /** How much a fact counts besides how well it matches: importance, confirmations, recency. */
  private weight(f: FactRow): number {
    const now = this.now();
    return (
      (1 + (f.importance - 1) * 0.25) *
      (1 + Math.log2(Math.max(1, f.confirmations)) * 0.1) *
      (0.5 + 0.5 * recency(f, now))
    );
  }

  // ── Vectors ──

  /**
   * Makes the vector indexes for this many dimensions (again, if the model changed).
   * @param dims - Vector length.
   */
  ensureVectorIndex(dims: number): void {
    if (!dims || this.vectorDims === dims) return;
    for (const [label, name] of VECTOR_INDEXES) {
      if (this.vectorDims !== null) this.engine.run(`DROP INDEX ${name}`);
      this.engine.must(
        `CREATE VECTOR INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.embedding)
         OPTIONS {indexConfig: {\`vector.dimensions\`: ${Math.round(dims)}, \`vector.similarity_function\`: 'cosine'}}`,
      );
    }
    this.vectorDims = dims;
  }

  /**
   * Nearest nodes of a label to a vector, made by the same model; cosine similarity (-1 to 1).
   * @param label - Fact, Task or Session.
   * @param embedding - Query vector and its model.
   * @param k - How many.
   */
  vectorHits(label: Label, embedding: Embedded, k: number): { key: string; cosine: number }[] {
    const index = VECTOR_INDEXES.find(([l]) => l === label)?.[1];
    if (!index || !embedding.vector.length) return [];
    this.ensureVectorIndex(embedding.vector.length);
    const r = this.engine.run(
      `CALL db.index.vector.queryNodes($index, $k, $vector) YIELD node, score
       WITH node, score WHERE node.embedModel = $model
       RETURN node.key AS key, score`,
      { index, k: Math.max(1, k) * 3, vector: embedding.vector, model: embedding.model },
    );
    if (r.error) return [];
    // relate's cosine score is (1 + cos) / 2.
    return r.rows.slice(0, k).map(row => ({
      key: String(row.key),
      cosine: num(row.score, 0.5) * 2 - 1,
    }));
  }

  /**
   * Stores a node's embedding.
   * @param label - Fact, Task or Session.
   * @param key - Node key.
   * @param embedding - Vector and model.
   */
  setEmbedding(label: Label, key: string, embedding: Embedded): void {
    if (!VECTOR_INDEXES.some(([l]) => l === label) || !embedding.vector.length) return;
    this.ensureVectorIndex(embedding.vector.length);
    this.write(
      `MATCH (n:${label} {key: $key}) SET n.embedding = $vector, n.embedModel = $model, n.embeddedAt = $at`,
      { key, vector: embedding.vector, model: embedding.model, at: this.now() },
    );
  }

  /**
   * Nodes whose embedding is missing or from another model: current facts, task results and
   * session summaries.
   * @param model - Embedding model in use.
   * @param limit - Most returned.
   */
  missingEmbeddings(model: string, limit = 32): { label: Label; key: string; text: string }[] {
    const out: { label: Label; key: string; text: string }[] = [];
    const take = (label: Label, query: string) => {
      if (out.length >= limit) return;
      for (const r of this.engine.must(query, { model, limit: limit - out.length }).rows) {
        out.push({ label, key: String(r.key), text: str(r.text) });
      }
    };
    take(
      'Fact',
      `MATCH (f:Fact) WHERE f.closedAt IS NULL AND (f.embedding IS NULL OR f.embedModel <> $model)
       RETURN f.key AS key, f.text AS text ORDER BY f.recordedAt DESC LIMIT $limit`,
    );
    take(
      'Task',
      `MATCH (t:Task) WHERE t.result IS NOT NULL AND (t.embedding IS NULL OR t.embedModel <> $model)
       RETURN t.key AS key, t.title + ': ' + t.result AS text ORDER BY t.startedAt DESC LIMIT $limit`,
    );
    take(
      'Session',
      `MATCH (s:Session) WHERE s.summary IS NOT NULL AND (s.embedding IS NULL OR s.embedModel <> $model)
       RETURN s.key AS key, s.title + ': ' + s.summary AS text ORDER BY s.startedAt DESC LIMIT $limit`,
    );
    return out;
  }

  /** The dimensions of the newest stored embedding of a model, to set up the index after load. */
  embeddingDims(model: string): number {
    const row = this.engine.must(
      'MATCH (f:Fact) WHERE f.embedModel = $model RETURN size(f.embedding) AS n LIMIT 1',
      { model },
    ).rows[0];
    return num(row?.n, 0);
  }

  // ── Recall ──

  /** Words for the full-text index: letters and digits only, so the query syntax can't misfire. */
  private searchTerms(query: string): string[] {
    return contentTerms(query, 12);
  }

  /**
   * Finds facts: by meaning (with an embedding), by words (without common words, and needing
   * two matching words once the query has three), by what they are about, by kind and age.
   * Ranked by how well they match, then importance, confirmations and recency.
   * @param input - Filters.
   */
  recall(input: RecallInput = {}): FactRow[] {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(num(input.limit, 10))));
    const params: Record<string, unknown> = {};
    const filters: string[] = [];
    if (!input.includeClosed) filters.push('f.closedAt IS NULL');
    if (input.kinds?.length) {
      filters.push('f.kind IN $kinds');
      params.kinds = input.kinds;
    }
    if (input.since) {
      filters.push('f.recordedAt >= $since');
      params.since = input.since;
    }
    if (input.about?.trim()) {
      const ref = parseRef(input.about);
      filters.push(
        ref.label === 'Note'
          ? 'EXISTS { MATCH (f)-[:ABOUT]->(:Note {key: $aboutKey}) }'
          : `EXISTS { MATCH (f)-[:ABOUT]->(e:Entity) WHERE e.key = $aboutKey
               OR coalesce(e.norm, toLower(e.name)) = $aboutName
               OR $aboutName IN coalesce(e.aliases, []) }`,
      );
      params.aboutKey = ref.key;
      params.aboutName = ref.label === 'Note' ? ref.name.toLowerCase() : normName(ref.name);
    }
    const where = filters.length ? filters.join(' AND ') : 'true';
    const terms = input.query ? this.searchTerms(input.query) : [];
    const vector = input.embedding?.vector.length ? input.embedding : undefined;
    if (!terms.length && !vector) {
      if (input.query?.trim()) {
        // Only common words: a plain substring match is the best there is.
        const rows = this.factRows(
          `${where} AND toLower(f.text) CONTAINS $q`,
          { ...params, q: input.query.toLowerCase().trim() },
          'f.importance DESC, f.recordedAt DESC',
          limit,
        );
        return rows;
      }
      const rows = this.factRows(where, params, 'f.importance DESC, f.recordedAt DESC', 200);
      for (const row of rows) row.score = this.weight(row);
      return rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
    }

    // Candidates: full-text hits, facts about entities whose names match, and vector neighbours.
    const candidates = new Set<string>();
    if (terms.length) {
      const q = fulltextQuery(terms);
      const hits = this.engine.run(
        'CALL db.index.fulltext.queryNodes($index, $terms) YIELD node, score RETURN node.key AS key LIMIT 300',
        { index: 'fact_text', terms: q },
      );
      for (const r of hits.error ? [] : hits.rows) candidates.add(String(r.key));
      const entities = this.engine.run(
        `CALL db.index.fulltext.queryNodes('entity_text', $terms) YIELD node, score
         MATCH (f:Fact)-[:ABOUT]->(node) RETURN f.key AS key LIMIT 300`,
        { terms: q },
      );
      for (const r of entities.error ? [] : entities.rows) candidates.add(String(r.key));
      if (hits.error) {
        // The index refused the words: fall back to a plain substring match.
        for (const r of this.engine.must(
          'MATCH (f:Fact) WHERE toLower(f.text) CONTAINS $q RETURN f.key AS key LIMIT 200',
          { q: input.query?.toLowerCase().trim() ?? '' },
        ).rows) {
          candidates.add(String(r.key));
        }
      }
    }
    const cosines = new Map<string, number>();
    if (vector) {
      for (const hit of this.vectorHits('Fact', vector, 40)) {
        cosines.set(hit.key, hit.cosine);
        if (hit.cosine >= VECTOR_MIN_COSINE) candidates.add(hit.key);
      }
    }
    if (!candidates.size) return [];
    const rows = this.factRows(
      `${where} AND f.key IN $keys`,
      { ...params, keys: [...candidates] },
      'f.recordedAt DESC',
      MAX_LIMIT * 8,
    );
    const need = termsNeeded(terms);
    const scored: FactRow[] = [];
    for (const row of rows) {
      const matched = terms.length ? matchedTerms(terms, `${row.text} ${row.about.join(' ')}`) : 0;
      const cos = cosines.get(row.key);
      const byWords = matched >= need;
      const byMeaning = cos !== undefined && cos >= VECTOR_MIN_COSINE;
      if (!byWords && !byMeaning) continue;
      const wordScore = terms.length ? matched / terms.length : 0;
      const meaning = cos === undefined ? 0 : Math.min(1, Math.max(0, (cos - 0.2) / 0.6));
      const relevance = vector ? 0.65 * meaning + 0.35 * wordScore : wordScore;
      row.score = relevance * this.weight(row);
      scored.push(row);
    }
    return scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }

  /**
   * Searches facts, task results and session summaries together, by words and by meaning.
   * @param input - Query and filters (filters other than the query apply to facts).
   */
  search(input: RecallInput & { types?: MemoryHit['type'][] }): MemoryHit[] {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(num(input.limit, 10))));
    const types = new Set(input.types ?? ['fact', 'task', 'session']);
    const hits: MemoryHit[] = [];
    if (types.has('fact')) {
      for (const f of this.recall({ ...input, limit })) {
        hits.push({
          type: 'fact',
          key: f.key,
          text: f.text,
          at: f.recordedAt,
          score: f.score ?? this.weight(f),
          fact: f,
        });
      }
    }
    const terms = input.query ? this.searchTerms(input.query) : [];
    const vector = input.embedding?.vector.length ? input.embedding : undefined;
    if ((terms.length || vector) && !input.about && !input.kinds?.length) {
      if (types.has('task')) hits.push(...this.searchOthers('Task', terms, vector, input.since));
      if (types.has('session'))
        hits.push(...this.searchOthers('Session', terms, vector, input.since));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Task results or session summaries that match. */
  private searchOthers(
    label: 'Task' | 'Session',
    terms: string[],
    vector: Embedded | undefined,
    since?: number,
  ): MemoryHit[] {
    const isTask = label === 'Task';
    const textField = isTask ? 'result' : 'summary';
    const candidates = new Set<string>();
    if (terms.length) {
      const r = this.engine.run(
        'CALL db.index.fulltext.queryNodes($index, $terms) YIELD node RETURN node.key AS key LIMIT 100',
        { index: isTask ? 'task_text' : 'session_text', terms: fulltextQuery(terms) },
      );
      for (const row of r.error ? [] : r.rows) candidates.add(String(row.key));
    }
    const cosines = new Map<string, number>();
    if (vector) {
      for (const hit of this.vectorHits(label, vector, 10)) {
        cosines.set(hit.key, hit.cosine);
        if (hit.cosine >= VECTOR_MIN_COSINE) candidates.add(hit.key);
      }
    }
    if (!candidates.size) return [];
    const rows = this.engine.must(
      `MATCH (n:${label}) WHERE n.key IN $keys AND n.${textField} IS NOT NULL
         AND coalesce(n.startedAt, 0) >= $since
       RETURN n.key AS key, n.title AS title, n.${textField} AS text, n.startedAt AS at`,
      { keys: [...candidates], since: since ?? 0 },
    ).rows;
    const need = termsNeeded(terms);
    const now = this.now();
    const out: MemoryHit[] = [];
    for (const r of rows) {
      const title = str(r.title);
      const text = str(r.text);
      const matched = terms.length ? matchedTerms(terms, `${title} ${text}`) : 0;
      const cos = cosines.get(String(r.key));
      if (matched < need && !(cos !== undefined && cos >= VECTOR_MIN_COSINE)) continue;
      const wordScore = terms.length ? matched / terms.length : 0;
      const meaning = cos === undefined ? 0 : Math.min(1, Math.max(0, (cos - 0.2) / 0.6));
      const relevance = vector ? 0.65 * meaning + 0.35 * wordScore : wordScore;
      const at = num(r.at, 0);
      const fresh = recency({ kind: 'observation', importance: 1, recordedAt: at }, now);
      out.push({
        type: isTask ? 'task' : 'session',
        key: String(r.key),
        title,
        text,
        at,
        // A task's finding or a call's summary counts like a fact of normal importance.
        score: relevance * (0.5 + 0.5 * fresh),
      });
    }
    return out;
  }

  // ── Shared state ──

  /**
   * Sets a value every agent sees (global, or for one session). An empty value clears it.
   * @param scope - `global` or a session key.
   * @param name - Name.
   * @param value - Value (text), or empty to clear.
   * @param agent - Who.
   * @param note - A vault note the value is about (a call's topic note).
   */
  setState(scope: string, name: string, value: string, agent: AgentName, note?: string): void {
    const key = `${scope}/${name.trim().toLowerCase()}`;
    if (!value.trim()) {
      // A cleared value is kept empty with its time, so a merge with an older copy from another
      // device doesn't bring it back (M7). Reads skip empty values.
      this.write(
        `MATCH (s:State {key: $key}) SET s.value = '', s.updatedAt = $at, s.clearedAt = $at, s.by = $agent`,
        { key, at: this.now(), agent },
      );
      return;
    }
    this.ensureAgent(agent);
    this.write(
      `MERGE (s:State {key: $key})
       SET s.scope = $scope, s.name = $name, s.value = $value, s.updatedAt = $at, s.by = $agent
       WITH s MATCH (a:Agent {key: $agent}) MERGE (s)-[:SET_BY]->(a)`,
      {
        key,
        scope,
        name: name.trim().toLowerCase(),
        value: clip(value, 4000),
        at: this.now(),
        agent,
      },
    );
    if (scope !== 'global' && scope !== 'system') {
      this.write('MATCH (s:State {key: $key}), (x:Session {key: $scope}) MERGE (s)-[:IN]->(x)', {
        key,
        scope,
      });
    }
    if (note) {
      const target = this.ensureRef(`[[${note}]]`);
      this.write('MATCH (s:State {key: $key}) OPTIONAL MATCH (s)-[old:ABOUT]->() DELETE old', {
        key,
      });
      this.write('MATCH (s:State {key: $key}), (n:Note {key: $note}) MERGE (s)-[:ABOUT]->(n)', {
        key,
        note: target.key,
      });
    }
  }

  /**
   * Shared values, global and for a session.
   * @param scopes - Scopes to read.
   */
  getState(
    scopes: string[],
  ): { scope: string; name: string; value: string; by: string; updatedAt: number }[] {
    return this.engine
      .must(
        `MATCH (s:State) WHERE s.scope IN $scopes AND coalesce(s.value, '') <> ''
         RETURN s.scope AS scope, s.name AS name, s.value AS value, s.by AS by, s.updatedAt AS updatedAt
         ORDER BY s.updatedAt DESC LIMIT 100`,
        { scopes },
      )
      .rows.map(r => ({
        scope: String(r.scope),
        name: String(r.name),
        value: str(r.value),
        by: str(r.by),
        updatedAt: num(r.updatedAt, 0),
      }));
  }

  // ── What a new session and each turn start with ──

  private factLine(f: FactRow): string {
    return `- ${f.text}${f.about.length ? ` (about ${f.about.slice(0, 3).join(', ')})` : ''} [${f.key}]`;
  }

  /**
   * Standing instructions, preferences and pinned facts: the part of the memory that belongs in
   * a system prompt. It changes only when one of those facts changes, so prompts stay cacheable.
   * @param maxChars - Longest text.
   */
  standingBrief(maxChars = 1500): string {
    const standing = this.factRows(
      "f.closedAt IS NULL AND (f.kind IN ['preference', 'instruction'] OR f.importance >= 3)",
      {},
      'f.importance DESC, f.recordedAt DESC, f.key',
      30,
    );
    return fitBlock(
      'Standing preferences, instructions and pinned facts:',
      standing.map(f => this.factLine(f)),
      maxChars,
    );
  }

  /**
   * What is happening now, the same picture for every layer: the call's topic and focus, the
   * tasks running with their last progress line, and questions waiting on an answer.
   * @param session - Current session key.
   * @param maxChars - Longest text.
   */
  nowSummary(session?: string, maxChars = 600): string {
    const lines: string[] = [];
    const state = this.getState(['global', ...(session ? [session] : [])]);
    const topic = state.find(s => s.scope === session && s.name === 'topic');
    if (topic) lines.push(`- Topic: ${clipLine(topic.value, 120)}`);
    const focus = state.find(s => s.name === 'focus');
    if (focus) lines.push(`- Focus: ${clipLine(focus.value, 120)}`);
    const tasks = this.engine.must(
      `MATCH (t:Task) WHERE t.endedAt IS NULL
       RETURN t.key AS key, t.title AS title, t.status AS status, t.progress AS progress,
         t.question AS question
       ORDER BY coalesce(t.lastUpdate, t.startedAt) DESC LIMIT 6`,
    ).rows;
    for (const t of tasks) {
      const question = t.question ? str(t.question) : '';
      lines.push(
        question
          ? `- Waiting for an answer: "${str(t.title)}" asks: ${clipLine(question, 160)}`
          : `- Running: "${str(t.title)}" (${str(t.status, 'running')}${
              t.progress ? `; last: ${clipLine(str(t.progress), 100)}` : ''
            })`,
      );
    }
    return fitBlock('Now:', lines, maxChars);
  }

  /**
   * The facts that matter for a request, as lines for a context block.
   * @param query - The request's words.
   * @param options - Session, notes it names, size.
   * @param options.embedding - The request's embedding.
   * @param options.about - Entities or notes it names (the active note).
   * @param options.limit - Most facts.
   * @param options.exclude - Fact keys already in the system prompt.
   */
  contextFacts(
    query: string,
    options: { embedding?: Embedded; about?: string[]; limit?: number; exclude?: Set<string> } = {},
  ): string[] {
    const limit = options.limit ?? 8;
    const seen = new Set<string>(options.exclude ?? []);
    const lines: string[] = [];
    const add = (line: string, key: string) => {
      if (seen.has(key) || lines.length >= limit) return;
      seen.add(key);
      lines.push(line);
    };
    for (const ref of options.about ?? []) {
      for (const f of this.recall({ about: ref, limit: 3 })) add(this.factLine(f), f.key);
    }
    for (const hit of this.search({ query, embedding: options.embedding, limit: limit + 4 })) {
      if (hit.type === 'fact' && hit.fact) add(this.factLine(hit.fact), hit.key);
      else
        add(
          `- ${hit.type === 'task' ? 'Task' : 'Session'} "${clipLine(hit.title ?? '', 60)}" (${localTime(hit.at)}): ${clipLine(hit.text, 240)} [${hit.key}]`,
          hit.key,
        );
    }
    return lines;
  }

  /** Keys of the standing facts, so a context block leaves them out. */
  standingKeys(): Set<string> {
    return new Set(
      this.engine
        .must(
          `MATCH (f:Fact) WHERE f.closedAt IS NULL
             AND (f.kind IN ['preference', 'instruction'] OR f.importance >= 3)
           RETURN f.key AS key`,
        )
        .rows.map(r => String(r.key)),
    );
  }

  /**
   * A short text of what matters now, for an agent's instructions: standing instructions and
   * preferences, pinned facts, recent decisions, unfinished tasks, the last sessions and the
   * shared state. Times are local, as call titles are.
   * @param options - Session and size.
   * @param options.session - Current session key.
   * @param options.maxChars - Longest brief.
   */
  brief(options: { session?: string; maxChars?: number } = {}): string {
    const maxChars = options.maxChars ?? 2500;
    const lines: string[] = [];
    const standing = this.factRows(
      "f.closedAt IS NULL AND (f.kind IN ['preference', 'instruction'] OR f.importance >= 3)",
      {},
      'f.importance DESC, f.recordedAt DESC',
      15,
    );
    if (standing.length)
      lines.push(
        'Standing preferences, instructions and pinned facts:',
        ...standing.map(f => this.factLine(f)),
      );
    const week = this.now() - 7 * 86_400_000;
    const recent = this.factRows(
      "f.closedAt IS NULL AND f.recordedAt >= $since AND NOT f.kind IN ['preference', 'instruction'] AND f.importance < 3",
      { since: week },
      'f.importance DESC, f.recordedAt DESC',
      40,
    )
      .map(f => ({ f, s: this.weight(f) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map(x => x.f);
    if (recent.length) lines.push('Recent (7 days):', ...recent.map(f => this.factLine(f)));
    const open = this.engine.must(
      `MATCH (t:Task) WHERE t.endedAt IS NULL
       RETURN t.key AS key, t.title AS title, t.status AS status ORDER BY t.startedAt DESC LIMIT 5`,
    ).rows;
    if (open.length) {
      lines.push(
        'Open tasks:',
        ...open.map(t => `- ${String(t.title)} (${String(t.status)}) [${String(t.key)}]`),
      );
    }
    const sessions = this.engine.must(
      `MATCH (s:Session) WHERE s.key <> $current AND s.summary IS NOT NULL
       RETURN s.title AS title, s.startedAt AS at, s.summary AS summary ORDER BY s.startedAt DESC LIMIT 3`,
      { current: options.session ?? '' },
    ).rows;
    if (sessions.length) {
      lines.push(
        'Last sessions:',
        ...sessions.map(
          s => `- ${localTime(num(s.at, 0))} ${String(s.title)}: ${String(s.summary)}`,
        ),
      );
    }
    const state = this.getState(['global', ...(options.session ? [options.session] : [])]);
    if (state.length) {
      lines.push(
        'Shared state:',
        ...state
          .slice(0, 15)
          .map(s => `- ${s.scope === 'global' ? '' : 'this session: '}${s.name} = ${s.value}`),
      );
    }
    let text = lines.join('\n');
    if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
    return text;
  }

  /**
   * The newest finished session's summary, for the voice agent's start-of-call brief.
   * @param current - This session, left out.
   */
  lastSessionLine(current?: string): string {
    const s = this.engine.must(
      `MATCH (s:Session) WHERE s.key <> $current AND s.summary IS NOT NULL
       RETURN s.title AS title, s.startedAt AS at, s.summary AS summary ORDER BY s.startedAt DESC LIMIT 1`,
      { current: current ?? '' },
    ).rows[0];
    return s ? `Last session (${localTime(num(s.at, 0))}, ${str(s.title)}): ${str(s.summary)}` : '';
  }

  // ── Agents' own read-only Cypher ──

  /**
   * Runs an agent's Cypher, read-only, with bound parameters and a row cap. A statement that
   * would write is refused before it runs; if one changed anything anyway, the caller restores
   * the graph (`changed` is true).
   * @param cypher - One statement.
   * @param params - Parameters.
   * @param maxRows - Rows returned at most.
   */
  query(
    cypher: string,
    params: Record<string, unknown> = {},
    maxRows = 50,
  ): { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; changed: boolean } {
    const refused = this.engine.writeCheck(cypher, params) || unboundedReason(cypher);
    if (refused) throw new Error(`Refused: ${refused}`);
    const result = this.engine.must(
      withRowLimit(cypher.trim().replace(/;\s*$/, ''), maxRows),
      params,
    );
    const changed = Object.values(result.stats).some(v => typeof v === 'number' && v > 0);
    return {
      columns: result.columns,
      rows: result.rows.slice(0, maxRows).map(r => hideVectors(r) as Record<string, unknown>),
      truncated: result.rows.length > maxRows,
      changed,
    };
  }

  /** The schema, for an agent writing Cypher. */
  schemaText(): string {
    return [
      'Labels (each node has a unique `key`):',
      '(:Agent {key: voice|orchestrator|worker|chat|librarian}) (:Session {key, kind, title, startedAt, endedAt, summary})',
      '(:Task {key, title, status, progress, question, lastUpdate, startedAt, endedAt, result}) (:Request {key, text, at, by, typed})',
      '(:Entity {key: "kind:name", name, kind, norm, aliases}) (:Note {key: vault path, name})',
      '(:Fact {key, text, kind, slot, importance, recordedAt, closedAt, closedReason, by, confirmations, lastSeenAt, evidence, source})',
      '(:State {key, scope, name, value, updatedAt, by})',
      'Relationships: (Fact)-[:ABOUT]->(Entity|Note), (Fact)-[:FROM]->(Session|Task), (Fact)-[:BY]->(Agent),',
      '(Fact)-[:SUPERSEDES]->(Fact), (Task)-[:IN]->(Session), (Task)-[:BY]->(Agent), (Request)-[:IN]->(Session),',
      '(Request)-[:SPAWNED]->(Task), (Session)-[:FOLLOWS]->(Session), (Entity)-[:RELATED {kind}]->(Entity),',
      '(State)-[:IN]->(Session), (State)-[:SET_BY]->(Agent), (State)-[:ABOUT]->(Note).',
      'Times are epoch milliseconds. A current fact has closedAt IS NULL.',
      "Full-text: CALL db.index.fulltext.queryNodes('fact_text' | 'task_text' | 'session_text', $words) YIELD node, score.",
    ].join('\n');
  }

  // ── Saving and loading ──

  /** The whole graph, for the vault file. */
  snapshot(): MemorySnapshot {
    const nodes: MemorySnapshot['nodes'] = {};
    for (const label of LABELS) {
      const rows = this.engine.must(
        `MATCH (n:${label}) RETURN properties(n) AS p ORDER BY n.key`,
      ).rows;
      if (rows.length) nodes[label] = rows.map(r => r.p as Record<string, unknown>);
    }
    const relationships = this.engine
      .must(
        `MATCH (a)-[r]->(b)
         RETURN type(r) AS type, labels(a)[0] AS fl, a.key AS fk, labels(b)[0] AS tl, b.key AS tk,
           properties(r) AS props ORDER BY fk, type, tk`,
      )
      .rows.filter(r => REL_TYPES.includes(r.type as RelType))
      .map(r => {
        const props = r.props as Record<string, unknown> | null;
        return {
          type: r.type as RelType,
          from: [r.fl as Label, String(r.fk)] as [Label, string],
          to: [r.tl as Label, String(r.tk)] as [Label, string],
          ...(props && Object.keys(props).length ? { props } : {}),
        };
      });
    return { format: 'voice-agent-memory', version: 1, savedAt: this.now(), nodes, relationships };
  }

  /**
   * Replaces the graph with a snapshot (on load, or after merging another device's copy).
   * @param snapshot - Saved graph.
   */
  load(snapshot: MemorySnapshot): void {
    if (snapshot?.format !== 'voice-agent-memory')
      throw new Error('Not a Voice Agent memory file.');
    this.engine.must('MATCH (n) DETACH DELETE n');
    for (const label of LABELS) {
      const rows = (snapshot.nodes?.[label] ?? []).filter(
        p => p && typeof p === 'object' && typeof p.key === 'string',
      );
      for (let i = 0; i < rows.length; i += 500) {
        this.engine.must(`UNWIND $rows AS p CREATE (n:${label}) SET n = p`, {
          rows: rows.slice(i, i + 500),
        });
      }
    }
    const groups = new Map<string, { type: RelType; fl: Label; tl: Label; rows: unknown[] }>();
    for (const r of snapshot.relationships ?? []) {
      if (
        !REL_TYPES.includes(r.type) ||
        !LABELS.includes(r.from?.[0]) ||
        !LABELS.includes(r.to?.[0])
      )
        continue;
      const id = `${r.type}|${r.from[0]}|${r.to[0]}`;
      const group = groups.get(id) ?? { type: r.type, fl: r.from[0], tl: r.to[0], rows: [] };
      group.rows.push({ from: r.from[1], to: r.to[1], props: r.props ?? {} });
      groups.set(id, group);
    }
    for (const g of groups.values()) {
      for (let i = 0; i < g.rows.length; i += 500) {
        this.engine.must(
          `UNWIND $rows AS r MATCH (a:${g.fl} {key: r.from}), (b:${g.tl} {key: r.to})
           CREATE (a)-[x:${g.type}]->(b) SET x = r.props`,
          { rows: g.rows.slice(i, i + 500) },
        );
      }
    }
    this.factVersion++;
    this.dirty = false;
  }

  /** Frees the engine. */
  dispose(): void {
    this.engine.dispose();
  }
}

/**
 * Replaces stored vectors in a query's rows with a short note, so a result never carries
 * thousands of numbers.
 * @param value - A row or a value in one.
 */
export function hideVectors(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > 16 && value.every(v => typeof v === 'number'))
      return `[vector of ${value.length} numbers]`;
    return value.map(hideVectors);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === 'embedding' && Array.isArray(v) ? `[vector of ${v.length} numbers]` : hideVectors(v),
      ]),
    );
  }
  return value;
}

/**
 * Leaves one current fact per slot, the newest; the others are closed as superseded by the merge.
 * @param facts - Fact nodes; the ones closed come back as copies.
 */
function closeDuplicateSlots(facts: Record<string, unknown>[]): Record<string, unknown>[] {
  const newest = new Map<string, Record<string, unknown>>();
  for (const f of facts) {
    if (typeof f.slot !== 'string' || !f.slot || f.closedAt != null) continue;
    const have = newest.get(f.slot);
    if (!have || num(f.recordedAt, 0) > num(have.recordedAt, 0)) newest.set(f.slot, f);
  }
  return facts.map(f => {
    if (typeof f.slot !== 'string' || !f.slot || f.closedAt != null) return f;
    const keep = newest.get(f.slot);
    return keep && keep !== f
      ? { ...f, closedAt: num(keep.recordedAt, 0), closedReason: 'superseded (merge)' }
      : f;
  });
}

/**
 * Joins two copies of the memory (this device's and one synced from another): every node from
 * both, the newer of the two where both have it (by its own time fields), every relationship
 * from both. Nothing is deleted in the memory model, so a union loses nothing. A cleared state
 * value is kept empty with its time, so the newer of a clear and a set wins; and when each device
 * wrote a new fact in the same slot, only the newest stays current (M7). A fact closed on either
 * device stays closed, confirmations add up to the larger count, and an embedding one copy has
 * is kept when the newer copy has none.
 * @param a - One copy.
 * @param b - The other.
 */
export function mergeSnapshots(a: MemorySnapshot, b: MemorySnapshot): MemorySnapshot {
  const stamp = (p: Record<string, unknown>) =>
    Math.max(
      ...[
        'updatedAt',
        'closedAt',
        'endedAt',
        'recordedAt',
        'startedAt',
        'createdAt',
        'lastSeenAt',
        'lastUpdate',
        'summarizedAt',
        'at',
      ].map(k => num(p[k], 0)),
    );
  const nodes: MemorySnapshot['nodes'] = {};
  for (const label of LABELS) {
    const byKey = new Map<string, Record<string, unknown>>();
    for (const p of [...(a.nodes[label] ?? []), ...(b.nodes[label] ?? [])]) {
      const key = String(p.key);
      const have = byKey.get(key);
      if (!have) {
        byKey.set(key, p);
        continue;
      }
      const newer = stamp(p) > stamp(have);
      const [winner, loser] = newer ? [{ ...have, ...p }, have] : [have, p];
      const embedded = (n: Record<string, unknown>) =>
        JSON.stringify([n.text, n.title, n.result, n.summary]);
      if (newer && p.embedding == null && embedded(p) !== embedded(have)) {
        // The text changed since the older copy's embedding was made.
        delete winner.embedding;
        delete winner.embedModel;
      }
      if (label === 'Fact') {
        if (winner.closedAt == null && loser.closedAt != null) {
          winner.closedAt = loser.closedAt;
          winner.closedReason = loser.closedReason;
          if (loser.closedBy !== undefined) winner.closedBy = loser.closedBy;
        }
        winner.confirmations = Math.max(num(winner.confirmations, 1), num(loser.confirmations, 1));
      }
      if (
        winner.embedding == null &&
        loser.embedding != null &&
        embedded(winner) === embedded(loser)
      ) {
        winner.embedding = loser.embedding;
        winner.embedModel = loser.embedModel;
      }
      byKey.set(key, winner);
    }
    if (byKey.size) nodes[label] = [...byKey.values()];
  }
  if (nodes.Fact) nodes.Fact = closeDuplicateSlots(nodes.Fact);
  const rels = new Map<string, MemorySnapshot['relationships'][number]>();
  for (const r of [...a.relationships, ...b.relationships]) {
    rels.set(
      `${r.type}|${r.from.join(':')}|${r.to.join(':')}|${JSON.stringify(r.props?.kind ?? '')}`,
      r,
    );
  }
  return {
    format: 'voice-agent-memory',
    version: 1,
    savedAt: Math.max(a.savedAt, b.savedAt),
    nodes,
    relationships: [...rels.values()],
  };
}
