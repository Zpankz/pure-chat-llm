// The agents' shared memory: one relate graph that the voice agent, the orchestrator, workers and
// note chats all read and write, saved in the vault so a new session starts with what earlier
// ones learned. The model follows relate's agent-memory guide (Entity, Fact, SUPERSEDES; nothing
// is deleted, a correction closes the old fact), with sessions, tasks, agents and a shared
// key/value state added for the plugin's own agents.
//
// Schema (every node has a unique `key`):
//   (:Agent   {key: voice|orchestrator|worker|chat, name})
//   (:Session {key, kind: call|app, title, startedAt, endedAt, summary})
//   (:Task    {key, title, status, startedAt, endedAt, result})
//   (:Entity  {key: kind:name, name, kind, aliases, createdAt, updatedAt})
//   (:Note    {key: vault path, path, name})
//   (:Fact    {key, text, kind, slot, importance, recordedAt, closedAt, closedReason, by})
//   (:State   {key: scope/name, scope, name, value, updatedAt, by})
//   (Fact)-[:ABOUT]->(Entity|Note)      (Fact)-[:FROM]->(Session|Task)
//   (Fact)-[:BY]->(Agent)               (Fact)-[:SUPERSEDES]->(Fact)
//   (Task)-[:IN]->(Session)             (Task)-[:BY]->(Agent)
//   (Session)-[:FOLLOWS]->(Session)     (Entity)-[:RELATED {kind}]->(Entity)
//   (State)-[:IN]->(Session)            (State)-[:SET_BY]->(Agent)
//
// Agents write only through the methods here, with bound parameters; their own Cypher goes
// through `query`, which refuses anything that writes.
import { GraphEngine } from './relateEngine';
import type { CypherResult } from './relateEngine';

export const LABELS = ['Agent', 'Session', 'Task', 'Entity', 'Note', 'Fact', 'State'] as const;
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

export type AgentName = 'voice' | 'orchestrator' | 'worker' | 'chat';

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
  score?: number;
}

export interface RecallInput {
  query?: string;
  about?: string;
  kinds?: string[];
  limit?: number;
  includeClosed?: boolean;
  since?: number;
}

const SCHEMA = [
  ...LABELS.map(
    l =>
      `CREATE CONSTRAINT ${l.toLowerCase()}_key IF NOT EXISTS FOR (n:${l}) REQUIRE n.key IS UNIQUE`,
  ),
  'CREATE FULLTEXT INDEX fact_text IF NOT EXISTS FOR (f:Fact) ON EACH [f.text]',
  'CREATE FULLTEXT INDEX entity_text IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.search]',
  'CREATE INDEX fact_slot IF NOT EXISTS FOR (f:Fact) ON (f.slot)',
  'CREATE INDEX fact_kind IF NOT EXISTS FOR (f:Fact) ON (f.kind)',
];

const MAX_TEXT = 2000;
const MAX_LIMIT = 50;

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

export class MemoryGraph {
  private engine: GraphEngine;
  /** Changes not yet saved. */
  dirty = false;
  private now: () => number;

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

