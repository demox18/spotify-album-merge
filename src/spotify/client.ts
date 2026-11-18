import { API_BASE, MAX_RATE_LIMIT_WAIT_MS, PAGE_LIMIT } from '../constants';
import type { AlbumTrack, PlaylistSummary, Progress, SavedAlbum, TrackLike } from '../types';
import { normalizeIsrc } from '../diff/text';
import {
  mapAlbumTrack,
  mapPlaylistItem,
  mapPlaylistSummary,
  mapSavedAlbumShell,
  mapSavedTrack,
} from '../read/map';
import { followPages } from '../read/pages';
import {
  AmbiguousWriteError,
  AuthError,
  HttpError,
  QuotaError,
  RateLimitError,
  classifyHttp,
  isAbortError,
  messageFromBody,
  publicErrorText,
  retryAfterMs,
} from './errors';

export interface AuthGate {
  accessToken(): Promise<string>;
  refresh(): Promise<string>;
}

export interface SpotifyClientOptions {
  auth: AuthGate;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: publicErrorText(text) } };
  }
}

export class SpotifyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private nextSlot = 0;

  constructor(private readonly options: SpotifyClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getMe(): Promise<{ id: string; displayName: string }> {
    const body = (await this.get('/me')) as { id?: string; display_name?: string | null };
    if (!body?.id) throw new HttpError(200, 'GET /me non ha restituito un id.');
    return { id: body.id, displayName: body.display_name || body.id };
  }

  async listPlaylists(): Promise<PlaylistSummary[]> {
    const raw = await followPages<unknown>(
      (url) => this.getPage(url),
      `${API_BASE}/me/playlists?limit=${PAGE_LIMIT}&offset=0`,
      { onPage: this.options.onProgress, signal: this.options.signal, phase: 'Playlist' },
    );
    return raw.map(mapPlaylistSummary).filter((playlist): playlist is PlaylistSummary => playlist !== null);
  }

  async listSavedTracks(): Promise<TrackLike[]> {
    const raw = await followPages<unknown>(
      (url) => this.getPage(url),
      `${API_BASE}/me/tracks?limit=${PAGE_LIMIT}&offset=0`,
      { onPage: this.options.onProgress, signal: this.options.signal, phase: 'Preferiti' },
    );
    return raw.map(mapSavedTrack);
  }

  async listSavedAlbums(): Promise<SavedAlbum[]> {
    const raw = await followPages<unknown>(
      (url) => this.getPage(url),
      `${API_BASE}/me/albums?limit=${PAGE_LIMIT}&offset=0`,
      { onPage: this.options.onProgress, signal: this.options.signal, phase: 'Album salvati' },
    );
    return raw.map(mapSavedAlbumShell);
  }

  async listAlbumTracks(album: SavedAlbum): Promise<AlbumTrack[]> {
    if (!album.id) return [];
    const raw = await followPages<unknown>(
      (url) => this.getPage(url),
      `${API_BASE}/albums/${encodeURIComponent(album.id)}/tracks?limit=${PAGE_LIMIT}&offset=0`,
      {
        onPage: (progress) =>
          this.options.onProgress?.({ ...progress, phase: 'Tracce degli album', detail: album.name }),
        signal: this.options.signal,
        phase: 'Tracce degli album',
      },
    );
    return raw.map((item) =>
      mapAlbumTrack(item, {
        id: album.id as string,
        name: album.name,
        artists: album.artists,
        primaryArtist: album.primaryArtist,
        releaseDate: album.releaseDate,
      }),
    );
  }

  async listPlaylistItems(playlistId: string): Promise<TrackLike[]> {
    const params = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      offset: '0',
      additional_types: 'track,episode',
    });
    const raw = await followPages<unknown>(
      (url) => this.getPage(url),
      `${API_BASE}/playlists/${encodeURIComponent(playlistId)}/items?${params.toString()}`,
      { onPage: this.options.onProgress, signal: this.options.signal, phase: 'Contenuto della playlist' },
    );
    return raw.map(mapPlaylistItem);
  }

  /** GET /tracks/{id} — una richiesta per traccia. Il batch GET /tracks non esiste più in Dev Mode. */
  async getTrackIsrc(id: string): Promise<string | null> {
    const body = (await this.get(`/tracks/${encodeURIComponent(id)}`)) as {
      external_ids?: { isrc?: string };
    };
    return normalizeIsrc(body?.external_ids?.isrc);
  }

  async createPrivatePlaylist(name: string, description: string): Promise<{ id: string }> {
    const body = (await this.post('/me/playlists', {
      name,
      description,
      public: false,
      collaborative: false,
    })) as { id?: string };
    if (!body?.id) throw new HttpError(201, 'POST /me/playlists non ha restituito un id.');
    return { id: body.id };
  }

  async addItems(playlistId: string, uris: string[]): Promise<void> {
    await this.post(`/playlists/${encodeURIComponent(playlistId)}/items`, { uris });
  }

  private get(path: string): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    return this.request('GET', url);
  }

  private post(path: string, body: unknown): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    return this.request('POST', url, body);
  }

  private async getPage(url: string): Promise<{ items: unknown[]; total: number; next: string | null }> {
    const body = (await this.get(url)) as { items?: unknown[]; total?: number; next?: string | null };
    return {
      items: Array.isArray(body?.items) ? body.items : [],
      total: typeof body?.total === 'number' ? body.total : -1,
      next: body?.next ?? null,
    };
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = Math.max(0, this.nextSlot - Date.now());
      if (wait > 0) await this.sleep(wait);
      this.nextSlot = Date.now() + 40;
      return task();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
    return this.schedule(() => this.requestOnce(method, url, body));
  }

  private async requestOnce(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
    const maxAttempts = method === 'GET' ? 4 : 3;
    let refreshed = false;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      if (this.options.signal?.aborted) throw new DOMException('Operazione annullata.', 'AbortError');
      let response: Response;
      try {
        const token = await this.options.auth.accessToken();
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: this.options.signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (method === 'POST') throw new AmbiguousWriteError();
        if (attempt >= maxAttempts) throw new HttpError(0, 'Rete non disponibile durante una lettura.');
        await this.sleep(500 * 2 ** (attempt - 1));
        continue;
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        try {
          await this.options.auth.refresh();
        } catch (error) {
          if (error instanceof AuthError) throw error;
          throw new AuthError('Sessione scaduta. Serve un nuovo accesso.');
        }
        attempt -= 1;
        continue;
      }

      if (response.status === 429) {
        const parsed = await readBody(response);
        const kind = classifyHttp(429, parsed);
        if (kind === 'quota') throw new QuotaError();
        const waitMs = retryAfterMs(response.headers.get('Retry-After'));
        if (method === 'POST') throw new RateLimitError(waitMs);
        if (waitMs > MAX_RATE_LIMIT_WAIT_MS || attempt >= maxAttempts) throw new RateLimitError(waitMs);
        await this.sleep(waitMs);
        continue;
      }

      if (response.status >= 500) {
        if (method === 'POST') throw new AmbiguousWriteError();
        if (attempt >= maxAttempts) throw new HttpError(response.status, 'Errore temporaneo di Spotify.');
        await this.sleep(500 * 2 ** (attempt - 1));
        continue;
      }

      const parsed = response.status === 204 ? null : await readBody(response);
      if (!response.ok) {
        throw new HttpError(response.status, messageFromBody(parsed));
      }
      return parsed;
    }
    throw new HttpError(0, 'Richiesta esaurita senza risposta utile.');
  }
}
