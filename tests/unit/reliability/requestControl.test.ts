import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpStatusError,
  RequestCancelledError,
  RequestTimeoutError,
  isRetryable,
  withDeadline,
} from '../../../src/core/requestControl';

/** A request that never answers unless its signal aborts. */
function hung(signal: AbortSignal): Promise<string> {
  return new Promise((_, reject) =>
    signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ),
  );
}

test('a hung request is stopped at its deadline and its signal aborts', async () => {
  let seen: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(
    withDeadline(
      s => {
        seen = s;
        return hung(s);
      },
      { timeoutMs: 50, retries: 0, label: 'Test request' },
    ),
    (e: unknown) => e instanceof RequestTimeoutError && /Test request/.test((e as Error).message),
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(seen?.aborted, true);
});

test('a request that ignores its signal is still stopped', async () => {
  await assert.rejects(
    withDeadline(() => new Promise<string>(() => undefined), { timeoutMs: 30, retries: 0 }),
    RequestTimeoutError,
  );
});

test('cancelling from outside aborts the request in flight', async () => {
  const parent = new AbortController();
  let seen: AbortSignal | undefined;
  const run = withDeadline(
    s => {
      seen = s;
      return hung(s);
    },
    { timeoutMs: 10_000, signal: parent.signal },
  );
  setTimeout(() => parent.abort(), 20);
  await assert.rejects(run, RequestCancelledError);
  assert.equal(seen?.aborted, true);
});

test('an already cancelled signal never starts the request', async () => {
  const parent = new AbortController();
  parent.abort();
  let started = false;
  await assert.rejects(
    withDeadline(
      async () => {
        started = true;
        return 'x';
      },
      { timeoutMs: 1000, signal: parent.signal },
    ),
    RequestCancelledError,
  );
  assert.equal(started, false);
});

test('a 503 is retried once and then succeeds', async () => {
  let tries = 0;
  const outcomes: string[] = [];
  const result = await withDeadline(
    async () => {
      tries++;
      if (tries === 1) throw new HttpStatusError('busy', 503);
      return 'ok';
    },
    { timeoutMs: 1000, backoffMs: 5, onTiming: (_, o) => outcomes.push(o) },
  );
  assert.equal(result, 'ok');
  assert.equal(tries, 2);
  assert.deepEqual(outcomes, ['error', 'ok']);
});

test('a 400 is not retried', async () => {
  let tries = 0;
  await assert.rejects(
    withDeadline(
      async () => {
        tries++;
        throw new HttpStatusError('bad request', 400);
      },
      { timeoutMs: 1000, backoffMs: 5 },
    ),
    HttpStatusError,
  );
  assert.equal(tries, 1);
});

test('retryable errors are rate limits, server errors and network failures', () => {
  assert.equal(isRetryable(new HttpStatusError('x', 429)), true);
  assert.equal(isRetryable(new HttpStatusError('x', 502)), true);
  assert.equal(isRetryable(new HttpStatusError('x', 401)), false);
  assert.equal(isRetryable(new Error('fetch failed')), true);
  assert.equal(isRetryable(new RequestTimeoutError('x', 1)), false);
});
