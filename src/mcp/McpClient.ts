import { requestUrl } from 'obsidian';
import type { McpServerConfig } from '../types';

/**
 * Minimal MCP client for remote servers over Streamable HTTP.
 *
 * Speaks the stateless 2026-07-28 revision first (per-request `_meta`, `MCP-Protocol-Version`,
 * `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*` headers, no sessions), and falls back to the
 * initialize-based 2025-11-25 era (with `Mcp-Session-Id`) when a server is older, exactly as the
 * spec's backward compatibility section describes.
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 *
 * Requests go through Obsidian's `requestUrl`, so remote servers need no CORS configuration.
 * The legacy HTTP+SSE transport (2024-11-05) is deprecated and not supported.
 */

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
  /** Parameter paths that must be mirrored into `Mcp-Param-*` headers. */
  headerParams?: Array<{ path: string[]; header: string }>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string; blob?: string };
}

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: string;
  inputRequests?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: { supported?: string[]; [key: string]: unknown };
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: JsonRpcError;
}

/** Thrown for JSON-RPC errors returned by a server. */
export class McpError extends Error {
  /**
   * @param rpc - The JSON-RPC error object.
   * @param httpStatus - The HTTP status of the response.
   */
  constructor(
    public rpc: JsonRpcError,
    public httpStatus: number,
  ) {
    super(`MCP error ${rpc.code}: ${rpc.message}`);
  }
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Transport hook, replaceable in tests. */
export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<HttpResponse>;

const defaultPost: HttpPost = async (url, headers, body) => {
  const res = await requestUrl({ url, method: 'POST', headers, body, throw: false });
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
  let text = '';
  try {
    text = res.text ?? '';
  } catch {
    text = '';
  }
  return { status: res.status, headers: lower, text };
};

/**
 * Encodes a value for an MCP header, using the `=?base64?...?=` sentinel when needed.
 * @param value - Raw value.
 */
export function encodeMcpHeaderValue(value: string): string {
  const safe = /^[\x21-\x7E](?:[\x20-\x7E\t]*[\x21-\x7E])?$/.test(value);
  const looksEncoded = value.startsWith('=?base64?') && value.endsWith('?=');
  if (safe && !looksEncoded) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return `=?base64?${btoa(bin)}?=`;
}

/**
 * Finds `x-mcp-header` annotations reachable only through `properties` keys.
 * Returns null when an annotation is invalid, which means the tool must be excluded.
 * @param schema - A tool's inputSchema.
 */
export function extractHeaderParams(
  schema: Record<string, unknown>,
): Array<{ path: string[]; header: string }> | null {
  const found: Array<{ path: string[]; header: string }> = [];
  const seen = new Set<string>();
  let valid = true;

  const visit = (node: unknown, path: string[], reachable: boolean) => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if ('x-mcp-header' in obj && path.length > 0) {
      const header = obj['x-mcp-header'];
      const type = obj.type;
      if (
        !reachable ||
        typeof header !== 'string' ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header) ||
        seen.has(header.toLowerCase()) ||
        !['string', 'integer', 'boolean'].includes(type as string)
      ) {
        valid = false;
      } else {
        seen.add(header.toLowerCase());
        found.push({ path, header });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
          visit(sub, [...path, prop], reachable);
        }
      } else if (value && typeof value === 'object' && key !== 'x-mcp-header') {
        // Anything reached through items, anyOf, $defs, etc. is not statically reachable.
        if (Array.isArray(value)) value.forEach(v => visit(v, path, false));
        else visit(value, path, false);
      }
    }
  };
  visit(schema, [], true);
  return valid ? found : null;
}

/**
 * Parses an SSE body and returns the JSON-RPC messages it carries.
 * @param text - Raw `text/event-stream` body.
 */
export function parseSseMessages(text: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // Ignore keep-alives and partial frames.
    }
  }
  return out;
}

/**
 * Parses `Name: value` lines into a header map.
 * @param raw - Header lines.
 */
