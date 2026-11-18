/**
 * Fixture vaults for the graph tools.
 *
 * `LO_VAULT` models the 8:20 PM voice test: the active learning-objective note has no backlinks,
 * and the answer (the drug note) is only reachable through outgoing body links and typed
 * frontmatter relations, two or more hops out.
 *
 *   AP11AO402 --concept--> Pharmacokinetics --principle--> Volume of distribution
 *       |                       ^
 *       link                    link (from Reading list)
 *       v
 *   Context sensitive half time --link--> Propofol <--link-- Case 1
 */
export const LO_VAULT: Record<string, string> = {
  'Medicine/ANZCA/LO/AP11AO402.md':
    '---\ntype: learning-objective\nconcept: "[[Pharmacokinetics]]"\n---\n# AP11AO402\nDescribe the [[Context sensitive half time]].\n',
  'Medicine/Concepts/Pharmacokinetics.md':
    '---\ntype: concept\nprinciple: "[[Volume of distribution]]"\n---\n# Pharmacokinetics\n',
  'Medicine/Concepts/Context sensitive half time.md':
    '---\ntype: concept\n---\nDepends on [[Propofol]] infusions. See [[Missing note]].\n',
  'Medicine/Drugs/Propofol.md':
    '---\ntype: drug\ntags: [pharm/agents]\n---\n# Propofol\nThe answer: its context-sensitive half time stays short.\n',
  'Medicine/Concepts/Volume of distribution.md':
    '---\ntype: principle\ntags: [pharm/core]\n---\n# Volume of distribution\n',
  'Other/Reading list.md': 'Read about [[Pharmacokinetics]].\n',
  'Medicine/Cases/Case 1.md': 'Patient given [[Propofol]].\n',
  'Notes/Index.md': 'one index',
  'Archive/Index.md': 'another index',
  // A folder note with aliases, and a stray note of the same name elsewhere.
  'Topics/Anaesthesia/Anaesthesia.md':
    '---\naliases: [Anesthesia, General anaesthesia]\n---\n# Anaesthesia\nCovers [[Propofol]].\n',
  'Other/Anaesthesia.md': '# A stray note with the same name',
};

export const FOLDER_NOTE = 'Topics/Anaesthesia/Anaesthesia.md';

export const START = 'Medicine/ANZCA/LO/AP11AO402.md';
export const PROPOFOL = 'Medicine/Drugs/Propofol.md';
export const VD = 'Medicine/Concepts/Volume of distribution.md';
export const PK = 'Medicine/Concepts/Pharmacokinetics.md';
export const CSHT = 'Medicine/Concepts/Context sensitive half time.md';
export const READING = 'Other/Reading list.md';
export const CASE = 'Medicine/Cases/Case 1.md';

/** Dataview-style inline fields in note bodies, with relative links. */
export const FIELDS_VAULT: Record<string, string> = {
  'Topics/Heart.md': [
    '---',
    'type: organ',
    '---',
    '# Heart',
    'part-of:: [[Body]]',
    '- related:: [[Lung]], [[Kidney]]',
    'The pump [supplies:: [[Brain]]] and (drains:: [[Liver]]).',
    'Plain link to [[Body]].',
    '```',
    'fake:: [[Ghost]]',
    '```',
    '**bold field**:: [[Spleen]]',
  ].join('\n'),
  'Topics/Body.md': '# Body',
  'Topics/Lung.md': '# Lung',
  'Topics/Kidney.md': '# Kidney',
  'Topics/Brain.md': '# Brain',
  'Topics/Liver.md': '# Liver',
  'Topics/Ghost.md': '# Ghost',
  'Topics/Spleen.md': '# Spleen',
  'Topics/sub/Child.md': 'part-of:: [[../Heart]]\nSee [[./Sibling]].',
  'Topics/sub/Sibling.md': '# Sibling',
};
