// Redaction for the diagnostics log: nothing that can open an account leaves the plugin in a log
// line. Secrets are removed three ways: by the name of the field that holds them, by their known
// value (the keys in settings), and by the shape of common keys and tokens wherever they appear
// in text (a key pasted into a chat, an auth header in an error message).

export const REDACTED = '[redacted]';

/** Field names whose string values are always secret. Counts such as `max_tokens` are numbers. */
const SECRET_KEY =
  /(api[-_]?key|apikey|token|secret|password|passwd|authorization|cookie|bearer|credential|private[-_]?key|client[-_]?secret|x-api-key)/i;

/** Shapes of keys and tokens, replaced wherever they appear in text. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [
    /\b(authorization|x-api-key|api-key|x-goog-api-key|cookie)(\s*[:=]\s*)("?)[^\s,;"]+/gi,
    `$1$2$3${REDACTED}`,
  ],
  [
    /([?&](?:key|api_key|apikey|token|access_token|refresh_token|id_token|code|client_secret)=)[^&\s"'#]+/gi,
    `$1${REDACTED}`,
  ],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, REDACTED],
  [/\b1\/\/0[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bxai-[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Short-lived voice session tokens (OpenAI Realtime client secrets, Gemini Live tokens).
  [/\bek_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bauth_tokens\/[A-Za-z0-9_-]{10,}/g, REDACTED],
];

/** Whether a field of this name holds a secret. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * Removes secrets from a piece of text.
 * @param text - Text.
 * @param known - Secret values to remove wherever they appear (longest first).
 */
export function redactText(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The secret values in a settings object: strings in fields named like keys or tokens, and the
 * values of `Name: value` header lines. Short values are left out, since they would match
 * ordinary words.
 * @param settings - Plugin settings.
 */
export function collectSecrets(settings: unknown): string[] {
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (/headers?$/i.test(key)) {
        for (const line of value.split(/\r?\n/)) {
          const at = line.indexOf(':');
          const v = at > 0 ? line.slice(at + 1).trim() : '';
          if (v.length >= 8) found.add(v);
        }
      } else if (isSecretKey(key) && value.trim().length >= 8) {
        found.add(value.trim());
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Header maps: every value is treated as secret.
      if (/headers?$/i.test(key) && typeof v === 'string' && v.length >= 8) found.add(v);
      walk(v, k, depth + 1);
    }
  };
  walk(settings, '', 0);
  return [...found].sort((a, b) => b.length - a.length);
}

export interface RedactOptions {
  /** Secret values to remove. */
  known?: readonly string[];
  /** Longest string kept; the rest is cut with a note of its length. */
  maxChars?: number;
  /** Deepest nesting kept. */
  maxDepth?: number;
}

/**
 * A copy of a value that is safe to write to a log: secrets removed, long strings cut, and
 * things that are not plain data (DOM nodes, class instances, functions) named instead of copied.
 * @param value - Any value.
 * @param options - Redaction options.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const known = options.known ?? [];
  const maxChars = options.maxChars ?? 20_000;
  const maxDepth = options.maxDepth ?? 8;
  const seen = new WeakSet<object>();
  const text = (s: string) => {
    const clean = redactText(s, known);
    return clean.length > maxChars
      ? `${clean.slice(0, maxChars)}…[+${clean.length - maxChars} chars]`
      : clean;
  };
  const copy = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === 'string') return text(v);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return `[function ${v.name || 'anonymous'}]`;
    if (typeof v === 'symbol') return v.toString();
    if (typeof v !== 'object') return '[unknown]';
    if (v instanceof Error) {
      return {
        error: v.name,
        message: text(v.message),
        ...(v.stack ? { stack: text(v.stack) } : {}),
      };
    }
    if (seen.has(v)) return '[circular]';
    if (depth >= maxDepth) return '[nested]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(item => copy(item, depth + 1));
    const proto = Object.getPrototypeOf(v) as object | null;
    if (proto !== null && proto !== Object.prototype) {
      if (v instanceof Date) return v.toISOString();
      if (v instanceof Map) return copy(Object.fromEntries(v), depth);
      if (v instanceof Set) return copy([...v], depth);
      const name = (proto as { constructor?: { name?: string } }).constructor?.name ?? 'object';
      return `[${name}]`;
    }
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      out[k] =
        typeof item === 'string' && isSecretKey(k) && item ? REDACTED : copy(item, depth + 1);
    }
    return out;
  };
  return copy(value, 0);
}
