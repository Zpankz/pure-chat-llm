// Runs only when DJS_WASM_FILE names a djs.wasm built from source (the djs-wasm CI workflow sets
// it): checks that the vendored host in src/vendor/djs works with that module, end to end through
// code mode's own script wrapper, before the module is embedded in a release.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import './helpers';
import { runWithDjs } from '../../../src/tools/codemode/djsEngine';

const file = process.env.DJS_WASM_FILE?.trim();

test('the djs module built from source runs code mode scripts', { skip: !file }, async () => {
  const module = await WebAssembly.compile(readFileSync(file!));
  const calls: string[] = [];
  const stored: Record<string, string> = {};
  const host = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'fail') throw new Error('NotFound: no such note');
      return { x: Number(args.x) * 2 };
    },
    store: (key: string, json: string) => {
      stored[key] = json;
    },
  };
  const tools = [
    { name: 'echo', id: 'echo', description: 'Doubles x', parameters: { type: 'object' } },
    { name: 'fail', id: 'fail', description: 'Always fails', parameters: { type: 'object' } },
  ];
  const limits = { maxFuel: 2_000_000_000, memoryLimitBytes: 64 * 1024 * 1024 };

  // TypeScript, a tool call, text output and a return value.
  const ok = await runWithDjs(
    module,
    `const r = await tools.echo({ x: 21 });
     const n: number = r.x;
     text('doubled');
     return n;`,
    { tools, store: {} },
    host,
    new AbortController().signal,
    limits,
  );
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.ret, '42');
  assert.ok(ok.outputs.includes('doubled'));
  assert.deepEqual(calls, ['echo']);

  // A failed tool call surfaces as a ToolError the script can catch.
  const caught = await runWithDjs(
    module,
    `try { await tools.fail({}); } catch (e) { return e.name; }`,
    { tools, store: {} },
    host,
    new AbortController().signal,
    limits,
  );
  assert.equal(caught.ret, 'ToolError');

  // The instruction budget stops a runaway loop.
  const loop = await runWithDjs(
    module,
    `while (true) {}`,
    { tools, store: {} },
    host,
    new AbortController().signal,
    { ...limits, maxFuel: 5_000_000 },
  );
  assert.equal(loop.ok, false);
  assert.equal(loop.limit, 'fuel');
});
