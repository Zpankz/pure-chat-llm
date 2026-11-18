// Pure helpers the memory uses to compare and rank text: content words without common words,
// a light stemmer, word overlap, normalised entity names, the recency decay and the sizing of
// context blocks. No engine and no plugin here, so all of it is tested directly.

/** Common English words that say nothing about what a fact is about. */
export const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before ' +
    'being below between both but by can could did do does doing done down during each else ever ' +
    'few find for found from further get got had has have having he her here hers him his how i if ' +
    'in into is it its itself just know let like made make me more most much must my no nor not now ' +
    'of off on once one only or other our ours out over own please really said same say see she ' +
    'should so some such than that the their theirs them then there these they thing things this ' +
    'those through to too under until up us use used very want wants was we well were what when ' +
    'where which while who whom why will with would yes yet you your yours user users'
  ).split(' '),
);

/**
 * A light stem: enough to match "equations" with "equation" and "rendering" with "renders".
 * @param word - Lower-case word.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

/** Words of a text, lower-case, letters and digits only. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The words that carry meaning: no common words, no single letters, each once, in order.
 * @param text - Text.
 * @param max - Most words kept.
 */
export function contentTerms(text: string, max = 16): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words(text)) {
    if (w.length < 2 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Share of the two texts' content words (stemmed) that they have in common (Jaccard), 0 to 1.
 * @param a - One text.
 * @param b - The other.
 */
export function termOverlap(a: string, b: string): number {
  // Every word but common ones, numbers included: "fact 1" and "fact 2" are not the same.
  const set = (text: string) =>
    new Set(
      words(text)
        .filter(w => !STOPWORDS.has(w))
        .map(stem),
    );
  const sa = set(a);
  const sb = set(b);
  if (!sa.size || !sb.size) return 0;
  let both = 0;
  for (const w of sa) if (sb.has(w)) both++;
  return both / (sa.size + sb.size - both);
}

/**
 * How many of the query terms a text contains, by stem prefix ("equation" finds "equations").
 * @param terms - Query terms (from `contentTerms`).
 * @param text - Text searched.
 */
export function matchedTerms(terms: string[], text: string): number {
  const tokens = words(text);
  let n = 0;
  for (const term of terms) {
    const s = stem(term);
    if (tokens.some(t => t === term || t.startsWith(s) || stem(t) === s)) n++;
  }
  return n;
}

/**
 * Matching terms a hit needs: one for a short query, two once the query has three or more
 * content words (so common words alone never make a match).
 * @param terms - Query terms.
 */
export function termsNeeded(terms: string[]): number {
  return terms.length >= 3 ? 2 : 1;
}

/**
 * A full-text query for relate's index: each term as a stem prefix, so word forms match.
 * @param terms - Query terms.
 */
export function fulltextQuery(terms: string[]): string {
  return terms.map(t => (t.length >= 4 ? `${stem(t)}*` : t)).join(' ');
}

/**
 * The form an entity's name is matched by: lower-case, hyphens, underscores and dots as spaces,
 * other punctuation dropped, single spaces.
 * @param name - Name as written.
 */
export function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Days for an observation's weight to halve. */
export const HALF_LIFE_DAYS = 30;
const DAY = 86_400_000;

/** Kinds that never fade: the user said how they want things. */
export const STANDING_KINDS = new Set(['preference', 'instruction']);

export interface DecayInput {
  kind: string;
  importance: number;
  confirmations?: number | null;
  recordedAt: number;
  lastSeenAt?: number | null;
}

/**
 * How recent a fact still counts, 0 to 1: halves every 30 days since it was last said or
 * confirmed; 1 for instructions, preferences and pinned facts.
 * @param f - Fact.
 * @param now - Time now.
 */
export function recency(f: DecayInput, now: number): number {
  if (STANDING_KINDS.has(f.kind) || f.importance >= 3) return 1;
  const since = Math.max(0, now - (f.lastSeenAt ?? f.recordedAt)) / DAY;
  return Math.pow(0.5, since / HALF_LIFE_DAYS);
}

/**
 * A fact's weight for ranking and for fading: importance × confirmations (with diminishing
 * returns) × recency.
 * @param f - Fact.
 * @param now - Time now.
 */
export function decayScore(f: DecayInput, now: number): number {
  const confirmations = Math.max(1, f.confirmations ?? 1);
  const confirmed = 1 + Math.log2(confirmations) * 0.5;
  return Math.max(1, f.importance) * confirmed * recency(f, now);
}

/** A faded observation scores below this (an unconfirmed one after about 100 days). */
export const FADED_SCORE = 0.1;

/**
 * Lines under a header, as many whole lines as fit the budget; '' when none fit.
 * @param header - First line.
 * @param lines - Lines in order of importance.
 * @param maxChars - Longest result.
 */
export function fitBlock(header: string, lines: string[], maxChars: number): string {
  const out: string[] = [];
  let size = header.length;
  for (const line of lines) {
    const clipped = line.length > maxChars - header.length - 1 ? clipLine(line, 300) : line;
    if (size + 1 + clipped.length > maxChars) continue;
    out.push(clipped);
    size += 1 + clipped.length;
  }
  return out.length ? [header, ...out].join('\n') : '';
}

/**
 * One line, at most this long.
 * @param text - Text.
 * @param max - Longest.
 */
export function clipLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Local date and time, `YYYY-MM-DD HH:MM`, as call titles show it (audit item 10: the brief
 * printed UTC next to local call titles).
 * @param at - Time.
 */
export function localTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local date, `YYYY-MM-DD`. */
export function localDate(at: number): string {
  return localTime(at).slice(0, 10);
}

/**
 * Cosine similarity of two vectors (-1 to 1); 0 when they can't be compared.
 * @param a - Vector.
 * @param b - Vector.
 */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * A vector made small enough to keep in the vault file: cut to `dims` (for models trained to
 * be cut), normalised, and rounded to four decimals.
 * @param vector - Embedding.
 * @param dims - Length kept, or 0 for all.
 */
export function compactVector(vector: number[], dims = 0): number[] {
  const cut = dims > 0 && vector.length > dims ? vector.slice(0, dims) : vector.slice();
  const norm = Math.sqrt(cut.reduce((s, x) => s + x * x, 0)) || 1;
  return cut.map(x => Math.round((x / norm) * 10_000) / 10_000);
}
