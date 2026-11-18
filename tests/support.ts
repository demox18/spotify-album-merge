import type { AlbumTrack, Kv, PlaylistSummary, TrackLike } from '../src/types';

export function memoryKv(): Kv {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

export function track(partial: Partial<TrackLike> & { uri: string }): TrackLike {
  return {
    id: partial.id ?? partial.uri.split(':').at(-1) ?? null,
    name: partial.name ?? partial.uri,
    artists: partial.artists ?? [partial.primaryArtist ?? 'Artista'],
    primaryArtist: partial.primaryArtist ?? partial.artists?.[0] ?? 'Artista',
    albumName: partial.albumName ?? 'Album',
    durationMs: partial.durationMs ?? 180_000,
    isrc: partial.isrc ?? null,
    isLocal: partial.isLocal ?? false,
    unavailable: partial.unavailable ?? false,
    restriction: partial.restriction ?? null,
    kind: partial.kind ?? 'track',
    discNumber: partial.discNumber ?? 1,
    trackNumber: partial.trackNumber ?? 1,
    addedAt: partial.addedAt ?? null,
    uri: partial.uri,
  };
}

export function albumTrack(partial: Partial<AlbumTrack> & { uri: string }): AlbumTrack {
  return {
    ...track(partial),
    albumId: partial.albumId ?? 'album',
    releaseDate: partial.releaseDate ?? '2000',
    albumName: partial.albumName ?? 'Album',
  };
}

export function playlist(partial: Partial<PlaylistSummary> & { id: string; name: string }): PlaylistSummary {
  return {
    ownerId: partial.ownerId ?? 'me',
    ownerName: partial.ownerName ?? 'Io',
    collaborative: partial.collaborative ?? false,
    public: partial.public ?? false,
    trackCount: partial.trackCount ?? 0,
    id: partial.id,
    name: partial.name,
  };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
