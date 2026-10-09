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

## Tester

```
node --test tests/*.test.cjs        # Node 20+; kjør `npm install` i functions/ først for lastetestene
```
