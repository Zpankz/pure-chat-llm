import { Notice, requestUrl } from 'obsidian';
import type PureChatLLM from '../main';
import type { McpOAuthState, McpServerConfig } from '../types';

/**
 * OAuth 2.1 sign-in for remote MCP servers that require it (the MCP authorization spec):
 *
 * 1. Discovery: the server's protected-resource metadata (RFC 9728), found from the
 *    `resource_metadata` parameter of a 401 `WWW-Authenticate` header or the well-known URL,
 *    names the authorization server; its metadata comes from RFC 8414 (or OpenID discovery).
 * 2. Client: a client id from settings, or dynamic client registration (RFC 7591).
 * 3. Authorization code with PKCE (S256) and the `resource` parameter (RFC 8707), opened in the
 *    browser and returned to `obsidian://pure-chat-llm-oauth`.
 * 4. Tokens are stored with the server and refreshed before they expire.
 *
 * Stateless (2026-07-28) and session-based (2025-11-25) servers use the same flow; the token is
 * sent as `Authorization: Bearer`. Requests use Obsidian's `requestUrl`, so no CORS is needed.
 */

export const OAUTH_ACTION = 'pure-chat-llm-oauth';
export const OAUTH_REDIRECT_URI = `obsidian://${OAUTH_ACTION}`;

interface PendingSignIn {
  resolve: (params: Record<string, string>) => void;
  reject: (error: Error) => void;
  timer: number;
}

const pending = new Map<string, PendingSignIn>();

/**
 * Called by the plugin's protocol handler with the redirect's query parameters.
 * @param params - Query parameters from obsidian://pure-chat-llm-oauth.
 */
