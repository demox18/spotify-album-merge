import { describe, expect, it } from 'vitest';
import { ALBUM_PLAYLIST_DESCRIPTION, ALBUM_PLAYLIST_NAME } from '../src/constants';
import { applyAlbumGoal, applyLikedGoal, type PlaylistAppender, type PlaylistCreator } from '../src/apply/run';
import { readJournal } from '../src/auth/storage';
import { AmbiguousWriteError, QuotaError } from '../src/spotify/errors';
import type { PlaylistSummary, TrackLike } from '../src/types';
import { memoryKv, track } from './support';

function items(uris: Iterable<string>): TrackLike[] {
  return [...uris].map((uri) => track({ uri, name: uri }));
}

describe('apply', () => {
  it('aggiunge solo i mancanti e la seconda corsa non riscrive', async () => {
    const store = new Set(['spotify:track:keep']);
    const calls: string[][] = [];
    const writer: PlaylistAppender = {
      listPlaylistItems: async () => items(store),
      addItems: async (_id, uris) => {
        calls.push([...uris]);
        for (const uri of uris) store.add(uri);
      },
    };
    const kv = memoryKv();
    const intended = ['spotify:track:keep', 'spotify:track:new'];
    const first = await applyLikedGoal(writer, {
      playlistId: 'pl',
      playlistName: 'Everything I Know',
      ownerId: 'me',
      intendedUris: intended,
      hooks: { kv, sleep: async () => undefined },
    });
    expect(first.verifiedComplete).toBe(true);
    expect(first.added).toEqual(['spotify:track:new']);
    expect(first.alreadyPresent).toEqual(['spotify:track:keep']);
    expect(calls).toEqual([['spotify:track:new']]);
    expect(readJournal(kv).liked).toBeNull();

    const second = await applyLikedGoal(writer, {
      playlistId: 'pl',
      playlistName: 'Everything I Know',
      ownerId: 'me',
      intendedUris: intended,
      hooks: { kv, sleep: async () => undefined },
    });
    expect(second.added).toEqual([]);
    expect(second.verifiedComplete).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('dopo un errore ambiguo rilegge e non duplica', async () => {
    const store = new Set<string>();
    let ambiguous = true;
    const writer: PlaylistAppender = {
      listPlaylistItems: async () => items(store),
      addItems: async (_id, uris) => {
        if (ambiguous) {
          ambiguous = false;
          store.add(uris[0] ?? '');
          throw new AmbiguousWriteError();
        }
        for (const uri of uris) store.add(uri);
      },
    };
    const report = await applyLikedGoal(writer, {
      playlistId: 'pl',
      playlistName: 'Everything I Know',
      ownerId: 'me',
      intendedUris: ['spotify:track:a', 'spotify:track:b'],
      hooks: { kv: memoryKv(), sleep: async () => undefined },
    });
    expect(report.verifiedComplete).toBe(true);
    expect([...store].sort()).toEqual(['spotify:track:a', 'spotify:track:b']);
  });

  it('con la quota esaurita si ferma e conserva il diario', async () => {
    const kv = memoryKv();
    const writer: PlaylistAppender = {
      listPlaylistItems: async () => [],
      addItems: async () => {
        throw new QuotaError();
      },
    };
    await expect(
      applyLikedGoal(writer, {
        playlistId: 'pl',
        playlistName: 'Everything I Know',
        ownerId: 'me',
        intendedUris: ['spotify:track:a'],
        hooks: { kv, sleep: async () => undefined },
      }),
    ).rejects.toBeInstanceOf(QuotaError);
    expect(readJournal(kv).liked?.intendedUris).toEqual(['spotify:track:a']);
    expect(readJournal(kv).liked?.createIfMissing).toBe(false);
  });

  it('crea la playlist album privata una sola volta e non tocca altre playlist', async () => {
    const lists: PlaylistSummary[] = [];
    const adds: { id: string; uris: string[] }[] = [];
    let created = 0;
    const writer: PlaylistCreator = {
      listPlaylists: async () => lists,
      listPlaylistItems: async () => [],
      createPrivatePlaylist: async (name, description) => {
        created += 1;
        expect(name).toBe(ALBUM_PLAYLIST_NAME);
        expect(description).toBe(ALBUM_PLAYLIST_DESCRIPTION);
        lists.push({
          id: 'new',
          name,
          ownerId: 'me',
          ownerName: 'Io',
          collaborative: false,
          public: false,
          trackCount: 0,
        });
        return { id: 'new' };
      },
      addItems: async (id, uris) => {
        expect(id).toBe('new');
        adds.push({ id, uris });
      },
    };
    const kv = memoryKv();
    const report = await applyAlbumGoal(writer, {
      existingPlaylistId: null,
      ownerId: 'me',
      intendedUris: ['spotify:track:z'],
      hooks: { kv, sleep: async () => undefined },
    });
    expect(created).toBe(1);
    expect(report.createdPlaylist).toBe(true);
    expect(report.verifiedComplete).toBe(false);
    expect(adds).toEqual([{ id: 'new', uris: ['spotify:track:z'] }]);

    writer.listPlaylistItems = async () => items(['spotify:track:z']);
    const again = await applyAlbumGoal(writer, {
      existingPlaylistId: 'new',
      ownerId: 'me',
      intendedUris: ['spotify:track:z'],
      hooks: { kv, sleep: async () => undefined },
    });
    expect(created).toBe(1);
    expect(again.added).toEqual([]);
    expect(again.verifiedComplete).toBe(true);
  });
});
