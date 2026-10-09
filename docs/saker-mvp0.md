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

## Tester

```
node --test tests/*.test.cjs        # Node 20+; kjør `npm install` i functions/ først for lastetestene
```
