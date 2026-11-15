import { Notice } from 'obsidian';
import type PureChatLLM from '../main';
import { PureChatLLMversion } from '../assets/constants';
import type { McpServerConfig } from '../types';
import { formatMcpResult, McpClient, McpToolInfo } from './McpClient';

export const DEFAULT_MCP_SERVER: McpServerConfig = {
  name: '',
  url: '',
  enabled: true,
  bearerToken: '',
  headers: '',
  mode: 'bridge',
  allowedTools: '',
};

/** A remote MCP tool exposed to models as a plain function. */
export interface BridgedMcpTool {
  server: McpServerConfig;
  tool: McpToolInfo;
  /** Function name shown to models: mcp__server__tool (max 64 chars, [A-Za-z0-9_-]). */
  exposedName: string;
}

/**
 * Turns a label into a safe identifier fragment.
 * @param value - Raw label.
 */
export function sanitizeToolFragment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
}

/**
 * Owns one MCP client per configured server and caches their tool lists.
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private tools = new Map<string, McpToolInfo[]>();
  readonly errors = new Map<string, string>();
  private refreshing: Promise<void> | null = null;

  /**
   * @param plugin - The plugin instance (for settings).
   */
  constructor(private plugin: PureChatLLM) {}

  /** Enabled servers from settings. */
  get servers(): McpServerConfig[] {
    return (this.plugin.settings.mcpServers ?? []).filter(s => s.enabled && s.name && s.url);
  }

  /**
   * Gets (or creates) the client for a server, recreating it if its config changed.
   * @param server - Server config.
   */
  private client(server: McpServerConfig): McpClient {
    const existing = this.clients.get(server.name);
    if (existing && JSON.stringify(existing.config) === JSON.stringify(server)) return existing;
    const client = new McpClient(
      { ...server },
      { name: 'pure-chat-llm', version: PureChatLLMversion },
    );
    this.clients.set(server.name, client);
    return client;
  }

  /**
   * Refreshes the tool lists of every enabled server.
   * @param notify - Show a notice with the result.
   */
  refreshAll(notify = true): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const servers = this.servers;
      await Promise.all(servers.map(s => this.refresh(s)));
      if (notify) {
        const ok = servers.filter(s => !this.errors.has(s.name)).length;
        const count = servers.reduce((n, s) => n + (this.tools.get(s.name)?.length ?? 0), 0);
        new Notice(`MCP: ${ok}/${servers.length} servers connected, ${count} tools.`);
      }
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /**
   * Refreshes one server's tool list.
   * @param server - Server config.
   */
  async refresh(server: McpServerConfig): Promise<McpToolInfo[]> {
    try {
      const list = await this.client(server).listTools();
      const allow = server.allowedTools
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const filtered = allow.length ? list.filter(t => allow.includes(t.name)) : list;
      this.tools.set(server.name, filtered);
      this.errors.delete(server.name);
      return filtered;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(server.name, message);
      this.tools.set(server.name, []);
      this.plugin.console?.error(`MCP server ${server.name} failed:`, message);
      return [];
    }
  }

  /**
   * Cached tool names for one server (empty until refreshed).
   * @param name - Server name.
   */
  toolNames(name: string): string[] {
    return (this.tools.get(name) ?? []).map(t => t.name);
  }

  /** Every cached tool from every enabled server, with stable unique model-facing names. */
  bridgedTools(): BridgedMcpTool[] {
    const used = new Set<string>();
    const out: BridgedMcpTool[] = [];
    for (const server of this.servers) {
      for (const tool of this.tools.get(server.name) ?? []) {
        let name =
          `mcp__${sanitizeToolFragment(server.name)}__${sanitizeToolFragment(tool.name)}`.slice(
            0,
            64,
          );
        for (let i = 2; used.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
        used.add(name);
        out.push({ server, tool, exposedName: name });
      }
    }
    return out;
  }

  /** Servers the user asked to hand to providers natively. */
  nativeServers(): McpServerConfig[] {
    return this.servers.filter(s => s.mode === 'native');
  }

  /**
   * Calls a bridged tool and returns model-readable text.
   * @param bridged - The tool.
   * @param args - Arguments from the model.
   */
  async call(bridged: BridgedMcpTool, args: Record<string, unknown>): Promise<string> {
    const result = await this.client(bridged.server).callTool(bridged.tool, args);
    return formatMcpResult(result);
  }

  /** Forgets every client. */
  dispose(): void {
    this.clients.clear();
    this.tools.clear();
  }
}

/**
 * Builds the native remote MCP tool block accepted by OpenAI Realtime, the Responses API and
 * Grok Voice (`type: "mcp"`).
 * @param server - Server config.
 */
export function nativeMcpToolDefinition(server: McpServerConfig): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const line of (server.headers ?? '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const allowed = server.allowedTools
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  return {
    type: 'mcp',
    server_label: sanitizeToolFragment(server.name),
    server_url: server.url,
    require_approval: 'never',
    ...(server.bearerToken ? { authorization: server.bearerToken } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(allowed.length ? { allowed_tools: allowed } : {}),
  };
}
