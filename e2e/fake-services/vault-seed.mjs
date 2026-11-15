// Builds the disposable test vault used by the end-to-end suite.
//
// The vault mirrors the shape of Hani's DTW vault (a `_types` folder of Typed Graph schema notes,
// `src/lo/.../LO` learning objectives, `src/ontology` concepts and principles linked through
// typed frontmatter relations, `src/qs` questions) with synthetic content only. No DTW content is
// copied. It also seeds Agent Skills, write targets for the review tests, and the settings file an
// older Pure Chat LLM install would have left behind, so the id migration can be tested.
import fs from 'node:fs';
import path from 'node:path';

const note = (fm, body) => {
  const lines = Object.entries(fm ?? {}).map(([k, v]) =>
    Array.isArray(v) ? `${k}:\n${v.map(x => `  - ${JSON.stringify(x)}`).join('\n')}` : `${k}: ${JSON.stringify(v)}`,
  );
  return `${lines.length ? `---\n${lines.join('\n')}\n---\n\n` : ''}${body}\n`;
};

/** Distinctive values that only the legacy settings file contains (checked by the migration spec). */
export const LEGACY_MARKERS = {
  SystemPrompt: 'LEGACY-SYSTEM-PROMPT-7f3a: you are the old Pure Chat LLM.',
  defaultmaxTokens: 1234,
  chatTemplates: { 'Legacy template 7f3a': 'Summarise {{selection}} in one line.' },
};

