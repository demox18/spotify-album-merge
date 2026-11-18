import { ALBUM_PLAYLIST_DESCRIPTION, ALBUM_PLAYLIST_NAME } from '../constants';
import { exactAlbumName } from '../diff/names';
import { addItemsBody, membershipDiff, verifyMembership } from '../diff/plan';
import { isSpotifyTrackUri } from '../diff/text';
import type { ApplyReport, Journal, JournalEntry, Kv, PlaylistSummary, Progress, TrackLike } from '../types';
import { readJournal, writeJournal } from '../auth/storage';
import { AmbiguousWriteError, HttpError, QuotaError, RateLimitError, isAbortError } from '../spotify/errors';

export interface PlaylistAppender {
  listPlaylistItems(playlistId: string): Promise<TrackLike[]>;
  addItems(playlistId: string, uris: string[]): Promise<void>;
}

export interface PlaylistCreator extends PlaylistAppender {
  listPlaylists(): Promise<PlaylistSummary[]>;
  createPrivatePlaylist(name: string, description: string): Promise<{ id: string }>;
}

export interface ApplyHooks {
  kv: Kv;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

function urisOf(items: TrackLike[]): Set<string> {
  const uris = new Set<string>();
  for (const item of items) {
    if (item.uri) uris.add(item.uri);
  }
  return uris;
}

function saveGoal(kv: Kv, entry: JournalEntry): void {
  const journal = readJournal(kv);
  const next: Journal = {
    version: 1,
    liked: entry.goal === 'liked' ? entry : journal.liked,
    albums: entry.goal === 'albums' ? entry : journal.albums,
  };
  writeJournal(kv, next);
}

function clearGoal(kv: Kv, goal: JournalEntry['goal']): void {
  const journal = readJournal(kv);
  writeJournal(kv, {
    version: 1,
    liked: goal === 'liked' ? null : journal.liked,
    albums: goal === 'albums' ? null : journal.albums,
  });
}

async function appendVerified(
  writer: PlaylistAppender,
  input: {
    playlistId: string;
    playlistName: string;
    intendedUris: string[];
    goal: JournalEntry['goal'];
    createdPlaylist: boolean;
    hooks: ApplyHooks;
    journalBase: Omit<JournalEntry, 'intendedUris' | 'playlistId'>;
  },
): Promise<ApplyReport> {
  const sleep = input.hooks.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const errors: ApplyReport['errors'] = [];
  const poisoned = new Set<string>();
  let ambiguous = 0;
  const intendedUris = uniqueUris(input.intendedUris);
  input = { ...input, intendedUris };

  input.hooks.onProgress?.({ phase: 'Rilettura prima di scrivere', done: 0, total: null });
  let present = urisOf(await writer.listPlaylistItems(input.playlistId));
  const before = new Set(present);
  const activeIntended = () => input.intendedUris.filter((uri) => !poisoned.has(uri));

  let safety = 0;
  while (safety < 10000) {
    safety += 1;
    if (input.hooks.signal?.aborted) throw new DOMException('Operazione annullata.', 'AbortError');
    const plan = membershipDiff(activeIntended(), present);
    if (plan.missing.length === 0) break;
    const batch = plan.batches[0];
    if (!batch) break;
    saveGoal(input.hooks.kv, {
      ...input.journalBase,
      playlistId: input.playlistId,
      intendedUris: activeIntended(),
    });
    try {
      await writer.addItems(input.playlistId, addItemsBody(batch).uris);
      for (const uri of batch) present.add(uri);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof QuotaError) throw error;
      if (error instanceof RateLimitError) {
        if (error.waitMs > 120_000) throw error;
        input.hooks.onProgress?.({
          phase: 'Attesa limite di frequenza',
          done: 0,
          total: null,
          detail: `${Math.ceil(error.waitMs / 1000)} secondi`,
        });
        await sleep(error.waitMs);
        present = urisOf(await writer.listPlaylistItems(input.playlistId));
        continue;
      }
      if (error instanceof AmbiguousWriteError) {
        ambiguous += 1;
        if (ambiguous > 3) throw error;
        present = urisOf(await writer.listPlaylistItems(input.playlistId));
        continue;
      }
      if (error instanceof HttpError && error.status === 400) {
        await bisectBadUris(writer, input.playlistId, batch, present, poisoned, errors);
        continue;
      }
      throw error;
    }
    input.hooks.onProgress?.({
      phase: 'Aggiunta in coda',
      done: membershipDiff(activeIntended(), present).alreadyPresent.length,
      total: activeIntended().length,
    });
  }

