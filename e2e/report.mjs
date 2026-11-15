// Builds the validation report from the suite's results.
// Usage: node e2e/report.mjs [outDir]   (defaults to e2e/.out)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIREMENTS } from './requirements.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, '.out'));
const resultsFile = path.join(out, 'results.jsonl');
const results = fs.existsSync(resultsFile)
  ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];
const latest = new Map(results.map(r => [r.id, r]));
const git = args => {
  try {
    return execFileSync('git', args, { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};
const commit = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']);
const obsidian = results.find(r => r.obsidian)?.obsidian;

const rows = REQUIREMENTS.map(req => {
  const r = latest.get(req.id);
  let status;
  if (r) status = r.status === 'pass' ? 'PASS' : 'FAIL';
  else if (req.needs) status = 'UNVERIFIED (real service)';
  else status = 'NOT RUN';
  return { ...req, status, result: r };
});
const count = s => rows.filter(r => r.status.startsWith(s)).length;
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

const lines = [
  '# Voice Agent validation report',
  '',
  `- Plugin commit: \`${commit}\``,
  `- Obsidian: ${obsidian ? `app ${obsidian.app}, installer ${obsidian.installer} (real desktop app, driven by WebdriverIO)` : 'no run recorded'}`,
  `- Generated: ${new Date().toISOString()}`,
  `- Results: ${count('PASS')} pass, ${count('FAIL')} fail, ${count('UNVERIFIED')} unverified against the real service, ${count('NOT RUN')} not run`,
  '',
  '## What is real and what is faked',
  '',
  '- **Real:** the Obsidian desktop app, the plugin as built from this commit, the vault, every tool, the settings tab, review modals, the reviewer gate, backups, trash, code mode, skills loading, the MCP client, sub-agents and the saved call notes.',
  '- **Faked:** every model provider and both MCP servers. A local fake server replays a script written into each test, and approves or rejects reviews by a marker. Its full traffic is saved under `traces/`. A PASS proves the plugin did the right thing with those replies; it does not prove a real model would send them.',
  '- **Not exercised:** audio. Live voice, provider sign-ins and real model quality are listed as unverified, with what is needed.',
  '',
  '## Results',
  '',
  '| Requirement | Source | Scenario | Evidence | Status |',
  '|---|---|---|---|---|',
  ...rows.map(r => {
    const ev = r.result?.evidence?.map(e => `[${path.basename(e)}](${e})`).join('<br>') ?? '';
    const scenario = r.result?.scenario ?? (r.needs ? `Needs: ${r.needs}` : '');
    const detail = r.result?.error ? `<br>${cell(r.result.error).slice(0, 300)}` : '';
    return `| **${r.id}** ${cell(r.title)} | ${cell(r.source)} | ${cell(scenario)} | ${ev} | ${r.status}${detail} |`;
  }),
  '',
  '## Notes from the run',
  '',
  ...rows.filter(r => r.result?.notes?.length).map(r => `- **${r.id}:** ${r.result.notes.join(' ')}`),
  '',
  '## What Hani would need to provide to verify the rest',
  '',
  ...rows.filter(r => r.status.startsWith('UNVERIFIED')).map(r => `- **${r.id}** ${r.title}: ${r.needs}`),
  '',
];
fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n'));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(rows.map(({ result, ...r }) => ({ ...r, result })), null, 2));
console.log(`Validation report: ${path.join(out, 'report.md')} (${count('PASS')} pass, ${count('FAIL')} fail, ${count('UNVERIFIED')} unverified, ${count('NOT RUN')} not run)`);
