# Lectio — prototipo 0.2 (versione gratuita)

Lectio trascrive le lezioni in diretta sull'iPhone con Whisper, ripulisce il testo direttamente sul telefono e lo inserisce nel Google Doc "Appunti lezione", nella scheda della materia e sotto la data del giorno. Funziona anche su Windows, da Chrome o Edge.

**Costo: zero.** GitHub Pages, Whisper e l'accesso a Google Docs sono gratuiti, e non si usano API a pagamento.

L'audio non viene mai salvato: Whisper lo trascrive sul telefono e lo scarta. Il testo va solo nel tuo documento Google. Una copia resta sul dispositivo per 30 giorni, come sicurezza.

## Come funziona una mattinata

1. Apri Lectio e premi **Avvia**. Dall'orario capisce che lezione è.
2. Le materie da trascrivere vengono trascritte. Quelle che scrivi a mano (ora Costituzionale) e le pause vengono saltate, con il microfono in attesa. A ogni cambio di fascia Lectio chiude la lezione e apre la successiva da sola. Dopo l'ultima fascia si spegne.
3. Durante la lezione il testo viene ripulito sul telefono, a blocchi di circa un minuto. Lectio toglie le esitazioni ("ehm", "uhm") e le ripetizioni ("il il", "la riserva la riserva"), corregge con il glossario della materia i termini storpiati ("comizia centuriata" → "comitia centuriata", "lex ortensia" → "lex Hortensia", "grund norm" → "Grundnorm"), sistema maiuscole e punti e divide in paragrafi. Non riassume e non riscrive nulla: la rielaborazione vera la fa la tua attività che legge gli appunti.
4. A fine lezione la trovi in **Da inviare**. La rivedi (puoi correggerla) e premi **Invia**. In Impostazioni puoi anche attivare l'invio automatico.
5. Il testo entra nella scheda della materia, sotto la data. Se la data non c'è, Lectio la crea nello stesso formato e stile delle altre, in ordine cronologico. Non modifica né cancella mai nulla di ciò che c'è già, e un secondo invio della stessa lezione non crea doppioni.

Con **Cambia materia** puoi forzare una materia diversa per la fascia in corso, oppure registrare fuori orario.

## Installazione (una volta sola, circa 20 minuti, dal PC)

### 1. Pubblicare l'app su GitHub Pages (gratis)

Fallo dal PC, con Chrome o Edge.

1. **Estrai lo zip.** Tasto destro su `lectio-v0.2.zip` → **Estrai tutto**. Ottieni una cartella che contiene `index.html`, `sw.js`, `manifest.webmanifest`, `LEGGIMI.md` e le cartelle `js`, `icons`, `tests`.
2. **Crea l'account.** Su https://github.com premi **Sign up** e segui i passaggi (email, password, nome utente). Il nome utente farà parte dell'indirizzo dell'app: se scegli `fededt`, l'app sarà su `https://fededt.github.io/lectio/`.
3. **Crea il repository.** In alto a destra **+ → New repository**:
   - Repository name: `lectio` (tutto minuscolo);
   - visibilità: **Public** (GitHub Pages gratuito funziona solo con i repository pubblici);
   - non spuntare "Add a README";
   - premi **Create repository**.
4. **Carica i file.** Nella pagina del repository vuoto premi il link **uploading an existing file**. Apri la cartella estratta, seleziona tutto il contenuto con **Ctrl+A** e **trascinalo** nel riquadro della pagina. Trascina il contenuto, non la cartella stessa: `index.html` deve stare al primo livello, non dentro una sottocartella. Il trascinamento mantiene le cartelle `js`, `icons` e `tests`; il pulsante "choose your files" non le carica. Aspetta che compaia l'elenco dei file, poi in fondo premi **Commit changes**.
5. **Controlla.** Nella pagina del repository devi vedere al primo livello `index.html`, `sw.js`, `manifest.webmanifest` e le cartelle `js`, `icons`, `tests`. Aprendo `js` devi trovare `app.js` e le cartelle `core`, `services`, `ui`.
6. **Attiva Pages.** **Settings** (in alto nel repository) → **Pages** (menu a sinistra) → in "Build and deployment":
   - Source: **Deploy from a branch**;
   - Branch: **main** e cartella **/ (root)**;
   - premi **Save**.
7. **Aspetta 1-2 minuti** e ricarica la pagina Settings → Pages: in alto compare "Your site is live at `https://TUO-NOME.github.io/lectio/`". Lo stato della pubblicazione si vede anche nella scheda **Actions** ("pages build and deployment" con la spunta verde).
8. **Prova dal PC.** Apri quell'indirizzo: deve comparire Lectio con la configurazione guidata. Se vedi un errore 404, aspetta un altro minuto. Se persiste, quasi sempre `index.html` è finito dentro una sottocartella: ripeti il punto 4 trascinando il contenuto della cartella.

**Aggiornamenti futuri:** quando ti mando una nuova versione, nel repository fai **Add file → Upload files**, trascina di nuovo tutto il contenuto e premi **Commit changes**. I file con lo stesso nome vengono sostituiti. Dopo un minuto l'app sul telefono si aggiorna da sola alla riapertura.

Il codice nel repository è pubblico, ma non contiene chiavi né dati tuoi: gli accessi e le trascrizioni stanno solo sul dispositivo.

### 2. Client ID di Google (gratis)

