import {
  ALBUM_PLAYLIST_NAME,
  APP_NAME,
  APP_VERSION,
  EVERYTHING_PLAYLIST_NAME,
  SCOPES,
} from '../constants';
import {
  appBaseUrl,
  authorizeUrl,
  codeChallenge,
  createPkcePair,
  exchangeCode,
  grantedScopes,
  redirectRejectionReason,
  refreshTokens,
  tokenNeedsRefresh,
} from '../auth/pkce';
import {
  clearPkce,
  clearSession,
  readClientId,
  readJournal,
  readPkce,
  readRedirectOverride,
  readTokens,
  writeClientId,
  writeJournal,
  writePkce,
  writeRedirectOverride,
  writeTokens,
} from '../auth/storage';
import { applyAlbumGoal, applyLikedGoal } from '../apply/run';
import { diffAlbumPlaylist } from '../diff/albums';
import { membershipDiff } from '../diff/plan';
import { classifyEverythingPlaylists, decideAlbumTarget, editBlocker } from '../diff/names';
import { diffLikedIntoPlaylist } from '../diff/liked';
import { isSpotifyTrackUri } from '../diff/text';
import { collectLibrary, enrichAlbumIsrcs } from '../read/collect';
import { SpotifyClient } from '../spotify/client';
import { AuthError } from '../spotify/errors';
import type { ApplyReport, JournalEntry, Kv, Library, PlaylistSummary, Progress, SavedAlbum, TrackLike } from '../types';
import { clear, el } from './dom';
import { errorText, n, playlistHref, progressText, spotifyHref, trackLabel, when } from './format';

interface ResumePreview {
  goal: 'liked' | 'albums';
  playlistId: string | null;
  playlistName: string;
  missing: number;
  already: number;
}

interface Model {
  screen: 'settings' | 'home' | 'preview';
  clientId: string;
  redirectUri: string;
  user: { id: string; displayName: string } | null;
  library: Library | null;
  items: Map<string, TrackLike[]>;
  everythingId: string | null;
  albumId: string | null;
  includeLikedIsrc: boolean;
  includeAlbumIsrc: boolean;
  confirmLiked: boolean;
  confirmAlbums: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
  reports: { liked?: ApplyReport; albums?: ApplyReport };
  limits: Record<string, number>;
  resume: ResumePreview | null;
  filter: string;
}

