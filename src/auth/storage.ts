import { STORAGE_KEYS } from '../constants';
import type { Journal, Kv, StoredTokens } from '../types';

export function browserKv(): Kv {
  return localStorage;
}

export function readJson<T>(kv: Kv, key: string): T | null {
  const raw = kv.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function readClientId(kv: Kv): string {
  return kv.getItem(STORAGE_KEYS.clientId)?.trim() ?? '';
}

export function writeClientId(kv: Kv, clientId: string): void {
  kv.setItem(STORAGE_KEYS.clientId, clientId.trim());
}

export function readRedirectOverride(kv: Kv): string {
  return kv.getItem(STORAGE_KEYS.redirectUri)?.trim() ?? '';
}

export function writeRedirectOverride(kv: Kv, uri: string): void {
  const trimmed = uri.trim();
  if (!trimmed) kv.removeItem(STORAGE_KEYS.redirectUri);
  else kv.setItem(STORAGE_KEYS.redirectUri, trimmed);
}

export function readTokens(kv: Kv): StoredTokens | null {
  const parsed = readJson<StoredTokens>(kv, STORAGE_KEYS.tokens);
  if (!parsed?.accessToken || !parsed.refreshToken || typeof parsed.expiresAt !== 'number') return null;
  return parsed;
}

export function writeTokens(kv: Kv, tokens: StoredTokens): void {
  kv.setItem(STORAGE_KEYS.tokens, JSON.stringify(tokens));
}

export function clearSession(kv: Kv): void {
  kv.removeItem(STORAGE_KEYS.tokens);
  kv.removeItem(STORAGE_KEYS.pkce);
  kv.removeItem(STORAGE_KEYS.journal);
}

export function readPkce(kv: Kv): { verifier: string; state: string; redirectUri: string } | null {
  const parsed = readJson<{ verifier?: string; state?: string; redirectUri?: string }>(kv, STORAGE_KEYS.pkce);
  if (!parsed?.verifier || !parsed.state || !parsed.redirectUri) return null;
  return { verifier: parsed.verifier, state: parsed.state, redirectUri: parsed.redirectUri };
}

export function writePkce(kv: Kv, value: { verifier: string; state: string; redirectUri: string }): void {
  kv.setItem(STORAGE_KEYS.pkce, JSON.stringify(value));
}

export function clearPkce(kv: Kv): void {
  kv.removeItem(STORAGE_KEYS.pkce);
}

export function readJournal(kv: Kv): Journal {
  const parsed = readJson<Journal>(kv, STORAGE_KEYS.journal);
  if (!parsed || parsed.version !== 1) return { version: 1, liked: null, albums: null };
  return {
    version: 1,
    liked: parsed.liked ?? null,
    albums: parsed.albums ?? null,
  };
}

export function writeJournal(kv: Kv, journal: Journal): void {
  kv.setItem(STORAGE_KEYS.journal, JSON.stringify(journal));
}
