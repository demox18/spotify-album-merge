import { AUTHORIZE_URL, SCOPES, TOKEN_URL } from '../constants';
import type { StoredTokens } from '../types';
import { AuthError, messageFromBody, publicErrorText } from '../spotify/errors';

const VERIFIER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(length: number): string {
  const values = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const value of values) out += VERIFIER_ALPHABET[value % VERIFIER_ALPHABET.length];
  return out;
}

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(digest);
}

export function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

export function redirectRejectionReason(uri: string): string | null {
  if (isAllowedRedirect(uri)) return null;
  try {
    const url = new URL(uri);
    if (url.hostname === 'localhost') {
      return 'Spotify rifiuta localhost. Usa http://127.0.0.1:5173/ in locale, oppure HTTPS quando pubblichi.';
    }
  } catch {
    return 'URI di reindirizzamento non valido.';
  }
  return 'URI non accettato. Serve HTTPS, oppure http://127.0.0.1:PORT (o [::1]) solo in locale.';
}

export function appBaseUrl(href = globalThis.location?.href ?? 'http://127.0.0.1:5173/'): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  let path = url.pathname;
  if (path.endsWith('/index.html')) path = path.slice(0, -'index.html'.length);
  if (!path.endsWith('/')) path += '/';
  url.pathname = path;
  return url.href;
}

export interface PkcePair {
  verifier: string;
  state: string;
}

export function createPkcePair(): PkcePair {
  return { verifier: randomString(64), state: randomString(32) };
}

export async function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  showDialog?: boolean;
}): Promise<string> {
  const reason = redirectRejectionReason(input.redirectUri);
  if (reason) throw new AuthError(reason);
  if (!/^[0-9a-f]{32}$/i.test(input.clientId)) {
    throw new AuthError('Il Client ID Spotify è una stringa di 32 caratteri esadecimali. Non va incollato il Client Secret.');
  }
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('state', input.state);
  url.searchParams.set('scope', SCOPES.join(' '));
  if (input.showDialog) url.searchParams.set('show_dialog', 'true');
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams, fetchImpl: typeof fetch): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new AuthError('Non riesco a raggiungere accounts.spotify.com. Controlla la rete e riprova.');
  }
  const text = await response.text();
  let parsed: TokenResponse = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as TokenResponse;
    } catch {
      throw new AuthError(`Risposta non valida dal token endpoint (${response.status}).`);
    }
  }
  if (!response.ok) {
    const detail = parsed.error_description || parsed.error || messageFromBody(parsed);
    throw new AuthError(publicErrorText(detail || `Scambio token fallito (${response.status}).`));
  }
  return parsed;
}

export async function exchangeCode(input: {
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  const parsed = await postToken(body, input.fetchImpl ?? fetch);
  if (!parsed.access_token || !parsed.refresh_token || typeof parsed.expires_in !== 'number') {
    throw new AuthError('Spotify non ha restituito access token e refresh token.');
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: Date.now() + parsed.expires_in * 1000,
    scope: parsed.scope ?? '',
  };
}

export async function refreshTokens(input: {
  clientId: string;
  tokens: StoredTokens;
  fetchImpl?: typeof fetch;
}): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.tokens.refreshToken,
    client_id: input.clientId,
  });
  if (body.has('client_secret')) body.delete('client_secret');
  const parsed = await postToken(body, input.fetchImpl ?? fetch);
  if (!parsed.access_token || typeof parsed.expires_in !== 'number') {
    throw new AuthError('Rinnovo del token fallito. Serve un nuovo accesso.');
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || input.tokens.refreshToken,
    expiresAt: Date.now() + parsed.expires_in * 1000,
    scope: parsed.scope || input.tokens.scope,
  };
}

export function tokenNeedsRefresh(expiresAt: number, now = Date.now(), skewMs = 60_000): boolean {
  return now >= expiresAt - skewMs;
}

export function grantedScopes(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}
