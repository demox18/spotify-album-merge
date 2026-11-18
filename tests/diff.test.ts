import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALBUM_PLAYLIST_NAME, EVERYTHING_PLAYLIST_NAME, SCOPES } from '../src/constants';
import { diffAlbumPlaylist } from '../src/diff/albums';
import { diffLikedIntoPlaylist } from '../src/diff/liked';
import { classifyEverythingPlaylists, decideAlbumTarget, editBlocker, namesAreExact } from '../src/diff/names';
import { addItemsBody, membershipDiff, verifyMembership } from '../src/diff/plan';
import { mapAlbumTrack, mapPlaylistItem, mapPlaylistSummary, mapSavedTrack } from '../src/read/map';
import { reducePages } from '../src/read/pages';
import type { AlbumTrack, Page, TrackLike } from '../src/types';
import { albumTrack, playlist, track } from './support';

function paging<T>(chunks: T[][]): T[] {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pages: Page<T>[] = chunks.map((items, index) => ({
    items,
    total,
    next: index === chunks.length - 1 ? null : `https://api.spotify.com/v1/next?offset=${index + 1}`,
  }));
  const reduced = reducePages(pages);
  expect(reduced.complete).toBe(true);
  expect(reduced.items).toHaveLength(total);
  return reduced.items;
}

function savedRaw(uri: string, addedAt: string, extra: Record<string, unknown> = {}) {
  return {
    added_at: addedAt,
    track: {
      type: 'track',
      uri,
      id: uri.split(':').at(-1),
      name: extra.name ?? uri,
      artists: [{ name: extra.artist ?? 'Ada' }],
      album: { name: extra.album ?? 'Disco' },
      duration_ms: extra.duration ?? 180000,
      external_ids: extra.isrc ? { isrc: extra.isrc } : undefined,
      is_local: extra.local ?? false,
      is_playable: extra.playable,
      restrictions: extra.restriction ? { reason: extra.restriction } : undefined,
      disc_number: 1,
      track_number: 1,
    },
  };
}