export function startApp(root: HTMLElement): void {
  const opened = openStore();
  if (!opened) {
    root.replaceChildren(el('p', { text: 'Questo browser blocca il salvataggio locale. Scaffale non può tenere il Client ID né i token.' }));
    return;
  }
  const kv: Kv = opened;

  const model: Model = {
    screen: 'settings',
    clientId: readClientId(kv),
    redirectUri: readRedirectOverride(kv) || appBaseUrl(),
    user: null,
    library: null,
    items: new Map(),
    everythingId: null,
    albumId: null,
    includeLikedIsrc: false,
    includeAlbumIsrc: true,
    confirmLiked: false,
    confirmAlbums: false,
    busy: null,
    error: null,
    notice: null,
    reports: {},
    limits: {},
    resume: null,
    filter: '',
  };
  let abort: AbortController | null = null;

  const auth = {
    async accessToken(): Promise<string> {
      let tokens = readTokens(kv);
      if (!tokens) throw new AuthError('Non sei connesso.');
      if (tokenNeedsRefresh(tokens.expiresAt)) {
        const refreshed = await this.refresh();
        return refreshed;
      }
      return tokens.accessToken;
    },
    async refresh(): Promise<string> {
      const tokens = readTokens(kv);
      const clientId = readClientId(kv);
      if (!tokens || !clientId) throw new AuthError('Sessione assente. Connettiti di nuovo.');
      try {
        const next = await refreshTokens({ clientId, tokens });
        writeTokens(kv, next);
        return next.accessToken;
      } catch (error) {
        clearSession(kv);
        model.user = null;
        throw error;
      }
    },
  };

  function client(signal?: AbortSignal): SpotifyClient {
    return new SpotifyClient({
      auth,
      signal,
      onProgress: (progress) => setBusy(formatProgress(progress)),
    });
  }

  function setBusy(text: string | null): void {
    model.busy = text;
    const live = document.getElementById('live-progress');
    if (live) live.textContent = text ?? '';
    else draw();
  }

  function draw(): void {
    const scroll = document.scrollingElement?.scrollTop ?? 0;
    const active = document.activeElement;
    const filter =
      active instanceof HTMLInputElement && active.id === 'playlist-filter'
        ? { start: active.selectionStart, end: active.selectionEnd }
        : null;
    clear(root);
    root.append(shell());
    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
    if (filter) {
      const input = document.getElementById('playlist-filter');
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.setSelectionRange(filter.start, filter.end);
      }
    }
  }

  function shell(): HTMLElement {
    return el(
      'main',
      { class: 'app' },
      masthead(),
      model.error ? el('div', { class: 'banner error', attrs: { role: 'alert' }, text: model.error }) : null,
      model.notice ? el('div', { class: 'banner ok', text: model.notice }) : null,
      model.busy ? el('p', { class: 'progress', attrs: { id: 'live-progress', 'aria-live': 'polite' }, text: model.busy }) : el('p', { class: 'progress', attrs: { id: 'live-progress', 'aria-live': 'polite' } }),
      model.screen === 'settings' ? settingsView() : null,
      model.screen === 'home' ? homeView() : null,
      model.screen === 'preview' && model.library && model.user ? previewView(model.library, model.user) : null,
      el('p', { class: 'footer', text: `${APP_NAME} ${APP_VERSION} · uso personale · solo Web API ufficiale · niente viene scritto prima della conferma` }),
    );
  }

  function masthead(): HTMLElement {
    return el(
      'header',
      { class: 'masthead' },
      mark(),
      el(
        'div',
        {},
        el('h1', { text: APP_NAME }),
        el('p', { class: 'lede', text: 'Due playlist a partire dalla tua libreria. Prima l’anteprima, poi una conferma per ciascun obiettivo.' }),
      ),
    );
  }

  function settingsView(): HTMLElement {
    const redirectIssue = redirectRejectionReason(model.redirectUri);
    return el(
      'section',
      { class: 'card stack' },
      el('h2', { text: 'Collegamento' }),
      el('p', { class: 'hint', text: 'Il Client ID non è segreto, ma non è nel codice: lo incolli qui e resta in questo browser. Il Client Secret non serve e non va incollato.' }),
      el(
        'form',
        {
          class: 'stack',
          on: {
            submit: (event) => {
              event.preventDefault();
              void connect(false);
            },
          },
        },
        el(
          'label',
          { text: 'Client ID' },
          el('input', {
            attrs: {
              id: 'client-id',
              type: 'text',
              spellcheck: 'false',
              autocapitalize: 'off',
              autocomplete: 'off',
              inputmode: 'text',
              value: model.clientId,
              placeholder: '32 caratteri esadecimali',
            },
            on: {
              input: (event) => {
                model.clientId = (event.target as HTMLInputElement).value.trim();
              },
            },
          }),
        ),
        el(
          'label',
          { text: 'URI di reindirizzamento' },
          el('input', {
            attrs: { id: 'redirect-uri', type: 'url', spellcheck: 'false', value: model.redirectUri },
            on: {
              input: (event) => {
                model.redirectUri = (event.target as HTMLInputElement).value.trim();
              },
            },
          }),
        ),
        redirectIssue ? el('p', { class: 'banner warn', text: redirectIssue }) : null,
        el('p', { class: 'fine', text: 'Deve coincidere, carattere per carattere, con un URI nel dashboard Spotify. In locale: http://127.0.0.1:5173/ — Spotify rifiuta localhost. In rete serve HTTPS.' }),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'button', attrs: { type: 'submit' }, text: 'Connetti Spotify' }),
          el('button', {
            class: 'ghost',
            attrs: { type: 'button' },
            text: 'Copia URI',
            on: { click: () => void navigator.clipboard?.writeText(model.redirectUri) },
          }),
          readTokens(kv)
            ? el('button', { class: 'quiet', attrs: { type: 'button' }, text: 'Torna alla libreria', on: { click: () => { model.screen = model.library ? 'preview' : 'home'; model.error = null; draw(); } } })
            : null,
        ),
      ),
      el('h3', { text: 'Permessi richiesti' }),
      el('p', { class: 'hint', text: SCOPES.join(', ') }),
      el('p', { class: 'fine', text: 'playlist-modify-public serve solo se la playlist di destinazione è pubblica. Per una playlist privata basta playlist-modify-private. Lo chiediamo perché «Everything I Know» potrebbe essere pubblica: senza quel permesso Spotify risponde 403. Non chiediamo il permesso di togliere brani dalla libreria.' }),
      el('h3', { text: 'Development Mode' }),
      el('p', { class: 'fine', text: 'Il proprietario dell’app deve avere Spotify Premium. L’app accetta al massimo 5 utenti, già inseriti nell’allowlist. La quota risponde 429 con reason QUOTA_EXCEEDED: in quel caso mi fermo. GET /me non restituisce più il piano, quindi non posso verificarlo da qui.' }),
      el('h3', { text: 'iPhone' }),
      el('p', { class: 'fine', text: 'Funziona in Safari. Per la schermata Home: Condividi → Aggiungi a Home. Su iOS la PWA e Safari non condividono lo spazio locale: fai l’accesso nel contesto in cui userai l’app. Se il login esce dall’icona e apre Safari, i token restano in Safari.' }),
    );
  }

  function homeView(): HTMLElement {
    const journal = readJournal(kv);
    const tokens = readTokens(kv);
    const scopes = grantedScopes(tokens?.scope ?? '');
    const missing = SCOPES.filter((scope) => !scopes.includes(scope));
    return el(
      'section',
      { class: 'stack' },
      el(
        'div',
        { class: 'card' },
        el('h2', { text: model.user ? model.user.displayName : 'Connesso' }),
        el('p', { class: 'meta', text: model.user ? `id ${model.user.id}` : 'Profilo non ancora letto.' }),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'button', attrs: { type: 'button' }, text: 'Leggi la libreria', on: { click: () => void readLibrary() } }),
          el('button', { class: 'ghost', attrs: { type: 'button' }, text: 'Disconnetti', on: { click: disconnect } }),
          el('button', { class: 'quiet', attrs: { type: 'button' }, text: 'Client ID', on: { click: () => { model.screen = 'settings'; draw(); } } }),
        ),
      ),
      missing.length
        ? el('div', { class: 'banner warn' }, el('p', { text: `Mancano permessi: ${missing.join(', ')}.` }), el('button', { class: 'ghost', attrs: { type: 'button' }, text: 'Riconnetti', on: { click: () => void connect(true) } }))
        : null,
      journalCard(journal.liked),
      journalCard(journal.albums),
      model.resume ? resumeCard(model.resume) : null,
      el(
        'div',
        { class: 'card stack' },
        el('h2', { text: 'Cosa farà, dopo la conferma' }),
        el('p', { text: `1. Accoda a «${EVERYTHING_PLAYLIST_NAME}» i Preferiti che non ci sono già, dal più vecchio. Non crea una playlist sostitutiva, non riordina e non toglie nulla.` }),
        el('p', { text: `2. Crea, se non c’è già, la playlist privata «${ALBUM_PLAYLIST_NAME}» con i brani degli album salvati che non sono nei Preferiti. Non li mette in Everything I Know.` }),
      ),
    );
  }

  function journalCard(entry: JournalEntry | null): HTMLElement | null {
    if (!entry) return null;
    return el(
      'div',
      { class: 'card stack' },
      el('h3', { text: entry.goal === 'liked' ? 'Aggiunta ai Preferiti interrotta' : 'Aggiunta dagli album interrotta' }),
      el('p', { class: 'hint', text: `${entry.playlistName} · ${n(entry.intendedUris.length)} URI ancora nel diario · ${entry.playlistId ?? 'playlist da creare o da ritrovare'}` }),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'button', attrs: { type: 'button' }, text: 'Prepara la ripresa', on: { click: () => void prepareResume(entry) } }),
        el('button', { class: 'quiet', attrs: { type: 'button' }, text: 'Abbandona il diario', on: { click: () => dropJournal(entry.goal) } }),
      ),
    );
  }

  function resumeCard(resume: ResumePreview): HTMLElement {
    return el(
      'div',
      { class: 'card stack' },
      el('h3', { text: 'Ripresa, dopo la rilettura' }),
      el('p', { text: `${resume.playlistName}${resume.playlistId ? ` · ${resume.playlistId}` : ''}` }),
      el('p', { text: `Già presenti: ${n(resume.already)}. Ancora da aggiungere: ${n(resume.missing)}. Non parto finché non confermi.` }),
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'button',
          attrs: { type: 'button' },
          text: resume.missing === 0 ? 'Niente da aggiungere' : `Riprendi: aggiungi ${n(resume.missing)}`,
          on: { click: () => void confirmResume(resume) },
        }),
      ),
    );
  }

  function previewView(library: Library, user: { id: string; displayName: string }): HTMLElement {
    const scopes = grantedScopes(readTokens(kv)?.scope ?? '');
    const classified = classifyEverythingPlaylists(library.playlists, user.id);
    const selected = library.playlists.find((playlist) => playlist.id === model.everythingId) ?? null;
    const everythingItems = selected ? model.items.get(selected.id) ?? null : null;
    const likedDiff = everythingItems ? diffLikedIntoPlaylist({ liked: library.liked, playlistItems: everythingItems, includeIsrcMatches: model.includeLikedIsrc }) : null;
    const albumDecision = decideAlbumTarget(library.playlists, user.id);
    const albumSelected = albumDecision.mode === 'update'
      ? library.playlists.find((playlist) => playlist.id === (model.albumId ?? (albumDecision.ownedExact.length === 1 ? albumDecision.ownedExact[0].id : ''))) ?? null
      : null;
    const albumReady = albumDecision.mode === 'create' || (albumSelected !== null && model.items.has(albumSelected.id));
    const albumItems = albumSelected && model.items.has(albumSelected.id) ? model.items.get(albumSelected.id) ?? [] : [];
    const albumDiff = diffAlbumPlaylist({
      albums: library.albums,
      liked: library.liked,
      playlistItems: albumReady ? albumItems : [],
      includeIsrcMatches: model.includeAlbumIsrc,
    });
    const rawTracks = library.albums.reduce((sum, album) => sum + album.tracks.length, 0);
    const everythingBlocker = selected ? editBlocker(selected, user.id, scopes) : 'Scegli la playlist.';
    const albumBlocker = albumGoalBlocker(albumDecision.mode, albumSelected, user.id, scopes);

    return el(
      'div',
      {},
      el(
        'section',
        { class: 'card' },
        el('h2', { text: 'Anteprima' }),
        el('p', { class: 'meta', text: `${user.displayName} · ${user.id}` }),
        el(
          'div',
          { class: 'stats' },
          stat(library.liked.length, 'Preferiti letti'),
          stat(library.albums.filter((album) => !album.unavailable).length, 'Album salvati'),
          stat(rawTracks, 'Tracce degli album'),
          stat(albumDiff.uniqueCatalog.length, 'Tracce album uniche'),
          stat(likedDiff ? likedDiff.toAdd.length : 0, 'Da aggiungere a Everything I Know'),
          stat(albumDiff.computedSet.length, 'Set playlist album'),
          stat(albumDiff.excludedLiked.length, 'Escluse, già nei Preferiti'),
          stat(albumDiff.ambiguousIsrc.length + (likedDiff?.ambiguousIsrc.length ?? 0), 'Casi ISRC ambigui'),
        ),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'ghost', attrs: { type: 'button' }, text: 'Rileggi', on: { click: () => void readLibrary() } }),
          el('button', { class: 'quiet', attrs: { type: 'button' }, text: 'Disconnetti', on: { click: disconnect } }),
          model.busy ? el('button', { class: 'quiet', attrs: { type: 'button' }, text: 'Annulla', on: { click: () => abort?.abort() } }) : null,
        ),
      ),
      reportCard('Everything I Know', model.reports.liked),
      reportCard(ALBUM_PLAYLIST_NAME, model.reports.albums),
      everythingSection(library, user.id, classified, selected, likedDiff, everythingBlocker),
      albumSection(user.id, albumDecision, albumSelected, albumDiff, albumReady, albumBlocker),
    );
  }

  function everythingSection(
    library: Library,
    meId: string,
    classified: ReturnType<typeof classifyEverythingPlaylists>,
    selected: PlaylistSummary | null,
    diff: ReturnType<typeof diffLikedIntoPlaylist> | null,
    blocker: string | null,
  ): HTMLElement {
    const query = model.filter.trim().toLocaleLowerCase('it');
    const pinned = [...classified.exact, ...classified.near];
    const pinnedIds = new Set(pinned.map((playlist) => playlist.id));
    const rest = library.playlists.filter((playlist) => !pinnedIds.has(playlist.id) && (!query || playlist.name.toLocaleLowerCase('it').includes(query))).slice(0, 80);
    return el(
      'section',
      { class: 'card stack' },
      el('h2', { text: '1. Preferiti → Everything I Know' }),
      el('p', { class: 'hint', text: 'Confronto per URI. Stesso ISRC e URI diverso: «possibile stessa registrazione». Per default non la aggiungo, finché non accendi il toggle. I duplicati già in playlist restano dov’ sono.' }),
      classified.autoSelectId
        ? el('p', { class: 'fine', text: 'C’è una sola corrispondenza esatta modificabile: è già selezionata. Puoi cambiarla.' })
        : el('p', { class: 'banner warn', text: 'Non c’è una sola corrispondenza esatta modificabile. Scegli tu. Non creo una playlist nuova al posto di questa.' }),
      ...pinned.map((playlist) => playlistChoice(playlist, meId, 'everything')),
      el('input', {
        attrs: { id: 'playlist-filter', type: 'text', placeholder: 'Cerca tra le altre playlist', value: model.filter },
        on: { input: (event) => { model.filter = (event.target as HTMLInputElement).value; draw(); } },
      }),
      ...rest.map((playlist) => playlistChoice(playlist, meId, 'everything')),
      selected ? el('p', { class: 'meta', text: `Destinazione: ${selected.name} · ${selected.id} · ${selected.ownerName} (${selected.ownerId}) · ${selected.collaborative ? 'collaborativa' : 'non collaborativa'} · ${visibility(selected)} · ${selected.trackCount === null ? 'conteggio assente' : `${n(selected.trackCount)} elementi`}` }) : null,
      selected ? el('a', { attrs: { href: playlistHref(selected.id), target: '_blank', rel: 'noreferrer' }, text: 'Apri la playlist su Spotify' }) : null,
      el(
        'label',
        { class: 'check' },
        el('input', {
          attrs: { type: 'checkbox', ...(model.includeLikedIsrc ? { checked: 'checked' } : {}) },
          on: { change: (event) => { model.includeLikedIsrc = (event.target as HTMLInputElement).checked; model.confirmLiked = false; draw(); } },
        }),
        'Aggiungi anche le possibili stesse registrazioni (stesso ISRC, URI diverso). Spento: non le aggiungo.',
      ),
      diff ? likedSummary(diff) : selected ? el('p', { text: 'Leggo il contenuto della playlist…' }) : null,
      blocker ? el('p', { class: 'banner warn', text: blocker }) : null,
      diff && diff.toAdd.length > 0
        ? el(
            'label',
            { class: 'check' },
            el('input', {
              attrs: { type: 'checkbox', ...(model.confirmLiked ? { checked: 'checked' } : {}) },
              on: { change: (event) => { model.confirmLiked = (event.target as HTMLInputElement).checked; draw(); } },
            }),
            'Confermo: accoda solo questi brani, dal Preferito più vecchio. Non riordinare e non togliere nulla.',
          )
        : null,
      el('button', {
        class: 'button',
        attrs: { type: 'button', ...(model.confirmLiked && diff && diff.toAdd.length > 0 && !blocker && !model.busy ? {} : { disabled: 'disabled' }) },
        text: diff && diff.toAdd.length > 0 ? `Conferma: aggiungi ${n(diff.toAdd.length)} brani` : 'Niente da aggiungere a questa playlist',
        on: { click: () => void confirmLiked(selected, diff) },
      }),
    );
  }

  function albumSection(
    meId: string,
    decision: ReturnType<typeof decideAlbumTarget>,
    selected: PlaylistSummary | null,
    diff: ReturnType<typeof diffAlbumPlaylist>,
    ready: boolean,
    blocker: string | null,
  ): HTMLElement {
    const missingIsrc = new Set(diff.uniqueCatalog.filter((track) => track.id && !track.isrc).map((track) => track.id)).size;
    return el(
      'section',
      { class: 'card stack' },
      el('h2', { text: `2. Album salvati → ${ALBUM_PLAYLIST_NAME}` }),
      el('p', {
        class: 'hint',
        text: decision.mode === 'create'
          ? 'Non esiste una playlist tua con questo nome esatto. Se confermi, la creo privata (public: false) e ci accodo i brani. Non svuoto nulla e non tocco Everything I Know.'
          : 'Esiste già una playlist tua con il nome esatto. Non la svuoto. Mostro cosa aggiungere in coda e cosa non è più nel set: quelle uscite sono solo un elenco, non le tolgo.',
      }),
      decision.near.length
        ? el('p', { class: 'banner warn', text: `Nomi simili, che non userò al posto del nome esatto: ${decision.near.map((playlist) => playlist.name).join(', ')}.` })
        : null,
      ...decision.ownedExact.map((playlist) => playlistChoice(playlist, meId, 'albums')),
      selected ? el('p', { class: 'meta', text: `Aggiorno: ${selected.name} · ${selected.id}` }) : el('p', { class: 'meta', text: 'Operazione: creare la playlist privata.' }),
      el('p', { class: 'fine', text: ready
        ? `Tracce lette ${n(diff.rawTrackCount)}, uniche ${n(diff.uniqueCatalog.length)}, escluse perché già nei Preferiti ${n(diff.excludedLiked.length)}, nel set ${n(diff.computedSet.length)}, da aggiungere ${n(diff.toAdd.length)}, già in playlist ${n(diff.alreadyInPlaylist.length)}, non più previsti ${n(diff.noLongerExpected.length)}.`
        : `Tracce lette ${n(diff.rawTrackCount)}, uniche ${n(diff.uniqueCatalog.length)}, escluse perché già nei Preferiti ${n(diff.excludedLiked.length)}, nel set ${n(diff.computedSet.length)}. Scelgo la playlist e la leggo prima di dire cosa accodare.` }),
      el('p', { class: 'fine', text: 'GET /albums/{id}/tracks non include l’ISRC. Senza il passo opzionale qui sotto non segno ambiguità ISRC sugli album: il brano entra se l’URI non è già nei Preferiti. Titolo, artista e durata simili diventano solo «possibile versione alternativa», mai un’esclusione. Live, remix e acoustic non si fondono.' }),
      el(
        'label',
        { class: 'check' },
        el('input', {
          attrs: { type: 'checkbox', ...(model.includeAlbumIsrc ? { checked: 'checked' } : {}) },
          on: { change: (event) => { model.includeAlbumIsrc = (event.target as HTMLInputElement).checked; model.confirmAlbums = false; draw(); } },
        }),
        'Includi i brani con lo stesso ISRC di un Preferito ma URI diverso. Acceso per default: li aggiungo e li elenco. Se lo spegni, non li aggiungo.',
      ),
      el('p', { class: 'fine', text: `${n(missingIsrc)} tracce album hanno un id e non hanno ancora un ISRC.` }),
      el('button', {
        class: 'ghost',
        attrs: { type: 'button', ...(model.busy ? { disabled: 'disabled' } : {}) },
        text: `Cerca gli ISRC mancanti (${n(missingIsrc)} richieste, opzionale)`,
        on: { click: () => { if (model.library) void enrich(model.library.albums); } },
      }),
      listBlock('Possibile stessa registrazione (ISRC)', diff.ambiguousIsrc.map((entry) => entry.liked), 'album-isrc'),
      listBlock('Possibile versione alternativa — solo segnalata', diff.alternatives.map((entry) => entry.albumTrack), 'album-alt', diff.alternatives.map((entry) => entry.reason)),
      listBlock('File locali', diff.local, 'album-local'),
      listBlock('Non disponibili', [...diff.unavailable, ...diff.unavailableAlbums.map(albumAsTrack)], 'album-missing'),
      ...(ready
        ? [
            listBlock('Da aggiungere', diff.toAdd, 'album-add'),
            listBlock('Non più previsti — non li tolgo', diff.noLongerExpected, 'album-stale'),
            listBlock('Episodi nella playlist', diff.playlistEpisodes, 'album-episodes'),
          ]
        : []),
      blocker ? el('p', { class: 'banner warn', text: blocker }) : null,
      ready && diff.toAdd.length > 0
        ? el(
            'label',
            { class: 'check' },
            el('input', {
              attrs: { type: 'checkbox', ...(model.confirmAlbums ? { checked: 'checked' } : {}) },
              on: { change: (event) => { model.confirmAlbums = (event.target as HTMLInputElement).checked; draw(); } },
            }),
            decision.mode === 'create'
              ? 'Confermo: crea la playlist privata e accoda solo questi brani. Non toccare Everything I Know e non togliere nulla.'
              : 'Confermo: accoda i brani mancanti. I «non più previsti» restano nella playlist.',
          )
        : el('p', { class: 'fine', text: !ready ? 'In attesa della playlist scelta.' : decision.mode === 'create' ? 'Nessun brano da mettere: non creo una playlist vuota.' : 'Niente di nuovo da accodare. Se rilanci l’operazione, non aggiungo duplicati.' }),
      el('button', {
        class: 'button',
        attrs: { type: 'button', ...(model.confirmAlbums && ready && diff.toAdd.length > 0 && !blocker && !model.busy ? {} : { disabled: 'disabled' }) },
        text: !ready ? 'Scegli la playlist' : decision.mode === 'create' ? `Conferma: crea la playlist privata e aggiungi ${n(diff.toAdd.length)}` : `Conferma: aggiungi ${n(diff.toAdd.length)} in coda`,
        on: { click: () => { if (ready) void confirmAlbums(decision.mode === 'update' ? selected : null, diff); } },
      }),
    );
  }

  function playlistChoice(playlist: PlaylistSummary, meId: string, goal: 'everything' | 'albums'): HTMLElement {
    const checked = goal === 'everything' ? model.everythingId === playlist.id : model.albumId === playlist.id;
    return el(
      'label',
      { class: 'choice' },
      el('input', {
        attrs: { type: 'radio', name: goal, value: playlist.id, ...(checked ? { checked: 'checked' } : {}) },
        on: { change: () => void pickPlaylist(goal, playlist.id) },
      }),
      el(
        'span',
        {},
        el('strong', { text: playlist.name }),
        el('span', { class: 'meta', text: ` · ${playlist.ownerName} (${playlist.ownerId}) · ${playlist.collaborative ? 'collaborativa' : 'non collaborativa'} · ${visibility(playlist)} · ${playlist.trackCount === null ? 'conteggio non disponibile' : `${n(playlist.trackCount)} elementi`} · ${playlist.ownerId === meId || playlist.collaborative ? 'modificabile' : 'non modificabile'} · ${playlist.id}` }),
      ),
    );
  }

  function likedSummary(diff: ReturnType<typeof diffLikedIntoPlaylist>): HTMLElement {
    return el(
      'div',
      {},
      el('p', { class: 'fine', text: `Da aggiungere ${n(diff.toAdd.length)}, già presenti ${n(diff.alreadyPresent.length)}, tenuti fuori per ISRC ${n(diff.heldBackByIsrc.length)}, file locali ${n(diff.local.length)}, non disponibili ${n(diff.unavailable.length)}, episodi ${n(diff.episodes.length + diff.playlistEpisodes.length)}, duplicati già in playlist ${n(diff.playlistDuplicateUris.length)} (non li tocco).` }),
      listBlock('Da aggiungere, dal più vecchio', diff.toAdd, 'liked-add'),
      listBlock('Possibile stessa registrazione', diff.ambiguousIsrc.map((entry) => entry.liked), 'liked-isrc'),
      listBlock('File locali nei Preferiti', diff.local, 'liked-local'),
      listBlock('Non disponibili nei Preferiti', diff.unavailable, 'liked-missing'),
      listBlock('Episodi', [...diff.episodes, ...diff.playlistEpisodes], 'liked-episodes'),
      listBlock('File locali già nella playlist', diff.playlistLocal, 'liked-plocal'),
    );
  }

  function listBlock(title: string, tracks: TrackLike[], key: string, notes?: string[]): HTMLElement {
    const limit = model.limits[key] ?? 40;
    const shown = tracks.slice(0, limit);
    return el(
      'details',
      {},
      el('summary', { text: `${title} (${n(tracks.length)})` }),
      tracks.length === 0 ? el('p', { class: 'fine', text: 'Nessuno.' }) : null,
      el(
        'ol',
        { class: 'track-list' },
        ...shown.map((track, index) => {
          const href = spotifyHref(track);
          return el(
            'li',
            {},
            href
              ? el('a', { attrs: { href, target: '_blank', rel: 'noreferrer' }, text: trackLabel(track) })
              : trackLabel(track),
            el('span', { class: 'meta', text: ` · ${when(track.addedAt)}${track.isrc ? ` · ISRC ${track.isrc}` : ''}${notes?.[index] ? ` · ${notes[index]}` : ''}` }),
          );
        }),
      ),
      tracks.length > shown.length
        ? el('button', { class: 'quiet', attrs: { type: 'button' }, text: 'Mostra altri', on: { click: () => { model.limits[key] = limit + 40; draw(); } } })
        : null,
    );
  }

  function reportCard(title: string, report: ApplyReport | undefined): HTMLElement | null {
    if (!report) return null;
    const tone = report.verifiedComplete ? 'banner ok' : 'banner error';
    const lead = report.verifiedComplete
      ? `Verifica dopo rilettura di «${title}»: tutti gli URI previsti sono nella playlist.`
      : `Non è un successo. Dopo la rilettura di «${title}» mancano ${n(report.missing.length)} URI. Il diario, se c’è ancora, serve a riprendere senza duplicare.`;
    return el(
      'div',
      { class: tone },
      el('p', { text: lead }),
      el('p', { text: `Aggiunti ${n(report.added.length)}. Già presenti ${n(report.alreadyPresent.length)}. Mancanti ${n(report.missing.length)}. Errori ${n(report.errors.length)}. Playlist ${report.playlistId}${report.createdPlaylist ? ' · creata privata' : ''}.` }),
    );
  }

  async function connect(showDialog: boolean): Promise<void> {
    model.error = null;
    const clientId = model.clientId.trim();
    const redirectUri = model.redirectUri.trim();
    const rejection = redirectRejectionReason(redirectUri);
    if (rejection) {
      model.error = rejection;
      draw();
      return;
    }
    try {
      writeClientId(kv, clientId);
      writeRedirectOverride(kv, redirectUri === appBaseUrl() ? '' : redirectUri);
      const pair = createPkcePair();
      writePkce(kv, { ...pair, redirectUri });
      const url = await authorizeUrl({
        clientId,
        redirectUri,
        challenge: await codeChallenge(pair.verifier),
        state: pair.state,
        showDialog,
      });
      window.location.assign(url);
    } catch (error) {
      clearPkce(kv);
      model.error = errorText(error);
      draw();
    }
  }

  function disconnect(): void {
    abort?.abort();
    clearSession(kv);
    model.user = null;
    model.library = null;
    model.items.clear();
    model.reports = {};
    model.screen = 'settings';
    model.notice = 'Token e diario cancellati da questo browser. Il Client ID è rimasto.';
    model.error = null;
    draw();
  }

  async function readLibrary(): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    model.error = null;
    model.notice = null;
    model.library = null;
    model.items.clear();
    model.screen = 'home';
    setBusy('Inizio la lettura. Non scrivo nulla.');
    draw();
    try {
      const api = client(abort.signal);
      model.user = await api.getMe();
      const library = await collectLibrary(api, {
        signal: abort.signal,
        onProgress: (progress) => setBusy(formatProgress(progress)),
      });
      model.library = library;
      const classified = classifyEverythingPlaylists(library.playlists, model.user.id);
      model.everythingId = classified.autoSelectId;
      const albumDecision = decideAlbumTarget(library.playlists, model.user.id);
      model.albumId = albumDecision.ownedExact.length === 1 ? albumDecision.ownedExact[0].id : null;
      model.screen = 'preview';
      model.busy = null;
      draw();
      if (model.everythingId) await loadItems(model.everythingId);
      if (model.albumId) await loadItems(model.albumId);
    } catch (error) {
      model.busy = null;
      model.error = errorText(error);
      model.screen = model.library ? 'preview' : 'home';
      draw();
    }
  }

  async function loadItems(playlistId: string): Promise<void> {
    if (model.items.has(playlistId)) return;
    abort?.abort();
    abort = new AbortController();
    setBusy('Leggo il contenuto della playlist scelta.');
    try {
      const items = await client(abort.signal).listPlaylistItems(playlistId);
      model.items.set(playlistId, items);
      model.busy = null;
      draw();
    } catch (error) {
      model.busy = null;
      model.error = errorText(error);
      draw();
    }
  }

  async function pickPlaylist(goal: 'everything' | 'albums', playlistId: string): Promise<void> {
    if (goal === 'everything') {
      model.everythingId = playlistId;
      model.confirmLiked = false;
    } else {
      model.albumId = playlistId;
      model.confirmAlbums = false;
    }
    draw();
    await loadItems(playlistId);
  }

  async function enrich(albums: SavedAlbum[]): Promise<void> {
    const count = new Set(albums.flatMap((album) => album.tracks.filter((track) => track.id && !track.isrc).map((track) => track.id))).size;
    if (count === 0) {
      model.notice = 'Non ci sono ISRC mancanti da cercare.';
      draw();
      return;
    }
    if (!window.confirm(`Parto con ${count} richieste GET /tracks/{id}, una alla volta. Può consumare la quota Dev Mode. Continuo?`)) return;
    abort?.abort();
    abort = new AbortController();
    model.error = null;
    try {
      const result = await enrichAlbumIsrcs(client(abort.signal), albums, {
        signal: abort.signal,
        onProgress: (progress) => setBusy(formatProgress(progress)),
      });
      model.notice = `ISRC controllati: ${n(result.requested)}. Trovati: ${n(result.found)}. Senza ISRC o in errore: ${n(result.failed)}.`;
      model.busy = null;
      draw();
    } catch (error) {
      model.busy = null;
      model.error = errorText(error);
      draw();
    }
  }

  async function confirmLiked(playlist: PlaylistSummary | null, diff: ReturnType<typeof diffLikedIntoPlaylist> | null): Promise<void> {
    if (!playlist || !diff || !model.user || !model.confirmLiked) return;
    await runWrite('liked', async (signal) =>
      applyLikedGoal(client(signal), {
        playlistId: playlist.id,
        playlistName: playlist.name,
        ownerId: model.user!.id,
        intendedUris: diff.toAdd.map((track) => track.uri).filter(isSpotifyTrackUri),
        hooks: hooks(signal),
      }),
    );
  }

  async function confirmAlbums(playlist: PlaylistSummary | null, diff: ReturnType<typeof diffAlbumPlaylist>): Promise<void> {
    if (!model.user || !model.confirmAlbums) return;
    await runWrite('albums', async (signal) =>
      applyAlbumGoal(client(signal), {
        existingPlaylistId: playlist?.id ?? null,
        ownerId: model.user!.id,
        intendedUris: diff.toAdd.map((track) => track.uri).filter(isSpotifyTrackUri),
        hooks: hooks(signal),
      }),
    );
  }

  async function prepareResume(entry: JournalEntry): Promise<void> {
    model.error = null;
    if (!entry.playlistId) {
      model.resume = { goal: entry.goal, playlistId: null, playlistName: entry.playlistName, missing: entry.intendedUris.length, already: 0 };
      draw();
      return;
    }
    abort?.abort();
    abort = new AbortController();
    setBusy('Rileggo la playlist prima di proporti la ripresa.');
    draw();
    try {
      const items = await client(abort.signal).listPlaylistItems(entry.playlistId);
      const present = items.map((item) => item.uri);
      const plan = membershipDiff(entry.intendedUris, present);
      model.resume = {
        goal: entry.goal,
        playlistId: entry.playlistId,
        playlistName: entry.playlistName,
        missing: plan.missing.length,
        already: plan.alreadyPresent.length,
      };
      model.busy = null;
      draw();
    } catch (error) {
      model.busy = null;
      model.error = errorText(error);
      draw();
    }
  }

  async function confirmResume(resume: ResumePreview): Promise<void> {
    const entry = readJournal(kv)[resume.goal];
    if (!entry) return;
    if (!model.user) {
      try {
        model.user = await client().getMe();
      } catch (error) {
        model.error = errorText(error);
        draw();
        return;
      }
    }
    if (resume.missing === 0 && resume.playlistId) {
      dropJournal(resume.goal);
      model.notice = 'La rilettura dice che quegli URI ci sono già. Non scrivo.';
      draw();
      return;
    }
    await runWrite(resume.goal, async (signal) => {
      if (resume.goal === 'liked') {
        if (!entry.playlistId) throw new Error('Il diario dei Preferiti non ha una playlist. Non ne creo una.');
        return applyLikedGoal(client(signal), {
          playlistId: entry.playlistId,
          playlistName: entry.playlistName,
          ownerId: entry.ownerId,
          intendedUris: entry.intendedUris,
          hooks: hooks(signal),
        });
      }
      return applyAlbumGoal(client(signal), {
        existingPlaylistId: entry.playlistId,
        ownerId: entry.ownerId,
        intendedUris: entry.intendedUris,
        hooks: hooks(signal),
      });
    });
    model.resume = null;
  }

  async function runWrite(goal: 'liked' | 'albums', task: (signal: AbortSignal) => Promise<ApplyReport>): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    model.error = null;
    model.notice = null;
    setBusy('Scrittura solo dopo questa conferma. Rileggo la playlist.');
    draw();
    try {
      const report = await task(abort.signal);
      model.reports[goal] = report;
      model.busy = null;
      model.confirmLiked = false;
      model.confirmAlbums = false;
      if (model.items.has(report.playlistId)) model.items.delete(report.playlistId);
      model.screen = model.library ? 'preview' : 'home';
      draw();
      if (model.library) await loadItems(report.playlistId);
    } catch (error) {
      model.busy = null;
      model.error = errorText(error);
      draw();
    }
  }

  function hooks(signal: AbortSignal) {
    return {
      kv,
      signal,
      onProgress: (progress: Progress) => setBusy(formatProgress(progress)),
    };
  }

  function dropJournal(goal: 'liked' | 'albums'): void {
    const journal = readJournal(kv);
    journal[goal] = null;
    writeJournal(kv, journal);
    model.resume = null;
    model.notice = 'Diario abbandonato. Non ho scritto su Spotify.';
    draw();
  }

  async function finishRedirect(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthError = params.get('error');
    const state = params.get('state');
    if (code || oauthError) history.replaceState({}, '', appBaseUrl());
    if (oauthError) model.error = oauthError === 'access_denied' ? 'Accesso negato su Spotify.' : `Spotify ha risposto: ${oauthError}.`;
    if (code) {
      const pkce = readPkce(kv);
      clearPkce(kv);
      if (!pkce || pkce.state !== state) model.error = 'Controllo state non superato. Riprova da Connetti.';
      else {
        try {
          const tokens = await exchangeCode({
            clientId: readClientId(kv),
            redirectUri: pkce.redirectUri,
            code,
            verifier: pkce.verifier,
          });
          writeTokens(kv, tokens);
        } catch (error) {
          model.error = errorText(error);
        }
      }
    }
    if (readTokens(kv)) {
      try {
        model.user = await client().getMe();
        model.screen = 'home';
      } catch (error) {
        model.error = errorText(error);
        model.screen = 'settings';
      }
    }
    draw();
  }

  void finishRedirect();
}