export function parseHeaderLines(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

/**
 * A client bound to one remote MCP server.
 */
export class McpClient {
  era: 'modern' | 'legacy' | null = null;
  protocolVersion = MCP_PROTOCOL_VERSION;
  sessionId: string | null = null;
  serverInfo: { name?: string; version?: string } | null = null;
  instructions: string | null = null;
  private nextId = 1;

  /**
   * @param config - Server configuration from settings.
   * @param clientInfo - Name and version reported to the server.
   * @param post - HTTP transport.
   */
  constructor(
    public config: McpServerConfig,
    private clientInfo: { name: string; version: string },
    private post: HttpPost = defaultPost,
  ) {}

  /**
   * Lists every tool on the server (following pagination), excluding tools with invalid
   * `x-mcp-header` annotations as the spec requires.
   */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpToolInfo[];
        nextCursor?: string;
      };
      for (const tool of result.tools ?? []) {
        const headerParams = extractHeaderParams(tool.inputSchema ?? {});
        if (headerParams === null) {
          console.warn(`[MCP] Skipping tool ${tool.name}: invalid x-mcp-header annotation`);
          continue;
        }
        tools.push({ ...tool, inputSchema: tool.inputSchema ?? { type: 'object' }, headerParams });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * Calls a tool.
   * @param tool - The tool (from listTools) to call.
   * @param args - Tool arguments.
   */
  async callTool(tool: McpToolInfo, args: Record<string, unknown>): Promise<McpCallResult> {
    const extra: Record<string, string> = {};
    for (const { path, header } of tool.headerParams ?? []) {
      let value: unknown = args;
      for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
      if (value === undefined || value === null) continue;
      extra[`Mcp-Param-${header}`] = encodeMcpHeaderValue(
        typeof value === 'object'
          ? JSON.stringify(value)
          : String(value as string | number | boolean),
      );
    }
    return (await this.request(
      'tools/call',
      { name: tool.name, arguments: args },
      extra,
    )) as McpCallResult;
  }

  /**
   * Sends one JSON-RPC request, negotiating the protocol era on first use.
   * @param method - JSON-RPC method.
   * @param params - Params without `_meta`.
   * @param extraHeaders - Additional headers (e.g. Mcp-Param-*).
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    if (this.era === null) {
      try {
        this.era = 'modern';
        return await this.send(method, params, extraHeaders);
      } catch (error) {
        const fallbackVersion = this.legacyFallbackVersion(error);
        if (!fallbackVersion) {
          this.era = null;
          throw error;
        }
        await this.initializeLegacy(fallbackVersion);
        return this.send(method, params, extraHeaders);
      }
    }
    try {
      return await this.send(method, params, extraHeaders);
    } catch (error) {
      // Legacy sessions expire with 404; re-initialize once.
      if (this.era === 'legacy' && error instanceof McpHttpError && error.status === 404) {
        await this.initializeLegacy(this.protocolVersion);
        return this.send(method, params, extraHeaders);
      }
      throw error;
    }
  }

  /**
   * Decides whether to fall back to the initialize-based era, per the spec's backward
   * compatibility rules.
   * @param error - Error from the first modern request.
   */
  private legacyFallbackVersion(error: unknown): string | null {
    if (error instanceof McpError) {
      const supported = error.rpc.data?.supported;
      if (Array.isArray(supported)) {
        // A modern UnsupportedProtocolVersionError: only fall back if it lists a legacy version.
        return supported.includes(MCP_PROTOCOL_VERSION)
          ? null
          : (LEGACY_VERSIONS.find(v => supported.includes(v)) ?? null);
      }
      const isModernError = error.rpc.code === -32020 || /capabilit/i.test(error.rpc.message ?? '');
      // Older servers answer a session-less request with a generic JSON-RPC error
      // (for example "No valid session ID"); treat those as legacy.
      if (!isModernError && [400, 404, 405].includes(error.httpStatus)) {
        return MCP_LEGACY_PROTOCOL_VERSION;
      }
      return null;
    }
    if (error instanceof McpHttpError && [400, 404, 405].includes(error.status)) {
      return MCP_LEGACY_PROTOCOL_VERSION;
    }
    return null;
  }

  /**
   * Runs the legacy initialize handshake.
   * @param version - Protocol version to request.
   */
  private async initializeLegacy(version: string): Promise<void> {
    this.era = 'legacy';
    this.sessionId = null;
    this.protocolVersion = version;
    const res = (await this.send('initialize', {
      protocolVersion: version,
      capabilities: {},
      clientInfo: this.clientInfo,
    })) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      instructions?: string;
    };
    if (res.protocolVersion) this.protocolVersion = res.protocolVersion;
    this.serverInfo = res.serverInfo ?? null;
    this.instructions = res.instructions ?? null;
    await this.notify('notifications/initialized');
  }

  /**
   * Base headers for every request.
   */
  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
      ...parseHeaderLines(this.config.headers ?? ''),
    };
    if (this.config.bearerToken) headers.Authorization = `Bearer ${this.config.bearerToken}`;
    if (this.era === 'legacy' && this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  /**
   * Sends a notification (legacy era only; the modern core protocol has none over HTTP).
   * @param method - Notification method.
   */
  private async notify(method: string): Promise<void> {
    await this.post(
      this.config.url,
      this.baseHeaders(),
      JSON.stringify({ jsonrpc: '2.0', method }),
    );
  }

  /**
   * Sends a request in the current era and returns its result.
   * @param method - JSON-RPC method.
   * @param params - Params.
   * @param extraHeaders - Additional headers.
   */
  private async send(
    method: string,
    params: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const headers = { ...this.baseHeaders(), ...extraHeaders };
    let body: Record<string, unknown> = params;
    if (this.era === 'modern') {
      headers['Mcp-Method'] = method;
      const name = (params.name ?? params.uri) as string | undefined;
      if (name !== undefined && ['tools/call', 'resources/read', 'prompts/get'].includes(method)) {
        headers['Mcp-Name'] = encodeMcpHeaderValue(name);
      }
      body = {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': this.protocolVersion,
          'io.modelcontextprotocol/clientInfo': this.clientInfo,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      };
    }

    const res = await this.post(
      this.config.url,
      headers,
      JSON.stringify({ jsonrpc: '2.0', id, method, params: body }),
    );

    if (method === 'initialize') {
      const sid = res.headers['mcp-session-id'];
      if (sid) this.sessionId = sid;
    }

    const contentType = res.headers['content-type'] ?? '';
    let messages: JsonRpcMessage[] = [];
    if (contentType.includes('text/event-stream')) {
      messages = parseSseMessages(res.text);
    } else if (res.text) {
      try {
        const parsed = JSON.parse(res.text) as JsonRpcMessage | JsonRpcMessage[];
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        messages = [];
      }
    }

    const reply = messages.find(m => m.id === id) ?? messages.find(m => m.error && m.id == null);
    if (reply?.error) throw new McpError(reply.error, res.status);
    if (res.status < 200 || res.status >= 300) {
      throw new McpHttpError(res.status, res.text.slice(0, 500));
    }
    if (!reply) throw new McpHttpError(res.status, 'No JSON-RPC response in body');
    return reply.result;
  }
}

/** Thrown for HTTP failures without a JSON-RPC error body. */
export class McpHttpError extends Error {
  /**
   * @param status - HTTP status.
   * @param body - Response body excerpt.
   */
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`MCP HTTP ${status}${body ? `: ${body}` : ''}`);
  }
}

/**
 * Renders a tools/call result as text a model can read.
 * @param result - The call result.
 */
export function formatMcpResult(result: McpCallResult): string {
  if (result.resultType === 'input_required') {
    return 'Error: the MCP server asked for extra user input (elicitation or sampling), which this client does not support yet.';
  }
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text ?? '');
        break;
      case 'image':
      case 'audio':
        parts.push(`[${block.type} ${block.mimeType ?? ''} omitted]`);
        break;
      case 'resource_link':
        parts.push(`[resource] ${block.name ?? ''} ${block.uri ?? ''}`.trim());
        break;
      case 'resource':
        parts.push(block.resource?.text ?? `[resource] ${block.resource?.uri ?? ''}`);
        break;
      default:
        parts.push(JSON.stringify(block));
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.join('\n\n') || '(no content)';
  return result.isError ? `Error: ${text}` : text;
}
