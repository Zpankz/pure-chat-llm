import { defineToolParameters, InferArgs, Tool } from '../tools';
import {
  CodeModeHost,
  CodeModeRunResult,
  djsProblem,
  loadDjsModule,
  runWithDjs,
} from './codemode/djsEngine';
import { runWithWorker, WorkerLike } from './codemode/workerEngine';
import { ScriptDeadline } from './codemode/deadline';
import {
  AbortHost,
  allowedIn,
  callWithSignal,
  cancelledError,
  clipToolText,
  formatSeconds,
  isToolError,
  offersJson,
  toolError,
  toolErrorLine,
  toolTimeoutMs,
  WAITS_FOR_USER,
  withToolTimeout,
} from './toolContract';

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
        'Deadline for the whole script in milliseconds (time waiting for the user to approve a change does not count). Defaults to the plugin setting.',
    },
    max_output_chars: {
      type: 'integer',
      description: 'Maximum characters of output to return. Longer output keeps its start and end.',
    },
  },
  required: ['code'],
} as const);

export type CodeModeArgs = InferArgs<typeof codeModeParameters>;

/** Converts a tool name to a JavaScript identifier (as pi's code mode does). */
export function toIdentifier(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

/**
 * Keeps the start and end of long text (and an error's type, reason and recovery lines whole).
 * @param text - Text to clip.
 * @param max - Maximum characters.
 */
export function clipMiddle(text: string, max: number): string {
  return clipToolText(text, max, 0.6);
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

/** Why a run stopped before the script ended. */
type StopReason = 'timeout' | 'cancelled';

/**
 * Turns an engine result into the tool's output: a `toolError` header when the script failed,
 * then the stats line, the script's text, console and return value.
 * @param done - Engine result.
 * @param info - Run facts.
 * @param info.stop - Why the run was stopped, if it was.
 * @param info.timeoutMs - The script's deadline.
 * @param info.stats - The stats line.
 * @param info.partial - Output streamed before the run ended.
 * @param info.partial.outputs - `text()` values.
 * @param info.partial.console - Console lines.
 */
export function formatRun(
  done: CodeModeRunResult,
  info: {
    stop?: StopReason;
    timeoutMs: number;
    stats: string;
    partial: { outputs: string[]; console: string[] };
  },
): string {
  const outputs = done.outputs.length ? done.outputs : info.partial.outputs;
  const consoleLines = done.console.length ? done.console : info.partial.console;
  const body: string[] = [info.stats];
  outputs.forEach((out, i) => body.push(`==> text ${i + 1}/${outputs.length} <==\n${out}`));
  if (consoleLines.length)
    body.push(`<console_output>\n${consoleLines.join('\n')}\n</console_output>`);
  if (done.ret !== undefined) body.push(`Return value:\n${done.ret}`);

  let head: string | undefined;
  if (info.stop === 'timeout') {
    head = toolError(
      'Timeout',
      `The script did not finish within ${formatSeconds(info.timeoutMs)} (time waiting for the user not counted).`,
      [
        'Tool calls still running were cancelled; changes they had not made were not made.',
        'Print progress with text() so partial results come back, split the work, or raise timeout_ms.',
      ],
    );
  } else if (info.stop === 'cancelled') {
    head = cancelledError('codemode');
  } else if (!done.ok && done.limit) {
    head = toolError('ResourceLimit', done.error ?? 'The script hit an engine limit.', [
      'Process less data per run, or raise the djs limits in settings.',
    ]);
  } else if (!done.ok && done.errorType === 'ToolError') {
    head = toolError('ScriptError', `Uncaught tool failure: ${done.error ?? ''}`, [
      'Catch tool failures with try/catch (the error has .tool and .type) or Promise.allSettled.',
    ]);
  } else if (!done.ok) {
    const [first, ...frames] = (done.error ?? 'The script failed.').split('\n');
    head = toolError('ScriptError', first, ['Fix the script and run it again.']);
    if (frames.length) body.splice(1, 0, `Stack:\n${frames.join('\n')}`);
  }
  return head ? `${head}\n\n${body.join('\n\n')}` : body.join('\n\n');
}

/**
 * Code mode: the model writes one JavaScript program that calls many tools, instead of making
 * one tool call per step. Modelled on pi's built-in `codemode` tool
 * (https://docs.pi.dev/latest/codemode): same globals (`tools`, `text`, `console`, `store`, `load`,
 * `exit`, `ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`), same `// @options:`
 * header and the same result layout.
 *
 * Scripts run in djs (https://github.com/earendil-works/djs), the WebAssembly engine built to
 * replace QuickJS in pi's code mode, when its module is available (in the plugin folder, or
 * downloaded from a configured URL and checked against a pinned sha256), and otherwise in a
 * locked-down Web Worker, a weaker sandbox the result names. With djs, scripts may also be
 * TypeScript.
 *
 * Every run has its own abort signal: the deadline, a cancelled request or the end of the script
 * aborts it, and every tool call the script makes gets a signal tied to it (through
 * `chat.abortSignal`), so a write still in review when the script stops does not land later.
 */
export class CodeModeTool extends Tool<CodeModeArgs> {
  readonly name = 'codemode';
  readonly classification = 'System';
  static _name = 'codemode';
  readonly parameters = codeModeParameters;

  /** Creates the Web Worker engine's worker (tests replace it). */
  static makeWorker: ((source: string) => WorkerLike) | undefined;

  /**
   * Callable tools, excluding code mode itself and tools the code mode layer may not use
   * (see TOOL_LAYERS). The sandboxes themselves have no fetch or sockets.
   */
  private callable() {
    return this.registry.tools.filter(t => t.name !== this.name && allowedIn(t.name, 'codemode'));
  }

  /** Description lists the callable tools within an inline budget. */
  get description(): string {
    const settings = this.chat.plugin.settings.codeMode;
    const tools = this.callable();
    const budget = 6000;
    let listing = '';
    let listed = 0;
    for (const t of tools) {
      const json = offersJson(t.parameters) ? ' (json)' : '';
      const line = `- tools.${toIdentifier(t.name)}${json}: ${t.description.split('\n')[0].slice(0, 140)}\n`;
      if (listing.length + line.length > budget) {
        listing += `- …and ${tools.length - listed} more; use searchTools(query) or describeTool(name).\n`;
        break;
      }
      listing += line;
      listed++;
    }
    return [
      'Run a JavaScript program that calls several tools in one step. Prefer it over separate calls when a task needs loops, filtering, joins or more than two tool calls.',
      'The code is the body of an async function, in a sandbox with no DOM, network, file system or Node APIs. Call tools as `await tools.<name>({...})`.',
      'Results: tools marked (json) are called with format:"json" unless you pass a format, and return parsed objects; other tools return text.',
      'Errors: a failed call throws a ToolError with .tool, .type (such as NotFound or Timeout) and the reason and fixes in .message. Catch it with try/catch or use Promise.allSettled; uncaught, it ends the script and the result starts with "Error:".',
      'Output: return a value, text(v) or console.log(...). Also: store(key, value)/load(key) keep small values across runs; ALL_TOOLS, searchTools(query, {limit, namespace}), describeTool(name) (JSON Schema), describeNamespace(prefix), exit().',
      `Limits: ${formatSeconds(settings?.timeoutMs ?? 60000)} per script (time waiting for the user to approve a change does not count) and ${settings?.maxOutputChars ?? 40000} characters of output; change them with a first line like // @options: {"timeout_ms": 120000, "max_output_tokens": 2000}. Each tool call also has its own time limit.`,
      'Engine: djs (JavaScript or TypeScript) when its module is loaded, otherwise a Web Worker fallback (JavaScript only); the result says which.',
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
    // Taken before any await: this call's signal (see AbortHost).
    const host = this.chat as unknown as AbortHost;
    const parent = host.abortSignal;
    if (parent?.aborted) return cancelledError(this.name);

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

    // One signal for the run: the deadline, the parent request or the end of the script aborts it.
    const run = new AbortController();
    let stop: StopReason | undefined;
    const onParentAbort = () => {
      stop ??= 'cancelled';
      run.abort();
    };
    parent?.addEventListener('abort', onParentAbort, { once: true });
    const deadline = new ScriptDeadline(timeout, () => {
      stop ??= 'timeout';
      run.abort();
    });

    // Tools that read `chat.abortSignal` late still see this run's signal while calls are running.
    const previousSignal = host.abortSignal;
    host.abortSignal = run.signal;
    let inFlight = 0;
    let ended = false;
    const release = () => {
      if (ended && inFlight === 0 && host.abortSignal === run.signal) {
        host.abortSignal = previousSignal;
      }
    };

    void this.status('Running code mode script...');
    const started = performance.now();
    let toolCalls = 0;
    const partial = { outputs: [] as string[], console: [] as string[] };
    const scriptHost: CodeModeHost = {
      call: (name, callArgs) => {
        toolCalls++;
        // Counts the tool's own promise, which may outlive a timed-out or cancelled call.
        return this.callTool(name, callArgs, run.signal, deadline, running => {
          inFlight++;
          void running.finally(() => {
            inFlight--;
            release();
          });
        });
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
      out: (kind, text) => (kind === 'text' ? partial.outputs : partial.console).push(text),
    };

    let engine = 'djs';
    let done: CodeModeRunResult;
    try {
      const djsModule = settings.engine === 'worker' ? null : await loadDjsModule(this.chat.plugin);
      if (djsModule) {
        done = await runWithDjs(djsModule, inline.code, { tools, store }, scriptHost, run.signal, {
          maxFuel: settings.djsMaxFuel || 2_000_000_000,
          memoryLimitBytes: (settings.djsMemoryLimitMb || 64) * 1024 * 1024,
        });
      } else if (settings.engine === 'djs') {
        return toolError(
          'EngineUnavailable',
          `Code mode is set to djs, but ${djsProblem() ?? 'the djs module was not found.'}`,
          [
            'Set the djs module path, or its download URL and sha256, in settings.',
            'Or switch the engine to auto to use the Web Worker.',
          ],
        );
      } else {
        const why = settings.engine === 'worker' ? 'set in settings' : djsProblem();
        engine = `Web Worker fallback, a weaker sandbox with no instruction or memory limits${why ? `; djs not used: ${why}` : ''}`;
        done = await runWithWorker(
          inline.code,
          { tools, store },
          scriptHost,
          run.signal,
          CodeModeTool.makeWorker,
        );
      }
    } finally {
      deadline.stop();
      parent?.removeEventListener('abort', onParentAbort);
      // Calls the script left running belong to a script that is over.
      run.abort();
      ended = true;
      release();
    }

    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    const stats = `Script ${done.ok && !stop ? 'completed' : stop === 'timeout' ? 'timed out' : stop === 'cancelled' ? 'was cancelled' : 'failed'} in ${seconds}s (${toolCalls} tool call${toolCalls === 1 ? '' : 's'}, ${engine})`;
    return clipMiddle(formatRun(done, { stop, timeoutMs: timeout, stats, partial }), maxChars);
  }

  /**
   * Executes one tool for a script, refusing recursion and unknown tools. Asks for JSON when the
   * tool offers it and the script did not choose a format, parses JSON results, and throws on a
   * failed call with its type, reason and recovery on one line.
   * @param name - Tool name or identifier.
   * @param args - Arguments.
   * @param runSignal - The run's signal.
   * @param deadline - The script's deadline (paused while a tool waits for the user).
   * @param track - Told about the tool's own promise once the call has started.
   */
  private async callTool(
    name: string,
    args: Record<string, unknown>,
    runSignal: AbortSignal,
    deadline: ScriptDeadline,
    track: (running: Promise<unknown>) => void,
  ): Promise<unknown> {
    const tool = this.callable().find(t => t.name === name || toIdentifier(t.name) === name);
    if (!tool) {
      throw new Error(
        `UnknownTool: there is no callable tool "${name}". Try: searchTools(query) to find one.`,
      );
    }
    const callArgs = { ...(args ?? {}) };
    // Scripts get data, not prose: ask for JSON when the tool offers it and the script didn't say.
    if (callArgs.format === undefined && offersJson(tool.parameters)) callArgs.format = 'json';
    const host = this.chat as unknown as AbortHost;
    const waits = WAITS_FOR_USER.has(tool.name);
    if (waits) deadline.pause();
    let output: string;
    try {
      output = await withToolTimeout(
        tool.name,
        toolTimeoutMs(tool.name),
        signal => {
          const running = callWithSignal(host, signal, () =>
            this.registry.executeTool(tool.name, callArgs),
          );
          track(running);
          return running;
        },
        runSignal,
      );
    } finally {
      if (waits) deadline.resume();
    }
    if (isToolError(output)) throw new Error(toolErrorLine(output));
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
