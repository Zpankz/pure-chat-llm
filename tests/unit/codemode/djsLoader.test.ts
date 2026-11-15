import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import './helpers';
import {
  djsSource,
  embeddedDjs,
  obtainDjsBytes,
  setEmbeddedDjsForTests,
  sha256Hex,
  verifyDjsBytes,
} from '../../../src/tools/codemode/djsEngine';

const fake = new TextEncoder().encode('not really wasm, just bytes').buffer;
const pin = createHash('sha256').update(new Uint8Array(fake)).digest('hex');

/**
 * A plugin with an in-memory adapter for binary files.
 * @param codeMode - Code mode settings.
 * @param files - Existing files.
 */
function plugin(codeMode: Record<string, unknown>, files: Record<string, ArrayBuffer> = {}) {
  const store = new Map(Object.entries(files));
  const written: string[] = [];
  return {
    written,
    store,
    plugin: {
      manifest: { dir: 'plugins/voice-agent' },
      settings: { codeMode: { djsModulePath: '', ...codeMode } },
      app: {
        vault: {
          adapter: {
            exists: async (p: string) => store.has(p),
            readBinary: async (p: string) => store.get(p)!,
            writeBinary: async (p: string, b: ArrayBuffer) => {
              written.push(p);
              store.set(p, b);
            },
          },
        },
      },
    } as never,
  };
}

test('sha256 check accepts the pinned bytes and refuses anything else', async () => {
  assert.equal(await sha256Hex(fake), pin);
  assert.deepEqual(await verifyDjsBytes(fake, pin.toUpperCase()), { ok: true, actual: pin });
  const other = new TextEncoder().encode('tampered').buffer;
  assert.equal((await verifyDjsBytes(other, pin)).ok, false);
  assert.equal((await verifyDjsBytes(fake, '')).ok, false, 'an empty pin never passes');
  assert.equal((await verifyDjsBytes(fake, 'abc')).ok, false);
});

test('downloads from the configured URL only with a matching pin, then caches it', async () => {
  const p = plugin({ djsModuleUrl: 'https://example.invalid/djs.wasm', djsModuleSha256: pin });
  const fetched: string[] = [];
  const got = await obtainDjsBytes(p.plugin, async url => {
    fetched.push(url);
    return fake;
  });
  assert.equal(got.problem, undefined);
  assert.equal(got.bytes, fake);
  assert.deepEqual(fetched, ['https://example.invalid/djs.wasm']);
  assert.deepEqual(p.written, ['plugins/voice-agent/djs.wasm']);

  // Next time the cached file is used, and checked against the pin again.
  const again = await obtainDjsBytes(p.plugin, async () => {
    throw new Error('should not download');
  });
  assert.equal(again.bytes, fake);
});

test('a download that does not match the pin is refused and not cached', async () => {
  const p = plugin({ djsModuleUrl: 'https://example.invalid/djs.wasm', djsModuleSha256: pin });
  const got = await obtainDjsBytes(p.plugin, async () => new TextEncoder().encode('evil').buffer);
  assert.equal(got.bytes, undefined);
  assert.match(got.problem ?? '', /does not match the pinned sha256/);
  assert.deepEqual(p.written, []);
});

test('no pin, no https or no URL: nothing is downloaded', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return fake;
  };
  const unpinned = await obtainDjsBytes(
    plugin({ djsModuleUrl: 'https://example.invalid/d.wasm' }).plugin,
    fetcher,
  );
  assert.match(unpinned.problem ?? '', /without a valid sha256/);
  const http = await obtainDjsBytes(
    plugin({ djsModuleUrl: 'http://example.invalid/d.wasm', djsModuleSha256: pin }).plugin,
    fetcher,
  );
  assert.match(http.problem ?? '', /https/);
  const none = await obtainDjsBytes(plugin({}).plugin, fetcher);
  assert.match(none.problem ?? '', /no djs module at plugins\/voice-agent\/djs\.wasm/);
  assert.equal(calls, 0);
  assert.deepEqual(djsSource(plugin({}).plugin), { url: '', sha256: '' });
});

test('a cached file that does not match the pin is not loaded', async () => {
  const p = plugin(
    { djsModuleSha256: pin },
    { 'plugins/voice-agent/djs.wasm': new TextEncoder().encode('swapped').buffer },
  );
  const got = await obtainDjsBytes(p.plugin);
  assert.equal(got.bytes, undefined);
  assert.match(got.problem ?? '', /does not match the pinned sha256/);
  // Without a pin, a file the user put there is used as before.
  const unpinned = plugin({}, { 'plugins/voice-agent/djs.wasm': fake });
  assert.equal((await obtainDjsBytes(unpinned.plugin)).bytes, fake);
});

test('the built-in module is used, after its recorded checksum matches', async () => {
  const base64 = Buffer.from(new Uint8Array(fake)).toString('base64');
  setEmbeddedDjsForTests({ base64, sha256: pin, commit: 'abc1234' });
  try {
    assert.deepEqual(embeddedDjs(), { sha256: pin, commit: 'abc1234' });
    let calls = 0;
    const got = await obtainDjsBytes(plugin({}).plugin, async () => {
      calls++;
      return fake;
    });
    assert.equal(got.problem, undefined);
    assert.deepEqual(new Uint8Array(got.bytes!), new Uint8Array(fake));
    assert.equal(calls, 0, 'nothing is downloaded');

    // A path or download of the user's own takes its place.
    const own = plugin({ djsModulePath: 'mine/djs.wasm' }, { 'mine/djs.wasm': fake });
    assert.equal((await obtainDjsBytes(own.plugin)).bytes, fake);
    const missing = await obtainDjsBytes(plugin({ djsModulePath: 'gone.wasm' }).plugin);
    assert.match(missing.problem ?? '', /no djs module at gone\.wasm/);

    // Bytes that do not match the checksum recorded at build time are never compiled.
    setEmbeddedDjsForTests({ base64, sha256: '0'.repeat(64) });
    const bad = await obtainDjsBytes(plugin({}).plugin);
    assert.equal(bad.bytes, undefined);
    assert.match(bad.problem ?? '', /built-in djs module does not match/);
  } finally {
    setEmbeddedDjsForTests({ base64: '', sha256: '' });
  }
  assert.equal(embeddedDjs(), null);
});
