# Saksgrunnlag og saksjournal – første leveranse (2026-10-14)

## Formål

Etterprøvbart, kilde-ID-merket saksgrunnlag for kommende AI-oppsummeringer uten at noen AI-modell brukes i denne leveransen.

## Server-API-er

- `getSaksgrunnlagV1({sakId})`: leser sak, spor, årsaksvurderinger, sakshendelser, tiltak knyttet via `tiltak.sakId`, tiltakshendelser, begge kommentarlagrene og saksjournal. Returnerer `sources` med faste ID-er, `sourceCount` og deterministisk `grunnlagHash`.
- `getSakJournalV1({sakId})`: leser journalposter.
- `createSakJournalEntryV1({sakId,type,tekst,gjelderDato?})`: legger til journalpost og hendelse i samme RTDB-oppdatering. Journaltekst kopieres ikke inn i hendelsesloggen.

Alle krever godkjent innlogging i `authorizedUsers`; nye noder har ingen direkte klientlesing eller -skriving. Journal og grunnlag lagres/leses på serveren. Ingen modellkall eller eksport til ekstern AI-leverandør.

## Journalposter

Typer: `observasjon`, `undersokelse`, `beslutning`, `dokumentasjon`, `effektmaling`. Opprettelse er append-only. V1 har ikke korrigering/fjerning av journalposter; ved feil må leder registrere en ny korrigerende post frem til revisjon er implementert.

## Avgrensning og neste fase

- Ingen AI-oppsummering eller AI-forslag er koblet opp.
- Ingen kildevalidering av AI-påstander, modellleverandør eller AI-kostnader er innført.
- Ingen LOR-runde er koblet som kilde til en sak ennå. LOR-koblinger kommer som egen integrasjon; medarbeiderdialoger skal ikke automatisk inn i modellgrunnlaget.
- Ingen pseudonymisering før modellkall finnes, fordi det ennå ikke finnes modellkall. Denne kontrollen må bygges før ekte bedriftsdata kan behandles av en ekstern AI.
- Saksgrunnlaget leser hele `/tiltak` for å finne `sakId`; dette er akseptabelt for pilot men bør optimaliseres før stor skala.
- Samtidige endringer under innhenting kan gi et grunnlag som er lest over et tidsvindu, ikke ett atomisk databasesnapshot. Versjonert AI-oppsummering krever kildeferskhetskontroll.
- En hash dokumenterer hvilken JSON som ble brukt, men er ikke alene en verifikasjon av AI-påstander.

## Sikkerhetseierskap

OpEx `database.rules.json` er snapshotet av felles RTDB-regler. LOR-repoets `firebase.json` har nå ingen `database.rules`-konfigurasjon, og LOR CI kontrollerer at den ikke gjeninnføres. **Aktive produksjonsregler endres ikke av denne leveransen.** Fullstendig beskyttelse mot utilsiktet massesletting under `/tiltak` er fortsatt en separat oppgave.
