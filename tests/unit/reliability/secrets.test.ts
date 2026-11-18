import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  persistentSecrets,
  readSecret,
  resetSecretCache,
  secretStorageSlow,
  SLOW_READ_MS,
  writeSecret,
} from '../../../src/auth/secrets';

/**
 * An app whose secret storage counts reads and can be slow.
 * @param delayMs - How long each read blocks.
 */
function app(delayMs = 0) {
  const store = new Map<string, string>();
  let reads = 0;
  const secretStorage = {
    getSecret: (key: string) => {
      reads++;
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        // Blocks, like a keyring that does not answer.
      }
      return store.get(key) ?? null;
    },
    setSecret: (key: string, value: string) => void store.set(key, value),
  };
  return { app: { secretStorage } as never, store, reads: () => reads };
}

test('each secret is read from storage once, then from memory', () => {
  resetSecretCache();
  const a = app();
  a.store.set('pure-chat-llm-chatgpt-session', JSON.stringify({ refreshToken: 'r' }));
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(readSecret(a.app, 'chatgpt session'), { refreshToken: 'r' });
    assert.equal(readSecret(a.app, 'google session'), null);
  }
  assert.equal(a.reads(), 2, 'one read per key, misses included');
  writeSecret(a.app, 'google session', { refreshToken: 'g' });
  assert.deepEqual(readSecret(a.app, 'google session'), { refreshToken: 'g' });
  assert.equal(a.reads(), 2, 'a write needs no read back');
  assert.equal(a.store.get('pure-chat-llm-google-session'), JSON.stringify({ refreshToken: 'g' }));
});

test('a keyring that does not answer is used once, then memory only', () => {
  resetSecretCache();
  const a = app(SLOW_READ_MS + 50);
  assert.equal(persistentSecrets(a.app), true);
  assert.equal(readSecret(a.app, 'one'), null);
  assert.equal(secretStorageSlow(), true);
  assert.equal(persistentSecrets(a.app), false);
  const started = Date.now();
  assert.equal(readSecret(a.app, 'two'), null);
  assert.equal(readSecret(a.app, 'three'), null);
  writeSecret(a.app, 'two', { t: 1 });
  assert.deepEqual(readSecret(a.app, 'two'), { t: 1 });
  assert.ok(Date.now() - started < SLOW_READ_MS, 'no further blocking reads');
  assert.equal(a.reads(), 1);
  resetSecretCache();
});
