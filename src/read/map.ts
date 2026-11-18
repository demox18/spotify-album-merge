import type { AlbumTrack, MediaKind, PlaylistSummary, SavedAlbum, TrackLike } from '../types';
import { normalizeIsrc } from '../diff/text';

interface Loose {
  [key: string]: unknown;
}

function asRecord(value: unknown): Loose | null {
  return value && typeof value === 'object' ? (value as Loose) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function artistNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const name = asString(asRecord(entry)?.name);
    if (name) names.push(name);
  }
  return names;
}

export function mapEntity(
  entity: unknown,
  extra: { isLocal: boolean; addedAt: string | null },
): TrackLike {
  const record = asRecord(entity);
  if (!record) {
    return {
      uri: '',
      id: null,
      name: 'Non disponibile',
      artists: [],
      primaryArtist: '',
      albumName: '',
      durationMs: 0,
      isrc: null,
      isLocal: extra.isLocal,
      unavailable: true,
      restriction: null,
      kind: 'unknown',
      discNumber: 0,
      trackNumber: 0,
      addedAt: extra.addedAt,
    };
  }
  const type = asString(record.type);
  const kind: MediaKind = type === 'episode' ? 'episode' : type === 'track' ? 'track' : 'unknown';
  const uri = asString(record.uri) ?? '';
  const isLocal = extra.isLocal || uri.startsWith('spotify:local:');
  const restriction = asString(asRecord(record.restrictions)?.reason);
  const playableFlag = record.is_playable;
  const artists = artistNames(record.artists);
  const album = asRecord(record.album);
  const show = asRecord(record.show);
  const unavailable =
    kind === 'track' &&
    !isLocal &&
    (!uri || playableFlag === false || Boolean(restriction));
  return {
    uri,
    id: asString(record.id),
    name: asString(record.name) ?? (kind === 'episode' ? 'Episodio' : 'Senza titolo'),
    artists,
    primaryArtist: artists[0] ?? '',
    albumName: asString(album?.name) ?? asString(show?.name) ?? '',
    durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : 0,
    isrc: normalizeIsrc(asRecord(record.external_ids)?.isrc),
    isLocal,
    unavailable,
    restriction,
    kind: isLocal && kind === 'unknown' ? 'track' : kind,
    discNumber: typeof record.disc_number === 'number' ? record.disc_number : 0,
    trackNumber: typeof record.track_number === 'number' ? record.track_number : 0,
    addedAt: extra.addedAt,
  };
}

export function mapSavedTrack(raw: unknown): TrackLike {
  const record = asRecord(raw);
  return mapEntity(record?.track, {
    isLocal: Boolean(asRecord(record?.track)?.is_local),
    addedAt: asString(record?.added_at),
  });
}

/** Legge `item` (schema 2026) e, se manca, il campo deprecato `track`. */
export function mapPlaylistItem(raw: unknown): TrackLike {
  const record = asRecord(raw);
  const entity = record?.item ?? record?.track ?? null;
  return mapEntity(entity, {
    isLocal: Boolean(record?.is_local) || Boolean(asRecord(entity)?.is_local),
    addedAt: asString(record?.added_at),
  });
}

export function mapAlbumTrack(
  raw: unknown,
  album: { id: string; name: string; artists: string[]; primaryArtist: string; releaseDate: string },
): AlbumTrack {
  const base = mapEntity(raw, {
    isLocal: Boolean(asRecord(raw)?.is_local),
    addedAt: null,
  });
  const artists = base.artists.length > 0 ? base.artists : album.artists;
  return {
    ...base,
    artists,
    primaryArtist: base.primaryArtist || album.primaryArtist,
    albumName: album.name,
    albumId: album.id,
    releaseDate: album.releaseDate,
  };
}

export function mapPlaylistSummary(raw: unknown): PlaylistSummary | null {
  const record = asRecord(raw);
  const id = asString(record?.id);
  const name = typeof record?.name === 'string' ? record.name : null;
  if (!record || !id || name === null) return null;
  const owner = asRecord(record.owner);
  const items = asRecord(record.items);
  const tracks = asRecord(record.tracks);
  const total = typeof items?.total === 'number' ? items.total : typeof tracks?.total === 'number' ? tracks.total : null;
  const publicity = record.public;
  return {
    id,
    name,
    ownerId: asString(owner?.id) ?? '',
    ownerName: asString(owner?.display_name) ?? asString(owner?.id) ?? 'Sconosciuto',
    collaborative: Boolean(record.collaborative),
    public: publicity === true ? true : publicity === false ? false : null,
    trackCount: total,
  };
}

export function mapSavedAlbumShell(raw: unknown): SavedAlbum {
  const record = asRecord(raw);
  const album = asRecord(record?.album);
  if (!album || !asString(album.id)) {
    return {
      id: null,
      name: 'Album non disponibile',
      artists: [],
      primaryArtist: '',
      releaseDate: '',
      unavailable: true,
      tracks: [],
    };
  }
  const artists = artistNames(album.artists);
  return {
    id: asString(album.id),
    name: asString(album.name) ?? 'Senza titolo',
    artists,
    primaryArtist: artists[0] ?? '',
    releaseDate: asString(album.release_date) ?? '',
    unavailable: false,
    tracks: [],
  };
}
