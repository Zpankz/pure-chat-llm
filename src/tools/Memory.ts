// The memory tools: every agent's way into the shared memory graph (see memory/MemoryGraph.ts).
// Writes go only through remember, forget, relate and state, with bound parameters; agents' own
// Cypher goes through memory_query, which is read-only.
import { defineToolParameters, InferArgs, Tool } from '../tools';
import { FACT_KINDS } from '../memory/MemoryGraph';
import type { FactRow, MemoryHit } from '../memory/MemoryGraph';
import { agentForRole } from '../memory/MemoryService';
import { looksSecret } from '../memory/Librarian';
import { memoryWithModels } from '../memory/pluginModels';
import { localDate, localTime } from '../memory/text';
import { FORMAT_PARAMETER, jsonResult, toolError, wantsJson } from './toolContract';

/** The shared memory tools, offered to every agent. */
export const MEMORY_TOOL_NAMES: string[] = [
  'memory_recall',
  'memory_remember',
  'memory_forget',
  'memory_state',
  'memory_query',
  'memory_relate',
];

/** Read-only memory tools (may run side by side). */
export const MEMORY_READ_TOOLS = ['memory_recall', 'memory_query'];

abstract class MemoryTool<T> extends Tool<T> {
  readonly classification = 'AI';
  readonly agentCore = true;

  protected get memory() {
    // The models make recall find things by meaning and catch near-copies on save.
    return memoryWithModels(this.chat.plugin) ?? this.chat.plugin.memory;
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
  const when = localDate(f.recordedAt);
  const about = f.about.length ? ` (about ${f.about.join(', ')})` : '';
  const closed = f.closedAt ? ' [no longer current]' : '';
  const confirmed = f.confirmations > 1 ? `, said ${f.confirmations} times` : '';
  return `- [${f.key}] ${f.kind}, ${when}${confirmed}, by ${f.by ?? '?'}: ${f.text}${about}${closed}`;
}

function hitLine(h: MemoryHit): string {
  if (h.type === 'fact' && h.fact) return factLine(h.fact);
  const what = h.type === 'task' ? 'task result' : 'call summary';
  const text = h.text.length > 1200 ? `${h.text.slice(0, 1199)}…` : h.text;
  return `- [${h.key}] ${what}, ${localTime(h.at)}, "${h.title ?? ''}": ${text}`;
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
    'Searches the shared memory that all agents keep across sessions: preferences, instructions, decisions and facts the user or other agents saved, what background tasks found and what earlier calls were about, with their ids. Finds things by meaning when embeddings are set up, otherwise by words. Use it before asking the user something they may have said before. Parameters: query (words), about (a name, kind:name or [[note]]), kinds, days, include_closed, limit, format.';
  readonly parameters = recallParameters;

  async execute(args: InferArgs<typeof recallParameters>): Promise<string> {
    try {
      const memory = this.memory;
      const hits = await memory.search({
        query: typeof args.query === 'string' ? args.query : undefined,
        about: typeof args.about === 'string' ? args.about : undefined,
        kinds: Array.isArray(args.kinds) ? (args.kinds as string[]) : undefined,
        limit: args.limit,
        includeClosed: !!args.include_closed,
        since: args.days ? Date.now() - args.days * 86_400_000 : undefined,
      });
      if (wantsJson(args)) {
        const facts = hits.flatMap(h => (h.fact ? [h.fact] : []));
        const others = hits
          .filter(h => h.type !== 'fact')
          .map(h => ({ type: h.type, key: h.key, title: h.title, text: h.text, at: h.at }));
        return jsonResult({ facts, results: others, count: hits.length });
      }
      if (!hits.length) return 'No memories match.';
      return [`${hits.length} memories:`, ...hits.map(hitLine)].join('\n');
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
    relations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'A name, kind:name or [[note]].' },
          kind: { type: 'string', description: 'How they relate, in a word or two.' },
          to: { type: 'string', description: 'A name, kind:name or [[note]].' },
        },
        required: ['from', 'kind', 'to'],
        description: 'One link.',
      },
      description:
        'Links between the things it is about, like {from: "project:Garden", kind: "part of", to: "[[Home]]"}.',
    },
    format: { ...FORMAT_PARAMETER, enum: [...FORMAT_PARAMETER.enum] },
  },
  required: ['text'],
} as const);

