import type { App } from 'obsidian';
import type { McpServerConfig, PureChatLLMSettings } from '../types';
import { readSecret, writeSecret } from './secrets';

/**
 * MCP OAuth tokens and client secrets stay out of the settings file (which lives in the vault
 * and may be synced): they are kept in Obsidian's secret storage, keyed by server address, and
 * put back into the in-memory settings on load.
 */
interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  clientSecret?: string;
}

/** @param server - Server. */
function key(server: McpServerConfig): string {
  return `mcp-${server.url.trim().toLowerCase()}`;
}

/**
 * Restores tokens into loaded settings, and moves any tokens an older version saved in the
 * settings file into secret storage.
 * @param app - Obsidian app.
 * @param servers - Loaded servers (changed in place).
 * @returns Whether old tokens were found in the settings file (save once to remove them).
 */
export function hydrateMcpTokens(app: App, servers: McpServerConfig[]): boolean {
  let migrated = false;
  for (const server of servers) {
    if (!server.oauth) continue;
    const o = server.oauth;
    if (o.accessToken || o.refreshToken || o.clientSecret) {
      writeSecret(app, key(server), {
        accessToken: o.accessToken,
        refreshToken: o.refreshToken,
        clientSecret: o.clientSecret,
      } satisfies StoredTokens);
      migrated = true;
      continue;
    }
    const stored = readSecret<StoredTokens>(app, key(server));
    if (stored) {
      o.accessToken = stored.accessToken ?? '';
      o.refreshToken = stored.refreshToken ?? '';
      if (stored.clientSecret) o.clientSecret = stored.clientSecret;
    }
  }
  return migrated;
}

/**
 * A copy of the settings for the settings file, with MCP tokens moved to secret storage.
 * @param app - Obsidian app.
 * @param settings - In-memory settings.
 */
export function withoutSecrets(app: App, settings: PureChatLLMSettings): PureChatLLMSettings {
  const servers = settings.mcpServers.map(server => {
    if (!server.oauth) return server;
    const { accessToken, refreshToken, clientSecret } = server.oauth;
    writeSecret(
      app,
      key(server),
      accessToken || refreshToken || clientSecret
        ? ({ accessToken, refreshToken, clientSecret } satisfies StoredTokens)
        : null,
    );
    return {
      ...server,
      oauth: { ...server.oauth, accessToken: '', refreshToken: '', clientSecret: undefined },
    };
  });
  return { ...settings, mcpServers: servers };
}
