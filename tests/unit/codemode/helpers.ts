/**
 * Fixtures for the code mode, tool loop and voice adapter tests: a `window` for timers, a tool
 * that runs a function, a registry with a chat, and a Web Worker stand-in built on Node's
 * worker_threads that runs the real worker engine source.
 */
import { Worker as NodeWorker } from 'node:worker_threads';
import { Tool, ToolRegistry } from '../../../src/tools';
import type { ToolParameters } from '../../../src/types';
import type { WorkerLike } from '../../../src/tools/codemode/workerEngine';
import { createApp } from '../obsidian-mock';

// Plugin code uses window.setTimeout; Node has the same timers on globalThis.
const g = globalThis as unknown as { window?: unknown };
if (!g.window) g.window = globalThis;

export const FORMAT = {
  type: 'string',
  description: 'text or json',
  enum: ['text', 'json'],
} as const;

/** A tool whose behaviour is a function, for tests. */
export class FnTool extends Tool<Record<string, unknown>> {
  readonly classification = 'Vault';
  readonly description: string;
  readonly parameters: ToolParameters;

  /**
   * @param chat - Chat.
   * @param registry - Registry.
   * @param name - Tool name.
   * @param fn - Behaviour; `this` gives access to the chat.
   * @param options - Description and parameters.
   * @param options.description - Description.
   * @param options.json - Whether the tool offers `format: json`.
   */
  constructor(
    chat: never,
    registry: ToolRegistry,
    readonly name: string,
    private fn: (args: Record<string, unknown>, tool: FnTool) => Promise<string> | string,
    options: { description?: string; json?: boolean } = {},
  ) {
    super(chat, registry);
    this.description = options.description ?? `Test tool ${name}.`;
    this.parameters = {
      type: 'object',
      properties: options.json ? { format: FORMAT } : {},
      required: [],
    } as unknown as ToolParameters;
  }

  /** The chat the tool runs in (for reading `abortSignal`). */
  get chatRef(): { abortSignal?: AbortSignal } {
    return this.chat as unknown as { abortSignal?: AbortSignal };
  }

  isAvailable(): boolean {
    return true;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return this.fn(args, this);
  }
}

export interface TestChat {
  plugin: {
    app: ReturnType<typeof createApp>;
    settings: Record<string, unknown> & { codeMode: Record<string, unknown> };
    codeModeStore: Map<string, string>;
    manifest: { dir: string };
  };
  role?: string;
  abortSignal?: AbortSignal;
  toolregistry: ToolRegistry;
}

/**
 * A chat with a real ToolRegistry and code mode settings.
 * @param codeMode - Code mode settings to merge.
 */
export function testChat(codeMode: Record<string, unknown> = {}): TestChat {
  const chat = {
    plugin: {
      app: createApp(),
      settings: {
        enabledToolClassifications: {},
        codeMode: {
          enabled: true,
          timeoutMs: 5000,
          maxOutputChars: 40000,
          engine: 'worker',
          djsModulePath: '',
          djsMaxFuel: 0,
          djsMemoryLimitMb: 0,
          ...codeMode,
        },
      },
      codeModeStore: new Map<string, string>(),
      manifest: { dir: '.obsidian/plugins/voice-agent' },
    },
    role: undefined,
  } as unknown as TestChat;
  chat.toolregistry = new ToolRegistry(chat as never);
  return chat;
}

/**
 * Registers a function tool.
 * @param chat - Test chat.
 * @param name - Tool name.
 * @param fn - Behaviour.
 * @param options - Description and JSON support.
 * @param options.description - Description.
 * @param options.json - Whether the tool offers `format: json`.
 */
export function addTool(
  chat: TestChat,
  name: string,
  fn: (args: Record<string, unknown>, tool: FnTool) => Promise<string> | string,
  options: { description?: string; json?: boolean } = {},
): FnTool {
  const tool = new FnTool(chat as never, chat.toolregistry, name, fn, options);
  chat.toolregistry.registerDynamic(tool);
  return tool;
}

/**
 * Resolves after `ms`.
 * @param ms - Milliseconds.
 */
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A Web Worker stand-in: runs the worker engine source in a Node worker thread, with `self`,
 * `postMessage` and `onmessage` as in a browser worker. `terminate` really stops it, so endless
 * scripts can be tested.
 * @param source - Worker source.
 */
export function nodeWorker(source: string): WorkerLike {
  const prologue = `
const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
parentPort.on('message', (data) => { if (typeof self.onmessage === 'function') self.onmessage({ data }); });
`;
  const thread = new NodeWorker(`${prologue}\n${source}`, { eval: true });
  const fake: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: message => thread.postMessage(message),
    terminate: () => {
      void thread.terminate();
    },
  };
  thread.on('message', data => fake.onmessage?.({ data } as MessageEvent));
  thread.on('error', (error: Error) => fake.onerror?.({ message: error.message } as ErrorEvent));
  return fake;
}
