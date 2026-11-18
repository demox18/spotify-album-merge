# Scaffale

App personale, a schermo intero anche su iPhone, che sistema **una** libreria Spotify usando solo la [Web API ufficiale](https://developer.spotify.com/documentation/web-api). Non c’è un server, non c’è un database e il Client Secret non serve: è un sito statico. Niente viene scritto su Spotify finché non premi un bottone di conferma, dopo aver visto l’anteprima.

Uso personale e non commerciale, da parte di chi possiede l’app nel Developer Dashboard.

## Cosa fa

1. **Preferiti → playlist già esistente «Everything I Know».** Legge i Preferiti e la playlist, e accoda in fondo i brani il cui URI non c’è già, dal più vecchio `added_at` al più recente. Non riordina, non toglie, non tocca i duplicati già presenti e non crea una playlist sostitutiva. Se il nome non ha una sola corrispondenza esatta e modificabile, la scelta è tua.
2. **Album salvati → playlist privata «Dagli album · non nei Preferiti».** Legge gli album salvati e tutte le tracce (anche su più dischi), tiene un solo URI se un brano sta in più album, e toglie dal set gli URI che sono già nei Preferiti. Se una playlist tua ha quel nome esatto, accoda solo i mancanti e **mostra** i brani che non sono più nel set («non più previsti») senza cancellarli. Altrimenti crea la playlist privata.

I due obiettivi hanno due conferme separate. I brani degli album non finiscono mai in «Everything I Know».

Ripetere l’operazione, se nel frattempo non è cambiato nulla, non aggiunge nulla.

## Cosa segnala, invece di ignorarlo

- File locali (`is_local` o URI `spotify:local:`): elencati, non aggiunti.
- Brani nulli, non riproducibili o con restrizione: elencati, non aggiunti.
- Episodi: elencati a parte.
- Stesso ISRC ma URI diverso, nei Preferiti verso «Everything I Know»: «possibile stessa registrazione». **Per default non viene aggiunta.** Il toggle la include.
- Stesso ISRC ma URI diverso, dagli album verso un Preferito: elencata e **inclusa per default**. Il toggle la esclude. Senza ISRC questo confronto non scatta.
- Titolo, artista e durata vicini (entro 15 secondi), compresi live, remix e acoustic: solo «possibile versione alternativa». Non vengono mai fusi, né per titolo.

`GET /albums/{id}/tracks` restituisce tracce semplificate, **senza ISRC**. Il controllo ISRC degli album è un bottone a parte: una `GET /tracks/{id}` per traccia, in serie, annullabile. Non parte da solo, perché possono essere migliaia di richieste e la quota Dev Mode è facile da esaurire.

## Cosa non fa

Fuori da questa versione, e possibili passi successivi:

- pulizia dei duplicati già presenti in una playlist
- filtri per artista o album
- sincronizzazione periodica
- togliere cuori o altri elementi dalla libreria
- rinominare, riordinare o cancellare altre playlist
- scaricare l’audio

## Development Mode

Verificato sulla [guida di migrazione di febbraio 2026](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) e su [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), il 18 novembre 2026:

- Dal 11 febbraio 2026 le app Development Mode nuove hanno queste restrizioni; dal 9 marzo 2026 anche quelle già esistenti.
- Il proprietario dell’app deve avere **Spotify Premium**. Se l’abbonamento cade, l’app smette di rispondere e riprende quando torna Premium.
- Fino a **5 utenti** per app. Gli altri vanno aggiunti nell’allowlist (Users Management). Senza allowlist le chiamate possono rispondere 403. Tu, come proprietario, puoi usarla.
- La quota, distinta dal rate limit, risponde **429** con `error.reason = QUOTA_EXCEEDED`. Scaffale non ritenta quel caso.
- Il rate limit 429 senza quella reason rispetta `Retry-After` (in secondi). Oltre due minuti si ferma e il diario permette di riprendere.
- `GET /playlists/{id}/items` è leggibile solo se la playlist è tua o collaborativa.
- Il campo playlist `tracks` si chiama `items`, e il brano dentro la pagina è `item` (il vecchio `track` è deprecato: lo leggiamo solo se `item` manca).
- I batch `GET /tracks` e `GET /albums` non ci sono più. Si usa `GET /tracks/{id}` e `GET /albums/{id}/tracks`.
- `POST /users/{user_id}/playlists` è sostituito da `POST /me/playlists`.
- Su `GET /me`, in Dev Mode, non arrivano più `country`, `email`, `explicit_content`, `followers`, `product`. Scaffale legge solo `id` e `display_name` e non può mostrare se l’account è Premium.
- La guida, aggiornata a luglio 2026, porta il tetto di Client ID per sviluppatore a 25. Il tetto di 5 utenti per app resta.

`playlist-modify-public` serve **solo** se la playlist di destinazione è pubblica. Per una playlist privata basta `playlist-modify-private`. Lo chiediamo perché «Everything I Know» potrebbe essere pubblica: senza quel permesso Spotify risponde 403. Non chiediamo alcun permesso per togliere brani dalla libreria.

## Creare l’app nel dashboard

1. Apri [Spotify for Developers](https://developer.spotify.com/dashboard) ed entra con l’account Premium che possiederà l’app.
2. Crea un’app. Nome, per esempio: **Scaffale**. Descrizione: uso personale della tua libreria. Sito: l’URL HTTPS dove la pubblicherai, oppure `http://127.0.0.1:5173/` se per ora la provi solo in locale.
3. Spunta **Web API**. Non ti serve altro.
4. In Settings, Redirect URIs, aggiungi **entrambi**, se ti servono, copiandoli così come sono, barra finale compresa:
   - prova sul Mac: `http://127.0.0.1:5173/`
   - sito pubblicato: l’URL esatto dell’app, per esempio `https://tuosito.altervista.org/scaffale/`
5. Spotify accetta HTTPS, oppure il loopback `http://127.0.0.1:PORT` (anche `[::1]`). **`localhost` non è valido.** L’URI della richiesta deve coincidere con quello registrato, maiuscole e barra finale comprese. In locale la porta è fissa: 5173.
6. Copia il **Client ID** (32 caratteri esadecimali). Il Client Secret non va nell’app e non va incollato da nessuna parte.
7. Users Management: il tuo utente c’è già. Altri utenti, al massimo cinque in tutto, vanno invitati con la mail Spotify prima che possano usare l’app.

Poi apri Scaffale, incolla il Client ID, controlla l’URI di reindirizzamento e premi **Connetti Spotify**. I token restano in `localStorage` di quel browser. **Disconnetti** li cancella, insieme al diario di ripresa. Il Client ID resta, finché non lo cambi.

Su iPhone: Safari → Condividi → Aggiungi a Home. La PWA e Safari **non** condividono lo spazio locale: fai l’accesso nel posto in cui userai l’app. Se il login esce dall’icona e apre Safari, i token sono in Safari.

Il refresh token del dashboard dura 6 mesi e non si allunga quando rinnovi l’access token (circa un’ora). Quando scade, Scaffale ti chiede di connetterti di nuovo.

## Sul Mac

Serve Node 20 o più recente.

```bash
npm install
npm test
npm run dev
```

Apri [http://127.0.0.1:5173/](http://127.0.0.1:5173/). Non usare `localhost`.

`npm test` esegue Vitest sul modulo di diff, sulla paginazione e sul piano di scrittura, senza rete.

## Pubblicare la cartella statica

```bash
npm run build
```

Produce `dist/` e, nella root del repository, `dist.zip` con il contenuto di `dist/` (non una cartella annidata). Sono già file statici: HTML, JS, CSS, manifest, service worker, icone. `base` è relativo, quindi funzionano anche in una sottocartella.

### Altervista, via FTP

1. Entra in FTP nel sito HTTPS (Altervista fornisce il certificato sul dominio `*.altervista.org`).
2. Crea una cartella, per esempio `scaffale`.
3. Carica **il contenuto** di `dist/` (o estrai lì `dist.zip`), così che `index.html` stia in quella cartella.
4. L’URI da registrare nel dashboard è `https://tuosito.altervista.org/scaffale/` con la barra finale. Scaffale calcola da solo l’URI della cartella in cui si trova: se il dashboard ha un altro indirizzo, incollalo nel campo prima di connetterti. Devono essere identici.

### Vercel

Dalla cartella del progetto, con il CLI di Vercel, pubblica `dist` come sito statico, oppure importa il repository e imposta:

- build command: `npm run build`
- output directory: `dist`

L’URI di reindirizzamento è `https://il-tuo-progetto.vercel.app/` (barra finale). Aggiungilo nel dashboard prima del primo login.

## Come è diviso il codice

| Pezzo | Ruolo |
| --- | --- |
| `src/read/` | Paginazione e lettura. Nessuna scrittura. |
| `src/diff/` | Anteprima pura, senza rete: nomi, Preferiti, album, batch. |
| `src/apply/` | Crea o accoda solo dopo la conferma. Rilegge la playlist e verifica gli URI. |
| `src/spotify/client.ts` | HTTP, 429, quota, rinnovo del token. |
| `src/auth/` | PKCE e `localStorage`. |
| `src/ui/` | Interfaccia in italiano. |

Il diario in `localStorage` ricorda gli URI già confermati. Se una scrittura si interrompe, la ripresa **rilegge** la playlist e ricalcola cosa manca: non si fida dell’ultimo `snapshot_id`. Il successo è dichiarato solo se, dopo una nuova lettura, ogni URI previsto è presente.

Le aggiunte partono a gruppi di al massimo 100, senza `position`, quindi Spotify le accoda. L’ordine dei Preferiti è `added_at` crescente. L’ordine degli album è artista, album, data, disco, numero traccia.

## Endpoint verificati il 18 novembre 2026

Tutti sotto `https://api.spotify.com/v1`, salvo l’autorizzazione.

| Uso | Metodo e percorso | Cosa ho controllato |
| --- | --- | --- |
| Profilo | `GET /me` | [Get Current User's Profile](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile): `id`, `display_name`. `product` è deprecato e in Dev Mode la migration guide lo toglie. Non chiedo `user-read-email` né `user-read-private`. |
| Playlist | `GET /me/playlists` | [Get Current User's Playlists](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists): `limit` massimo 50. Conteggio in `items.total` (se manca, `tracks.total`). |
| Preferiti | `GET /me/tracks` | [Get User's Saved Tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks): `limit` massimo 50, `added_at`, oggetto `track` con `external_ids.isrc`. Scope `user-library-read`. |
| Album salvati | `GET /me/albums` | [Get User's Saved Albums](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-albums): `limit` massimo 50. |
| Tracce album | `GET /albums/{id}/tracks` | [Get Album Tracks](https://developer.spotify.com/documentation/web-api/reference/get-an-albums-tracks): pagina di `SimplifiedTrackObject`, con `disc_number` e `track_number`, **senza** `external_ids`. |
| Contenuto playlist | `GET /playlists/{id}/items` | [Get Playlist Items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items): `limit` massimo 50, `additional_types=track,episode`. 403 se non sei proprietario né collaboratore. Il brano sta in `item`. |
| ISRC opzionale | `GET /tracks/{id}` | La migration guide sostituisce il batch `GET /tracks` con una richiesta per id. Non uso `GET /tracks?ids=`. |
| Crea playlist | `POST /me/playlists` | [Create Playlist](https://developer.spotify.com/documentation/web-api/reference/create-playlist) e la migration guide (`POST /users/{id}/playlists` rimosso). Corpo: `name`, `public: false`, `collaborative: false`, `description`. |
| Accoda | `POST /playlists/{id}/items` | [Add Items to Playlist](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist): al massimo 100 URI. Senza `position` vengono accodati. Non uso più `/playlists/{id}/tracks`. |
| Login | Authorization Code + PKCE | [Code PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), [redirect URI](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri), [refresh](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens). `POST https://accounts.spotify.com/api/token` con `client_id` e `code_verifier`, senza `Authorization: Basic` e senza client secret. |
| Errori | 429 | [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) e [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits). |

Scope richiesti, e nessun altro: `user-library-read`, `playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-private`, `playlist-modify-public`.
