import { defineToolParameters, InferArgs, Tool } from '../tools';
import { CODEMODE_WORKER_SOURCE } from './codemode/sandboxSource';
import { CodeModeHost, CodeModeRunResult, loadDjsModule, runWithDjs } from './codemode/djsEngine';

const codeModeParameters = defineToolParameters({
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description:
        'Raw JavaScript (not a markdown fence) run as the body of an async function. Use `await tools.<name>({...})`, `return` a value, `text(v)` or `console.log(v)` for output.',
    },
    timeout_ms: {
      type: 'integer',
      description:
        'Hard deadline for the whole script in milliseconds. Defaults to the plugin setting.',
    },
    max_output_chars: {
      type: 'integer',
      description: 'Maximum characters of output to return. Longer output keeps its start and end.',
    },
  },
  required: ['code'],
} as const);

export type CodeModeArgs = InferArgs<typeof codeModeParameters>;

interface WorkerDone extends CodeModeRunResult {
  type: 'done';
}

interface WorkerCall {
  type: 'call';
  id: number;
  name: string;
  args: Record<string, unknown>;
}

interface WorkerStore {
  type: 'store';
  key: string;
  value: string;
}

type WorkerMessage = WorkerDone | WorkerCall | WorkerStore;

/** Converts a tool name to a JavaScript identifier (as pi's code mode does). */
export function toIdentifier(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

/**
 * Keeps the start and end of long text.
 * @param text - Text to clip.
 * @param max - Maximum characters.
 */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(-tail)}`;
}

/**
 * Parses pi-style `// @options: {...}` on the first line.
 * @param code - Script source.
 */
export function parseInlineOptions(code: string): {
  code: string;
  timeout_ms?: number;
  max_output_chars?: number;
} {
  const stripped = code
    .trim()
    .replace(/^```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)\n```$/i, '$1');
  const match = /^\s*\/\/\s*@options:\s*(\{.*\})\s*(?:\n|$)/.exec(stripped);
  if (!match) return { code: stripped };
  try {
    const opts = JSON.parse(match[1]) as {
      timeout_ms?: number;
      max_output_tokens?: number;
      max_output_chars?: number;
    };
    return {
      code: stripped.slice(match[0].length),
      timeout_ms: opts.timeout_ms,
      max_output_chars:
        opts.max_output_chars ?? (opts.max_output_tokens ? opts.max_output_tokens * 4 : undefined),
    };
  } catch {
    return { code: stripped };
  }
}

/**
 * Code mode: the model writes one JavaScript program that calls many tools, instead of making
 * one tool call per step. Modelled on pi's built-in `codemode` tool
 * (https://docs.pi.dev/latest/codemode): same globals (`tools`, `text`, `console`, `store`, `load`,
 * `exit`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`), same `// @options:`
 * header and the same result layout.
 *
 * Scripts run in djs (https://github.com/earendil-works/djs), the WebAssembly engine built to
 * replace QuickJS in pi's code mode, when its module is available, and otherwise in a locked-down
 * Web Worker. With djs, scripts may also be TypeScript.
 */
/** Tools scripts can't call. */
const CODE_MODE_EXCLUDED = new Set(['generate_image', 'suno_music_gen', 'manage_plugin_settings']);

export class CodeModeTool extends Tool<CodeModeArgs> {
  readonly name = 'codemode';
  readonly classification = 'System';
  static _name = 'codemode';
  readonly parameters = codeModeParameters;

  /**
   * Callable tools, excluding code mode itself and tools that reach the internet other than
   * through MCP servers or change plugin settings (Hani's sandbox rule: scripts read anything
   * and create notes; edits and deletes go through the same tools, so the same review applies;
   * no network beyond MCP). The sandboxes themselves have no fetch or sockets.
   */
  private callable() {
    return this.registry.tools.filter(t => t.name !== this.name && !CODE_MODE_EXCLUDED.has(t.name));
  }

  /** Description lists the callable tools within an inline budget. */
  get description(): string {
    const tools = this.callable();
    const budget = 6000;
    let listing = '';
    for (const t of tools) {
      const line = `- tools.${toIdentifier(t.name)}: ${t.description.split('\n')[0].slice(0, 140)}\n`;
      if (listing.length + line.length > budget) {
        listing += `- …and ${tools.length - listing.split('\n').length + 1} more; use searchTools(query) or describeTool(name).\n`;
        break;
      }
      listing += line;
    }
    return [
      'Run a JavaScript program that orchestrates several tools in one step. Prefer this over many separate calls when a task needs loops, filtering, joins or more than two tool calls.',
      'The code runs as an async function body (JavaScript, or TypeScript when the djs engine is active) in a sandbox with no DOM, network, file system or Node APIs. Every tool is `await tools.<name>(argsObject)`; results are strings, or parsed JSON when a tool returns JSON. Failed calls throw, so use try/catch or Promise.allSettled.',
      'Globals: text(v), console.log(...), return v, exit(), store(key, json) and load(key) (persist small values across calls), ALL_TOOLS, searchTools(query, {limit, namespace}), describeTool(name) (returns JSON Schema), describeNamespace(prefix).',
      'Optional first line: // @options: {"timeout_ms": 60000, "max_output_tokens": 2000}',
      'Tool calls are real: anything a script changes stays changed.',
      `Callable tools:\n${listing}`,
    ].join('\n');
  }