describe('preferiti verso Everything I Know, da pagine', () => {
  const likedPages = paging<Record<string, unknown>>([
    [savedRaw('spotify:track:B', '2020-02-01T00:00:00Z', { name: 'Seconda' })],
    [
      savedRaw('spotify:track:A', '2019-01-01T00:00:00Z', { name: 'Prima' }),
      savedRaw('spotify:track:D', '2018-06-01T00:00:00Z', { name: 'Registrazione', isrc: 'us-rc1-7607839' }),
    ],
    [
      savedRaw('spotify:track:C', '2021-03-01T00:00:00Z', { name: 'Terza' }),
      { added_at: '2017-01-01T00:00:00Z', track: { type: 'track', uri: 'spotify:local:file', id: null, name: 'File mio', artists: [{ name: 'Io' }], is_local: true, duration_ms: 1000 } },
    ],
    [
      { added_at: '2016-01-01T00:00:00Z', track: null },
      savedRaw('spotify:track:F', '2015-01-01T00:00:00Z', { name: 'Spento', playable: false }),
    ],
  ]);
  const liked = likedPages.map(mapSavedTrack);

  const playlistPages = paging<Record<string, unknown>>([
    [
      { added_at: '2024-01-01T00:00:00Z', is_local: false, item: { type: 'track', uri: 'spotify:track:B', id: 'B', name: 'Seconda', artists: [{ name: 'Ada' }], external_ids: { isrc: 'AAAA11111111' }, duration_ms: 180000, disc_number: 1, track_number: 1 } },
      { added_at: '2024-01-02T00:00:00Z', is_local: false, item: { type: 'episode', uri: 'spotify:episode:E1', id: 'E1', name: 'Puntata', duration_ms: 1000 } },
    ],
    [
      { added_at: '2024-01-03T00:00:00Z', is_local: false, item: { type: 'track', uri: 'spotify:track:X', id: 'X', name: 'Altra edizione', artists: [{ name: 'Ada' }], external_ids: { isrc: 'USRC17607839' }, duration_ms: 180000, disc_number: 1, track_number: 1 } },
      { added_at: '2024-01-04T00:00:00Z', is_local: false, item: { type: 'track', uri: 'spotify:track:B', id: 'B', name: 'Seconda', artists: [{ name: 'Ada' }], duration_ms: 180000 } },
      { added_at: null, is_local: true, track: { type: 'track', uri: 'spotify:local:gia', id: 'local', name: 'Già locale', artists: [{ name: 'Io' }], is_local: true, duration_ms: 1000 } },
    ],
  ]);
  const playlistItems = playlistPages.map(mapPlaylistItem);
  const orderBefore = playlistItems.map((item) => item.uri).join('|');

  it('tiene il default che non duplica le stesse registrazioni e ordina dal Preferito più vecchio', () => {
    const diff = diffLikedIntoPlaylist({ liked, playlistItems });
    expect(diff.includeIsrcMatches).toBe(false);
    expect(diff.toAdd.map((item) => item.uri)).toEqual(['spotify:track:A', 'spotify:track:C']);
    expect(diff.alreadyPresent.map((item) => item.uri)).toEqual(['spotify:track:B']);
    expect(diff.heldBackByIsrc.map((item) => item.uri)).toEqual(['spotify:track:D']);
    expect(diff.ambiguousIsrc).toHaveLength(1);
    expect(diff.ambiguousIsrc[0]?.matches.map((item) => item.uri)).toEqual(['spotify:track:X']);
    expect(diff.local.map((item) => item.uri)).toEqual(['spotify:local:file']);
    expect(diff.unavailable.map((item) => item.name)).toEqual(['Spento', 'Non disponibile']);
    expect(diff.playlistEpisodes.map((item) => item.uri)).toEqual(['spotify:episode:E1']);
    expect(diff.playlistLocal.map((item) => item.uri)).toEqual(['spotify:local:gia']);
    expect(diff.playlistDuplicateUris).toEqual(['spotify:track:B']);
    expect(diff).not.toHaveProperty('removals');
    expect(playlistItems.map((item) => item.uri).join('|')).toBe(orderBefore);
  });

  it('con il toggle acceso include l’ISRC ambiguo nella posizione cronologica', () => {
    const diff = diffLikedIntoPlaylist({ liked, playlistItems, includeIsrcMatches: true });
    expect(diff.toAdd.map((item) => item.uri)).toEqual(['spotify:track:D', 'spotify:track:A', 'spotify:track:C']);
    expect(diff.includedDespiteIsrc.map((item) => item.uri)).toEqual(['spotify:track:D']);
  });

  it('è idempotente: la seconda passata non ha nulla da aggiungere', () => {
    const first = diffLikedIntoPlaylist({ liked, playlistItems });
    const after = [...playlistItems, ...first.toAdd.map((item) => track({ uri: item.uri, name: item.name }))];
    const second = diffLikedIntoPlaylist({ liked, playlistItems: after });
    expect(second.toAdd).toEqual([]);
  });
});

