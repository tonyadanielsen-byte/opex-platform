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
| `setTiltakSakV1` | Kobler tiltak til sak og setter sporsettet (erstatter forrige). Idempotent. |
| `removeTiltakSakV1` | Fjerner tiltaket fra saken. Idempotent. |
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
```

Status sak: `Åpen | Under oppfølging | Avventer beslutning | Løst | Lukket` (standard `Åpen`).
Status årsak: `hypotese | støttet | bekreftet | avkreftet`; `støttet`/`bekreftet` krever `grunnlag`.
`vurdertAv`/`vurdertAt`/`opprettetAv`/`opprettetAt` og alle hendelser settes **av serveren**; forespørsler med ukjente felt
avvises, så identitet og tidsstempel aldri kan sendes inn av klienten.

### Konsistens (ingen delvis fullførte oppdateringer)

- Alle operasjoner som berører flere noder er **én multi-path `update()`** (atomisk), med endring og sakEvents sammen.
- **Koble tiltak:** `tiltak.sakId` avgjøres med en **transaksjon på tiltaket** (kun én sak kan «vinne», også ved samtidige
  forsøk). Deretter skrives spor-koblinger + hendelser i én atomisk update (3 forsøk). Feiler den, **rulles `sakId` tilbake**.
  Hele operasjonen er idempotent og kan trygt gjentas.
- **Frakoble:** samme mønster. Feiler skrivingen etter frikobling, er medlemskapet (sannheten) allerede fjernet; gjenværende
  spor-koblinger er foreldreløse, ignoreres (`ugyldigeKoblinger`) og erstattes ved neste kobling.
- Ett tiltak kan bare tilhøre **én** sak; flytting krever eksplisitt frakobling først.
- **Revisjon av årsakstekst** lager en ny årsak (`erstatter`) og markerer den gamle `fjernet`; status nullstilles til `hypotese`.
  Fjernede årsaker kan ikke endres (append-only).
- Lukket sak: innhold (tiltak, årsaker, tittel …) kan ikke endres før saken åpnes igjen; status kan alltid settes.
- Fritekst (tittel, problemstilling, årsakstekst, grunnlag) skrives **aldri** i sakEvents.

### Begrensninger og kjent risiko (må leses før deploy)

1. **Testet mot en SIMULERT database**, ikke ekte Firebase. Simulatoren er bevisst streng (ugyldige nøkler, `undefined`,
   overlappende stier, transaksjonssemantikk med kald cache, samtidige skrivinger, feilinjeksjon), men den beviser logikken,
   ikke at ekte RTDB/admin-SDK oppfører seg likt. Callable-bindingen er bare lastetestet.
2. **Dobbeltfeil:** feiler både skrivingen og tilbakerullingen ved kobling, blir tiltaket stående med `sakId` uten spor-koblinger.
   Gjentakelse fullfører sporene, men `tiltak_koblet` mangler da i `sakEvents` (endringen er likevel logget i `tiltakEvents`, uten bruker).
3. **Samtidig redigering av samme sak/årsak** (`updateSak`, `updateArsak`) er last-write-wins; `foer` i hendelsen kan være feil
   hvis to personer endrer akkurat samme felt i samme øyeblikk. Akseptabelt for få piloter.
4. **Saksnummer** kan få hull (nummer tildeles før skrivingen), aldri duplikater.
5. **Ingen rate limiting / App Check** (som resten av OpEx). Ingen regelendring: nodene er kun tilgjengelige via disse funksjonene
   forutsatt at dagens RTDB-regler er deny-by-default for ukjente noder (**ikke verifisert**).
6. `getSakV1` finner saksmedlemmer med `orderByChild('sakId')` uten `.indexOn`; admin-SDK leser da alle tiltak (greit for hundrevis).
7. Spor kan bare opprettes sammen med saken (ingen «legg til spor» ennå). Ingen sletting av saker.
8. Hendelser i samme millisekund har tilfeldig rekkefølge innen én operasjon (tilfeldig suffiks i nøkkelen).
9. Funksjonene er IKKE deployet; merge til `main` deployer dem (se avsnittet om deploy under 1a).

## Tester

```
node --test tests/*.test.cjs        # Node 20+; kjør `npm install` i functions/ først for lastetestene
```
