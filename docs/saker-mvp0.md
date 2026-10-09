# Saker MVP-0 — arkitektur og status

Hovedstruktur: **Saker → Tiltak.** En sak samler flere tiltak, fakta, spørsmål, beslutninger og status
rundt ett problem eller forbedringsområde. Første pilot: «Ribbefett 2025 – restlager og kassasjon».

## Låste arkitekturregler

1. `tiltak.sakId` er eneste kilde til hvilken sak et tiltak tilhører.
2. Aggregater lagres ikke. Antall, statusfordeling, «sist oppdatert» osv. beregnes.
3. Historikk er append-only og skrives av server.
4. Saker bygges som egen modul (`saker/`), ikke som nytt overlay-script.
5. AI skal senere aldri skrive i menneskelige datafelt.

## ⚠ Midlertidig pilotløsning: tilgang kun via callables (beslutning D1)

Dagens RTDB-sikkerhetsregler er **ikke versjonsstyrt** og var ikke tilgjengelige da MVP-0 ble designet.
Derfor gjelder i MVP-0:

- **Ingen regelendring.** Alle nye noder (`/saker`, `/sakSpor`, `/sakTiltakSpor`, `/sakArsaker`,
  `/sakEvents`, `/tiltakEvents`, `/counters`) leses og skrives **kun** av Cloud Functions (admin SDK),
  etter `authorizedUsers`-sjekk. Klienter har ingen direkte tilgang (forutsatt at dagens regler er
  deny-by-default for ukjente noder — **ikke verifisert**).
- Konsekvens: ingen sanntidslyttere på sak-data, og lesing går via `getSaker*`-callables.
- Hvem som helst med `authorizedUsers` kan opprette sak, koble tiltak og sette spor/årsaker (pilot, få brukere).
  Ingen ny hardkodet admin-uid.

**Gjeld som må betales etter piloten:**

- [ ] Hent dagens RTDB-regler fra Firebase-konsollen og legg dem i repoet (`database.rules.json`) med emulatortester.
- [ ] Verifiser at nye noder faktisk er stengt for klienter.
- [ ] Innfør server-side roller (`/users/{uid}`) i stedet for flat `authorizedUsers`.
- [ ] Vurder App Check på callables.

## Hendelseslogg (fase 1a)

Server-skrevet, append-only. Filer: `functions/events-core.js` (ren logikk), `functions/tiltak-events.js`
(Firebase-binding), `tests/`.

| Funksjon | Trigger | Skriver |
|---|---|---|
| `logTiltakEventsV1` | `/tiltak/{taskId}` skrevet | `/tiltakEvents/{taskId}/{eventId}` |
| `logTaskCommentEventV1` | `/taskComments/{taskId}/{commentId}` opprettet | `/tiltakEvents/{taskId}/{eventId}` |

Bevisst **adskilt fra `notifyTaskChangesV1C`**: varsling og logging skal ikke kunne påvirke hverandre,
testtiltak skal kunne logges, og loggen skal være mer komplett enn push-logikken.

### Hendelsesformat

```
type        opprettet | endret | slettet | kommentar
felt        status | eier | prioritet | frist | kategori | omrade | sakId | nestesteg | livssyklus | miljo   (type=endret)
foer/etter  verdi før/etter (utelatt = tom). Ved opprettet/slettet: map med de loggede feltene.
createdAt   ISO-tidspunkt (hendelsestid fra plattformen; for kommentar: kommentarens eget tidspunkt)
actorUid    hvem — KUN hvis plattformen leverer det (se under)
actorType   authType hvis levert
avkortet    true hvis nestesteg ble kuttet til 200 tegn
kommentarId, forfatterUid, kilde   (type=kommentar; kilde = taskComments | kommentarer)
```

- Nøkkel: `{13-sifret epoch-ms}-{cloud-event-id}-{felt}` → kronologisk sorterbar og **deterministisk**
  (levering «minst én gang» overskriver samme noder, ingen duplikater). `retry` er på.
- **Logges aldri:** tittel, beskrivelse, kommentartekst, visningsnavn på kommentarforfatter.
  `nestesteg` kuttes til 200 tegn (den er allerede synlig for alle autoriserte og sendes i push).
- Én hendelse per endret felt; alle hendelser for én skriving skrives i én atomisk `update`.

### Kjent begrensning: aktør

RTDB-hendelser i `firebase-functions` v2 (6.x) har **ikke** auth-kontekst. `actorUid` på feltendringer
vil derfor trolig mangle. Kommentarhendelser har `forfatterUid` fra selve kommentaren og er pålitelige.
Hvem som koblet et tiltak til en sak vil bli registrert i `sakEvents` (callable kjenner `request.auth.uid`).

