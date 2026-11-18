import type { App } from 'obsidian';

/**
 * Sign-in tokens live in Obsidian's secret storage (`app.secretStorage`, Obsidian 1.11.4+), which
 * is kept out of the vault and out of the plugin's settings file, so tokens are never synced with
 * the vault (for example by obsidian-git). Where secret storage is missing, tokens are kept in
 * memory only for this session and never written to disk.
 *
 * Secret storage is synchronous and, on Linux, goes through the system keyring. Where no keyring
 * answers, each read can block the window for many seconds (validation run 2: opening the settings
 * tab froze Obsidian for minutes, one sign-in check after another). So each secret is read from
 * storage at most once per session and then served from memory, and a read that takes longer than
 * `SLOW_READ_MS` marks secret storage as unusable for the rest of the session: later reads and
 * writes use memory only.
 */
const memory = new Map<string, string>();
/** Keys already read from secret storage this session (their value, if any, is in `memory`). */
const loaded = new Set<string>();
/** A read slower than this means the keyring is not answering. */
export const SLOW_READ_MS = 1000;
let unusable = false;

/** Whether secret storage was found too slow this session (tokens then last until restart). */
export function secretStorageSlow(): boolean {
  return unusable;
}

/** Forgets what was read and found (tests only). */
export function resetSecretCache(): void {
  memory.clear();
  loaded.clear();
  unusable = false;
}

/** @param id - Any key; turned into a valid secret id (lowercase letters, digits, dashes). */
export function secretId(id: string): string {
  const clean = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `pure-chat-llm-${clean || 'secret'}`;
}

/** Whether tokens survive a restart on this device. */
export function persistentSecrets(app: App): boolean {
  return !unusable && typeof app.secretStorage?.setSecret === 'function';
}

/**
 * Reads a JSON secret.
 * @param app - Obsidian app.
 * @param id - Key.
 */
export function readSecret<T>(app: App, id: string): T | null {
  const key = secretId(id);
  if (!loaded.has(key) && persistentSecrets(app)) {
    loaded.add(key);
    const started = Date.now();
    try {
      const stored = app.secretStorage.getSecret(key);
      if (stored && !memory.has(key)) memory.set(key, stored);
    } catch {
      // Keep whatever memory has.
    }
    if (Date.now() - started > SLOW_READ_MS) {
      unusable = true;
      console.warn(
        `Voice Agent: secret storage took ${Date.now() - started} ms to answer, so sign-ins are kept in memory for this session.`,
      );
    }
  }
  const raw = memory.get(key) ?? null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Writes a JSON secret; `null` clears it.
 * @param app - Obsidian app.
 * @param id - Key.
 * @param value - Value.
 */
export function writeSecret(app: App, id: string, value: unknown): void {
  const key = secretId(id);
  const raw = value === null || value === undefined ? '' : JSON.stringify(value);
  // Memory always holds the latest value, so reads never go back to storage for it.
  loaded.add(key);
  if (raw) memory.set(key, raw);
  else memory.delete(key);
  try {
    if (persistentSecrets(app)) app.secretStorage.setSecret(key, raw);
  } catch {
    // Memory keeps it for this session.
  }
}
