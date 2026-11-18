import type { AlbumDiff, AlbumTrack, AlternativeVersion, IsrcMatch, SavedAlbum, TrackLike } from '../types';
import { artistKey, baseTitle, compareIt, durationsAreClose, isEpisode, isLocal, isSpotifyTrackUri } from './text';

export interface AlbumDiffInput {
  albums: SavedAlbum[];
  liked: TrackLike[];
  playlistItems: TrackLike[];
  /**
   * Default true: stesso ISRC e URI diverso resta nel set, ma è elencato.
   * Il toggle lo esclude. Senza ISRC (tracce semplificate degli album) non scatta.
   */
  includeIsrcMatches?: boolean;
}

function compareAlbumTracks(a: AlbumTrack, b: AlbumTrack): number {
  const artist = compareIt(a.primaryArtist, b.primaryArtist);
  if (artist !== 0) return artist;
  const album = compareIt(a.albumName, b.albumName);
  if (album !== 0) return album;
  const date = a.releaseDate.localeCompare(b.releaseDate);
  if (date !== 0) return date;
  if (a.discNumber !== b.discNumber) return a.discNumber - b.discNumber;
  if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
  return a.uri.localeCompare(b.uri);
}

function dedupeSorted(tracks: AlbumTrack[]): AlbumTrack[] {
  const seen = new Set<string>();
  const unique: AlbumTrack[] = [];
  for (const track of tracks) {
    if (track.uri) {
      if (seen.has(track.uri)) continue;
      seen.add(track.uri);
    }
    unique.push(track);
  }
  return unique;
}

function alternativeReason(albumTrack: AlbumTrack, liked: TrackLike): string {
  const albumFold = albumTrack.name.toLocaleLowerCase('it');
  const likedFold = liked.name.toLocaleLowerCase('it');
  const markers = ['live', 'remix', 'acoustic', 'acustic', 'remaster', 'demo', 'instrumental', 'radio'];
  const hit = markers.find((marker) => albumFold.includes(marker) !== likedFold.includes(marker) && (albumFold.includes(marker) || likedFold.includes(marker)));
  if (hit) return `possibile versione alternativa (${hit})`;
  return 'possibile versione alternativa';
}

export function diffAlbumPlaylist(input: AlbumDiffInput): AlbumDiff {
  const includeIsrcMatches = input.includeIsrcMatches ?? true;
  const unavailableAlbums = input.albums.filter((album) => album.unavailable || !album.id);
  const flat: AlbumTrack[] = [];
  for (const album of input.albums) {
    if (album.unavailable || !album.id) continue;
    flat.push(...album.tracks);
  }

  const local: AlbumTrack[] = [];
  const unavailable: AlbumTrack[] = [];
  const catalog: AlbumTrack[] = [];
  for (const track of flat) {
    if (isEpisode(track)) continue;
    if (isLocal(track)) {
      local.push(track);
      continue;
    }
    if (track.unavailable || !isSpotifyTrackUri(track.uri)) {
      unavailable.push(track);
      continue;
    }
    catalog.push(track);
  }

  const uniqueCatalog = dedupeSorted([...catalog].sort(compareAlbumTracks));
  const uniqueLocal = dedupeSorted([...local].sort(compareAlbumTracks));
  const uniqueUnavailable = dedupeSorted([...unavailable].sort(compareAlbumTracks));

  const likedByUri = new Map<string, TrackLike>();
  const likedByIsrc = new Map<string, TrackLike[]>();
  const likedByTitle = new Map<string, TrackLike[]>();
  for (const track of input.liked) {
    if (isSpotifyTrackUri(track.uri)) likedByUri.set(track.uri, track);
    if (track.isrc) {
      const bucket = likedByIsrc.get(track.isrc) ?? [];
      bucket.push(track);
      likedByIsrc.set(track.isrc, bucket);
    }
    const title = baseTitle(track.name);
    const artist = artistKey(track.primaryArtist);
    if (title && artist && isSpotifyTrackUri(track.uri)) {
      const key = `${artist}\u0000${title}`;
      const bucket = likedByTitle.get(key) ?? [];
      bucket.push(track);
      likedByTitle.set(key, bucket);
    }
  }

  const present = new Set<string>();
  const playlistEpisodes: TrackLike[] = [];
  const playlistLocal: TrackLike[] = [];
  const playlistDuplicateUris: string[] = [];
  for (const item of input.playlistItems) {
    if (isEpisode(item)) {
      playlistEpisodes.push(item);
      continue;
    }
    if (isLocal(item)) {
      playlistLocal.push(item);
      if (item.uri) present.add(item.uri);
      continue;
    }
    if (!item.uri) continue;
    if (present.has(item.uri)) playlistDuplicateUris.push(item.uri);
    present.add(item.uri);
  }

  const excludedLiked: AlbumTrack[] = [];
  const ambiguousIsrc: IsrcMatch[] = [];
  const heldBackByIsrc: AlbumTrack[] = [];
  const includedDespiteIsrc: AlbumTrack[] = [];
  const computedSet: AlbumTrack[] = [];
  const alternatives: AlternativeVersion[] = [];

  for (const track of uniqueCatalog) {
    if (likedByUri.has(track.uri)) {
      excludedLiked.push(track);
      continue;
    }
    const isrcMatches = (track.isrc ? likedByIsrc.get(track.isrc) ?? [] : []).filter(
      (liked) => liked.uri !== track.uri,
    );
    if (isrcMatches.length > 0) {
      ambiguousIsrc.push({ liked: track, matches: isrcMatches });
      if (!includeIsrcMatches) {
        heldBackByIsrc.push(track);
        continue;
      }
      includedDespiteIsrc.push(track);
    } else {
      const title = baseTitle(track.name);
      const artist = artistKey(track.primaryArtist);
      if (title && artist) {
        const similar = (likedByTitle.get(`${artist}\u0000${title}`) ?? []).filter(
          (liked) =>
            liked.uri !== track.uri &&
            durationsAreClose(track.durationMs, liked.durationMs) &&
            !(track.isrc && liked.isrc && track.isrc === liked.isrc),
        );
        if (similar[0]) {
          alternatives.push({
            albumTrack: track,
            liked: similar[0],
            reason: alternativeReason(track, similar[0]),
          });
        }
      }
    }
    computedSet.push(track);
  }

  const computedUris = new Set(computedSet.map((track) => track.uri));
  const toAdd = computedSet.filter((track) => !present.has(track.uri));
  const alreadyInPlaylist = computedSet.filter((track) => present.has(track.uri));
  const noLongerExpected = input.playlistItems.filter((item) => {
    if (isEpisode(item) || isLocal(item) || !isSpotifyTrackUri(item.uri)) return false;
    return !computedUris.has(item.uri);
  });

  return {
    rawTrackCount: flat.length,
    uniqueCatalog,
    excludedLiked,
    ambiguousIsrc,
    heldBackByIsrc,
    includedDespiteIsrc,
    computedSet,
    toAdd,
    alreadyInPlaylist,
    noLongerExpected,
    alternatives,
    local: uniqueLocal,
    unavailable: uniqueUnavailable,
    unavailableAlbums,
    playlistEpisodes,
    playlistLocal,
    playlistDuplicateUris,
    includeIsrcMatches,
  };
}
