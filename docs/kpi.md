# KPI-apper (KPI Renhold, senere KPI Ferdigmat)

KPI-registrering og oppfølging per avdeling (Nortura Sarpsborg). KPI Renhold erstatter Excel-arket «KPI 2026 Renhold».

**Egne apper** med kobling til tiltakslista i OpEx Hub. Én felles kodebase i `kpi/`, én side per avdeling:

| Avdeling | Adresse | Status |
|---|---|---|
| Renhold | `kpi/renhold/` (https://tonyadanielsen-byte.github.io/opex-platform/kpi/renhold/) | aktiv |
| Ferdigmat | `kpi/ferdigmat/` | forberedt (ikke aktiv) |

Den gamle adressen `kpi/` sender videre til `kpi/renhold/`.

- Samme Firebase-prosjekt og innlogging som OpEx Hub. Appen leser `/tiltak` for å vise koblede tiltak, oppretter KPI-tiltak i den felles lista og åpner tiltak i OpEx Hub (`?openTask=`).
- OpEx Hub viser KPI-appene som **egne knapper øverst til høyre** (og i «Mer» på mobil), generert fra `kpi/kpi-enheter.js`. De ligger ikke blant tiltaksfanene.
- Visninger i appen: `#kpi`, `#kpi/registrer`, `#kpi/oppsett`.

### Ny avdeling (f.eks. Ferdigmat)

1. `kpi/kpi-enheter.js` (og kopien `functions/kpi-enheter.js`): sett `aktiv: true` og riktige standard registratorer.
2. Kopier `kpi/renhold/index.html` til `kpi/ferdigmat/index.html` og endre `window.KPI_ENHET = 'ferdigmat'`.
3. Merge. Knappen i OpEx Hub, serverfunksjonene og varslene virker uten annen kode. Sett opp KPI-ene under Oppsett (eller importer et Excel-ark med samme oppsett).

## Filer

| Fil | Innhold |
|---|---|
| `kpi/kpi-enheter.js` | Lista over avdelinger (navn, adresse, område for tiltak, standard registratorer, aktiv). Kopi i `functions/`. |
| `kpi/<enhet>/index.html`, `kpi/kpi-shell.js`, `kpi/kpi-shell.css` | Selve appen per avdeling: topplinje, innlogging, Firebase og vertsflaten (`OpExHost`) mot tiltakslista. |
| `kpi/kpi-logic.js` | Beregning (HIÅ, mål, status, grenser) og tallformat. Ren, testet. |
| `kpi/kpi-import.js` | Leser Excel-arket (månedsark Januar–Desember) til oppsett + verdier. |
| `kpi/kpi-app.js` | Kjerne: datalag (callables), ruting, personlige innstillinger (lagres med `saveKpiPreferanserV1`), felles hjelpere (`OpExKpiKjerne`). |
| `kpi/kpi-oversikt.js` | Oversikten som tilpassbart dashboard: bokser i 12-kolonners rutenett (status, krever oppfølging, registrering, nøkkeltall, grafer, tabeller per område). «Tilpass oversikt»: dra for å flytte, dra i kanten eller velg bredde, velg graftype (stolpe/linje/område), skjul/vis, fargetema og tetthet. |
| `kpi/kpi-registrer.js` | Registrering: fargekodet seksjon per område, kort per KPI med forhåndsvisning av status, endring fra forrige måned, fremdrift og fast lagrelinje. |
| `kpi/kpi-oppsett.js` | Oppsett: faner (KPI-er, nytt år, import), KPI-er gruppert per område med sammendrag og redigering ved utfolding. |
| `kpi/kpi-charts.js` | Avhengighetsfrie SVG-grafer: månedsgraf med mål og fjorår (hover), sparkline, statusring. |
| `kpi/kpi.css` | Stil (bygger på appens tokens og fargeprofil; faste status- og seriefarger). |
| `functions/kpi-core.js` | Serverlogikk: tilgang, validering, lagring, logg, import, tiltak. |
| `functions/kpi-api.js` | Callables (`getKpiV1`, `saveKpiMaanedV1`, `saveKpiConfigV1`, `importKpiV1`, `createKpiTiltakV1`, `saveKpiPreferanserV1` (alle tar `{ enhet }`)). |

## Statusregel (én felles regel)

- **Faktisk HIÅ**: Sum → summen av registrerte måneder t.o.m. valgt måned. Snitt → gjennomsnittet av registrerte måneder.
- **Mål HIÅ**: Årsmål (HIA) → årsmål / 12 × månedsnummer. Fast → målet slik det står.
- **Status**: Opp: ≥ mål = *På mål*, ≥ mål × (1 − grense) = *Nær mål*. Ned: ≤ mål = *På mål*, ≤ mål × (1 + grense) = *Nær mål*.
  Ellers *Ikke på mål*. Ingen verdier = *Ingen data*.
- **Grense**: per KPI hvis satt, ellers årets felles grense (standard 20 %). Justeres under Oppsett.

Excel-arket brukte ulike grenser i månedsark og dashboard (±20 % mot +0,05) og hardkodet månedsnummer i formlene. Det er borte.

## Data (Realtime Database, kun via callables)

```
/kpi/{enhet}/config/{år}              oppsett: naerMaalProsent, kpier{ id: navn, omrade, enhet, retning, aggregat, maaltype, maal, fjorResultat, naerMaalProsent, sortering, aktiv }
/kpi/{enhet}/verdier/{år}/{mm}/{kpiId} månedens verdi (prosent lagres som 94.8)
/kpi/{enhet}/registrert/{år}/{mm}     { av, at } siste registrering
/kpi/{enhet}/logg/{år}/{nøkkel}        endringslogg { mnd, kpiId, foer, etter, av, at }
/kpi/{enhet}/preferanser/{uid}         personlig oppsett av oversikten (tema, tetthet, bokser)
/kpi/{enhet}/registratorer/{uid}       true = kan registrere (i tillegg til standard registratorer i kpi-enheter.js)
```

Klienter har ingen direkte tilgang (`database.rules.json` er deny-by-default for ukjente noder).
Lese: alle i `/authorizedUsers`. Skrive: registratorer.

## Tiltak

«+ Tiltak» på et KPI-kort oppretter et tiltak i den **felles tiltakslista** (`/tiltak`, område Renhold) med
`kilde: 'kpi'`, `kpiEnhet`, `kpiId`, `kpiAar`, `kpiNavn`. Eksisterende varsler for tiltak (opprettet, endret, frist) gjelder automatisk.
Kortet viser åpne tiltak koblet til KPI-en.

## Nytt år

Oppsett → «Lag oppsett for {år+1}» kopierer KPI-ene og målene; årets resultat blir «oppnådd i fjor». Juster mål etterpå.
En KPI med registrerte verdier kan ikke slettes, bare settes inaktiv.

## Varsler

Sendes som de øvrige OpEx-varslene: aktivitetsinnboks + push til enheter som har slått på varsler i OpEx Hub. Klikk åpner KPI-appen.

| Varsel | Når | Funksjon |
|---|---|---|
| Påminnelse om registrering | Den 3. kl. 08:10 for forrige måned, hvis noe mangler | `notifyKpiPaaminnelseV1` |
| Purring | Den 7., 10. og 14. hvis noe fortsatt mangler | `notifyKpiPaaminnelseV1` |
| KPI falt til «Ikke på mål» | Ved lagring av nyeste måned (sammenlignet med før; ny måned: med forrige måned) | `notifyKpiEndringV1` |
| Månedsoppsummering | Når siste verdi for måneden registreres | `notifyKpiEndringV1` |
| Tiltak (opprettet, endret, frist) | Eksisterende tiltaksvarsler, siden KPI-tiltak ligger i tiltakslista | `notifyNewTaskV1C` m.fl. |

Mottakere per avdeling: standard registratorer fra `kpi-enheter.js`, pluss alle med `/kpi/{enhet}/varselMottakere/{uid} = true` (f.eks. Besim, når han har bruker).
Hvert varsel sendes bare én gang (`/kpi/{enhet}/varslet/{nøkkel}`). Import fra Excel gir ingen varsler.
Beregningen på serveren bruker `functions/kpi-logic.js`, en eksakt kopi av `kpi/kpi-logic.js` (testen sjekker at de er like).

## Neste steg

- Besim: legges i `/authorizedUsers` og `/kpi/{enhet}/varselMottakere` (og ev. `/kpi/{enhet}/registratorer`) når brukeren finnes.
