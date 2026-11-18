import { defineConfig } from 'vitest/config';

/**
 * Base pubblica dei file statici.
 * Senza variabile: `/` (sviluppo locale e app Mac, entrambi su http://127.0.0.1:5173/).
 * GitHub Pages: `/spotify-album-merge/`.
 * Sottocartella: per esempio `/scaffale/`, oppure `./` per percorsi relativi.
 */
function publicBase(): string {
  const raw = process.env.SCAFFALE_BASE?.trim();
  if (!raw) return '/';
  if (raw === '.' || raw === './') return './';
  if (/^https?:\/\//i.test(raw)) return raw.endsWith('/') ? raw : `${raw}/`;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.endsWith('/') ? withSlash : `${withSlash}/`;
}

export default defineConfig({
  base: publicBase(),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