  // ── Agents, sessions and tasks (written by the plugin, not by models) ──

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
        (summary ? ', s.summary = $summary' : ''),
      { key, at: this.now(), ...(summary ? { summary: clip(summary) } : {}) },
    );
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
       SET t.title = $title, t.status = $status${ended ? ', t.endedAt = $at' : ''}${
         task.result ? ', t.result = $result' : ''
       }
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

  // ── Facts ──

  private ensureRef(ref: string): { label: 'Note' | 'Entity'; key: string } {
    const r = parseRef(ref);
    const at = this.now();
    if (r.label === 'Note') {
      this.write('MERGE (n:Note {key: $key}) ON CREATE SET n.path = $key, n.name = $name', {
        key: r.key,
        name: r.name,
      });
    } else {
      this.write(
        `MERGE (e:Entity {key: $key})
         ON CREATE SET e.name = $name, e.kind = $kind, e.createdAt = $at, e.aliases = [], e.search = $name
         SET e.updatedAt = $at`,
        { key: r.key, name: r.name, kind: r.kind, at },
      );
    }
    return r;
  }

  /**
   * Saves a fact. With a slot, the slot's current fact is closed and superseded.
   * @param input - The fact.
   * @returns Its key, and the keys it closed.
   */
  remember(input: RememberInput): { key: string; closed: string[] } {
    const text = clip(input.text ?? '');
    if (!text) throw new Error('The memory is empty.');
    const kind = FACT_KINDS.includes(input.kind as FactKind) ? (input.kind as FactKind) : 'fact';
    const importance = Math.min(3, Math.max(1, Math.round(num(input.importance, 1))));
    const slot = input.slot?.trim().toLowerCase() || null;
    const at = this.now();
    const key = newKey('f', at);
    this.ensureAgent(input.agent);
    this.write(
      `CREATE (f:Fact {key: $key, text: $text, kind: $kind, slot: $slot, importance: $importance,
         recordedAt: $at, by: $agent})
       WITH f MATCH (a:Agent {key: $agent}) CREATE (f)-[:BY]->(a)`,
      { key, text, kind, slot, importance, at, agent: input.agent },
    );
    for (const ref of (input.about ?? [])
      .filter(r => typeof r === 'string' && r.trim())
      .slice(0, 12)) {
      const target = this.ensureRef(ref);
      this.write(
        `MATCH (f:Fact {key: $key}), (t:${target.label} {key: $target}) MERGE (f)-[:ABOUT]->(t)`,
        {
          key,
          target: target.key,
        },
      );
    }
    if (input.task) {
      this.write('MATCH (f:Fact {key: $key}), (t:Task {key: $task}) MERGE (f)-[:FROM]->(t)', {
        key,
        task: input.task,
      });
    }
    if (input.session) {
      this.write('MATCH (f:Fact {key: $key}), (s:Session {key: $session}) MERGE (f)-[:FROM]->(s)', {
        key,
        session: input.session,
      });
    }
    const replaced = new Set<string>(input.supersedes ?? []);
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
      const r = this.write(
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
    const r = this.write(
      `MATCH (f:Fact {key: $key}) WHERE f.closedAt IS NULL
       SET f.closedAt = $at, f.closedReason = $reason, f.closedBy = $agent RETURN f.key AS key`,
      { key, at: this.now(), reason: clip(reason || 'retracted', 300), agent },
    );
    return r.rows.length > 0;
  }

  /**
   * Relates two entities.
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
           f.by AS by, about, session
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
      }));
  }

  /** Words for the full-text index: letters and digits only, so the query syntax can't misfire. */
  private searchTerms(query: string): string {
    return query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 12)
      .join(' ');
  }

  /**
   * Finds facts: by words (full-text), by what they are about, by kind and age.
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
          : 'EXISTS { MATCH (f)-[:ABOUT]->(e:Entity) WHERE e.key = $aboutKey OR toLower(e.name) = $aboutName OR $aboutName IN e.aliases }',
      );
      params.aboutKey = ref.key;
      params.aboutName = ref.name.toLowerCase();
    }
    const where = filters.length ? filters.join(' AND ') : 'true';
    const terms = input.query ? this.searchTerms(input.query) : '';
    if (!terms) return this.factRows(where, params, 'f.importance DESC, f.recordedAt DESC', limit);

    // Full-text hits, and facts about entities whose names match, ranked together.
    const scores = new Map<string, number>();
    const hits = this.engine.run(
      'CALL db.index.fulltext.queryNodes($index, $terms) YIELD node, score RETURN node.key AS key, score LIMIT 200',
      { index: 'fact_text', terms },
    );
    for (const r of hits.error ? [] : hits.rows) scores.set(String(r.key), num(r.score, 0));
    const entities = this.engine.run(
      `CALL db.index.fulltext.queryNodes('entity_text', $terms) YIELD node, score
       MATCH (f:Fact)-[:ABOUT]->(node) RETURN f.key AS key, score LIMIT 200`,
      { terms },
    );
    for (const r of entities.error ? [] : entities.rows) {
      const k = String(r.key);
      scores.set(k, (scores.get(k) ?? 0) + num(r.score, 0) * 0.8);
    }
    if (hits.error) {
      // The index refused the words: fall back to a plain substring match.
      for (const r of this.engine.must(
        'MATCH (f:Fact) WHERE toLower(f.text) CONTAINS $q RETURN f.key AS key LIMIT 200',
        { q: input.query?.toLowerCase().trim() ?? '' },
      ).rows) {
        scores.set(String(r.key), 1);
      }
    }
    if (!scores.size) return [];
    const rows = this.factRows(
      `${where} AND f.key IN $keys`,
      { ...params, keys: [...scores.keys()] },
      'f.recordedAt DESC',
      MAX_LIMIT * 4,
    );
    for (const row of rows)
      row.score = (scores.get(row.key) ?? 0) * (1 + (row.importance - 1) * 0.25);
    return rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }

  // ── Shared state ──

  /**
   * Sets a value every agent sees (global, or for one session). An empty value clears it.
   * @param scope - `global` or a session key.
   * @param name - Name.
   * @param value - Value (text), or empty to clear.
   * @param agent - Who.
   */
  setState(scope: string, name: string, value: string, agent: AgentName): void {
    const key = `${scope}/${name.trim().toLowerCase()}`;
    if (!value.trim()) {
      this.write('MATCH (s:State {key: $key}) DETACH DELETE s', { key });
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
    if (scope !== 'global') {
      this.write('MATCH (s:State {key: $key}), (x:Session {key: $scope}) MERGE (s)-[:IN]->(x)', {
        key,
        scope,
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
        `MATCH (s:State) WHERE s.scope IN $scopes
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

  // ── What a new session starts with ──

  /**
   * A short text of what matters now, for an agent's instructions: standing instructions and
   * preferences, pinned facts, recent decisions, unfinished tasks, the last sessions and the
   * shared state.
   * @param options - Session and size.
   * @param options.session - Current session key.
   * @param options.maxChars - Longest brief.
   */
  brief(options: { session?: string; maxChars?: number } = {}): string {
    const maxChars = options.maxChars ?? 2500;
    const lines: string[] = [];
    const fact = (f: FactRow) =>
      `- ${f.text}${f.about.length ? ` (about ${f.about.slice(0, 3).join(', ')})` : ''} [${f.key}]`;
    const standing = this.factRows(
      "f.closedAt IS NULL AND (f.kind IN ['preference', 'instruction'] OR f.importance >= 3)",
      {},
      'f.importance DESC, f.recordedAt DESC',
      15,
    );
    if (standing.length)
      lines.push('Standing preferences, instructions and pinned facts:', ...standing.map(fact));
    const week = this.now() - 7 * 86_400_000;
    const recent = this.factRows(
      "f.closedAt IS NULL AND f.recordedAt >= $since AND NOT f.kind IN ['preference', 'instruction'] AND f.importance < 3",
      { since: week },
      'f.importance DESC, f.recordedAt DESC',
      10,
    );
    if (recent.length) lines.push('Recent (7 days):', ...recent.map(fact));
    const open = this.engine.must(
      `MATCH (t:Task) WHERE t.endedAt IS NULL
       RETURN t.key AS key, t.title AS title, t.status AS status ORDER BY t.startedAt DESC LIMIT 5`,
    ).rows;
    if (open.length) {
      lines.push(
        'Unfinished tasks from earlier:',
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
          s =>
            `- ${new Date(num(s.at, 0)).toISOString().slice(0, 16).replace('T', ' ')} ${String(s.title)}: ${String(s.summary)}`,
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
    const refused = this.engine.writeCheck(cypher, params);
    if (refused) throw new Error(`Refused: ${refused}`);
    const result = this.engine.must(cypher.trim().replace(/;\s*$/, ''), params);
    const changed = Object.values(result.stats).some(v => typeof v === 'number' && v > 0);
    return {
      columns: result.columns,
      rows: result.rows.slice(0, maxRows),
      truncated: result.rows.length > maxRows,
      changed,
    };
  }

  /** The schema, for an agent writing Cypher. */
  schemaText(): string {
    return [
      'Labels (each node has a unique `key`):',
      '(:Agent {key: voice|orchestrator|worker|chat}) (:Session {key, kind, title, startedAt, endedAt, summary})',
      '(:Task {key, title, status, startedAt, endedAt, result}) (:Entity {key: "kind:name", name, kind, aliases})',
      '(:Note {key: vault path, name}) (:Fact {key, text, kind, slot, importance, recordedAt, closedAt, closedReason, by})',
      '(:State {key, scope, name, value, updatedAt, by})',
      'Relationships: (Fact)-[:ABOUT]->(Entity|Note), (Fact)-[:FROM]->(Session|Task), (Fact)-[:BY]->(Agent),',
      '(Fact)-[:SUPERSEDES]->(Fact), (Task)-[:IN]->(Session), (Task)-[:BY]->(Agent), (Session)-[:FOLLOWS]->(Session),',
      '(Entity)-[:RELATED {kind}]->(Entity), (State)-[:IN]->(Session), (State)-[:SET_BY]->(Agent).',
      'Times are epoch milliseconds. A current fact has closedAt IS NULL.',
      "Full-text: CALL db.index.fulltext.queryNodes('fact_text', $words) YIELD node, score.",
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
    this.dirty = false;
  }

  /** Frees the engine. */
  dispose(): void {
    this.engine.dispose();
  }
}

/**
 * Joins two copies of the memory (this device's and one synced from another): every node from
 * both, the newer of the two where both have it (by its own time fields), every relationship
 * from both. Nothing is deleted in the memory model, so a union loses nothing; a state value
 * cleared on one device and kept on the other comes back.
 * @param a - One copy.
 * @param b - The other.
 */
export function mergeSnapshots(a: MemorySnapshot, b: MemorySnapshot): MemorySnapshot {
  const stamp = (p: Record<string, unknown>) =>
    Math.max(
      ...['updatedAt', 'closedAt', 'endedAt', 'recordedAt', 'startedAt', 'createdAt'].map(k =>
        num(p[k], 0),
      ),
    );
  const nodes: MemorySnapshot['nodes'] = {};
  for (const label of LABELS) {
    const byKey = new Map<string, Record<string, unknown>>();
    for (const p of [...(a.nodes[label] ?? []), ...(b.nodes[label] ?? [])]) {
      const key = String(p.key);
      const have = byKey.get(key);
      if (!have || stamp(p) > stamp(have)) byKey.set(key, have ? { ...have, ...p } : p);
    }
    if (byKey.size) nodes[label] = [...byKey.values()];
  }
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
