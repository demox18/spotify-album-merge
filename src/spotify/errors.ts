export class SpotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpotifyError';
  }
}

export class QuotaError extends SpotifyError {
  constructor() {
    super(
      'Quota di Development Mode esaurita (429 QUOTA_EXCEEDED). Non riprovo. Puoi riprendere più tardi: rileggerò la playlist e aggiungerò solo ciò che manca ancora.',
    );
    this.name = 'QuotaError';
  }
}

export class RateLimitError extends SpotifyError {
  readonly waitMs: number;

  constructor(waitMs: number) {
    super(`Limite di frequenza Spotify. Attesa richiesta: ${Math.ceil(waitMs / 1000)} secondi.`);
    this.name = 'RateLimitError';
    this.waitMs = waitMs;
  }
}

export class AmbiguousWriteError extends SpotifyError {
  constructor() {
    super(
      'La scrittura potrebbe essere arrivata a Spotify oppure no. Rileggo la playlist prima di riprovare, così non duplico i brani.',
    );
    this.name = 'AmbiguousWriteError';
  }
}

export class HttpError extends SpotifyError {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail ? `Errore Spotify ${status}: ${detail}` : `Errore Spotify ${status}.`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class AuthError extends SpotifyError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export type HttpClass = 'quota' | 'rate' | 'auth' | 'forbidden' | 'bad' | 'server' | 'other';

export function classifyHttp(status: number, body: unknown): HttpClass {
  if (status === 429) {
    const reason =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { reason?: unknown } }).error?.reason
        : undefined;
    return reason === 'QUOTA_EXCEEDED' ? 'quota' : 'rate';
  }
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 400) return 'bad';
  if (status >= 500) return 'server';
  return 'other';
}

export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 2000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return 2000;
}

export function publicErrorText(raw: string): string {
  return raw
    .replace(/access_token["']?\s*[:=]\s*["'][^"']+["']/gi, 'access_token:"[omesso]"')
    .replace(/refresh_token["']?\s*[:=]\s*["'][^"']+["']/gi, 'refresh_token:"[omesso]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [omesso]')
    .slice(0, 400);
}

export function messageFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as { error?: unknown; error_description?: unknown };
  if (typeof record.error_description === 'string') return publicErrorText(record.error_description);
  const nested = record.error;
  if (typeof nested === 'string') return publicErrorText(nested);
  if (nested && typeof nested === 'object') {
    const message = (nested as { message?: unknown }).message;
    const reason = (nested as { reason?: unknown }).reason;
    const parts = [typeof message === 'string' ? message : '', typeof reason === 'string' ? reason : ''].filter(Boolean);
    return publicErrorText(parts.join(' — '));
  }
  return '';
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
