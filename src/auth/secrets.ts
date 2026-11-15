import type { App } from 'obsidian';

/**
 * Sign-in tokens live in Obsidian's secret storage (`app.secretStorage`, Obsidian 1.11.4+), which
 * is kept out of the vault and out of the plugin's settings file, so tokens are never synced with
 * the vault (for example by obsidian-git). Where secret storage is missing, tokens are kept in
 * memory only for this session and never written to disk.
 */
const memory = new Map<string, string>();

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
  return typeof app.secretStorage?.setSecret === 'function';
}

/**
 * Reads a JSON secret.
 * @param app - Obsidian app.
 * @param id - Key.
 */
export function readSecret<T>(app: App, id: string): T | null {
  const key = secretId(id);
  let raw: string | null = null;
  try {
    raw = persistentSecrets(app) ? app.secretStorage.getSecret(key) : (memory.get(key) ?? null);
  } catch {
    raw = memory.get(key) ?? null;
  }
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
  try {
    if (persistentSecrets(app)) {
      app.secretStorage.setSecret(key, raw);
      return;
    }
  } catch {
    // Fall through to memory.
  }
  if (raw) memory.set(key, raw);
  else memory.delete(key);
}
