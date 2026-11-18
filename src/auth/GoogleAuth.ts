import { Platform, requestUrl } from 'obsidian';
import type { App } from 'obsidian';
import { randomString, sha256Base64Url } from './ChatGPTAuth';
import { readSecret, writeSecret } from './secrets';

/**
 * Sign in with Google for the Gemini API, following Google's own OAuth quickstart
 * (https://ai.google.dev/gemini-api/docs/oauth):
 *
 * - The user creates a Desktop app OAuth client in their own Google Cloud project, with the
 *   Generative Language API enabled and the consent screen set up (test users added). Google
 *   offers no shared client for third-party apps, so the plugin cannot ship one.
 * - Installed-app flow: authorization code with PKCE (S256) and `state`, redirected to a loopback
 *   listener on `http://127.0.0.1:<random port>`, which needs Node, so desktop only.
 * - Calls send `Authorization: Bearer <token>` and `x-goog-user-project: <project id>`, so usage
 *   is billed to that Cloud project, not to a Google AI Pro or Ultra subscription.
 * - The client secret of a Desktop client is not confidential (Google says so), but it is kept in
 *   secret storage with the tokens anyway, so nothing lands in the synced settings file.
 */
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** The scope Google's quickstart requests for the Gemini API. */
export const GOOGLE_GEMINI_SCOPE = 'https://www.googleapis.com/auth/generative-language.retriever';
const CLIENT_KEY = 'google-oauth-client';
const SESSION_KEY = 'google-sign-in';

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
}

interface GoogleSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface LoopbackServer {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  on(event: 'error', cb: (error: Error) => void): void;
  close(): void;
}

interface NodeHttpServer {
  createServer(
    handler: (
      req: { url?: string },
      res: {
        writeHead(code: number, headers: Record<string, string>): void;
        end(body: string): void;
      },
    ) => void,
  ): LoopbackServer;
}

/** Google sign-in for Gemini on this device. */
export class GoogleAuth {
  private refreshing: Promise<string> | null = null;

  /** @param app - Obsidian app. */
  constructor(private app: App) {}

  /** Whether the browser sign-in can run here. */
  static get supported(): boolean {
    return Platform.isDesktopApp;
  }

  /** The OAuth client the user created, if saved. */
  get client(): GoogleClientConfig | null {
    return readSecret<GoogleClientConfig>(this.app, CLIENT_KEY);
  }

  /** @param config - Client to save (null clears it). */
  setClient(config: GoogleClientConfig | null): void {
    writeSecret(this.app, CLIENT_KEY, config);
  }

  private get session(): GoogleSession | null {
    return readSecret<GoogleSession>(this.app, SESSION_KEY);
  }

  /** Whether tokens are stored. */
  get signedIn(): boolean {
    return !!this.session?.refreshToken && !!this.client?.projectId;
  }

  /** Cloud project the calls are billed to. */
  get projectId(): string {
    return this.client?.projectId ?? '';
  }

  /** Runs the browser sign-in. Resolves when tokens are stored. */
  async signIn(): Promise<void> {
    if (!GoogleAuth.supported)
      throw new Error('Google sign-in needs the desktop app (a local sign-in page).');
    const client = this.client;
    if (!client?.clientId || !client.clientSecret || !client.projectId)
      throw new Error('Add your OAuth client ID, client secret and project ID first.');
    const verifier = randomString(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomString(32);
    const { result, redirectUri } = await this.listen(state);
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_GEMINI_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    window.open(`${AUTHORIZE_URL}?${params.toString()}`);
    const code = await result;
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (!tokens.refresh_token)
      throw new Error('Google returned no refresh token. Remove the app’s access and try again.');
    this.store(tokens, null);
  }

  /** A valid access token, refreshed within two minutes of expiry. */
  async accessToken(): Promise<string> {
    const s = this.session;
    if (!s?.refreshToken) throw new Error('Not signed in with Google. Sign in from settings.');
    if (s.accessToken && s.expiresAt - Date.now() > 120_000) return s.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Forces a refresh (after a 401). */
  async refresh(): Promise<string> {
    const s = this.session;
    const client = this.client;
    if (!s?.refreshToken || !client)
      throw new Error('Not signed in with Google. Sign in from settings.');
    try {
      const tokens = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: s.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      });
      return this.store(tokens, s).accessToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid_grant/.test(message)) {
        writeSecret(this.app, SESSION_KEY, null);
        throw new Error(
          'Your Google sign-in expired (test-mode projects expire sign-ins after 7 days). Sign in again from settings.',
        );
      }
      throw error;
    }
  }

  /** Revokes the token and clears it here. */
  async signOut(): Promise<string> {
    const s = this.session;
    writeSecret(this.app, SESSION_KEY, null);
    if (!s?.refreshToken) return 'Signed out.';
    try {
      const res = await requestUrl({
        url: REVOKE_URL,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({ token: s.refreshToken }).toString(),
        throw: false,
      });
      if (res.status === 200) return 'Signed out of Google.';
    } catch {
      // Fall through.
    }
    return 'Signed out here, but Google did not confirm it. To be sure, remove the app at myaccount.google.com/permissions.';
  }

  private store(tokens: TokenResponse, previous: GoogleSession | null): GoogleSession {
    if (!tokens.access_token) throw new Error('Google sign-in returned no access token.');
    const session: GoogleSession = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || previous?.refreshToken || '',
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope ?? previous?.scope ?? GOOGLE_GEMINI_SCOPE,
    };
    writeSecret(this.app, SESSION_KEY, session);
    return session;
  }

  /**
   * Starts a loopback listener on a free port and resolves once it is listening.
   * @param state - Expected state.
   */
  private listen(state: string): Promise<{ result: Promise<string>; redirectUri: string }> {
    const http = (window as unknown as { require: (m: string) => NodeHttpServer }).require('http');
    return new Promise((ready, fail) => {
      let settle: (code: string) => void = () => undefined;
      let reject: (e: Error) => void = () => undefined;
      const result = new Promise<string>((res, rej) => {
        settle = res;
        reject = rej;
      });
      const page = (title: string) =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:2em"><h3>${title}</h3><p>You can close this tab and return to Obsidian.</p></body>`;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (!error && !code) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const ok = !error && !!code && url.searchParams.get('state') === state;
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(ok ? 'Signed in to Voice Agent' : 'Sign-in did not finish'));
        window.clearTimeout(timer);
        server.close();
        if (error === 'access_denied') reject(new Error('Sign-in was cancelled.'));
        else if (!ok)
          reject(new Error(error ? `Sign-in failed: ${error}` : 'Sign-in failed: bad state.'));
        else settle(code);
      });
      const timer = window.setTimeout(() => {
        server.close();
        reject(new Error('Sign-in timed out.'));
      }, 300_000);
      server.on('error', error => {
        window.clearTimeout(timer);
        fail(new Error(`Could not open the local sign-in page: ${error.message}`));
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        ready({ result, redirectUri: `http://127.0.0.1:${port}` });
      });
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
      `Google sign-in: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`,
    );
  }
  return data;
}