export class MemoryRememberTool extends MemoryTool<InferArgs<typeof rememberParameters>> {
  readonly name = 'memory_remember';
  readonly description =
    'Saves one fact to the shared memory every agent reads, now and in later sessions. Use it when the user asks you to remember something or states a preference, instruction or decision; a librarian files the rest after each call and task. A fact that repeats a current one confirms it instead of adding a copy. Never save passwords, keys or card or ID numbers. Parameters: text, kind, about, slot (one current value), supersedes (ids it corrects), importance, relations, format.';
  readonly parameters = rememberParameters;

  async execute(args: InferArgs<typeof rememberParameters>): Promise<string> {
    if (typeof args.text !== 'string' || !args.text.trim()) {
      return toolError('InvalidArgs', 'text is empty.');
    }
    if (looksSecret(args.text)) {
      return toolError(
        'Refused',
        'That looks like a key or a card number; memory never keeps those.',
      );
    }
    try {
      const memory = this.memory;
      const saved = await memory.remember({
        text: args.text,
        kind: args.kind as never,
        about: Array.isArray(args.about) ? (args.about as string[]) : undefined,
        slot: typeof args.slot === 'string' ? args.slot : undefined,
        supersedes: Array.isArray(args.supersedes) ? (args.supersedes as string[]) : undefined,
        importance: args.importance,
        agent: this.agent,
        session: memory.session,
        task: this.chat.task ? memory.taskKey(this.chat.task.id) : undefined,
      });
      const relations = Array.isArray(args.relations) ? args.relations : [];
      const linked = relations.length
        ? await memory.use(g => {
            let n = 0;
            for (const r of relations.slice(0, 8)) {
              const rel = r as { from?: unknown; kind?: unknown; to?: unknown };
              if (typeof rel.from !== 'string' || typeof rel.to !== 'string') continue;
              g.relate(rel.from, typeof rel.kind === 'string' ? rel.kind : 'related', rel.to);
              n++;
            }
            return n;
          })
        : 0;
      if (wantsJson(args))
        return jsonResult({
          key: saved.key,
          closed: saved.closed,
          confirmed: !!saved.confirmed,
          linked,
        });
      if (saved.confirmed) return `Already known as ${saved.key}; confirmed it.`;
      return `Saved as ${saved.key}.${saved.closed.length ? ` No longer current: ${saved.closed.join(', ')}.` : ''}${
        linked ? ` Linked ${linked}.` : ''
      }`;
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

// ── memory_relate ──

const relateParameters = defineToolParameters({
  type: 'object',
  properties: {
    from: { type: 'string', description: 'A name, `kind:name` (person:Sam) or a [[note]].' },
    kind: {
      type: 'string',
      description:
        'How they relate, in a word or two ("part of", "works on", "depends on"). "alias" or "same as" makes `to` another name of `from`.',
    },
    to: { type: 'string', description: 'A name, `kind:name` or a [[note]].' },
  },
  required: ['from', 'kind', 'to'],
} as const);

export class MemoryRelateTool extends MemoryTool<InferArgs<typeof relateParameters>> {
  readonly name = 'memory_relate';
  readonly description =
    'Links two people, projects, things or notes in the shared memory, so recall about one finds the other; or, with kind "alias", records another name for the same thing. Parameters: from, kind, to.';
  readonly parameters = relateParameters;

  async execute(args: InferArgs<typeof relateParameters>): Promise<string> {
    const from = typeof args.from === 'string' ? args.from.trim() : '';
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
    if (!from || !to || !kind) return toolError('InvalidArgs', 'from, kind and to are required.');
    try {
      if (/^(alias|same as|also called|aka)$/i.test(kind)) {
        const key = await this.memory.use(g => g.addAlias(from, to.replace(/^[\w-]+:/, '')));
        return `"${to}" is now another name of ${key}.`;
      }
      await this.memory.use(g => g.relate(from, kind, to));
      return `Linked ${from} → ${kind} → ${to}.`;
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
  MemoryRelateTool,
];
