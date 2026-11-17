# KPI Renhold — v1

KPI-registrering og oppfølging for renhold (Nortura Sarpsborg). Erstatter Excel-arket «KPI 2026 Renhold».

**Egen app** på `renhold-kpi/` (https://tonyadanielsen-byte.github.io/opex-platform/renhold-kpi/), med kobling til tiltakslista i OpEx Hub:
samme Firebase-prosjekt og samme innlogging (samme opprinnelse, så innlogging i OpEx gjelder også her), leser `/tiltak` for å vise
koblede tiltak, oppretter KPI-tiltak i den felles lista og åpner tiltak i OpEx Hub (`?openTask=`). OpEx Hub har bare en lenke hit.
Visninger: `#kpi`, `#kpi/registrer`, `#kpi/oppsett`.

## Filer

| Fil | Innhold |
|---|---|
| `renhold-kpi/index.html`, `kpi-shell.js`, `kpi-shell.css` | Selve appen: topplinje, innlogging, Firebase og vertsflaten (`OpExHost`) mot tiltakslista. |
| `renhold-kpi/kpi-logic.js` | Beregning (HIÅ, mål, status, grenser) og tallformat. Ren, testet. |
| `renhold-kpi/kpi-import.js` | Leser Excel-arket (månedsark Januar–Desember) til oppsett + verdier. |
| `renhold-kpi/kpi-app.js` | Datalag (callables), ruting og visninger: Oversikt (statusfelt, nøkkeltall, utvikling, detaljer per område), Registrer, Oppsett. |
| `renhold-kpi/kpi-charts.js` | Avhengighetsfrie SVG-grafer: månedsgraf med mål og fjorår (hover), sparkline, statusring. |
| `renhold-kpi/kpi.css` | Stil (bygger på appens tokens og fargeprofil; faste status- og seriefarger). |
| `functions/renhold-kpi-core.js` | Serverlogikk: tilgang, validering, lagring, logg, import, tiltak. |
| `functions/renhold-kpi-api.js` | Callables (`getRenholdKpiV1`, `saveRenholdKpiMaanedV1`, `saveRenholdKpiConfigV1`, `importRenholdKpiV1`, `createRenholdKpiTiltakV1`). |

## Statusregel (én felles regel)

- **Faktisk HIÅ**: Sum → summen av registrerte måneder t.o.m. valgt måned. Snitt → gjennomsnittet av registrerte måneder.
- **Mål HIÅ**: Årsmål (HIA) → årsmål / 12 × månedsnummer. Fast → målet slik det står.
- **Status**: Opp: ≥ mål = *På mål*, ≥ mål × (1 − grense) = *Nær mål*. Ned: ≤ mål = *På mål*, ≤ mål × (1 + grense) = *Nær mål*.
  Ellers *Ikke på mål*. Ingen verdier = *Ingen data*.
- **Grense**: per KPI hvis satt, ellers årets felles grense (standard 20 %). Justeres under Oppsett.

Excel-arket brukte ulike grenser i månedsark og dashboard (±20 % mot +0,05) og hardkodet månedsnummer i formlene. Det er borte.

## Data (Realtime Database, kun via callables)

```
/renholdKpi/config/{år}              oppsett: naerMaalProsent, kpier{ id: navn, omrade, enhet, retning, aggregat, maaltype, maal, fjorResultat, naerMaalProsent, sortering, aktiv }
/renholdKpi/verdier/{år}/{mm}/{kpiId} månedens verdi (prosent lagres som 94.8)
/renholdKpi/registrert/{år}/{mm}     { av, at } siste registrering
/renholdKpi/logg/{år}/{nøkkel}        endringslogg { mnd, kpiId, foer, etter, av, at }
/renholdKpi/registratorer/{uid}       true = kan registrere (i tillegg til Tony og Kenneth i koden)
```

Klienter har ingen direkte tilgang (`database.rules.json` er deny-by-default for ukjente noder).
Lese: alle i `/authorizedUsers`. Skrive: registratorer.

## Tiltak

«+ Tiltak» på et KPI-kort oppretter et tiltak i den **felles tiltakslista** (`/tiltak`, område Renhold) med
`kilde: 'renhold-kpi'`, `kpiId`, `kpiAar`, `kpiNavn`. Eksisterende varsler for tiltak (opprettet, endret, frist) gjelder automatisk.
Kortet viser åpne tiltak koblet til KPI-en.

## Nytt år

Oppsett → «Lag oppsett for {år+1}» kopierer KPI-ene og målene; årets resultat blir «oppnådd i fjor». Juster mål etterpå.
En KPI med registrerte verdier kan ikke slettes, bare settes inaktiv.

## Varsler

Sendes som de øvrige OpEx-varslene: aktivitetsinnboks + push til enheter som har slått på varsler i OpEx Hub. Klikk åpner KPI-appen.

| Varsel | Når | Funksjon |
|---|---|---|
| Påminnelse om registrering | Den 3. kl. 08:10 for forrige måned, hvis noe mangler | `notifyRenholdKpiPaaminnelseV1` |
| Purring | Den 7., 10. og 14. hvis noe fortsatt mangler | `notifyRenholdKpiPaaminnelseV1` |
| KPI falt til «Ikke på mål» | Ved lagring av nyeste måned (sammenlignet med før; ny måned: med forrige måned) | `notifyRenholdKpiEndringV1` |
| Månedsoppsummering | Når siste verdi for måneden registreres | `notifyRenholdKpiEndringV1` |
| Tiltak (opprettet, endret, frist) | Eksisterende tiltaksvarsler, siden KPI-tiltak ligger i tiltakslista | `notifyNewTaskV1C` m.fl. |

Mottakere: Tony og Kenneth, pluss alle med `/renholdKpi/varselMottakere/{uid} = true` (f.eks. Besim, når han har bruker).
Hvert varsel sendes bare én gang (`/renholdKpi/varslet/{nøkkel}`). Import fra Excel gir ingen varsler.
Beregningen på serveren bruker `functions/renhold-kpi-logic.js`, en eksakt kopi av `renhold-kpi/kpi-logic.js` (testen sjekker at de er like).

## Neste steg

- Besim: legges i `/authorizedUsers` og `/renholdKpi/varselMottakere` (og ev. `/renholdKpi/registratorer`) når brukeren finnes.