  input.hooks.onProgress?.({ phase: 'Verifica: rilettura della playlist', done: 0, total: null });
  const finalPresent = urisOf(await writer.listPlaylistItems(input.playlistId));
  const verification = verifyMembership(input.intendedUris, finalPresent);
  const missing = verification.missing;
  const added = input.intendedUris.filter((uri) => !before.has(uri) && finalPresent.has(uri));
  const alreadyPresent = input.intendedUris.filter((uri) => before.has(uri));
  const verifiedComplete = missing.length === 0 && errors.length === 0;
  if (verifiedComplete) clearGoal(input.hooks.kv, input.goal);
  else {
    const retryable = missing.filter((uri) => !poisoned.has(uri));
    if (retryable.length === 0) clearGoal(input.hooks.kv, input.goal);
    else {
      saveGoal(input.hooks.kv, {
        ...input.journalBase,
        playlistId: input.playlistId,
        intendedUris: retryable,
      });
    }
  }

  return {
    playlistId: input.playlistId,
    playlistName: input.playlistName,
    intended: new Set(input.intendedUris).size,
    added,
    alreadyPresent,
    missing,
    errors,
    verifiedComplete,
    createdPlaylist: input.createdPlaylist,
  };
}

async function bisectBadUris(
  writer: PlaylistAppender,
  playlistId: string,
  uris: string[],
  present: Set<string>,
  poisoned: Set<string>,
  errors: ApplyReport['errors'],
): Promise<void> {
  if (uris.length === 1) {
    const uri = uris[0];
    poisoned.add(uri);
    errors.push({ uri, message: 'Spotify ha rifiutato questo URI (400). Non lo riprovo in automatico.' });
    return;
  }
  const mid = Math.ceil(uris.length / 2);
  for (const part of [uris.slice(0, mid), uris.slice(mid)]) {
    try {
      await writer.addItems(playlistId, addItemsBody(part).uris);
      for (const uri of part) present.add(uri);
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        await bisectBadUris(writer, playlistId, part, present, poisoned, errors);
        continue;
      }
      throw error;
    }
  }
}

export async function applyLikedGoal(
  writer: PlaylistAppender,
  input: {
    playlistId: string;
    playlistName: string;
    ownerId: string;
    intendedUris: string[];
    hooks: ApplyHooks;
  },
): Promise<ApplyReport> {
  const intended = input.intendedUris.filter(isSpotifyTrackUri);
  return appendVerified(writer, {
    playlistId: input.playlistId,
    playlistName: input.playlistName,
    intendedUris: intended,
    goal: 'liked',
    createdPlaylist: false,
    hooks: input.hooks,
    journalBase: {
      goal: 'liked',
      playlistName: input.playlistName,
      ownerId: input.ownerId,
      createIfMissing: false,
      description: null,
      createdAt: new Date().toISOString(),
    },
  });
}

export async function applyAlbumGoal(
  writer: PlaylistCreator,
  input: {
    existingPlaylistId: string | null;
    ownerId: string;
    intendedUris: string[];
    hooks: ApplyHooks;
  },
): Promise<ApplyReport> {
  const intended = input.intendedUris.filter(isSpotifyTrackUri);
  const journalBase: Omit<JournalEntry, 'intendedUris' | 'playlistId'> = {
    goal: 'albums',
    playlistName: ALBUM_PLAYLIST_NAME,
    ownerId: input.ownerId,
    createIfMissing: input.existingPlaylistId === null,
    description: ALBUM_PLAYLIST_DESCRIPTION,
    createdAt: new Date().toISOString(),
  };
  saveGoal(input.hooks.kv, { ...journalBase, playlistId: input.existingPlaylistId, intendedUris: intended });

  let playlistId = input.existingPlaylistId;
  let createdPlaylist = false;
  if (!playlistId) {
    const playlists = await writer.listPlaylists();
    const owned = playlists.filter((playlist) => playlist.ownerId === input.ownerId && exactAlbumName(playlist.name));
    if (owned.length > 1) {
      throw new Error(
        'Ci sono più playlist tue con il nome esatto. Non ne creo un’altra: scegline una nell’anteprima e conferma di nuovo.',
      );
    }
    if (owned.length === 1) playlistId = owned[0].id;
    else {
      const created = await writer.createPrivatePlaylist(ALBUM_PLAYLIST_NAME, ALBUM_PLAYLIST_DESCRIPTION);
      playlistId = created.id;
      createdPlaylist = true;
      saveGoal(input.hooks.kv, { ...journalBase, playlistId, intendedUris: intended, createIfMissing: false });
    }
  }

  return appendVerified(writer, {
    playlistId,
    playlistName: ALBUM_PLAYLIST_NAME,
    intendedUris: intended,
    goal: 'albums',
    createdPlaylist,
    hooks: input.hooks,
    journalBase: { ...journalBase, createIfMissing: false },
  });
}

function uniqueUris(uris: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const uri of uris) {
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    unique.push(uri);
  }
  return unique;
}
