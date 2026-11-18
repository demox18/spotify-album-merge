import type { TrackLike } from '../types';

export function n(value: number): string {
  return new Intl.NumberFormat('it-IT').format(value);
}

export function trackLabel(track: TrackLike): string {
  const artist = track.primaryArtist || track.artists.join(', ');
  return artist ? `${artist} — ${track.name}` : track.name;
}

export function spotifyHref(track: TrackLike): string | null {
  if (!track.id) return null;
  if (track.kind === 'episode') return `https://open.spotify.com/episode/${track.id}`;
  if (track.uri.startsWith('spotify:track:')) return `https://open.spotify.com/track/${track.id}`;
  return null;
}

export function playlistHref(id: string): string {
  return `https://open.spotify.com/playlist/${id}`;
}

export function when(iso: string | null): string {
  if (!iso) return 'data sconosciuta';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'data sconosciuta';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' }).format(parsed);
}

export function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Operazione annullata.';
  if (error instanceof Error && error.message) return error.message;
  return 'Qualcosa non ha funzionato.';
}

export function progressText(phase: string, done: number, total: number | null, detail?: string): string {
  const amount = total === null ? `${n(done)}` : `${n(done)} / ${n(total)}`;
  return detail ? `${phase}: ${amount} — ${detail}` : `${phase}: ${amount}`;
}
