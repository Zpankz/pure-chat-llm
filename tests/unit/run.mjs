// Bundles each tests/unit/**/*.test.ts with esbuild (the `obsidian` module aliased to the
// in-memory mock) and runs them with Node's built-in test runner. No extra dependencies.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname);
const out = join(root, '.out');
const filter = process.argv[2] ?? '';

const find = dir =>
  readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (name === '.out' || name === 'node_modules') return [];
    if (statSync(p).isDirectory()) return find(p);
    return p.endsWith('.test.ts') && p.includes(filter) ? [p] : [];
  });

const entries = find(root);
if (!entries.length) {
  console.error('No unit tests found.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: entries,
  outdir: out,
  outbase: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: { obsidian: join(root, 'obsidian-mock.ts') },
  logLevel: 'error',
  sourcemap: 'inline',
});
const files = entries.map(e => join(out, relative(root, e).replace(/\.ts$/, '.js')));
const run = spawnSync(process.execPath, ['--test', '--enable-source-maps', ...files], {
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
