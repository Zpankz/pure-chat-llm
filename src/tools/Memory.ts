// The memory tools: every agent's way into the shared memory graph (see memory/MemoryGraph.ts).
// Writes go only through remember, forget, relate and state, with bound parameters; agents' own
// Cypher goes through memory_query, which is read-only.
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FACT_KINDS } from '../memory/MemoryGraph';
import type { FactRow } from '../memory/MemoryGraph';
import { agentForRole } from '../memory/MemoryService';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

/** The shared memory tools, offered to every agent. */
export const MEMORY_TOOL_NAMES: string[] = [
  'memory_recall',
  'memory_remember',
  'memory_forget',
  'memory_state',
  'memory_query',
];

/** Read-only memory tools (may run side by side). */
export const MEMORY_READ_TOOLS = ['memory_recall', 'memory_query'];

abstract class MemoryTool<T> extends Tool<T> {
  readonly classification = 'AI';
  readonly agentCore = true;

  protected get memory() {
    return this.chat.plugin.memory;
  }

  protected get agent() {
    return agentForRole(this.chat.role);
  }

  isAvailable(): boolean {
    return !!this.memory?.enabled;
  }

  protected failed(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Refused:')) {
      return toolError('Refused', message.replace(/^Refused:\s*/, ''), [
        'Use memory_remember, memory_forget or memory_state to change memory.',
      ]);
    }
    return toolError('MemoryError', message);
  }
}

function factLine(f: FactRow): string {
  const when = new Date(f.recordedAt).toISOString().slice(0, 10);
  const about = f.about.length ? ` (about ${f.about.join(', ')})` : '';
  const closed = f.closedAt ? ' [no longer current]' : '';
  return `- [${f.key}] ${f.kind}, ${when}, by ${f.by ?? '?'}: ${f.text}${about}${closed}`;
}

// ── memory_recall ──

const recallParameters = defineToolParameters({
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Words to search for. Leave empty to list the most important and recent facts.',
    },
    about: {
      type: 'string',
      description: 'Only facts about this: a name, `kind:name` (person:Sam) or a [[note]].',
    },
    kinds: {
      type: 'array',
      items: { type: 'string', enum: [...FACT_KINDS], description: 'A kind.' },
      description: 'Only these kinds.',
    },
    days: { type: 'number', description: 'Only facts from the last this many days.' },
    include_closed: {
      type: 'boolean',
      description: 'Also facts that were corrected or forgotten (marked no longer current).',
    },
    limit: { type: 'number', description: 'Most facts to return (default 10, at most 50).' },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: [],
} as const);

export class MemoryRecallTool extends MemoryTool<InferArgs<typeof recallParameters>> {
  readonly name = 'memory_recall';
  readonly description =
    'Searches the shared memory that all agents keep across sessions: preferences, instructions, decisions and facts the user or other agents saved, with their ids. Use it before asking the user something they may have said before. Parameters: query (words), about (a name, kind:name or [[note]]), kinds, days, include_closed, limit, format.';
  readonly parameters = recallParameters;

  async execute(args: InferArgs<typeof recallParameters>): Promise<string> {
    try {
      const memory = this.memory;
      const facts = await memory.use(g =>
        g.recall({
          query: typeof args.query === 'string' ? args.query : undefined,
          about: typeof args.about === 'string' ? args.about : undefined,
          kinds: Array.isArray(args.kinds) ? (args.kinds as string[]) : undefined,
          limit: args.limit,
          includeClosed: !!args.include_closed,
          since: args.days ? Date.now() - args.days * 86_400_000 : undefined,
        }),
      );
      if (wantsJson(args)) return jsonResult({ facts, count: facts.length });
      if (!facts.length) return 'No memories match.';
      return [`${facts.length} memories:`, ...facts.map(factLine)].join('\n');
    } catch (error) {
      return this.failed(error);
    }
  }
}

// ── memory_remember ──

