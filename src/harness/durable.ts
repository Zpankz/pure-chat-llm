// Opening the durable engine: one Harness per vault over IndexedDB, guarded by a Web Lock so two
// Obsidian windows on one vault never write the same database, resumed so a turn a reload cut off
// carries on. Adapted from vault-agent's src/agent/harness.ts (Zpankz/vault-agent at 58bd6b7)
// for Pi Durable 1.5.2 (one `Report` argument to `onReport`).
import { createLayerProvider, LAYER_PROVIDER_ID } from './layerProvider';
import type { LayerName, LayerSend } from './layerProvider';
import { createToolsExtension, WORKER_TOOLS_EXTENSION } from './toolsExtension';
import type { ToolSource } from './toolsExtension';
import { createModels, createRegistry, CTX, Harness, IndexedDbStorage } from './pi';
import type {
  AgentChange,
  Conversation,
  Extension,
  HarnessSettings,
  Models,
  Report,
  Storage,
} from './pi';
import { createWorkers } from './workers';
import type { WorkerHost } from './workers';

/** IndexedDB database of one vault's durable conversations. */
export const durableDbName = (vaultKey: string) => `voice-agent:${vaultKey}`;

/**
 * Run policy. Tools run one after another unless every call in a round is read-only (the tools
 * extension marks read-only tools parallel), retries are left to `layerFetch` (one retry with its
 * own deadline), and a task that keeps crashing is parked after three tries.
 * @param mobile - Fewer progress commits on mobile.
 */
export function durableSettings(mobile = false): HarnessSettings {
  return {
    retry: { maxRetries: 1 },
    stream: { timeoutMs: 180_000 },
    restartLimit: 3,
    afterFailedRun: 'withdraw',
    toolExecution: 'sequential',
    progress: mobile
      ? { partialIntervalMs: 300, outputIntervalMs: 300 }
      : { partialIntervalMs: 150, outputIntervalMs: 150 },
  };
}

/** The model choice of a conversation that runs on one of the plugin's layers. */
export function layerRef(layer: LayerName) {
  return { provider: LAYER_PROVIDER_ID, modelId: layer };
}

export interface DurableHost {
  /** Identifies the vault (its database name). */
  vaultKey: string;
  /** Sends one layer request (a wrapper around `layerFetch`). */
  send: LayerSend;
  /** The orchestrator's tools. */
  tools: ToolSource;
  /** A worker's tools; the orchestrator's when left out. */
  workerTools?: ToolSource;
  /** Instructions of the orchestrator (read when its conversation is created) and of each worker. */
  orchestratorInstructions?: () => string;
  workerInstructions?: () => string;
  /** Longest task result `get_task_result` returns. */
  maxResultChars?: number;
  /** Minutes between check-ins on a running worker; 0 turns them off. Read for each round. */
  checkInMinutes?: () => number;
  /** Mobile device (fewer progress commits). */
  mobile?: boolean;
  /** Told when a worker task starts or ends (the shared memory records it). */
  onTask?: WorkerHost['onTask'];
}

export interface OpenDurableOptions {
  /** Tests: a MemoryStorage. Skips the Web Lock and IndexedDB. */
  storage?: Storage;
  /** Tests: models with a faux provider instead of the layer provider. */
  models?: Models;
  /** More extensions, installed after the tools extension. */
  extensions?: readonly Extension[];
  /** Failures that don't fail a call: a faulted or parked task, a failed storage session. */
  onReport?: (report: Report) => void;
}

export interface DurableSession {
  readonly harness: Harness;
  /** The orchestrator's agent: its layer, its tools and the orchestration tools. */
  orchestratorAgent(): AgentChange;
  /** The root conversation, set up as the orchestrator. */
  root(): Promise<Conversation>;
  /** Closes the Harness, then releases the Web Lock. */
  close(): Promise<void>;
}

const LOCK_TIMEOUT_MS = 10_000;

/**
 * Holds the vault's Web Lock until `release` is called. Fails when another window holds it for
 * longer than the timeout, so a second window says why instead of waiting forever.
 * @param name - Lock name.
 */
async function acquireLock(name: string): Promise<() => void> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return () => {};
  let release!: () => void;
  const held = new Promise<void>(resolve => (release = resolve));
  await new Promise<void>((granted, refused) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCK_TIMEOUT_MS);
    locks
      .request(name, { signal: controller.signal }, async () => {
        clearTimeout(timer);
        granted();
        await held;
      })
      .catch(() =>
        refused(
          new Error(
            'Another Obsidian window is running the durable engine on this vault. Close it, or switch this window to the Classic engine.',
          ),
        ),
      );
  });
  return release;
}

/**
 * Opens the durable engine and resumes what the last session left unfinished.
 * @param host - Vault, layer transport and tools.
 * @param options - Test storage and models, more extensions, report handler.
 */
export async function openDurable(
  host: DurableHost,
  options: OpenDurableOptions = {},
): Promise<DurableSession> {
  const name = durableDbName(host.vaultKey);
  const release = options.storage ? () => {} : await acquireLock(name);
  let opened: IndexedDbStorage | undefined;
  try {
    const storage = options.storage ?? (opened = await IndexedDbStorage.open(name));
    let models = options.models;
    if (!models) {
      const mutable = createModels();
      mutable.setProvider(createLayerProvider(host.send));
      models = mutable;
    }
    const registry = createRegistry();
    const tools = createToolsExtension(host.tools);
    const workerTools = createToolsExtension(
      host.workerTools ?? host.tools,
      WORKER_TOOLS_EXTENSION,
    );
    // The Harness, once open: `cancel_task` aborts a worker's task through it.
    const live: { harness?: Harness } = {};
    const workers = createWorkers(
      {
        workerAgent: own => ({
          model: layerRef('worker'),
          extensions: [workerTools, own],
          ...(host.workerInstructions ? { instructions: host.workerInstructions() } : {}),
        }),
        maxResultChars: host.maxResultChars,
        checkInMinutes: host.checkInMinutes,
        onTask: host.onTask,
      },
      taskId =>
        live.harness
          ? live.harness.abortTask(taskId, CTX)
          : Promise.reject(new Error('Not open yet.')),
    );
    for (const extension of [tools, workerTools, workers.orchestration, workers.workerAgent]) {
      registry.install(extension);
    }
    const orchestratorAgent = (): AgentChange => ({
      model: layerRef('orchestrator'),
      extensions: [tools, workers.orchestration],
      ...(host.orchestratorInstructions ? { instructions: host.orchestratorInstructions() } : {}),
    });
    for (const extension of options.extensions ?? []) registry.install(extension);
    const harness = await Harness.open(
      storage,
      {
        models: models,
        registry,
        settings: () => durableSettings(host.mobile),
        identity: { attribution: null },
        onReport: report => {
          try {
            options.onReport?.(report);
          } catch (error) {
            console.error('[voice-agent] durable report handler failed', error);
          }
        },
      },
      CTX,
    );
    live.harness = harness;
    harness.resume();
    let closed = false;
    return {
      harness,
      orchestratorAgent,
      root: () => harness.root(CTX, { agent: orchestratorAgent() }),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await harness.close(CTX);
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    await opened?.close(CTX).catch(() => undefined);
    release();
    throw error;
  }
}