### sakEvents (grunnlag)

`buildSakEvent` / `sakEventWrites` i `events-core.js` brukes av callables (kommer i 1c) slik at sakhendelsen
skrives i **samme atomiske update** som endringen. Typer: `sak_opprettet`, `sak_endret`, `tiltak_koblet`,
`tiltak_frakoblet`, `spor_koblet`, `spor_frakoblet`, `arsak_opprettet`, `arsak_endret`, `arsak_fjernet`.
`actorUid` er påkrevd.

## Beregning av en sak (fase 1b): `saker/sak-logic.js`

Én ren, DOM-fri, testet sannhet. Samme modul brukes av UI og senere av AI/evidence builder.
Ingen DOM, Firebase, nettverk eller globale nettleserfunksjoner; henter aldri data selv; muterer ikke inndata.
Lastes som klassisk `<script>` (`window.OpExSakLogic`) eller `require()` i Node.

| Klasse | Regel |
|---|---|
| **Ekskludert** | papirkurv (`livssyklus === 'Papirkurv'` eller `papirkurv === true`) eller test (`miljo === 'Test'` eller `test === true`). Gjelder uansett status. |
| **Gjort** | Fullført (også når tiltaket er arkivert/lagret) |
| **Gjenstår** | Innmeldt, Til godkjenning, Aktiv. Tom status = Innmeldt. Ukjent status = gjenstår, men flagges i `datakvalitet.ukjentStatus`. |
| **Forfalt** | *delmengde* av gjenstår med gyldig frist strengt før dagens Oslo-dato. Frist i dag er ikke forfalt. |
| **Separat** | Stanset, Avsluttet. Ikke i fremdriftsnevneren. |

Normalisering som `normStatus` i appen: Åpen → Innmeldt, Pågår → Aktiv, Avvist → Avsluttet.
`totalt = gjort + gjenstår + stanset + avsluttet` (ekskluderte ikke med; se `kobletTotalt`).
`fremdrift = gjort / (gjort + gjenstår)`, `null` hvis nevneren er 0.
`naermesteFrist` = tidligste frist ≥ i dag blant gjenstående. `eldsteForfaltFrist` = tidligste forfalte.

**Datoer:** «i dag» er alltid `Europe/Oslo`. Fristlogikk er strenglogikk på ÅÅÅÅ-MM-DD (kalenderregning i UTC),
aldri lokal `Date`-parsing. Dagens app bruker UTC-dato i `today()`/`daysTo()` og får derfor «forfalt» feil med én
dag mellom 00:00 og ca. 02:00 norsk tid; modulen gjør ikke den feilen.

**Arkiverte tiltak:** Fullført + arkivert/lagret teller som *gjort*. Et arkivert tiltak med ikke-ferdig status
(`livssyklus` Arkivert/Idebank/Idébank/Avsluttet eller `arkivert === true`) er en inkonsistens: det regnes
fortsatt som *gjenstår*, regnes **aldri** som forfalt (som `computedStatus` i appen), påvirker ikke
«nærmeste frist»/«eldste forfalte» med en passert frist, og flagges i `datakvalitet.arkivertIkkeFerdig`.

**Kjente, bevisste avvik fra dagens app** (målt mot appens egne funksjoner, 95 256 kombinasjoner):
1. Umulig kalenderdato (`2026-02-30`): appen ruller over til 2. mars; modulen behandler den som ugyldig frist.
2. Midnattsvinduet: appen bruker UTC-dato og er én dag bak mellom 00:00 og ca. 02:00 norsk tid; modulen bruker Oslo-dato.

Ellers er ekskludering, klasse, statustekst og «forfalt» identisk med appen i alle testede kombinasjoner.

## Datalag for saker (fase 1c)

Filer: `functions/sak-core.js` (all logikk, databasen injiseres), `functions/sak-api.js` (tynn callable-binding),
`tests/sak-core.test.cjs` + `tests/helpers/fake-rtdb.cjs` (simulert database). **Ikke deployet.** Ingen UI.

### Callables (alle: region `europe-west1`, `maxInstances: 2`, krever `authorizedUsers/{uid} === true`)

| Funksjon | Gjør |
|---|---|
| `createSakV1` | Oppretter sak med servergenerert `SAK-0001`, spor og sakhendelse i **én** atomisk skriving |
| `getSakerV1` | Lett liste over alle saker |
| `getSakV1` | Sak + spor + årsaker (inkl. fjernede) + tiltak-ids + spor-koblinger + hendelser i rå RTDB-form (direkte inn i `sak-logic.js`) |
| `updateSakV1` | Tittel, problemstilling, status, eier, områder. **Status endres bare manuelt.** |
| `setTiltakSakV1` | Kobler tiltak til sak og setter sporsettet (erstatter forrige). **To faser, ikke atomisk samlet** (se «Konsistens»). Idempotent. |
| `removeTiltakSakV1` | Fjerner tiltaket fra saken. **To faser, ikke atomisk samlet** (se «Konsistens»). Idempotent. |
| `createArsakV1` | Registrerer årsak under et spor |
| `updateArsakV1` | Endrer status/grunnlag på stedet, reviderer tekst (ny årsak som erstatter), eller fjerner |

