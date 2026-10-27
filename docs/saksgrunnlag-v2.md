# Saksgrunnlag v2 – kildeoversikt og kronologi (2026-10-27)

Denne leveransen er **lesende** og endrer ikke eksisterende saker, journalposter, tiltak eller databaseregler.

## Server API
`getSaksgrunnlagV2({sakId})` krever godkjent innlogging (samme `authorizedUsers` som V1) og returnerer:
- `basis`: uendret V1-kildepakke med kilde-ID-er og SHA-256 `grunnlagHash`.
- `oversikt`: deterministisk V2-avledning, inkludert `projectionHash`, kilde-ID/type, status, timestamp, eksplisitte kildekoblinger, kronologi og oppsummerte statustall.

## Avledningsregler
- Journalposter med `erstattetAv` markeres `erstattet`, mens `fjernet:true` markeres `avkreftet_eller_fjernet`.
- Årsaker med status `hypotese`, `mulig` eller `under_vurdering` markeres `hypotese`; `avkreftet`, `forkastet` eller `avvist` markeres `avkreftet_eller_fjernet`.
- Andre kilder markeres `gjeldende` som teknisk visningsstatus. Det betyr **ikke** at innholdet er faktaverifisert.
- Koblinger opprettes bare når en eksplisitt referanse peker på en eksisterende journalpost eller et eksisterende spor.
- Kronologi sorteres etter eksplisitte tidsfelt; kilder uten tidspunkt beholdes separat, aldri gitt oppdiktet dato.
- Utsagn i fri tekst tolkes **ikke** som verifiserte fakta eller konklusjoner.

## Avgrensninger
- V2 inkluderer fortsatt V1s fullskanning av tiltak og kan representere data lest på ulike tidspunkter; en hash er ikke et atomisk databasesnapshot.
- Ingen LOR-kildekoblinger, AI-kall, pseudonymisering, UI-endringer eller produksjonsdatamigrering i denne leveransen.
- Dette er et sikkert strukturgrunnlag, ikke en ferdig lederoppsummering eller effektvurdering.