export function handleOAuthCallback(params: Record<string, string>): void {
  const entry = params.state ? pending.get(params.state) : undefined;
  if (!entry) {
    new Notice('MCP sign-in: this sign-in link has expired or was not started here.');
    return;
  }
  pending.delete(params.state);
  window.clearTimeout(entry.timer);
  if (params.error) entry.reject(new Error(params.error_description || params.error));
  else entry.resolve(params);
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await requestUrl({
      url,
      method: 'GET',
      headers: { Accept: 'application/json' },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return res.json as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Reads `resource_metadata` from a `WWW-Authenticate` header.
 * @param header - Header value.
 */
export function resourceMetadataFromHeader(header: string | undefined): string | null {
  const match = /resource_metadata="?([^",\s]+)"?/i.exec(header ?? '');
  return match ? match[1] : null;
}

/**
 * Candidate well-known URLs: with the resource's path inserted, then at the origin.
 * @param url - Resource or issuer URL.
 * @param suffix - Well-known name.
 */
function wellKnown(url: string, suffix: string): string[] {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  const out = [`${u.origin}/.well-known/${suffix}${path}`];
  if (path) out.push(`${u.origin}/.well-known/${suffix}`);
  return out;
}

/**
 * Finds the authorization server for an MCP server.
 * @param server - Server config.
 */
async function discover(server: McpServerConfig): Promise<{
  resource: string;
  scopes: string[];
  issuer: string;
  meta: Record<string, unknown>;
}> {
  // Probe the server to get WWW-Authenticate.
  let headerUrl: string | null = null;
  try {
    const probe = await requestUrl({
      url: server.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
      throw: false,
    });
    const auth = Object.entries(probe.headers).find(
      ([k]) => k.toLowerCase() === 'www-authenticate',
    );
    headerUrl = resourceMetadataFromHeader(auth?.[1]);
  } catch {
    // Discovery below still works without the header.
  }

  let prm: Record<string, unknown> | null = null;
  for (const url of [
    ...(headerUrl ? [headerUrl] : []),
    ...wellKnown(server.url, 'oauth-protected-resource'),
  ]) {
    prm = await getJson(url);
    if (prm) break;
  }
  const servers = (prm?.authorization_servers as string[] | undefined) ?? [];
  // Older servers without RFC 9728 act as their own authorization server.
  const issuer = servers[0] ?? new URL(server.url).origin;

  let meta: Record<string, unknown> | null = null;
  for (const url of [
    ...wellKnown(issuer, 'oauth-authorization-server'),
    ...wellKnown(issuer, 'openid-configuration'),
  ]) {
    meta = await getJson(url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }
  if (!meta) throw new Error(`Could not find the sign-in server for ${server.url}.`);
  return {
    resource: (prm?.resource as string | undefined) ?? server.url,
    scopes: (prm?.scopes_supported as string[] | undefined) ?? [],
    issuer,
    meta,
  };
}

/**
 * Registers the plugin as a public client (RFC 7591).
 * @param endpoint - Registration endpoint.
 */
async function register(endpoint: string): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await requestUrl({
    url: endpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Pure Chat LLM (Obsidian)',
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Client registration failed (${res.status}). Enter a client id for this server in settings.`,
    );
  }
  const body = res.json as { client_id?: string; client_secret?: string };
  if (!body.client_id) throw new Error('Client registration returned no client id.');
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/**
 * Posts to the token endpoint.
 * @param state - OAuth state of the server.
 * @param params - Grant parameters.
 */
async function tokenRequest(state: McpOAuthState, params: Record<string, string>): Promise<void> {
  const body = new URLSearchParams({
    client_id: state.clientId,
    ...(state.clientSecret ? { client_secret: state.clientSecret } : {}),
    ...(state.resource ? { resource: state.resource } : {}),
    ...params,
  });
  const res = await requestUrl({
    url: state.tokenEndpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    throw: false,
  });
  const json = (res.json ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (res.status < 200 || res.status >= 300 || !json.access_token) {
    throw new Error(
      json.error_description || json.error || `Token request failed (${res.status}).`,
    );
  }
  state.accessToken = json.access_token;
  if (json.refresh_token) state.refreshToken = json.refresh_token;
  state.expiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : 0;
}

/**
 * Runs the full browser sign-in for a server and stores its tokens.
 * @param plugin - Plugin (settings and saving).
 * @param server - The server's settings entry (updated in place).
 */
export async function signIn(plugin: PureChatLLM, server: McpServerConfig): Promise<void> {
  const found = await discover(server);
  const meta = found.meta;
  const existing = server.oauth;
  let clientId = existing?.clientId ?? '';
  let clientSecret = existing?.clientSecret;
  if (!clientId) {
    const endpoint = meta.registration_endpoint as string | undefined;
    if (!endpoint) {
      throw new Error('This server needs a client id. Enter one in the server settings.');
    }
    ({ clientId, clientSecret } = await register(endpoint));
  }

  const verifier = randomString(48);
  const challenge = base64Url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const stateParam = randomString(16);
  const scope = existing?.scope || found.scopes.join(' ');
  const authorize = new URL(meta.authorization_endpoint as string);
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: stateParam,
    resource: found.resource,
    ...(scope ? { scope } : {}),
  };
  for (const [k, v] of Object.entries(query)) authorize.searchParams.set(k, v);

  const callback = new Promise<Record<string, string>>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(stateParam);
      reject(new Error('Sign-in timed out.'));
    }, 5 * 60_000);
    pending.set(stateParam, { resolve, reject, timer });
  });
  window.open(authorize.toString());
  new Notice(`Finish signing in to ${server.name} in your browser.`);
  const params = await callback;
  if (!params.code) throw new Error('The sign-in returned no code.');

  const state: McpOAuthState = {
    clientId,
    clientSecret,
    scope,
    resource: found.resource,
    issuer: found.issuer,
    tokenEndpoint: meta.token_endpoint as string,
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
  };
  await tokenRequest(state, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: verifier,
  });
  server.oauth = state;
  await plugin.saveSettings();
  new Notice(`Signed in to ${server.name}.`);
}

/**
 * Refreshes a server's access token when it expires within a minute (or when forced).
 * Returns false when the server needs a new sign-in.
 * @param plugin - Plugin.
 * @param server - Server settings entry.
 * @param force - Refresh even if not expiring (after a 401).
 */
export async function ensureFreshToken(
  plugin: PureChatLLM,
  server: McpServerConfig,
  force = false,
): Promise<boolean> {
  const state = server.oauth;
  if (server.auth !== 'oauth') return true;
  if (!state?.accessToken) return false;
  if (!force && (!state.expiresAt || state.expiresAt - Date.now() > 60_000)) return true;
  if (!state.refreshToken) return false;
  try {
    await tokenRequest(state, { grant_type: 'refresh_token', refresh_token: state.refreshToken });
    await plugin.saveSettings();
    return true;
  } catch {
    return false;
  }
}

/**
 * The bearer token to send for a server: the OAuth access token or the static token.
 * @param server - Server config.
 */
export function bearerFor(server: McpServerConfig): string {
  return server.auth === 'oauth' ? (server.oauth?.accessToken ?? '') : server.bearerToken;
}
