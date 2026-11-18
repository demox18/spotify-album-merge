/** Nomi, permessi e percorsi usati dall'app. Nessun Client ID. */

export const APP_NAME = 'Scaffale';
export const APP_VERSION = '1.0.0';

export const EVERYTHING_PLAYLIST_NAME = 'Everything I Know';
export const ALBUM_PLAYLIST_NAME = 'Dagli album \u00b7 non nei Preferiti';

export const ALBUM_PLAYLIST_DESCRIPTION =
  'Brani degli album salvati che non sono nei Preferiti. Creata da Scaffale: solo aggiunte in coda, nessuna rimozione.';

/** Scope minimi. playlist-modify-public serve solo se la playlist di destinazione è pubblica. */
export const SCOPES = [
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
] as const;

export const API_BASE = 'https://api.spotify.com/v1';
export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export const PAGE_LIMIT = 50;
export const ADD_BATCH_SIZE = 100;

/** Soglia per segnalare una possibile versione alternativa. Non unisce nulla. */
export const ALTERNATIVE_DURATION_MS = 15_000;

/** Attesa massima automatica su un 429 di frequenza, poi ci si ferma e si riprende dopo. */
export const MAX_RATE_LIMIT_WAIT_MS = 120_000;

export const STORAGE_KEYS = {
  clientId: 'scaffale.clientId',
  redirectUri: 'scaffale.redirectUri',
  tokens: 'scaffale.tokens',
  pkce: 'scaffale.pkce',
  journal: 'scaffale.journal',
} as const;
