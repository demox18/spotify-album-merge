import type { Library, Progress, SavedAlbum, TrackLike } from '../types';

/** Solo letture. Nessuna creazione e nessuna aggiunta. */
export interface LibraryReader {
  listPlaylists(): Promise<Library['playlists']>;
  listSavedTracks(): Promise<TrackLike[]>;
  listSavedAlbums(): Promise<SavedAlbum[]>;
  listAlbumTracks(album: SavedAlbum): Promise<Library['albums'][number]['tracks']>;
  listPlaylistItems(playlistId: string): Promise<TrackLike[]>;
  getTrackIsrc(id: string): Promise<string | null>;
}

export async function collectLibrary(
  reader: LibraryReader,
  hooks?: { onProgress?: (progress: Progress) => void; signal?: AbortSignal },
): Promise<Library> {
  const playlists = await reader.listPlaylists();
  throwIfAborted(hooks?.signal);
  const liked = await reader.listSavedTracks();
  throwIfAborted(hooks?.signal);
  const albums = await reader.listSavedAlbums();
  let index = 0;
  for (const album of albums) {
    index += 1;
    throwIfAborted(hooks?.signal);
    hooks?.onProgress?.({
      phase: 'Tracce degli album',
      done: index,
      total: albums.length,
      detail: album.name,
    });
    if (!album.id || album.unavailable) continue;
    album.tracks = await reader.listAlbumTracks(album);
  }
  return { playlists, liked, albums };
}

export interface IsrcEnrichment {
  requested: number;
  found: number;
  failed: number;
  stoppedEarly: boolean;
}

/**
 * Passo opzionale. GET /albums/{id}/tracks non include l'ISRC e il batch GET /tracks
 * non è disponibile: una richiesta per traccia, in serie, annullabile.
 */
export async function enrichAlbumIsrcs(
  reader: LibraryReader,
  albums: SavedAlbum[],
  hooks?: {
    onProgress?: (progress: Progress) => void;
    signal?: AbortSignal;
    pauseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<IsrcEnrichment> {
  const pending = new Map<string, Library['albums'][number]['tracks']>();
  for (const album of albums) {
    for (const track of album.tracks) {
      if (!track.id || track.isrc || track.isLocal) continue;
      const list = pending.get(track.id) ?? [];
      list.push(track);
      pending.set(track.id, list);
    }
  }
  const ids = [...pending.keys()];
  const result: IsrcEnrichment = { requested: 0, found: 0, failed: 0, stoppedEarly: false };
  const sleep = hooks?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pauseMs = hooks?.pauseMs ?? 200;
  for (const id of ids) {
    throwIfAborted(hooks?.signal);
    result.requested += 1;
    hooks?.onProgress?.({
      phase: 'ISRC degli album',
      done: result.requested,
      total: ids.length,
      detail: pending.get(id)?.[0]?.name,
    });
    try {
      const isrc = await reader.getTrackIsrc(id);
      if (isrc) {
        result.found += 1;
        for (const track of pending.get(id) ?? []) track.isrc = isrc;
      }
    } catch (error) {
      result.failed += 1;
      const name = error instanceof Error ? error.name : '';
      if (name === 'QuotaError' || name === 'RateLimitError' || name === 'AuthError') {
        result.stoppedEarly = true;
        throw error;
      }
    }
    if (pauseMs > 0 && result.requested < ids.length) await sleep(pauseMs);
  }
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operazione annullata.', 'AbortError');
}
