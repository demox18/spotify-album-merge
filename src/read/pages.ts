import type { Page, Progress } from '../types';

export class IncompleteReadError extends Error {
  readonly fetched: number;
  readonly total: number;

  constructor(fetched: number, total: number) {
    super(`Lettura incompleta: ricevuti ${fetched} elementi su ${total}. Non calcolo l'anteprima su dati parziali.`);
    this.name = 'IncompleteReadError';
    this.fetched = fetched;
    this.total = total;
  }
}

export function reducePages<T>(pages: Page<T>[]): { items: T[]; total: number; complete: boolean } {
  if (pages.length === 0) return { items: [], total: 0, complete: false };
  const items = pages.flatMap((page) => page.items);
  const total = pages[pages.length - 1]?.total ?? 0;
  const last = pages[pages.length - 1];
  const complete = last.next === null && items.length === total && pages.every((page) => page.total === total);
  return { items, total, complete };
}

export async function followPages<T>(
  fetchPage: (url: string) => Promise<Page<T>>,
  firstUrl: string,
  hooks?: {
    onPage?: (progress: Progress) => void;
    signal?: AbortSignal;
    phase?: string;
  },
): Promise<T[]> {
  const pages: Page<T>[] = [];
  const seen = new Set<string>();
  let url: string | null = firstUrl;
  while (url) {
    if (hooks?.signal?.aborted) {
      throw new DOMException('Operazione annullata.', 'AbortError');
    }
    if (seen.has(url)) throw new Error('Paginazione ciclica: la stessa pagina è tornata due volte.');
    seen.add(url);
    if (seen.size > 20000) throw new Error('Paginazione troppo lunga.');
    const page = await fetchPage(url);
    if (!Array.isArray(page.items) || typeof page.total !== 'number') {
      throw new Error('Pagina Spotify senza items o total.');
    }
    pages.push({ items: page.items, total: page.total, next: page.next ?? null });
    const fetched = pages.reduce((sum, entry) => sum + entry.items.length, 0);
    hooks?.onPage?.({
      phase: hooks.phase ?? 'Lettura',
      done: fetched,
      total: page.total,
    });
    url = page.next ?? null;
  }
  const reduced = reducePages(pages);
  if (!reduced.complete) throw new IncompleteReadError(reduced.items.length, reduced.total);
  return reduced.items;
}
