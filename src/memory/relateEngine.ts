// The relate graph engine (https://relatedb.ai, Apache-2.0): an embedded openCypher database,
// here as its WebAssembly build, so the same engine runs on desktop and mobile with nothing to
// install. The release build embeds the module gzipped (esbuild.config.mjs); it is unpacked and
// checked against its pinned sha256 before it is compiled. The database itself lives in memory;
// `MemoryGraph` saves it to the vault and loads it back.
import { initSync, RelateDb } from '@relate/relate-wasm';

// Set by esbuild.config.mjs.
declare const __RELATE_WASM_GZ_BASE64__: string | undefined;
declare const __RELATE_WASM_SHA256__: string | undefined;

/** One statement's result, from relate's wire envelope. */
export interface CypherResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Mutation counters (nodes_created, properties_set…). */
  stats: Record<string, number>;
  /** The engine's error, or null. Engine errors never throw. */
  error: string | null;
}

/** Plan operators a read may use; anything else refuses the statement. */
const READ_OPERATORS = new Set([
  'ProduceResults',
  'NodeIndexSeek',
  'NodeUniqueIndexSeek',
  'NodeIndexScan',
  'NodeByLabelScan',
  'NodeByIdSeek',
  'AllNodesScan',
  'Expand',
  'VarLengthExpand',
  'Optional',
  'Filter',
  'Projection',
  'EagerAggregation',
  'Aggregation',
  'Sort',
  'Top',
  'Limit',
  'Skip',
  'Distinct',
  'Unwind',
  'Union',
  'Apply',
  'CartesianProduct',
  'CallSubquery',
  'Argument',
  'ShortestPath',
  'ProcedureCall',
  'Catalog',
]);

/** Procedures a read may call. */
const READ_PROCEDURES = new Set([
  'db.labels',
  'db.relationshipTypes',
  'db.propertyKeys',
  'db.schema.visualization',
  'db.schema.nodeTypeProperties',
  'db.schema.relTypeProperties',
  'db.index.fulltext.queryNodes',
  'db.index.fulltext.queryRelationships',
]);

/** Clauses that write data or schema, refused in the text even inside a subquery. */
const WRITE_CLAUSE =
  /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD|ALTER|GRANT|DENY|REVOKE|TERMINATE|START|STOP|USE)\b/i;

/** Statement text without string literals, quoted names and comments, for keyword checks. */
function codeOnly(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, ' ');
}

let module: WebAssembly.Module | null = null;
let ready: Promise<void> | null = null;
let testBytes: Uint8Array | null = null;

/**
 * Supplies the module's bytes directly (tests, where nothing is embedded).
 * @param bytes - relate_bg.wasm.
 */
export function setRelateWasmForTests(bytes: Uint8Array): void {
  testBytes = bytes;
  module = null;
  ready = null;
}

/** Whether this build carries the engine. */
export function relateAvailable(): boolean {
  return (
    !!testBytes || (typeof __RELATE_WASM_GZ_BASE64__ === 'string' && !!__RELATE_WASM_GZ_BASE64__)
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function gunzip(base64: string): Promise<Uint8Array> {
  const binary = atob(base64);
  const packed = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) packed[i] = binary.charCodeAt(i);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This device cannot unpack the graph engine (no DecompressionStream).');
  }
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Loads the engine once. */
export function loadRelate(): Promise<void> {
  ready ??= (async () => {
    let bytes: Uint8Array;
    if (testBytes) {
      bytes = testBytes;
    } else {
      if (!relateAvailable()) throw new Error('This build does not include the graph engine.');
      bytes = await gunzip(__RELATE_WASM_GZ_BASE64__ as string);
      const expected = typeof __RELATE_WASM_SHA256__ === 'string' ? __RELATE_WASM_SHA256__ : '';
      const actual = await sha256(bytes);
      if (!expected || actual !== expected) {
        throw new Error(`The graph engine failed its checksum (${actual.slice(0, 12)}…).`);
      }
    }
    module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
    initSync({ module });
  })().catch(error => {
    ready = null;
    throw error;
  });
  return ready;
}

/** Walks a relate plan tree: its operators and the procedures it calls. */
function planParts(plan: unknown): { operators: string[]; procedures: string[] } {
  const operators: string[] = [];
  const procedures: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { operator?: unknown; details?: unknown; children?: unknown };
    if (typeof n.operator === 'string') {
      operators.push(n.operator.replace(/\(.*$/, ''));
      if (n.operator === 'ProcedureCall' && typeof n.details === 'string') {
        procedures.push(n.details.split('(')[0].trim());
      }
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk((plan as { root?: unknown } | null)?.root);
  return { operators, procedures };
}

/** An in-memory relate database. `loadRelate` must have finished first. */
export class GraphEngine {
  private db: RelateDb;

  constructor() {
    if (!module) throw new Error('The graph engine is not loaded yet.');
    this.db = new RelateDb();
  }

  /**
   * Runs one statement with bound parameters.
   * @param query - Cypher.
   * @param params - Parameters, bound as `$name`; never spliced into the text.
   */
  run(query: string, params?: Record<string, unknown>): CypherResult {
    const raw = this.db.execute(query, params ? JSON.stringify(params) : null);
    const envelope = JSON.parse(raw) as Partial<CypherResult> & { plan?: unknown };
    return {
      columns: envelope.columns ?? [],
      rows: envelope.rows ?? [],
      stats: (envelope.stats as Record<string, number>) ?? {},
      error: envelope.error ?? null,
    };
  }

  /**
   * Runs a statement and throws on an engine error.
   * @param query - Cypher.
   * @param params - Parameters.
   */
  must(query: string, params?: Record<string, unknown>): CypherResult {
    const result = this.run(query, params);
    if (result.error) throw new Error(result.error);
    return result;
  }

  /**
   * Why a statement may not run read-only, or null when it only reads. Three checks: no write
   * clause in its text (subqueries included), only read operators in the engine's plan of it, and
   * only catalogue and search procedures. The caller still compares the counters afterwards.
   * @param query - Cypher.
   * @param params - Parameters.
   */
  writeCheck(query: string, params?: Record<string, unknown>): string | null {
    const trimmed = query.trim().replace(/;\s*$/, '');
    const code = codeOnly(trimmed);
    if (code.includes(';')) return 'Run one statement at a time.';
    if (/^\s*(EXPLAIN|PROFILE)\b/i.test(code)) return 'Leave out EXPLAIN and PROFILE.';
    const clause = WRITE_CLAUSE.exec(code);
    if (clause) return `${clause[1].toUpperCase()} changes the graph; this is read-only.`;
    const raw = this.db.execute(`EXPLAIN ${trimmed}`, params ? JSON.stringify(params) : null);
    const envelope = JSON.parse(raw) as { error?: string | null; plan?: unknown };
    if (envelope.error) return envelope.error;
    const { operators, procedures } = planParts(envelope.plan);
    if (!operators.length) return 'The statement has no plan, so it cannot be checked.';
    const other = operators.filter(op => !READ_OPERATORS.has(op));
    if (other.length) return `It is not a plain read (${[...new Set(other)].join(', ')}).`;
    const calls = procedures.filter(p => !READ_PROCEDURES.has(p));
    if (calls.length)
      return `Only search and schema procedures may be called (${calls.join(', ')}).`;
    return null;
  }

  /** Frees the database. */
  dispose(): void {
    try {
      this.db.free();
    } catch {
      // Already freed.
    }
  }
}
