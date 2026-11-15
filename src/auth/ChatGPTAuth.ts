import { Platform, requestUrl } from 'obsidian';
import type { App } from 'obsidian';
import { readSecret, writeSecret } from './secrets';

/**
 * Sign in with ChatGPT, OpenAI's official flow for open-source and local apps
 * (https://developers.openai.com/siwc/token-sharing-open-source). The orchestrator then runs on
 * the user's ChatGPT plan through `POST https://api.openai.com/v1/responses`.
 *
 * - Authorization code with PKCE (S256), `state` and `nonce`, no client secret.
 * - First sign-in uses `client_id=dynamic_agent_client` with `agent_name_hint`; OpenAI registers
 *   the app and returns an issued client id, which every later sign-in, refresh and sign-out uses.
 * - `ext_agent_host_id` is a random `urn:uuid:` kept on this device (not personal data).
 * - The redirect is a loopback listener on `http://127.0.0.1:1455/auth/callback`, started before
 *   the browser opens. That needs Node, so sign-in works on desktop only.
 * - Access tokens last about an hour; refresh tokens rotate on every refresh, so the newest one is
 *   stored and refreshes are serialised.
 * - Tokens live in Obsidian's secret storage, never in the settings file or the vault.
 */
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const PORT = 1455;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/auth/callback`;
const SESSION_KEY = 'chatgpt-sign-in';
const HOST_KEY = 'chatgpt-host-id';
const CLIENT_KEY = 'chatgpt-client-id';

interface ChatGPTSession {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  email?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Minimal Node types used through `window.require` on desktop. */
interface NodeHttp {
  createServer(
    handler: (
      req: { url?: string },
      res: {
        writeHead(code: number, headers: Record<string, string>): void;
        end(body: string): void;
      },
    ) => void,
  ): {
    listen(port: number, host: string, cb: () => void): void;
    on(event: 'error', cb: (error: Error) => void): void;
    close(): void;
  };
}

/** Sign in with ChatGPT for this device. */
export class ChatGPTAuth {
  private refreshing: Promise<string> | null = null;

  /** @param app - Obsidian app. */
  constructor(private app: App) {}

  /** Whether the browser sign-in can run here. */
  static get supported(): boolean {
    return Platform.isDesktopApp;
  }

  /** The current session, if any. */
  get session(): ChatGPTSession | null {
    return readSecret<ChatGPTSession>(this.app, SESSION_KEY);
  }

  /** Whether a session is stored. */
  get signedIn(): boolean {
    return !!this.session?.refreshToken;
  }

  /** The signed-in account's email, when the ID token had one. */
  get email(): string {
    return this.session?.email ?? '';
  }

  /** A persisted per-device id for `ext_agent_host_id`. */
  private hostId(): string {
    const existing = readSecret<string>(this.app, HOST_KEY);
    if (existing) return existing;
    const id = `urn:uuid:${crypto.randomUUID()}`;
    writeSecret(this.app, HOST_KEY, id);
    return id;
  }

  /**
   * Runs the browser sign-in. Resolves when tokens are stored.
   * @param appName - Name OpenAI shows on first sign-in.
   */
  async signIn(appName = 'Voice Agent for Obsidian'): Promise<void> {
    if (!ChatGPTAuth.supported)
      throw new Error('Sign in with ChatGPT needs the desktop app (a local sign-in page).');
    const issued = readSecret<string>(this.app, CLIENT_KEY);
    const clientId = issued || DYNAMIC_CLIENT;
    const verifier = randomString(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomString(32);
    const nonce = randomString(32);

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ext_agent_host_id: this.hostId(),
    });
    if (!issued) params.set('agent_name_hint', appName);
    const previous = this.session;
    if (previous?.idToken) params.set('id_token_hint', previous.idToken);
    if (previous?.email) params.set('login_hint', previous.email);

    // Wrapped in an object: resolving with a bare promise would wait for the callback.
    const { result } = await this.listen(state);
    window.open(`${AUTHORIZE_URL}?${params.toString()}`);
    const { code, clientId: returnedClient } = await result;
    const finalClient = returnedClient || clientId;

    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: finalClient,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    if (finalClient !== DYNAMIC_CLIENT) writeSecret(this.app, CLIENT_KEY, finalClient);
    this.store(finalClient, tokens, previous);
  }

  /**
   * A valid access token, refreshed when it is within two minutes of expiring. Refreshes are
   * serialised because each one rotates the refresh token.
   */
  async accessToken(): Promise<string> {
    const s = this.session;
    if (!s?.refreshToken) throw new Error('Not signed in with ChatGPT. Sign in from settings.');
    if (s.accessToken && s.expiresAt - Date.now() > 120_000) return s.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Forces a refresh now (after a 401). */
  async refresh(): Promise<string> {
    const s = this.session;
    if (!s?.refreshToken) throw new Error('Not signed in with ChatGPT. Sign in from settings.');
    try {
      const tokens = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: s.clientId,
        refresh_token: s.refreshToken,
        resource: RESOURCE,
      });
      return this.store(s.clientId, tokens, s).accessToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid_grant/.test(message)) {
        writeSecret(this.app, SESSION_KEY, null);
        throw new Error('Your ChatGPT sign-in expired. Sign in again from settings.');
      }
      throw error;
    }
  }

  /**
   * Revokes the refresh token and clears local tokens. Returns a message for the user.
   */
  async signOut(): Promise<string> {
    const s = this.session;
    writeSecret(this.app, SESSION_KEY, null);
    if (!s?.refreshToken) return 'Signed out.';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const discovery = await requestUrl({ url: DISCOVERY_URL, throw: false });
        const endpoint = (discovery.json as { revocation_endpoint?: string })?.revocation_endpoint;
        if (!endpoint) break;
        const res = await requestUrl({
          url: endpoint,
          method: 'POST',
          contentType: 'application/x-www-form-urlencoded',
          body: new URLSearchParams({
            token: s.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: s.clientId,
          }).toString(),
          throw: false,
        });
        if (res.status === 200) return 'Signed out of ChatGPT.';
        if (res.status < 500) break;
      } catch {
        // Network error: retry with backoff.
      }
      await new Promise(resolve => window.setTimeout(resolve, 1000 * 2 ** attempt));
    }
    return 'Signed out here, but ChatGPT did not confirm it. To be sure, disconnect the app in ChatGPT Settings.';
  }

  private store(
    clientId: string,
    tokens: TokenResponse,
    previous: ChatGPTSession | null,
  ): ChatGPTSession {
    if (!tokens.access_token) throw new Error('ChatGPT sign-in returned no access token.');
    const session: ChatGPTSession = {
      clientId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || previous?.refreshToken || '',
      idToken: tokens.id_token || previous?.idToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      email: emailFromIdToken(tokens.id_token) || previous?.email,
    };
    writeSecret(this.app, SESSION_KEY, session);
    return session;
  }

  /**
   * Starts the loopback listener and resolves with the code from the callback.
   * @param state - Expected state.
   */
  private listen(state: string): Promise<{ result: Promise<{ code: string; clientId?: string }> }> {
    const http = (window as unknown as { require: (m: string) => NodeHttp }).require('http');
    return new Promise((ready, fail) => {
      let settle: (v: { code: string; clientId?: string }) => void = () => undefined;
      let reject: (e: Error) => void = () => undefined;
      const result = new Promise<{ code: string; clientId?: string }>((res, rej) => {
        settle = res;
        reject = rej;
      });
      const page = (title: string) =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:2em"><h3>${title}</h3><p>You can close this tab and return to Obsidian.</p></body>`;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', REDIRECT_URI);
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const ok = !error && !!code && url.searchParams.get('state') === state;
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(ok ? 'Signed in to Voice Agent' : 'Sign-in did not finish'));
        window.clearTimeout(timer);
        server.close();
        if (error === 'access_denied') reject(new Error('Sign-in was cancelled.'));
        else if (!ok)
          reject(new Error(error ? `Sign-in failed: ${error}` : 'Sign-in failed: bad state.'));
        else settle({ code, clientId: url.searchParams.get('client_id') ?? undefined });
      });
      const timer = window.setTimeout(() => {
        server.close();
        reject(new Error('Sign-in timed out.'));
      }, 300_000);
      server.on('error', error => {
        window.clearTimeout(timer);
        fail(
          new Error(
            `Could not open the local sign-in page on port ${PORT}: ${error.message}. Close other apps using that port and try again.`,
          ),
        );
      });
      server.listen(PORT, '127.0.0.1', () => ready({ result }));
    });
  }
}

/** @param params - Form fields. */
async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await requestUrl({
    url: TOKEN_URL,
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams(params).toString(),
    throw: false,
  });
  let data: TokenResponse = {};
  try {
    data = res.json as TokenResponse;
  } catch {
    // Not JSON.
  }
  if (res.status >= 400 || data.error) {
    throw new Error(
      `ChatGPT sign-in: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`,
    );
  }
  return data;
}

/** @param length - Characters. */
function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, length);
}

/** @param text - Verifier. */
async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64Url(new Uint8Array(digest));
}

/** @param bytes - Bytes. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param idToken - JWT; only the email claim is read, the signature is not checked. */
function emailFromIdToken(idToken?: string): string | undefined {
  const part = idToken?.split('.')[1];
  if (!part) return undefined;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}
