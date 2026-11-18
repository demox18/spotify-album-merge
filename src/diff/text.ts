import { ALTERNATIVE_DURATION_MS } from '../constants';

export function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase('it').trim();
}

/** Confronto nomi playlist: ignora maiuscole, spazi e punteggiatura. */
export function normalizePlaylistName(name: string): string {
  return fold(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normalizeIsrc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.length === 12 ? compact : null;
}

const VERSION_WORDS =
  /\b(live|remix|rmx|acoustic|acustica|acustico|remaster(?:ed|izzata)?|demo|instrumental|radio(?:\s+edit)?|edit|versione|version|mono|stereo|deluxe|bonus|unplugged)\b/gi;

/** Chiave di somiglianza. Vuota se resterebbe solo un marcatore di versione. */
export function baseTitle(name: string): string {
  let text = fold(name);
  text = text.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  text = text.replace(/\b(feat|ft|featuring)\b.*$/g, ' ');
  text = text.replace(VERSION_WORDS, ' ');
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

export function artistKey(name: string): string {
  return fold(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

export function durationsAreClose(a: number, b: number, threshold = ALTERNATIVE_DURATION_MS): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= threshold;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = current;
    }
  }
  return row[b.length];
}

export function addedAtMillis(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function compareIt(a: string, b: string): number {
  return a.localeCompare(b, 'it', { sensitivity: 'base', numeric: true });
}

export function isSpotifyTrackUri(uri: string): boolean {
  return uri.startsWith('spotify:track:');
}

export function isEpisode(item: { kind: string; uri: string }): boolean {
  return item.kind === 'episode' || item.uri.startsWith('spotify:episode:');
}

export function isLocal(item: { isLocal: boolean; uri: string }): boolean {
  return item.isLocal || item.uri.startsWith('spotify:local:');
}