export const SEED_FILES = {
  // Typed Graph (TGS) schema notes, same frontmatter keys the plugin reads from DTW's _types.
  '_types/relations.md': `---
tgs: "0.6"
edgeTypes:
  concept:
    from: [objective, saq, concept]
    to: [concept]
    description: "The domain subject the note addresses."
  principle:
    from: [objective, concept]
    to: [principle]
    description: "An explanatory law or model applied or studied."
  part-of:
    from: [concept]
    to: [concept]
    description: "A component of another concept."
  lo:
    from: [saq]
    to: [objective]
    description: "A learning objective the question assesses."
---

Edge types for the validation vault.
`,
  '_types/curriculum.md': `---
tgs: "0.6"
schemas:
  objective:
    description: "An official learning objective."
    edges:
      concept: {}
      principle: {}
  concept:
    description: "A domain concept."
    edges:
      part-of: {}
      principle: {}
  principle:
    description: "An explanatory law or model."
  saq:
    description: "A past short answer question."
    edges:
      lo: {}
---

Node types for the validation vault.
`,
  // Learning objectives live in a nested LO folder, as in the 8:20 PM voice test.
  'src/lo/anzca/LO/AP11AO401.md': note(
    { type: 'objective', code: 'AP11AO401', concept: '[[oxygen-cascade]]' },
    'Describe the oxygen cascade from inspired gas to the mitochondria.',
  ),
  // No note links to AP11AO402: it has no backlinks, only outgoing typed and body links.
  'src/lo/anzca/LO/AP11AO402.md': note(
    {
      type: 'objective',
      code: 'AP11AO402',
      concept: '[[alveolar-gas-equation]]',
      principle: '[[fick-law-of-diffusion]]',
    },
    'Explain the alveolar gas equation and how [[ventilation-perfusion-matching]] changes arterial oxygen. See also [[missing-concept-note]].',
  ),
  'src/lo/anzca/LO/AP11AO403.md': note(
    { type: 'objective', code: 'AP11AO403', concept: '[[shunt]]' },
    'Describe the effect of shunt on arterial oxygen tension.',
  ),
  'src/lo/anzca/LO/AP11AO404.md': note(
    { type: 'objective', code: 'AP11AO404', principle: '[[partial-pressure]]' },
    'Explain partial pressure and its measurement.',
  ),
  'src/lo/anzca/LO/AP11AO405.md': note(
    { type: 'objective', code: 'AP11AO405' },
    'Outline carbon dioxide carriage in blood.',
  ),
  'src/ontology/concepts/oxygen-cascade.md': note(
    { type: 'concept', 'part-of': '[[respiratory-physiology]]' },
    'The stepwise fall in oxygen partial pressure from air to tissue.',
  ),
  'src/ontology/concepts/alveolar-gas-equation.md': note(
    { type: 'concept', principle: '[[partial-pressure]]' },
    'Estimates alveolar oxygen. Related: [[oxygen-cascade]].',
  ),
  'src/ontology/concepts/ventilation-perfusion-matching.md': note(
    { type: 'concept', 'part-of': '[[respiratory-physiology]]' },
    'Matching of ventilation to perfusion. The extreme mismatch is [[shunt]].',
  ),
  'src/ontology/concepts/shunt.md': note({ type: 'concept' }, 'Perfusion without ventilation.'),
  'src/ontology/concepts/respiratory-physiology.md': note(
    { type: 'concept' },
    'Respiratory physiology, the parent concept.',
  ),
  'src/ontology/principles/fick-law-of-diffusion.md': note(
    { type: 'principle' },
    'Diffusion rate is proportional to area and the [[partial-pressure]] gradient.',
  ),
  'src/ontology/principles/partial-pressure.md': note(
    { type: 'principle' },
    'The pressure a gas would exert alone in the volume.',
  ),
  'src/qs/saq/AP11B05.md': note(
    { type: 'saq', lo: '[[AP11AO401]]', concept: '[[oxygen-cascade]]' },
    'Describe the oxygen cascade. (pass rate 41%)',
  ),
  'src/note/oxygen-cascade-model-answer.md': note(
    {},
    'A model answer about oxygen delivery. Links: [[oxygen-cascade]].',
  ),
  // Write targets for the review tests (each test uses its own note).
  'Notes/edit-approve.md': '# Edit target\n\nLine A\nLine B\n',
  'Notes/edit-reject.md': '# Edit target\n\nLine A\nLine B\n',
  'Notes/delete-approve.md': '# Delete target\n\nThis note may be deleted.\n',
  'Notes/delete-reject.md': '# Delete target\n\nThis note must survive. REVIEW-REJECT\n',
  'Notes/codemode-edit.md': '# Code mode edit target\n\nOriginal line\n',
  'Notes/chat-edit.md': '# Chat edit target\n\n## Section\n\nOld text\n',
  'Notes/scratch.md': '# Scratch\n\nalpha beta gamma\n',
  'Notes/chat-delete.md': '# Delete me from a chat\n',
  'Notes/sections.md': '# Sections\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n',
  // Agent Skills: main file named after the folder (decision 13), plus SKILL.md accepted.
  'Skills/vault-search/vault-search.md': `---
name: vault-search
description: Find notes in a named folder and walk the link graph around them.
---

# Vault search skill

1. Resolve the folder name with list_vault_folders.
2. Walk links with traverse_graph.
`,
  'Skills/vault-search/reference.md': '# Reference\n\nSKILL-REFERENCE-MARKER-91c2\n',
  'Skills/legacy-format/SKILL.md': `---
name: legacy-format
description: A skill written with the standard SKILL.md file name.
---

# Legacy format skill
`,
  'Skills/no-description/no-description.md': '---\nname: no-description\n---\n\nNo description, so it must not load.\n',
  'Templates/Daily.md': '# {{date}}\n\n## Tasks\n',
};

/** Settings an older Pure Chat LLM install would have saved (plugin id `pure-chat-llm`). */
export function legacySettings() {
  return {
    ...LEGACY_MARKERS,
    agentMode: true,
    endpoint: 0,
    messageRoleFormatter: '# role: {role}',
  };
}

/**
 * Writes a fresh copy of the vault.
 * @param {string} dir - Target folder (deleted first).
 */
export function seedVault(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(SEED_FILES)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  const legacy = path.join(dir, '.obsidian/plugins/pure-chat-llm/data.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify(legacySettings(), null, 2));
  // Core Templates plugin pointed at Templates/, so manage_templates has something to list.
  // Deleted notes go to the vault's .trash folder, so the tests can see them there.
  fs.writeFileSync(path.join(dir, '.obsidian/app.json'), JSON.stringify({ trashOption: 'local' }));
  fs.writeFileSync(path.join(dir, '.obsidian/templates.json'), JSON.stringify({ folder: 'Templates' }));
  fs.writeFileSync(
    path.join(dir, '.obsidian/core-plugins.json'),
    JSON.stringify(['file-explorer', 'global-search', 'graph', 'backlink', 'outgoing-link', 'templates', 'page-preview']),
  );
  return dir;
}
