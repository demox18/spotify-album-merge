export type MediaKind = 'track' | 'episode' | 'unknown';

export interface TrackLike {
  uri: string;
  id: string | null;
  name: string;
  artists: string[];
  primaryArtist: string;
  albumName: string;
  durationMs: number;
  isrc: string | null;
  isLocal: boolean;
  unavailable: boolean;
  restriction: string | null;
  kind: MediaKind;
  discNumber: number;
  trackNumber: number;
  addedAt: string | null;
}

export interface AlbumTrack extends TrackLike {
  albumId: string;
  releaseDate: string;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  collaborative: boolean;
  /** true pubblica, false privata, null se Spotify non lo indica. */
  public: boolean | null;
  trackCount: number | null;
}

export interface SavedAlbum {
  id: string | null;
  name: string;
  artists: string[];
  primaryArtist: string;
  releaseDate: string;
  unavailable: boolean;
  tracks: AlbumTrack[];
}

export interface Library {
  playlists: PlaylistSummary[];
  liked: TrackLike[];
  albums: SavedAlbum[];
}

export interface Progress {
  phase: string;
  done: number;
  total: number | null;
  detail?: string;
}

export interface IsrcMatch {
  liked: TrackLike;
  matches: TrackLike[];
}

export interface AlternativeVersion {
  albumTrack: AlbumTrack;
  liked: TrackLike;
  reason: string;
}

export interface LikedDiff {
  toAdd: TrackLike[];
  alreadyPresent: TrackLike[];
  ambiguousIsrc: IsrcMatch[];
  heldBackByIsrc: TrackLike[];
  includedDespiteIsrc: TrackLike[];
  local: TrackLike[];
  unavailable: TrackLike[];
  episodes: TrackLike[];
  playlistLocal: TrackLike[];
  playlistUnavailable: TrackLike[];
  playlistEpisodes: TrackLike[];
  playlistDuplicateUris: string[];
  includeIsrcMatches: boolean;
}

export interface AlbumDiff {
  rawTrackCount: number;
  uniqueCatalog: AlbumTrack[];
  excludedLiked: AlbumTrack[];
  ambiguousIsrc: IsrcMatch[];
  heldBackByIsrc: AlbumTrack[];
  includedDespiteIsrc: AlbumTrack[];
  computedSet: AlbumTrack[];
  toAdd: AlbumTrack[];
  alreadyInPlaylist: AlbumTrack[];
  /** Solo da mostrare. Questa versione non rimuove nulla. */
  noLongerExpected: TrackLike[];
  alternatives: AlternativeVersion[];
  local: AlbumTrack[];
  unavailable: AlbumTrack[];
  unavailableAlbums: SavedAlbum[];
  playlistEpisodes: TrackLike[];
  playlistLocal: TrackLike[];
  playlistDuplicateUris: string[];
  includeIsrcMatches: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  next: string | null;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export interface Kv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface JournalEntry {
  goal: 'liked' | 'albums';
  playlistId: string | null;
  playlistName: string;
  ownerId: string;
  intendedUris: string[];
  createIfMissing: boolean;
  description: string | null;
  createdAt: string;
}

export interface Journal {
  version: 1;
  liked: JournalEntry | null;
  albums: JournalEntry | null;
}

export interface ApplyReport {
  playlistId: string;
  playlistName: string;
  intended: number;
  added: string[];
  alreadyPresent: string[];
  missing: string[];
  errors: { uri: string | null; message: string }[];
  verifiedComplete: boolean;
  createdPlaylist: boolean;
}
