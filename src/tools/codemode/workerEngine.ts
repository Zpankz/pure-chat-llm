import { CODEMODE_WORKER_SOURCE } from './sandboxSource';
import type { CodeModeHost, CodeModeRunResult } from './djsEngine';

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

interface WorkerOut {
  type: 'out';
  kind: 'text' | 'console';
  text: string;
}

type WorkerMessage = WorkerDone | WorkerCall | WorkerStore | WorkerOut;

/** The part of the Worker API the engine uses (a fake can stand in for tests). */
export interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/**
 * Runs a code mode script in the Web Worker fallback engine. It is weaker than djs: no
 * instruction or memory budget (only the wall-clock deadline, by terminating the worker), and
 * JavaScript only. The run ends when the script finishes, fails or `stop` aborts; on `stop` the
 * worker is terminated at once.
 * @param code - Script.
 * @param meta - Tool metadata and the persisted store.
 * @param meta.tools - Tools the script may call.
 * @param meta.store - Persisted values for `load()`.
 * @param host - Tool calls, store writes and streamed output.
 * @param stop - Aborts the run (timeout or cancellation).
 * @param makeWorker - Creates the worker from its source (tests pass a fake).
 */
export function runWithWorker(
  code: string,
  meta: { tools: unknown[]; store: Record<string, string> },
  host: CodeModeHost,
  stop: AbortSignal,
  makeWorker: (source: string) => WorkerLike = defaultWorker,
): Promise<CodeModeRunResult> {
  if (stop.aborted)
    return Promise.resolve({ ok: false, error: 'Stopped.', outputs: [], console: [] });
  const worker = makeWorker(CODEMODE_WORKER_SOURCE);

  return new Promise<CodeModeRunResult>(resolve => {
    let settled = false;
    const finish = (result: CodeModeRunResult) => {
      if (settled) return;
      settled = true;
      stop.removeEventListener('abort', onStop);
      worker.terminate();
      resolve(result);
    };
    const onStop = () => finish({ ok: false, error: 'Stopped.', outputs: [], console: [] });
    stop.addEventListener('abort', onStop, { once: true });

    worker.onerror = event => finish({ ok: false, error: event.message, outputs: [], console: [] });

    worker.onmessage = event => {
      const msg = event.data;
      if (settled) return;
      if (msg.type === 'done') {
        finish(msg);
      } else if (msg.type === 'store') {
        host.store(msg.key, msg.value);
      } else if (msg.type === 'out') {
        host.out?.(msg.kind, msg.text);
      } else if (msg.type === 'call') {
        void host.call(msg.name, msg.args).then(
          value => {
            if (!settled) worker.postMessage({ type: 'reply', id: msg.id, value });
          },
          (error: unknown) => {
            if (!settled)
              worker.postMessage({
                type: 'reply',
                id: msg.id,
                error: error instanceof Error ? error.message : String(error),
              });
          },
        );
      }
    };

    worker.postMessage({ type: 'run', code, tools: meta.tools, store: meta.store });
  });
}

/**
 * A real Web Worker from source text.
 * @param source - Worker source.
 */
function defaultWorker(source: string): WorkerLike {
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  const worker = new Worker(blobUrl);
  URL.revokeObjectURL(blobUrl);
  return worker as unknown as WorkerLike;
}
