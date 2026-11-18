import type { IsrcMatch, LikedDiff, TrackLike } from '../types';
import { addedAtMillis, isEpisode, isLocal, isSpotifyTrackUri } from './text';

export interface LikedDiffInput {
  liked: TrackLike[];
  playlistItems: TrackLike[];
  /**
   * Default false: un brano con lo stesso ISRC ma URI diverso non viene aggiunto.
   * L'utente può includerlo con il toggle.
   */
  includeIsrcMatches?: boolean;
}

function byOldest(a: TrackLike, b: TrackLike): number {
  const delta = addedAtMillis(a.addedAt) - addedAtMillis(b.addedAt);
  if (delta !== 0) return delta;
  return a.uri.localeCompare(b.uri);
}

export function diffLikedIntoPlaylist(input: LikedDiffInput): LikedDiff {
  const includeIsrcMatches = input.includeIsrcMatches ?? false;
  const local: TrackLike[] = [];
  const unavailable: TrackLike[] = [];
  const episodes: TrackLike[] = [];
  const playlistLocal: TrackLike[] = [];
  const playlistUnavailable: TrackLike[] = [];
  const playlistEpisodes: TrackLike[] = [];
  const playlistDuplicateUris: string[] = [];
  const present = new Set<string>();
  const isrcIndex = new Map<string, TrackLike[]>();

  for (const item of input.playlistItems) {
    if (isEpisode(item)) {
      playlistEpisodes.push(item);
      continue;
    }
    if (isLocal(item)) {
      playlistLocal.push(item);
      if (item.uri) {
        if (present.has(item.uri)) playlistDuplicateUris.push(item.uri);
        present.add(item.uri);
      }
      continue;
    }
    if (!item.uri || item.kind === 'unknown') {
      playlistUnavailable.push(item);
      continue;
    }
    if (present.has(item.uri)) playlistDuplicateUris.push(item.uri);
    present.add(item.uri);
    if (item.unavailable) playlistUnavailable.push(item);
    if (item.isrc && item.kind === 'track') {
      const bucket = isrcIndex.get(item.isrc) ?? [];
      bucket.push(item);
      isrcIndex.set(item.isrc, bucket);
    }
  }

  const catalog: TrackLike[] = [];
  const seenLiked = new Set<string>();
  for (const track of [...input.liked].sort(byOldest)) {
    if (isEpisode(track)) {
      episodes.push(track);
      continue;
    }
    if (isLocal(track)) {
      local.push(track);
      continue;
    }
    if (track.unavailable || !isSpotifyTrackUri(track.uri)) {
      unavailable.push(track);
      continue;
    }
    if (seenLiked.has(track.uri)) continue;
    seenLiked.add(track.uri);
    catalog.push(track);
  }

  const toAdd: TrackLike[] = [];
  const alreadyPresent: TrackLike[] = [];
  const ambiguousIsrc: IsrcMatch[] = [];
  const heldBackByIsrc: TrackLike[] = [];
  const includedDespiteIsrc: TrackLike[] = [];

  for (const track of catalog) {
    if (present.has(track.uri)) {
      alreadyPresent.push(track);
      continue;
    }
    const matches = (track.isrc ? isrcIndex.get(track.isrc) ?? [] : []).filter(
      (item) => item.uri !== track.uri,
    );
    if (matches.length > 0) {
      ambiguousIsrc.push({ liked: track, matches });
      if (includeIsrcMatches) {
        includedDespiteIsrc.push(track);
        toAdd.push(track);
      } else {
        heldBackByIsrc.push(track);
      }
      continue;
    }
    toAdd.push(track);
  }

  return {
    toAdd,
    alreadyPresent,
    ambiguousIsrc,
    heldBackByIsrc,
    includedDespiteIsrc,
    local,
    unavailable,
    episodes,
    playlistLocal,
    playlistUnavailable,
    playlistEpisodes,
    playlistDuplicateUris,
    includeIsrcMatches,
  };
}
