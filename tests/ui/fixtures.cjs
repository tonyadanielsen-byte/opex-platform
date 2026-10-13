'use strict';

// Testdata for UI-testene. Ribbefett finnes KUN her (som fixture), aldri i produktet.
const TONY = 'TJKI3zlDKSR7jvFXksVFgEgjS432';
const KENNETH = 'gibm3aDi1KWlNyl7P3jTktQoGsM2';
const ERLING = 'lJ7bn7HkbcZnhDoxfaBYQKEFL083';

const NOW_ISO = '2026-10-09T10:00:00.000Z'; // fredag 9. oktober 2026, kl. 12:00 i Oslo

const base = (over) => ({
  kategori: 'Kvalitet', omrade: 'Ferdigmat', prioritet: 'Høy', miljo: 'Produksjon', livssyklus: 'Aktiv',
  dato: '2026-09-20', forslagsstiller: 'Tony Danielsen', opprettetAv: 'Tony Danielsen', ...over,
});

const RIBBEFETT_TILTAK = {
  '-Orib1': base({ tittel: 'Fast lagergjennomgang hos Constellation', eier: 'Tony Danielsen', status: 'Aktiv', frist: '2026-10-30', systemId: 'KVAL-0101', nestesteg: 'Avtale møte med Constellation' }),
  '-Orib2': base({ tittel: 'Batchstyring ved bestilling fra Constellation', eier: 'Kenneth Nordbakk', status: 'Aktiv', frist: '2026-10-16', systemId: 'KVAL-0102', prioritet: 'Kritisk' }),
  '-Orib3': base({ tittel: 'Avvik mot Constellation – utgått vare sendt til Sarpsborg', eier: 'Tony Danielsen', status: 'Fullført', frist: '2026-10-02', livssyklus: 'Arkivert', arkivert: true, systemId: 'KVAL-0103' }),
  '-Orib4': base({ tittel: 'Internt avvik – datokontroll ved mottak på Frysa', eier: 'Erling Magnussen', status: 'Aktiv', frist: '2026-10-08', systemId: 'KVAL-0104' }),
  '-Orib5': base({ tittel: 'Internt avvik – datokontroll før pakking i Ferdigmat', eier: 'Kenneth Nordbakk', status: 'Innmeldt', frist: '2026-10-09', systemId: 'KVAL-0105' }),
  '-Orib6': base({ tittel: 'Vurdere systemvarsel/sperre ved mottak av utgått vare', eier: 'Erling Magnussen', status: 'Til godkjenning', frist: '2026-11-15', systemId: 'KVAL-0106', prioritet: 'Middels' }),
  '-Orib7': base({ tittel: 'Avklare tapskategori og årsak til restlager ribbefett 2025', eier: 'Tony Danielsen', status: 'Aktiv', frist: '2026-10-20', systemId: 'KVAL-0107' }),
};

const ANDRE_TILTAK = {
  '-Oann1': base({ tittel: 'Oppgradere etikettskriver pakkelinje 2', eier: 'Kenneth Nordbakk', kategori: 'KF', status: 'Aktiv', frist: '2026-10-28', systemId: 'KF-0044' }),
  '-Oann2': base({ tittel: 'Renholdsrutine for sluse', eier: 'Erling Magnussen', kategori: 'HMS', omrade: 'Renhold', status: 'Innmeldt', frist: '2026-10-12', systemId: 'HMS-0031', prioritet: 'Middels' }),
  '-Oann3': base({ tittel: 'Testtiltak som ikke skal telle', eier: 'Tony Danielsen', status: 'Aktiv', frist: '2026-10-01', miljo: 'Test' }),
};

const AUTHORIZED = { [TONY]: true, [KENNETH]: true, [ERLING]: true };

module.exports = { TONY, KENNETH, ERLING, NOW_ISO, RIBBEFETT_TILTAK, ANDRE_TILTAK, AUTHORIZED };