### Datamodell

```
tiltak/{id}.sakId                          eneste endring på eksisterende data (kilde til medlemskap)
/saker/{sakId}            kode, tittel, problemstilling?, eierUid, status, omrader{navn:true}?, opprettetAt, opprettetAv
/sakSpor/{sakId}/{sporId}                  kode (A,B,…), sporsmal, rekkefolge      — spor har ingen status
/sakTiltakSpor/{sakId}/{tiltakId}/{sporId}: true                                   — gyldig bare hvis tiltak.sakId === sakId
/sakArsaker/{sakId}/{arsakId}              sporId, tekst, status, grunnlag?, vurdertAv, vurdertAt,
                                           opprettetAv, opprettetAt, fjernet, erstatter?
/sakEvents/{sakId}/{eventKey}              se events-core.js (alltid med actorUid = request.auth.uid)
/counters/sak                              heltall; transaksjon, aldri skanning
/sakLocks/{tiltakId}                       {owner, until, uid} — kortlivet lås som serialiserer koble/frakoble på samme tiltak (driftsnode, ikke sakdata)
```

Status sak: `Åpen | Under oppfølging | Avventer beslutning | Løst | Lukket` (standard `Åpen`).
Status årsak: `hypotese | støttet | bekreftet | avkreftet`; `støttet`/`bekreftet` krever `grunnlag`.
`vurdertAv`/`vurdertAt`/`opprettetAv`/`opprettetAt` og alle hendelser settes **av serveren**; forespørsler med ukjente felt
avvises, så identitet og tidsstempel aldri kan sendes inn av klienten.

### Konsistens: hva som er atomisk, og hva som ikke er det

**Atomisk (én multi-path `update()`, alt eller ingenting):** opprette sak, oppdatere sak, opprette/endre/fjerne årsak. Endringen og
`sakEvents` skrives alltid i samme update.

**IKKE atomisk samlet: «koble tiltak til sak» og «frakoble».** De skrives i to faser, og hver fase er atomisk for seg:

| Fase | Hva | Mekanisme |
|---|---|---|
| 0 | Serialisering | Per-tiltak-lås `/sakLocks/{tiltakId}` (transaksjon, eier-token, utløper etter 45 s) |
| 1 | Medlemskap (`tiltak.sakId`) | Transaksjon på tiltaket: bare én sak kan «vinne» |
| 2 | Spor-koblinger + `sakEvents` | Én atomisk update (3 forsøk) |

Det som holder koblingen konsistent er derfor **ikke atomitet, men fire ting sammen**:

1. **Låsen** hindrer at to operasjoner på samme tiltak flettes mellom fasene. Uten den kunne en tilbakerulling fjerne en nyere, gyldig
   kobling, to koblinger bygge på hverandre, og samtidige frakoblinger skrive dupliserte hendelser (alle reprodusert i testene).
   Operasjoner på *ulike* tiltak blokkerer ikke hverandre. Opptatt lås gir `aborted` («prøv igjen om litt») etter 5 forsøk.
2. **Kompensasjon:** feiler fase 2, rulles fase 1 tilbake (koble: fjern `sakId`; frakoble: gjenopprett `sakId`). Rullingen skjer
   **bare** hvis vi fortsatt eier låsen, **bare** hvis tiltaket fortsatt har vår `sakId` (aldri overskriv en annen saks kobling), og
   meldes som «rullet tilbake» **bare** hvis transaksjonen faktisk ble committet. Ellers sies «delvis lagret».
3. **Idempotens:** samme kall kan gjentas. Koble erstatter hele spor-settet; frakoble rydder også en avbrutt frakobling
   (ikke-medlem med gjenværende koblinger gir `tiltak_frakoblet` + opprydding, slik at historikken heles).
4. **Trygg lesing:** spor-koblinger gjelder bare for tiltak som har `tiltak.sakId === sakId`; resten ignoreres og rapporteres som
   `ugyldigeKoblinger`.

`claimed`/`released` i transaksjonscallbackene: callbacken kan kjøres flere ganger (kald cache gir `null` først; samtidige
skrivinger gir nye kjøringer). Variablene nullstilles i hver kjøring, og bare den siste, committede kjøringen brukes. Callbacken
bygger alltid på de ferske dataene den får, så samtidige endringer på andre felt på tiltaket går ikke tapt.