  /** Enabled in settings. */
  isAvailable(): boolean {
    return this.chat.plugin.settings.codeMode?.enabled ?? true;
  }

  /**
   * Runs the script.
   * @param args - Tool arguments.
   */
  async execute(args: CodeModeArgs): Promise<string> {
    const settings = this.chat.plugin.settings.codeMode;
    const inline = parseInlineOptions(args.code ?? '');
    const timeout = Math.max(
      1000,
      inline.timeout_ms ?? args.timeout_ms ?? settings.timeoutMs ?? 60000,
    );
    const maxChars = Math.max(
      500,
      inline.max_output_chars ?? args.max_output_chars ?? settings.maxOutputChars ?? 40000,
    );

    const tools = this.callable().map(t => ({
      name: t.name,
      id: toIdentifier(t.name),
      description: t.description,
      parameters: t.parameters,
    }));
    const store = Object.fromEntries(this.chat.plugin.codeModeStore);

    void this.status('Running code mode script...');
    const started = performance.now();
    let toolCalls = 0;
    const host: CodeModeHost = {
      call: (name, callArgs) => {
        toolCalls++;
        return this.callTool(name, callArgs);
      },
      store: (key, value) => {
        const total = [...this.chat.plugin.codeModeStore.values()].reduce(
          (n, v) => n + v.length,
          0,
        );
        if (value.length <= 262144 && total + value.length <= 1048576) {
          this.chat.plugin.codeModeStore.set(key, value);
        }
      },
    };

    let engine = 'worker';
    let done: CodeModeRunResult;
    const djsModule = settings.engine === 'worker' ? null : await loadDjsModule(this.chat.plugin);
    if (djsModule) {
      engine = 'djs';
      done = await runWithDjs(djsModule, inline.code, { tools, store }, host, {
        timeoutMs: timeout,
        maxFuel: settings.djsMaxFuel || 2_000_000_000,
        memoryLimitBytes: (settings.djsMemoryLimitMb || 64) * 1024 * 1024,
      });
    } else if (settings.engine === 'djs') {
      return 'Error: Code mode is set to djs, but the djs module (djs.wasm) was not found. Set its path in settings or switch the engine to auto.';
    } else {
      done = await this.runInWorker(inline.code, tools, store, host, timeout);
    }

    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    const parts: string[] = [
      `Script ${done.ok ? 'completed' : 'failed'} in ${seconds}s (${toolCalls} tool call${toolCalls === 1 ? '' : 's'}, ${engine})`,
    ];
    done.outputs.forEach((out, i) =>
      parts.push(`==> text ${i + 1}/${done.outputs.length} <==\n${out}`),
    );
    if (done.console.length)
      parts.push(`<console_output>\n${done.console.join('\n')}\n</console_output>`);
    if (done.ret !== undefined) parts.push(`Return value:\n${done.ret}`);
    if (!done.ok && done.error) parts.push(`Script error: ${done.error}`);
    return clipMiddle(parts.join('\n\n'), maxChars);
  }

  /**
   * Runs a script in the Web Worker engine.
   * @param code - Script.
   * @param tools - Tool metadata.
   * @param store - Persisted values.
   * @param host - Tool calls and store writes.
   * @param timeout - Deadline in ms.
   */
  private runInWorker(
    code: string,
    tools: unknown[],
    store: Record<string, string>,
    host: CodeModeHost,
    timeout: number,
  ): Promise<CodeModeRunResult> {
    const blobUrl = URL.createObjectURL(
      new Blob([CODEMODE_WORKER_SOURCE], { type: 'application/javascript' }),
    );
    const worker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);

    return new Promise<CodeModeRunResult>(resolve => {
      const timer = window.setTimeout(() => {
        worker.terminate();
        resolve({ ok: false, error: `Timed out after ${timeout} ms`, outputs: [], console: [] });
      }, timeout);

      worker.onerror = event => {
        window.clearTimeout(timer);
        worker.terminate();
        resolve({ ok: false, error: event.message, outputs: [], console: [] });
      };

      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const msg = event.data;
        if (msg.type === 'done') {
          window.clearTimeout(timer);
          worker.terminate();
          resolve(msg);
        } else if (msg.type === 'store') {
          host.store(msg.key, msg.value);
        } else if (msg.type === 'call') {
          void host.call(msg.name, msg.args).then(
            value => worker.postMessage({ type: 'reply', id: msg.id, value }),
            (error: unknown) =>
              worker.postMessage({
                type: 'reply',
                id: msg.id,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
        }
      };

      worker.postMessage({ type: 'run', code, tools, store });
    });
  }

  /**
   * Executes one tool for a script, refusing recursion and unknown tools.
   * @param name - Tool name or identifier.
   * @param args - Arguments.
   */
  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.callable().find(t => t.name === name || toIdentifier(t.name) === name);
    if (!tool) throw new Error(`Unknown tool "${name}". Use searchTools() to find tools.`);
    const output = await this.registry.executeTool(tool.name, args ?? {});
    if (/^Error:/.test(output)) throw new Error(output.replace(/^Error:\s*/, ''));
    const trimmed = output.trim();
    if (/^[[{]/.test(trimmed)) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return output;
      }
    }
    return output;
  }
}
