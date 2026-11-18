import { describe, expect, it } from 'vitest';
import { appBaseUrl, isAllowedRedirect, redirectRejectionReason, refreshTokens } from '../src/auth/pkce';
import { classifyHttp, retryAfterMs } from '../src/spotify/errors';
import { SpotifyClient } from '../src/spotify/client';
import { QuotaError, AmbiguousWriteError } from '../src/spotify/errors';
import { reducePages } from '../src/read/pages';
import { jsonResponse } from './support';

function client(fetchImpl: typeof fetch) {
  return new SpotifyClient({
    fetchImpl,
    sleep: async () => undefined,
    auth: {
      accessToken: async () => 'token-di-test',
      refresh: async () => 'token-di-test',
    },
  });
}

describe('client Spotify', () => {
  it('distingue la quota dal limite di frequenza', () => {
    expect(classifyHttp(429, { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } })).toBe('quota');
    expect(classifyHttp(429, { error: { status: 429, message: 'Too many requests' } })).toBe('rate');
    expect(retryAfterMs('2')).toBe(2000);
  });

  it('non ritenta la quota e non mette il token nell’URL', async () => {
    let calls = 0;
    const api = client(async (url) => {
      calls += 1;
      expect(String(url)).not.toContain('token-di-test');
      return jsonResponse(429, { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } });
    });
    await expect(api.getMe()).rejects.toBeInstanceOf(QuotaError);
    expect(calls).toBe(1);
  });

  it('ritenta una lettura 500 e non una scrittura 500', async () => {
    let gets = 0;
    const reading = client(async () => {
      gets += 1;
      if (gets === 1) return jsonResponse(500, {});
      return jsonResponse(200, { id: 'ada', display_name: 'Ada' });
    });
    await expect(reading.getMe()).resolves.toEqual({ id: 'ada', displayName: 'Ada' });
    expect(gets).toBe(2);

    let posts = 0;
    const writing = client(async (url, init) => {
      posts += 1;
      expect(String(url)).toBe('https://api.spotify.com/v1/playlists/abc/items');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ uris: ['spotify:track:a'] });
      return jsonResponse(500, {});
    });
    await expect(writing.addItems('abc', ['spotify:track:a'])).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(posts).toBe(1);
  });

  it('crea la playlist con POST /me/playlists e public false', async () => {
    const api = client(async (url, init) => {
      expect(String(url)).toBe('https://api.spotify.com/v1/me/playlists');
      expect(JSON.parse(String(init?.body))).toEqual({
        name: 'Dagli album · non nei Preferiti',
        description: 'desc',
        public: false,
        collaborative: false,
      });
      return jsonResponse(201, { id: 'pl1' });
    });
    await expect(api.createPrivatePlaylist('Dagli album · non nei Preferiti', 'desc')).resolves.toEqual({ id: 'pl1' });
  });

  it('segue tutte le pagine di /me/playlists', async () => {
    const api = client(async (url) => {
      const href = String(url);
      if (href.includes('offset=0')) {
        return jsonResponse(200, {
          items: [{ id: 'a', name: 'Uno', owner: { id: 'me', display_name: 'Ada' }, collaborative: false, public: false, items: { total: 2 } }],
          total: 2,
          next: 'https://api.spotify.com/v1/me/playlists?offset=1&limit=50',
        });
      }
      return jsonResponse(200, {
        items: [{ id: 'b', name: 'Due', owner: { id: 'me', display_name: 'Ada' }, collaborative: true, public: true, items: { total: 8 } }],
        total: 2,
        next: null,
      });
    });
    const playlists = await api.listPlaylists();
    expect(playlists.map((item) => item.id)).toEqual(['a', 'b']);
    expect(playlists[1]?.collaborative).toBe(true);
    expect(playlists[1]?.trackCount).toBe(8);
  });

  it('il rinnovo PKCE non manda il client secret e conserva il refresh token', async () => {
    const next = await refreshTokens({
      clientId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tokens: { accessToken: 'vecchio', refreshToken: 'resto', expiresAt: 0, scope: 'user-library-read' },
      fetchImpl: async (_url, init) => {
        const body = init?.body as URLSearchParams;
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('client_id')).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        expect(body.get('client_secret')).toBeNull();
        expect(String(init?.headers && JSON.stringify(init.headers))).not.toContain('Basic');
        return jsonResponse(200, { access_token: 'nuovo', expires_in: 3600, scope: 'user-library-read' });
      },
    });
    expect(next.accessToken).toBe('nuovo');
    expect(next.refreshToken).toBe('resto');
  });

  it('accetta solo redirect HTTPS o loopback', () => {
    expect(isAllowedRedirect('http://127.0.0.1:5173/')).toBe(true);
    expect(isAllowedRedirect('https://esempio.altervista.org/scaffale/')).toBe(true);
    expect(isAllowedRedirect('http://localhost:5173/')).toBe(false);
    expect(redirectRejectionReason('http://localhost:5173/')).toMatch(/127\.0\.0\.1/);
    expect(appBaseUrl('http://127.0.0.1:5173/index.html?code=1#x')).toBe('http://127.0.0.1:5173/');
    expect(appBaseUrl('https://esempio.altervista.org/scaffale/index.html')).toBe('https://esempio.altervista.org/scaffale/');
  });

  it('segna incompleta una sequenza di pagine che non torna il totale', () => {
    const reduced = reducePages([
      { items: [1, 2], total: 5, next: 'next' },
      { items: [3], total: 5, next: null },
    ]);
    expect(reduced.complete).toBe(false);
  });
});