const rememberParameters = defineToolParameters({
  type: 'object',
  properties: {
    text: { type: 'string', description: 'One fact, in plain words that stand on their own.' },
    kind: {
      type: 'string',
      enum: [...FACT_KINDS],
      description:
        'preference or instruction (the user said how they want things; always briefed), decision, todo, summary, observation, or fact (default).',
    },
    about: {
      type: 'array',
      items: { type: 'string', description: 'A name, kind:name or [[note]].' },
      description:
        'What it is about: names, `kind:name` (person:Sam, project:Garden) or [[notes]].',
    },
    slot: {
      type: 'string',
      description:
        'For things with one current value (for example "preferred voice"): saving closes the slot’s earlier fact.',
    },
    supersedes: {
      type: 'array',
      items: { type: 'string', description: 'A fact id.' },
      description: 'Ids of facts this one corrects; they stop being current.',
    },
    importance: {
      type: 'number',
      description: '1 normal (default), 2 important, 3 pinned (always in every agent’s brief).',
    },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: ['text'],
} as const);

export class MemoryRememberTool extends MemoryTool<InferArgs<typeof rememberParameters>> {
  readonly name = 'memory_remember';
  readonly description =
    'Saves one fact to the shared memory every agent reads, now and in later sessions. Use it when the user states a preference, instruction or decision, or a task learns something worth keeping. Never save passwords, keys or card or ID numbers. Parameters: text, kind, about, slot (one current value), supersedes (ids it corrects), importance, format.';
  readonly parameters = rememberParameters;

  async execute(args: InferArgs<typeof rememberParameters>): Promise<string> {
    if (typeof args.text !== 'string' || !args.text.trim()) {
      return toolError('InvalidArgs', 'text is empty.');
    }
    if (
      /\b(sk-[A-Za-z0-9]{8,}|AIza[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|\d{13,19})\b/.test(args.text)
    ) {
      return toolError(
        'Refused',
        'That looks like a key or a card number; memory never keeps those.',
      );
    }
    try {
      const memory = this.memory;
      const saved = await memory.use(g =>
        g.remember({
          text: args.text,
          kind: args.kind as never,
          about: Array.isArray(args.about) ? (args.about as string[]) : undefined,
          slot: typeof args.slot === 'string' ? args.slot : undefined,
          supersedes: Array.isArray(args.supersedes) ? (args.supersedes as string[]) : undefined,
          importance: args.importance,
          agent: this.agent,
          session: memory.session,
          task: this.chat.task ? memory.taskKey(this.chat.task.id) : undefined,
        }),
      );
      if (wantsJson(args)) return jsonResult({ key: saved.key, closed: saved.closed });
      return `Saved as ${saved.key}.${saved.closed.length ? ` No longer current: ${saved.closed.join(', ')}.` : ''}`;
    } catch (error) {
      return this.failed(error);
    }
  }
}

// ── memory_forget ──

const forgetParameters = defineToolParameters({
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The fact’s id, from memory_recall.' },
    reason: { type: 'string', description: 'Why, in a few words.' },
  },
  required: ['id'],
} as const);

export class MemoryForgetTool extends MemoryTool<InferArgs<typeof forgetParameters>> {
  readonly name = 'memory_forget';
  readonly description =
    'Marks a fact in shared memory as no longer current (wrong, outdated or the user asked you to forget it). It stays in the history but is no longer recalled or briefed. Parameters: id (from memory_recall), reason.';
  readonly parameters = forgetParameters;

  async execute(args: InferArgs<typeof forgetParameters>): Promise<string> {
    try {
      const done = await this.memory.use(g =>
        g.forget(
          String(args.id ?? ''),
          typeof args.reason === 'string' ? args.reason : '',
          this.agent,
        ),
      );
      return done
        ? `Fact ${args.id} is no longer current.`
        : toolError('NotFound', `No current fact has id ${args.id}.`, [
            'Find it with memory_recall.',
          ]);
    } catch (error) {
      return this.failed(error);
    }
  }
}

// ── memory_state ──

const stateParameters = defineToolParameters({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['get', 'set', 'clear'],
      description: 'get (default), set or clear.',
    },
    name: { type: 'string', description: 'The value’s name (for set and clear).' },
    value: { type: 'string', description: 'The value (for set).' },
    scope: {
      type: 'string',
      enum: ['session', 'global'],
      description: 'session (default: this call or app session) or global (kept until cleared).',
    },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: [],
} as const);