**Gjenværende hull (dobbeltfeil / prosess som dør):**
- *Koble:* feiler både fase 2 og kompensasjonen, eller dør prosessen etter fase 1, står tiltaket i saken uten spor-koblinger og uten
  `tiltak_koblet` i `sakEvents`. Gjentakelse fullfører sporene, men kan ikke vite at `tiltak_koblet` mangler. Endringen er likevel
  logget i `tiltakEvents` (uten bruker). Foreldreløse koblinger kan i mellomtiden ligge igjen ved frakobling; de ignoreres av lesere.
- *Låsen:* utløper den (45 s, mer enn funksjonens 30 s timeout) før operasjonen er ferdig, skriver operasjonen ikke mer og ruller ikke
  tilbake (en annen kan ha tatt over); den melder «delvis lagret». En lås som blir stående etter en krasj stenger tiltaket i maks 45 s.
- *Tapt oppdatering mot lukking:* en sak som lukkes i samme øyeblikk som en kobling pågår, kan få koblingen gjennomført.
- Direkte skriving til `tiltak.sakId` utenom disse funksjonene (f.eks. fra konsollen) omgår låsen og historikken.

**Øvrige regler:**
- Ett tiltak tilhører **én** sak; flytting krever eksplisitt frakobling først.
- **Endret årsakstekst** gir en ny versjon (`erstatter`, den gamle markeres `fjernet`) med status `hypotese`, med mindre ny status
  **og** grunnlag uttrykkelig oppgis i samme kall. Fjernede årsaker kan ikke endres (append-only).
- Lukket sak er låst for innholdsendringer, men kan åpnes igjen manuelt (endre status). Sak-status endres aldri automatisk.
- Hendelser er **begrenset** til de nyeste (100 per tiltak, 300 for saken). `getSakV1` returnerer `avkortet` som forteller at det kan
  finnes eldre; «siste aktivitet» påvirkes ikke fordi de nyeste alltid er med. Paginering kan komme senere.
- Fritekst (tittel, problemstilling, årsakstekst, grunnlag) skrives **aldri** i `sakEvents`.

### Begrensninger og kjent risiko (må leses før deploy)

1. **RTDB-reglene er IKKE verifisert.** De er ikke versjonsstyrt, og jeg har aldri sett dem. All sikkerhet i Saker bygger på at
   (a) alle sak-noder bare nås via disse funksjonene, og (b) dagens regler er deny-by-default for ukjente noder (`/saker`, `/sakSpor`,
   `/sakTiltakSpor`, `/sakArsaker`, `/sakEvents`, `/sakLocks`, `/counters`, `/tiltakEvents`). Hvis (b) ikke stemmer, kan
   innloggede brukere lese eller skrive disse nodene direkte og omgå validering, låser og historikk. **Hent og versjonsstyr reglene før Saker brukes
   utover pilotgruppen.** (Eksisterende tiltak har samme avhengighet i dag.)
2. **Testet mot en SIMULERT database**, ikke ekte Firebase. Simulatoren er bevisst streng (ugyldige nøkler, `undefined`,
   overlappende stier, transaksjonssemantikk med kald cache, samtidige skrivinger og flettede operasjoner, feilinjeksjon, tapt lås,
   hengende prosesser), men den beviser logikken, ikke at ekte RTDB/admin-SDK oppfører seg likt (f.eks. faktisk transaksjonsretry og
   tidsavbrudd). Callable-bindingen er bare lastetestet. Ekte Firebase er ikke testet.
3. Hull i «Gjenværende hull» over.
4. **Samtidig redigering av samme sak/årsak** (`updateSak`, `updateArsak`) er last-write-wins; `foer` i hendelsen kan være feil
   hvis to personer endrer akkurat samme felt i samme øyeblikk. Akseptabelt for få piloter.
5. **Saksnummer** kan få hull (nummer tildeles før skrivingen), aldri duplikater.
6. **Ingen rate limiting / App Check** (som resten av OpEx). Pilot: alle med `authorizedUsers` kan opprette og koble.
7. `getSakV1` finner saksmedlemmer med `orderByChild('sakId')` uten `.indexOn`; admin-SDK leser da alle tiltak (greit for hundrevis).
8. Spor kan bare opprettes sammen med saken. Ingen sletting av saker.
9. Hendelser i samme millisekund har tilfeldig rekkefølge innen én operasjon (tilfeldig suffiks i nøkkelen).
10. Funksjonene er IKKE deployet; merge til `main` deployer dem (se avsnittet om deploy under 1a).

## Tester

```
node --test tests/*.test.cjs        # Node 20+; kjør `npm install` i functions/ først for lastetestene
```