describe('album non nei Preferiti', () => {
  const zebraPages = paging<Record<string, unknown>>([
    [
      { type: 'track', uri: 'spotify:track:a1', id: 'a1', name: 'Uno', artists: [{ name: 'Zebra' }], disc_number: 1, track_number: 1, duration_ms: 1000 },
      { type: 'track', uri: 'spotify:track:a2', id: 'a2', name: 'Due', artists: [{ name: 'Zebra' }], disc_number: 1, track_number: 2, duration_ms: 200000 },
    ],
    [
      { type: 'track', uri: 'spotify:track:a3', id: 'a3', name: 'Tre', artists: [{ name: 'Zebra' }], disc_number: 2, track_number: 1, duration_ms: 1000 },
      { type: 'track', uri: 'spotify:track:a4', id: 'a4', name: 'Quattro', artists: [{ name: 'Zebra' }], disc_number: 2, track_number: 1, duration_ms: 1000 },
    ],
  ]);
  const zebra = zebraPages.map((raw) =>
    mapAlbumTrack(raw, { id: 'albZ', name: 'Zebra LP', artists: ['Zebra'], primaryArtist: 'Zebra', releaseDate: '2001-01-01' }),
  );
  const beta: AlbumTrack[] = [
    albumTrack({ uri: 'spotify:track:a1', id: 'a1', name: 'Uno', primaryArtist: 'Alpha', albumName: 'Beta', albumId: 'albB', releaseDate: '1999-05-01', discNumber: 1, trackNumber: 1, durationMs: 1000 }),
    albumTrack({ uri: 'spotify:track:b2', name: 'Canzone (Live)', primaryArtist: 'Alpha', albumName: 'Beta', albumId: 'albB', releaseDate: '1999-05-01', discNumber: 1, trackNumber: 2, durationMs: 180000 }),
    albumTrack({ uri: 'spotify:local:b3', name: 'Bozza', primaryArtist: 'Alpha', albumName: 'Beta', albumId: 'albB', releaseDate: '1999-05-01', isLocal: true, discNumber: 1, trackNumber: 3 }),
    albumTrack({ uri: 'spotify:track:b4', name: 'Canzone', primaryArtist: 'Alpha', albumName: 'Beta', albumId: 'albB', releaseDate: '1999-05-01', discNumber: 1, trackNumber: 4, durationMs: 210000 }),
    albumTrack({ uri: 'spotify:track:b5', name: 'Canzone', primaryArtist: 'Other', albumName: 'Beta', albumId: 'albB', releaseDate: '1999-05-01', discNumber: 1, trackNumber: 5, durationMs: 180000 }),
  ];
  const albums = [
    { id: 'albZ', name: 'Zebra LP', artists: ['Zebra'], primaryArtist: 'Zebra', releaseDate: '2001-01-01', unavailable: false, tracks: zebra },
    { id: 'albB', name: 'Beta', artists: ['Alpha'], primaryArtist: 'Alpha', releaseDate: '1999-05-01', unavailable: false, tracks: beta },
    { id: null, name: 'Album sparito', artists: [], primaryArtist: '', releaseDate: '', unavailable: true, tracks: [] },
  ];
  const liked = [
    track({ uri: 'spotify:track:a3', name: 'Tre', primaryArtist: 'Zebra' }),
    track({ uri: 'spotify:track:L1', name: 'Canzone', primaryArtist: 'Alpha', durationMs: 180500, isrc: 'ISRC0LIKED001' }),
    track({ uri: 'spotify:track:L2', name: 'Due', primaryArtist: 'Zebra', durationMs: 200000, isrc: 'ITISRC0000001' }),
  ];
  const existing: TrackLike[] = [
    track({ uri: 'spotify:track:a1', name: 'Uno' }),
    track({ uri: 'spotify:track:old', name: 'Vecchio extra' }),
    track({ uri: 'spotify:episode:ep', kind: 'episode', name: 'Podcast' }),
    track({ uri: 'spotify:local:pl', isLocal: true, name: 'Locale in playlist' }),
  ];

  it('deduplica, ordina, esclude gli URI già nei Preferiti e non fonde le versioni', () => {
    const diff = diffAlbumPlaylist({ albums, liked, playlistItems: existing });
    expect(diff.includeIsrcMatches).toBe(true);
    expect(diff.rawTrackCount).toBe(zebra.length + beta.length);
    expect(diff.excludedLiked.map((item) => item.uri)).toEqual(['spotify:track:a3']);
    expect(diff.local.map((item) => item.uri)).toEqual(['spotify:local:b3']);
    expect(diff.unavailableAlbums.map((album) => album.name)).toEqual(['Album sparito']);
    expect(diff.uniqueCatalog.find((item) => item.uri === 'spotify:track:a1')?.albumId).toBe('albB');
    expect(diff.computedSet.map((item) => item.uri)).toEqual([
      'spotify:track:a1',
      'spotify:track:b2',
      'spotify:track:b4',
      'spotify:track:b5',
      'spotify:track:a2',
      'spotify:track:a4',
    ]);
    expect(diff.toAdd.map((item) => item.uri)).toEqual([
      'spotify:track:b2',
      'spotify:track:b4',
      'spotify:track:b5',
      'spotify:track:a2',
      'spotify:track:a4',
    ]);
    expect(diff.alreadyInPlaylist.map((item) => item.uri)).toEqual(['spotify:track:a1']);
    expect(diff.noLongerExpected.map((item) => item.uri)).toEqual(['spotify:track:old']);
    expect(diff.playlistEpisodes.map((item) => item.uri)).toEqual(['spotify:episode:ep']);
    expect(diff.alternatives.map((item) => item.albumTrack.uri).sort()).toEqual(['spotify:track:a2', 'spotify:track:b2']);
    expect(diff.alternatives.every((item) => item.reason.startsWith('possibile versione alternativa'))).toBe(true);
    expect(diff.toAdd.map((item) => item.uri)).toContain('spotify:track:b2');
    expect(diff).not.toHaveProperty('removals');
  });

  it('con ISRC diverso URI include di default e, se spento, non aggiunge', () => {
    const enriched = structuredClone(albums);
    const due = enriched[0]?.tracks.find((item) => item.uri === 'spotify:track:a2');
    expect(due).toBeTruthy();
    if (due) due.isrc = 'ITISRC0000001';
    const included = diffAlbumPlaylist({ albums: enriched, liked, playlistItems: existing });
    expect(included.includedDespiteIsrc.map((item) => item.uri)).toEqual(['spotify:track:a2']);
    expect(included.toAdd.map((item) => item.uri)).toContain('spotify:track:a2');
    expect(included.alternatives.map((item) => item.albumTrack.uri)).not.toContain('spotify:track:a2');

    const held = diffAlbumPlaylist({ albums: enriched, liked, playlistItems: existing, includeIsrcMatches: false });
    expect(held.toAdd.map((item) => item.uri)).not.toContain('spotify:track:a2');
    expect(held.heldBackByIsrc.map((item) => item.uri)).toEqual(['spotify:track:a2']);

    const present = [...existing, track({ uri: 'spotify:track:a2' })];
    const stale = diffAlbumPlaylist({ albums: enriched, liked, playlistItems: present, includeIsrcMatches: false });
    expect(stale.noLongerExpected.map((item) => item.uri)).toContain('spotify:track:a2');
  });

  it('la seconda passata non aggiunge nulla se il set non cambia', () => {
    const first = diffAlbumPlaylist({ albums, liked, playlistItems: existing });
    const second = diffAlbumPlaylist({
      albums,
      liked,
      playlistItems: [...existing, ...first.toAdd],
    });
    expect(second.toAdd).toEqual([]);
    expect(second.noLongerExpected.map((item) => item.uri)).toEqual(['spotify:track:old']);
  });
});