export class MemoryStateTool extends MemoryTool<InferArgs<typeof stateParameters>> {
  readonly name = 'memory_state';
  readonly description =
    'Reads or sets shared state that the voice agent, orchestrator and workers all see at once: a current focus, a plan step, a handoff note. Session values end with the call; global ones stay until cleared. Parameters: action (get, set, clear), name, value, scope, format.';
  readonly parameters = stateParameters;

  async execute(args: InferArgs<typeof stateParameters>): Promise<string> {
    const memory = this.memory;
    const action = args.action ?? 'get';
    const scope = args.scope === 'global' ? 'global' : memory.session;
    try {
      if (action === 'get') {
        const rows = await memory.use(g => g.getState(['global', memory.session]));
        if (wantsJson(args)) return jsonResult({ state: rows });
        if (!rows.length) return 'No shared state is set.';
        return rows
          .map(
            r =>
              `- ${r.name} = ${r.value} (${r.scope === 'global' ? 'global' : 'this session'}, by ${r.by})`,
          )
          .join('\n');
      }
      if (typeof args.name !== 'string' || !args.name.trim()) {
        return toolError('InvalidArgs', 'name is required to set or clear a value.');
      }
      const value = action === 'clear' ? '' : String(args.value ?? '');
      if (action === 'set' && !value.trim()) {
        return toolError('InvalidArgs', 'value is empty; use action clear to remove a value.');
      }
      await memory.use(g => g.setState(scope, args.name as string, value, this.agent));
      return action === 'clear' ? `Cleared ${args.name}.` : `Set ${args.name}.`;
    } catch (error) {
      return this.failed(error);
    }
  }
}

// ── memory_query ──

const queryParameters = defineToolParameters({
  type: 'object',
  properties: {
    cypher: {
      type: 'string',
      description:
        'One read-only openCypher statement. Put values in parameters ($name), never in the text. Writes are refused.',
    },
    params: { type: 'object', description: 'Parameters for $names in the statement.' },
    limit: { type: 'number', description: 'Rows returned at most (default 25, at most 100).' },
    schema: {
      type: 'boolean',
      description: 'Return the memory graph’s schema instead of running a statement.',
    },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: [],
} as const);

export class MemoryQueryTool extends MemoryTool<InferArgs<typeof queryParameters>> {
  readonly name = 'memory_query';
  readonly description =
    'Runs your own read-only Cypher on the shared memory graph (relate, openCypher), for questions memory_recall cannot answer, such as what a task produced or how facts link. Call with schema true first to see the labels and relationships. Parameters: cypher, params (bound values), limit, schema, format.';
  readonly parameters = queryParameters;

  async execute(args: InferArgs<typeof queryParameters>): Promise<string> {
    try {
      if (args.schema || !args.cypher) {
        const [schema, stats] = await this.memory.use(g => [g.schemaText(), g.stats()] as const);
        if (wantsJson(args)) return jsonResult({ schema, counts: stats });
        return `${schema}\nCounts: ${Object.entries(stats)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`;
      }
      const params =
        args.params && typeof args.params === 'object' && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : {};
      const limit = Math.min(100, Math.max(1, Math.round(args.limit ?? 25)));
      const result = await this.memory.query(String(args.cypher), params, limit);
      if (wantsJson(args)) return jsonResult({ ...result, changed: undefined });
      if (!result.rows.length) return 'No rows.';
      const lines = result.rows.map(r => JSON.stringify(r));
      if (result.truncated) lines.push(`(more rows than ${limit}; add LIMIT or narrow the match)`);
      return [result.columns.join(' | '), ...lines].join('\n');
    } catch (error) {
      return this.failed(error);
    }
  }
}

export const MEMORY_TOOLS = [
  MemoryRecallTool,
  MemoryRememberTool,
  MemoryForgetTool,
  MemoryStateTool,
  MemoryQueryTool,
];
