// End-to-end validation of the Voice Agent plugin in real Obsidian.
//
// Real: Obsidian desktop (downloaded by wdio-obsidian-service), the built plugin (main.js,
// manifest.json, styles.css from the repo root), the vault, the UI.
// Faked: every model provider and MCP server, served from e2e/fake-services/server.mjs.
//
// Run: npm run build && xvfb-run -a npm run e2e   (Linux CI)   or   npm run e2e   (desktop)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { seedVault } from './fake-services/vault-seed.mjs';
import { startFakeServices } from './fake-services/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = process.env.E2E_OUT ?? path.join(here, '.out');
const vault = path.join(here, '.generated', 'vault');
const port = Number(process.env.FAKE_PORT ?? 8787);
process.env.E2E_OUT = out;
process.env.FAKE_URL = `http://127.0.0.1:${port}`;

// The launcher seeds once; worker processes load this file too and must not rebuild the vault.
if (!process.env.WDIO_WORKER_ID) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
  seedVault(vault);
  for (const f of ['main.js', 'manifest.json']) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`Build the plugin first: ${f} is missing (npm run build).`);
  }
}

let fake: { server: { close(): void } } | null = null;

export const config: WebdriverIO.Config = {
  runner: 'local',
  framework: 'mocha',
  // E2E_SPEC_FILE runs one file outside specs/ (the side panel screenshots).
  specs: [
    process.env.E2E_SPEC_FILE
      ? path.resolve(root, process.env.E2E_SPEC_FILE)
      : path.join(here, 'specs', process.env.E2E_SPEC ? `*${process.env.E2E_SPEC}*.e2e.mts` : '*.e2e.mts'),
  ],
  // One Obsidian at a time: specs share the fake services' trace file.
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'obsidian',
      browserVersion: process.env.OBSIDIAN_VERSION ?? 'latest',
      'wdio:obsidianOptions': {
        installerVersion: process.env.OBSIDIAN_INSTALLER ?? 'latest',
        // E2E_WITH_PURE_CHAT=1 also installs the community Pure Chat LLM, to check both load together.
        plugins: process.env.E2E_WITH_PURE_CHAT === '1' ? [root, { id: 'pure-chat-llm' }] : [root],
        vault,
      },
    },
  ],
  services: ['obsidian'],
  reporters: ['obsidian'],
  cacheDir: path.join(here, '.obsidian-cache'),
  mochaOpts: { ui: 'bdd', timeout: 150_000 },
  waitforTimeout: 30_000,
  logLevel: 'warn',
  outputDir: path.join(out, 'wdio-logs'),

  onPrepare: async () => {
    fake = await startFakeServices({ port, traceDir: path.join(out, 'traces') });
  },
  before: async () => {
    try {
      await browser.setWindowSize(1440, 960);
    } catch {
      // Some Electron builds refuse resizing; screenshots are still taken at the default size.
    }
  },
  onComplete: () => {
    fake?.server.close();
    try {
      execFileSync(process.execPath, [path.join(here, 'report.mjs'), out], { stdio: 'inherit' });
    } catch (error) {
      console.error('Could not build the validation report', error);
    }
  },
};