describe('nomi playlist e piani di scrittura', () => {
  it('riconosce Everything I Know in modo esatto o vicino', () => {
    expect(namesAreExact('Everything  I Know!', EVERYTHING_PLAYLIST_NAME)).toBe(true);
    const mine = playlist({ id: '1', name: 'everything-i-know', ownerId: 'me' });
    const other = playlist({ id: '2', name: 'Everything I Know', ownerId: 'loro', collaborative: false });
    const near = playlist({ id: '3', name: 'Everything I Know (backup)', ownerId: 'me' });
    const noise = playlist({ id: '4', name: 'Radiohead', ownerId: 'me' });
    const single = classifyEverythingPlaylists([mine, near, noise], 'me');
    expect(single.exact.map((item) => item.id)).toEqual(['1']);
    expect(single.near.map((item) => item.id)).toEqual(['3']);
    expect(single.autoSelectId).toBe('1');
    expect(classifyEverythingPlaylists([mine, other], 'me').autoSelectId).toBe('1');
    const second = playlist({ id: '5', name: 'EVERYTHING I KNOW', ownerId: 'me' });
    expect(classifyEverythingPlaylists([mine, second], 'me').autoSelectId).toBeNull();
    expect(classifyEverythingPlaylists([other], 'me').autoSelectId).toBeNull();
  });

  it('aggiorna la playlist album solo se il nome esatto è tuo', () => {
    const exact = playlist({ id: 'a', name: ALBUM_PLAYLIST_NAME, ownerId: 'me' });
    const similar = playlist({ id: 'b', name: 'Dagli album - non nei Preferiti', ownerId: 'me' });
    const foreign = playlist({ id: 'c', name: ALBUM_PLAYLIST_NAME, ownerId: 'altro' });
    expect(decideAlbumTarget([similar, foreign], 'me').mode).toBe('create');
    const update = decideAlbumTarget([exact, similar], 'me');
    expect(update.mode).toBe('update');
    expect(update.ownedExact.map((item) => item.id)).toEqual(['a']);
    expect(update.near.map((item) => item.id)).toEqual(['b']);
  });

  it('spiega il permesso pubblico', () => {
    const pub = playlist({ id: 'p', name: 'Everything I Know', public: true, ownerId: 'me' });
    expect(editBlocker(pub, 'me', ['playlist-modify-private'])).toMatch(/playlist-modify-public/);
    expect(editBlocker(pub, 'me', ['playlist-modify-public'])).toBeNull();
    expect(editBlocker(playlist({ id: 'x', name: 'x', ownerId: 'altro' }), 'me', SCOPES)).toMatch(/collaborativa/);
  });

  it('accoda a batch da 100 senza position e verifica gli URI', () => {
    const intended = Array.from({ length: 250 }, (_, index) => `spotify:track:${index}`);
    const plan = membershipDiff(intended, new Set(['spotify:track:1']));
    expect(plan.batches.map((batch) => batch.length)).toEqual([100, 100, 49]);
    expect(plan.missing[0]).toBe('spotify:track:0');
    expect(plan.alreadyPresent).toEqual(['spotify:track:1']);
    const body = addItemsBody(plan.batches[0] ?? []);
    expect(Object.keys(body)).toEqual(['uris']);
    expect(body).not.toHaveProperty('position');
    const present = new Set([...plan.alreadyPresent, ...plan.missing]);
    expect(verifyMembership(intended, present).complete).toBe(true);
    expect(verifyMembership(intended, plan.alreadyPresent).complete).toBe(false);
    expect(membershipDiff(intended, present).missing).toEqual([]);
  });
});