Serve perché Lectio possa scrivere nel tuo documento. I nomi delle voci nella console di Google potrebbero essere leggermente diversi da quelli qui sotto.

1. Vai su https://console.cloud.google.com e crea un progetto chiamato `Lectio`.
2. **API e servizi → Libreria**: cerca **Google Docs API** e premi **Abilita**.
3. **Google Auth Platform** (o "Schermata consenso OAuth") → **Inizia**. Nome app: `Lectio`; email di assistenza: la tua; pubblico: **Esterno**; poi conferma.
4. In **Pubblico → Utenti di test** aggiungi il tuo indirizzo Gmail. L'app resta in modalità test, ed è giusto così: la usi solo tu.
5. **Client → Crea client**, tipo **Applicazione web**:
   - Origini JavaScript autorizzate: `https://TUO-NOME.github.io`
   - URI di reindirizzamento autorizzati: `https://TUO-NOME.github.io/lectio/` (con la barra finale)
6. Copia il **Client ID**: finisce con `.apps.googleusercontent.com`.

Gli indirizzi esatti da registrare li mostra anche Lectio, in Impostazioni → Accesso a Google. Al primo accesso Google avvisa che l'app non è verificata: premi **Continua**. È normale per un'app personale in modalità test.

### 3. Sull'iPhone

1. Apri `https://TUO-NOME.github.io/lectio/` in **Safari**.
2. **Condividi → Aggiungi alla schermata Home** e da quel momento apri Lectio dall'icona.
3. Segui la configurazione guidata: Client ID e accesso a Google, controllo del documento, orario, download di Whisper (col Wi-Fi).
4. Controlla l'orario in Impostazioni → Orario. L'ho impostato a 8:45–10:25, 10:40–12:20, 12:35–14:15 (lezioni da 1h40 con 15 minuti di pausa). Se le fasce vere sono diverse, ad esempio se finisci alle 14:00, correggile.

## In aula

- Tieni il telefono sul banco, vicino al docente, con **Lectio aperta e lo schermo acceso**. Lectio impedisce allo schermo di spegnersi. Se blocchi il telefono o cambi app, su iPhone il microfono delle app web si ferma: Lectio te lo segnala e il pulsante "Riattiva microfono" lo fa ripartire.
- La spia **"Whisper: tiene il passo"** deve restare verde. Se diventa "in ritardo", il testo arriva comunque, ma più tardi. Se succede spesso, in Impostazioni → Trascrizione scegli **Whisper base**.
- Batteria: la trascrizione continua consuma parecchio. Parti carico o tieni un powerbank.

## Accesso a Google

Per sicurezza, l'accesso concesso da Google a un'app web dura circa un'ora. Quando invii una lezione e l'accesso è scaduto, Lectio ti porta alla pagina di Google: un tocco e torni indietro, e l'invio riparte da solo. L'invio automatico a fine lezione funziona se hai fatto l'accesso nell'ultima ora; altrimenti la lezione resta in coda finché non tocchi "Accedi a Google e invia".

## Nuovo semestre

Impostazioni → Semestri → **Nuovo semestre** (vuoto o copiando le materie). Poi aggiungi le materie, scegli la scheda del documento per ciascuna, scrivi i glossari (o importali da un file .txt o .csv, una voce per riga) e l'orario. Il glossario conta molto: aiuta Whisper a riconoscere i termini e la pulizia a correggerli. Mettici nomi di autori, istituti e termini latini del corso. Il semestre precedente resta archiviato. Con **Esporta** salvi la configurazione e la reimporti su un altro dispositivo.

## Limiti noti (onestamente)

- **Velocità di Whisper sull'iPhone: non ancora misurata.** Abbiamo saltato la Fase 0, quindi la prima lezione vera fa da prova. Guarda la spia della velocità e, se serve, passa a Whisper base. La pagina di test della Fase 0 resta disponibile.
- **La pulizia gratuita è meccanica.** Non capisce il senso: corregge solo i termini del glossario e le esitazioni evidenti, e non riscrive le frasi. Gli errori di Whisper su parole fuori glossario restano: li sistemerà la tua attività di rielaborazione, che già corregge gli errori di trascrizione.
- **Collaudato con servizi simulati, non con quelli veri.** Ho provato tutta la catena in Chrome con un microfono finto e simulando Whisper e Google Docs: cambio di materia, pause, pulizia a blocchi, inserimento nella scheda giusta sotto la data, nessun doppione, recupero dopo una chiusura improvvisa. Il primo uso reale su iPhone, con il tuo documento e le tue chiavi, resta da verificare.
- **Formato delle date:** Lectio lo deduce dalle date già scritte nella scheda e te lo mostra nella configurazione guidata. Controllalo lì prima del primo invio.
- **Per venderla a terzi** servirebbe la verifica dell'app da parte di Google, perché in modalità test può accedere solo chi è nella lista degli utenti di test.

## Per chi sviluppa

- `js/core/`: logica pura, coperta da test (`node --test tests/*.test.mjs`): orario, date, inserimento nel documento (con un simulatore di Google Docs), pulizia locale, audio, configurazione.
- `js/services/`: Whisper (Web Worker con transformers.js 4.3.2), Google (OAuth con reindirizzamento e Docs API), IndexedDB, regia della mattinata (`pipeline.js`).
- `js/ui/`: interfaccia senza librerie. `sw.js` rende l'app apribile anche offline.
