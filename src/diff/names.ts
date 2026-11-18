import { ALBUM_PLAYLIST_NAME, EVERYTHING_PLAYLIST_NAME } from '../constants';
import type { PlaylistSummary } from '../types';
import { levenshtein, normalizePlaylistName } from './text';

export interface ClassifiedPlaylists {
  exact: PlaylistSummary[];
  near: PlaylistSummary[];
  /** Valorizzato solo se c'è una sola corrispondenza esatta modificabile. */
  autoSelectId: string | null;
}

export function isOwnedOrCollaborative(playlist: PlaylistSummary, meId: string): boolean {
  return playlist.ownerId === meId || playlist.collaborative;
}

export function namesAreExact(a: string, b: string): boolean {
  return normalizePlaylistName(a) === normalizePlaylistName(b) && normalizePlaylistName(a).length > 0;
}

export function namesAreNear(candidate: string, target: string): boolean {
  const left = normalizePlaylistName(candidate);
  const right = normalizePlaylistName(target);
  if (!left || !right || left === right) return false;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (shorter.length >= 10 && longer.includes(shorter)) return true;
  const distance = levenshtein(left, right);
  const limit = Math.max(left.length, right.length) >= 12 ? 2 : 1;
  return distance <= limit;
}

export function classifyEverythingPlaylists(
  playlists: PlaylistSummary[],
  meId: string,
  target = EVERYTHING_PLAYLIST_NAME,
): ClassifiedPlaylists {
  const exact: PlaylistSummary[] = [];
  const near: PlaylistSummary[] = [];
  for (const playlist of playlists) {
    if (namesAreExact(playlist.name, target)) exact.push(playlist);
    else if (namesAreNear(playlist.name, target)) near.push(playlist);
  }
  const editableExact = exact.filter((playlist) => isOwnedOrCollaborative(playlist, meId));
  return {
    exact,
    near,
    autoSelectId: editableExact.length === 1 ? editableExact[0].id : null,
  };
}

export function exactAlbumName(name: string): boolean {
  return name.normalize('NFC').trim() === ALBUM_PLAYLIST_NAME.normalize('NFC').trim();
}

export interface AlbumTargetDecision {
  mode: 'update' | 'create';
  ownedExact: PlaylistSummary[];
  near: PlaylistSummary[];
}

export function decideAlbumTarget(playlists: PlaylistSummary[], meId: string): AlbumTargetDecision {
  const ownedExact = playlists.filter(
    (playlist) => playlist.ownerId === meId && exactAlbumName(playlist.name),
  );
  const near = playlists.filter((playlist) => {
    if (exactAlbumName(playlist.name)) return false;
    return namesAreExact(playlist.name, ALBUM_PLAYLIST_NAME) || namesAreNear(playlist.name, ALBUM_PLAYLIST_NAME);
  });
  return {
    mode: ownedExact.length > 0 ? 'update' : 'create',
    ownedExact,
    near,
  };
}

export function editBlocker(
  playlist: PlaylistSummary,
  meId: string,
  scopes: readonly string[],
): string | null {
  if (!isOwnedOrCollaborative(playlist, meId)) {
    return 'Non è tua e non è collaborativa: Spotify consente di leggerne i brani e di modificarla solo al proprietario o ai collaboratori.';
  }
  if (playlist.public === true && !scopes.includes('playlist-modify-public')) {
    return 'È pubblica. Per aggiungerci brani serve playlist-modify-public. Se fosse privata basterebbe playlist-modify-private.';
  }
  if (playlist.public !== true && !scopes.includes('playlist-modify-private')) {
    return 'È privata (o lo stato non è indicato). Per aggiungerci brani serve playlist-modify-private.';
  }
  return null;
}