describe('separatori e scope', () => {
  it('non chiede permessi per svuotare la libreria', () => {
    expect(SCOPES).not.toContain('user-library-modify');
    expect(SCOPES).toContain('playlist-modify-public');
  });

  it('la lettura non scrive e il client non usa gli endpoint rimossi', () => {
    const collect = readFileSync('src/read/collect.ts', 'utf8');
    const liked = readFileSync('src/diff/liked.ts', 'utf8');
    const albums = readFileSync('src/diff/albums.ts', 'utf8');
    const client = readFileSync('src/spotify/client.ts', 'utf8');
    const apply = readFileSync('src/apply/run.ts', 'utf8');
    expect(collect).not.toMatch(/addItems|createPrivatePlaylist|\.post\(/);
    expect(liked).not.toMatch(/fetch\(|spotify\.com|localStorage/);
    expect(albums).not.toMatch(/fetch\(|spotify\.com|localStorage/);
    expect(client).not.toMatch(/\/v1\/tracks\?/);
    expect(client).not.toContain('/tracks?ids');
    expect(client).not.toMatch(/\/playlists\/\$\{[^}]+\}\/tracks/);
    expect(client).not.toMatch(/method:\s*['"]DELETE['"]/);
    expect(client).not.toContain('/me/library');
    expect(apply).not.toContain(EVERYTHING_PLAYLIST_NAME);
  });

  it('legge items.total e, in mancanza, il campo vecchio tracks', () => {
    expect(mapPlaylistSummary({ id: '1', name: 'A', owner: { id: 'me', display_name: 'Io' }, collaborative: false, public: true, items: { total: 4 }, tracks: { total: 9 } })?.trackCount).toBe(4);
    expect(mapPlaylistSummary({ id: '2', name: 'B', owner: { id: 'me' }, tracks: { total: 9 } })?.trackCount).toBe(9);
    const legacy = mapPlaylistItem({ is_local: false, track: { type: 'track', uri: 'spotify:track:legacy', id: 'legacy', name: 'Vecchio campo', artists: [{ name: 'Ada' }], duration_ms: 1 } });
    expect(legacy.uri).toBe('spotify:track:legacy');
  });
});