function openStore(): Kv | null {
  try {
    localStorage.setItem('scaffale.probe', '1');
    localStorage.removeItem('scaffale.probe');
    return localStorage;
  } catch {
    return null;
  }
}

function formatProgress(progress: Progress): string {
  return progressText(progress.phase, progress.done, progress.total, progress.detail);
}

function stat(value: number, label: string): HTMLElement {
  return el('div', { class: 'stat' }, el('b', { text: n(value) }), el('span', { text: label }));
}

function visibility(playlist: PlaylistSummary): string {
  if (playlist.public === true) return 'pubblica';
  if (playlist.public === false) return 'privata';
  return 'visibilità non indicata';
}

function albumGoalBlocker(
  mode: 'create' | 'update',
  playlist: PlaylistSummary | null,
  meId: string,
  scopes: string[],
): string | null {
  if (mode === 'create' && !scopes.includes('playlist-modify-private')) {
    return 'Per creare la playlist privata serve playlist-modify-private.';
  }
  if (mode === 'update') {
    if (!playlist) return 'C’è più di una playlist tua con quel nome esatto. Scegline una. Non ne creo un’altra.';
    return editBlocker(playlist, meId, scopes);
  }
  return null;
}

function albumAsTrack(album: { name: string }): TrackLike {
  return {
    uri: '',
    id: null,
    name: album.name,
    artists: [],
    primaryArtist: '',
    albumName: album.name,
    durationMs: 0,
    isrc: null,
    isLocal: false,
    unavailable: true,
    restriction: null,
    kind: 'unknown',
    discNumber: 0,
    trackNumber: 0,
    addedAt: null,
  };
}

function mark(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<rect width="64" height="64" rx="16" fill="#1d3c34"/><circle cx="32" cy="32" r="22" fill="#f4efe4"/><circle cx="32" cy="32" r="15" fill="none" stroke="#24584c" stroke-width="1.6"/><circle cx="32" cy="32" r="9" fill="none" stroke="#24584c" stroke-width="1.6"/><circle cx="32" cy="32" r="4.2" fill="#c4512c"/><circle cx="32" cy="32" r="1.5" fill="#1d3c34"/>';
  return svg;
}
