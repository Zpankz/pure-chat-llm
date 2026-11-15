/**
 * Deadlines, cancellation and retries for model requests (system review A1).
 *
 * Every agent request goes through `withDeadline`: it gets an AbortSignal that fires when the
 * deadline passes or the caller cancels (a cancelled task, a stopped turn), and one retry with
 * backoff on rate limits, server errors and network failures. A hung request can no longer hold
 * the orchestrator's queue or a worker's slot.
 */

/** A request passed its deadline. */
export class RequestTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} took longer than ${Math.round(ms / 1000)} s and was stopped.`);
    this.name = 'RequestTimeoutError';
  }
}

/** The caller cancelled the request. */
export class RequestCancelledError extends Error {
  constructor(label: string) {
    super(`${label} was cancelled.`);
    this.name = 'RequestCancelledError';
  }
}

/** An HTTP error with its status, so callers can tell what is worth retrying. */
export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

/** @param error - Anything thrown. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof RequestTimeoutError ||
    error instanceof RequestCancelledError ||
    (error as { name?: string })?.name === 'AbortError'
  );
}

/** Whether one more try may help: rate limits, server errors and network failures. */
export function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  return /Network request failed|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|NetworkError/i.test(
    message,
  );
}

export interface DeadlineOptions {
  /** Milliseconds for one try. */
  timeoutMs: number;
  /** Cancels the request from outside. */
  signal?: AbortSignal;
  /** Extra tries after a retryable failure (default 1). */
  retries?: number;
  /** Backoff before a retry, in ms (default 1000, doubled per retry). */
  backoffMs?: number;
  /** Names the request in errors and timing logs. */
  label?: string;
  /** Called with how long each try took. */
  onTiming?: (ms: number, outcome: 'ok' | 'error' | 'timeout' | 'cancelled') => void;
}

/**
 * Runs a request with a deadline, cancellation and a retry.
 * @param run - Starts the request; must pass `signal` to fetch.
 * @param options - Deadline and cancellation.
 */
export async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const label = options.label ?? 'The request';
  const retries = Math.max(0, options.retries ?? 1);
  let backoff = Math.max(0, options.backoffMs ?? 1000);
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new RequestCancelledError(label);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const started = Date.now();
    // Also race the abort, in case the request ignores its signal.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            timedOut
              ? new RequestTimeoutError(label, options.timeoutMs)
              : new RequestCancelledError(label),
          ),
        { once: true },
      );
    });
    aborted.catch(() => undefined);
    try {
      const result = await Promise.race([run(controller.signal), aborted]);
      options.onTiming?.(Date.now() - started, 'ok');
      return result;
    } catch (error) {
      const outcome = timedOut ? 'timeout' : options.signal?.aborted ? 'cancelled' : 'error';
      options.onTiming?.(Date.now() - started, outcome);
      if (timedOut) throw new RequestTimeoutError(label, options.timeoutMs);
      if (options.signal?.aborted) throw new RequestCancelledError(label);
      if (attempt >= retries || !isRetryable(error)) throw error;
      await sleep(backoff, options.signal);
      backoff *= 2;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Waits, unless cancelled first.
 * @param ms - Milliseconds.
 * @param signal - Cancels the wait.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RequestCancelledError('The wait'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new RequestCancelledError('The wait'));
      },
      { once: true },
    );
  });
}

/**
 * A controller that also aborts when any parent signal aborts.
 * @param parents - Signals to follow.
 */
export function linkedController(...parents: (AbortSignal | undefined)[]): AbortController {
  const controller = new AbortController();
  for (const parent of parents) {
    if (!parent) continue;
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}
