'use strict';

// KPI Renhold: serverlogikk mot simulert database — tilgang, validering, lagring, logg, import og tiltak i felles liste.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../functions/renhold-kpi-core');
const { FakeRtdb } = require('./helpers/fake-rtdb.cjs');

const TONY = 'TJKI3zlDKSR7jvFXksVFgEgjS432';
const KENNETH = 'gibm3aDi1KWlNyl7P3jTktQoGsM2';
const LESER = 'uid-leser';
const FREMMED = 'uid-fremmed';

const KPIER = {
  farlige: { navn: 'Antall farlige forhold', omrade: 'HMS', enhet: 'Antall', retning: 'Opp', aggregat: 'Sum', maaltype: 'HIA', maal: 25 },
  score: { navn: 'Snitt fabrikk', omrade: 'Renholdsresultater', enhet: 'Score', retning: 'Ned', aggregat: 'Snitt', maaltype: 'Fast', maal: 1.5 },
};

function setup(extra = {}) {
  const db = new FakeRtdb({ authorizedUsers: { [TONY]: true, [KENNETH]: true, [LESER]: true }, ...extra });
  let n = 0;
  const deps = { db, now: () => new Date('2026-11-03T08:15:00Z'), sleep: async () => {}, newKey: () => `-tiltak${++n}`, log: { error() {}, warn() {}, info() {} } };
  return { db, deps };
}
async function val(db, path) { return (await db.ref(path).get()).val(); }
function koder(code) { return (err) => { assert.equal(err.code, code, err.message); return true; }; }

async function medOppsett() {
  const s = setup();
  await core.saveRenholdKpiConfig(s.deps, TONY, { aar: 2026, config: { naerMaalProsent: 15, kpier: KPIER } });
  return s;
}

test('uinnlogget og ikke-autorisert avvises', async () => {
  const { deps } = setup();
  await assert.rejects(core.getRenholdKpi(deps, '', {}), koder('unauthenticated'));
  await assert.rejects(core.getRenholdKpi(deps, FREMMED, {}), koder('permission-denied'));
});

test('leser kan hente, men ikke registrere', async () => {
  const { deps } = await medOppsett();
  const res = await core.getRenholdKpi(deps, LESER, {});
  assert.equal(res.aar, 2026);
  assert.equal(res.kanRegistrere, false);
  assert.equal(res.config.kpier.farlige.navn, 'Antall farlige forhold');
  await assert.rejects(core.saveRenholdKpiMaaned(deps, LESER, { aar: 2026, maaned: 1, verdier: { farlige: 1 } }), koder('permission-denied'));
  await assert.rejects(core.saveRenholdKpiConfig(deps, LESER, { aar: 2026, config: { kpier: KPIER } }), koder('permission-denied'));
});

test('registrator flagget i databasen får skrive (f.eks. Besim senere)', async () => {
  const { deps, db } = await medOppsett();
  await db.ref('/renholdKpi/registratorer/' + LESER).set(true);
  const res = await core.saveRenholdKpiMaaned(deps, LESER, { aar: 2026, maaned: 1, verdier: { farlige: 2 } });
  assert.equal(res.endret, 1);
});

test('oppsett lagres normalisert med standardverdier', async () => {
  const { deps, db } = await medOppsett();
  const cfg = await val(db, '/renholdKpi/config/2026');
  assert.equal(cfg.naerMaalProsent, 15);
  assert.equal(cfg.kpier.farlige.aktiv, true);
  assert.equal(cfg.kpier.farlige.sortering, 10);
  assert.equal(cfg.kpier.score.sortering, 20);
  assert.equal(cfg.oppdatertAv, TONY);
});

test('ugyldig oppsett avvises med norsk melding', async () => {
  const { deps } = setup();
  const kjor = (config) => core.saveRenholdKpiConfig(deps, TONY, { aar: 2026, config });
  await assert.rejects(kjor({ kpier: {} }), koder('invalid-argument'));
  await assert.rejects(kjor({ kpier: { 'Ugyldig ID': KPIER.farlige } }), koder('invalid-argument'));
  await assert.rejects(kjor({ kpier: { a: { ...KPIER.farlige, enhet: 'Liter' } } }), /enhet/);
  await assert.rejects(kjor({ kpier: { a: { ...KPIER.farlige, retning: 'Sidelengs' } } }), /retning/);
  await assert.rejects(kjor({ kpier: { a: KPIER.farlige, b: { ...KPIER.score, navn: 'antall farlige forhold' } } }), /to ganger/);
  await assert.rejects(kjor({ naerMaalProsent: 150, kpier: KPIER }), /0 og 100/);
  await assert.rejects(core.saveRenholdKpiConfig(deps, TONY, { aar: 1999, config: { kpier: KPIER } }), /år/);
});

test('månedsverdier: bare endringer skrives, alt logges med hvem og når', async () => {
  const { deps, db } = await medOppsett();
  let res = await core.saveRenholdKpiMaaned(deps, KENNETH, { aar: 2026, maaned: 10, verdier: { farlige: 1, score: 1.79 } });
  assert.equal(res.endret, 2);
  assert.deepEqual(await val(db, '/renholdKpi/verdier/2026/10'), { farlige: 1, score: 1.79 });
  assert.deepEqual(await val(db, '/renholdKpi/registrert/2026/10'), { av: KENNETH, at: '2026-11-03T08:15:00.000Z' });

  res = await core.saveRenholdKpiMaaned(deps, TONY, { aar: 2026, maaned: 10, verdier: { farlige: 1, score: 1.8 } });
  assert.equal(res.endret, 1);
  const logg = Object.values(await val(db, '/renholdKpi/logg/2026'));
  assert.equal(logg.length, 3);
  const endring = logg.find((l) => l.av === TONY);
  assert.deepEqual({ ...endring, at: undefined }, { mnd: '10', kpiId: 'score', foer: 1.79, etter: 1.8, av: TONY, at: undefined });

  res = await core.saveRenholdKpiMaaned(deps, TONY, { aar: 2026, maaned: 10, verdier: { farlige: 1, score: 1.8 } });
  assert.equal(res.endret, 0);
});

test('tom verdi (null) sletter en registrert verdi', async () => {
  const { deps, db } = await medOppsett();
  await core.saveRenholdKpiMaaned(deps, TONY, { aar: 2026, maaned: 2, verdier: { farlige: 3, score: 1.5 } });
  await core.saveRenholdKpiMaaned(deps, TONY, { aar: 2026, maaned: 2, verdier: { farlige: null } });
  assert.deepEqual(await val(db, '/renholdKpi/verdier/2026/02'), { score: 1.5 });
});

test('månedsverdier valideres', async () => {
  const { deps } = await medOppsett();
  const kjor = (data) => core.saveRenholdKpiMaaned(deps, TONY, { aar: 2026, maaned: 1, ...data });
  await assert.rejects(kjor({ verdier: { ukjent: 1 } }), /Ukjent KPI/);
  await assert.rejects(kjor({ verdier: { farlige: 'mange' } }), koder('invalid-argument'));
  await assert.rejects(kjor({ maaned: 13, verdier: { farlige: 1 } }), /måned/);
  await assert.rejects(core.saveRenholdKpiMaaned(deps, TONY, { aar: 2027, maaned: 1, verdier: { farlige: 1 } }), koder('failed-precondition'));
});

test('KPI med registrerte verdier kan ikke fjernes fra oppsettet, bare settes inaktiv', async () => {
  const { deps } = await medOppsett();
  await core.saveRenholdKpiMaaned(deps, TONY, { aar: 2026, maaned: 1, verdier: { score: 1.6 } });
  await assert.rejects(core.saveRenholdKpiConfig(deps, TONY, { aar: 2026, config: { kpier: { farlige: KPIER.farlige } } }), /Snitt fabrikk.*inaktiv/);
  await core.saveRenholdKpiConfig(deps, TONY, { aar: 2026, config: { kpier: { farlige: KPIER.farlige, score: { ...KPIER.score, aktiv: false } } } });
});

test('import skriver oppsett, årets og fjorårets verdier atomisk; krever bekreftelse for å overskrive', async () => {
  const { deps, db } = setup();
  const data = {
    aar: 2026, config: { kpier: KPIER },
    verdier: { '01': { farlige: 3, score: 1.74 }, '02': { farlige: 2 } },
    fjorVerdier: { '01': { farlige: 1 } },
  };
  const res = await core.importRenholdKpi(deps, TONY, data);
  assert.deepEqual(res, { aar: 2026, kpier: 2, verdier: 3, fjorVerdier: 1 });
  assert.deepEqual(await val(db, '/renholdKpi/verdier/2025'), { '01': { farlige: 1 } });
  assert.equal((await val(db, '/renholdKpi/registrert/2026/01')).import, true);

  await assert.rejects(core.importRenholdKpi(deps, TONY, data), koder('already-exists'));
  await core.importRenholdKpi(deps, TONY, { ...data, verdier: { '03': { farlige: 9 } }, overskriv: true });
  assert.deepEqual(await val(db, '/renholdKpi/verdier/2026'), { '03': { farlige: 9 } });

  const henting = await core.getRenholdKpi(deps, LESER, { aar: 2026 });
  assert.deepEqual(henting.fjorVerdier, { '01': { farlige: 1 } });
  assert.deepEqual(henting.aarListe, [2026]);
});

test('import avviser verdier for ukjente KPI-er og ugyldige måneder', async () => {
  const { deps } = setup();
  await assert.rejects(core.importRenholdKpi(deps, TONY, { aar: 2026, config: { kpier: KPIER }, verdier: { '01': { x: 1 } } }), /Ukjent KPI/);
  await assert.rejects(core.importRenholdKpi(deps, TONY, { aar: 2026, config: { kpier: KPIER }, verdier: { '13': { farlige: 1 } } }), /måned/);
});

test('KPI-tiltak legges i felles tiltaksliste med kobling og felter som gir eksisterende varsler', async () => {
  const { deps, db } = await medOppsett();
  const res = await core.createRenholdKpiTiltak(deps, KENNETH, {
    aar: 2026, kpiId: 'farlige', tittel: 'Vernerunde på kveld', eier: 'Tony Danielsen', frist: '2026-12-01', prioritet: 'Høy', beskrivelse: 'Henger etter',
  });
  const t = await val(db, `/tiltak/${res.tiltakId}`);
  assert.equal(t.tittel, 'Vernerunde på kveld');
  assert.equal(t.kategori, 'HMS');
  assert.equal(t.omrade, 'Renhold');
  assert.equal(t.status, 'Aktiv');
  assert.equal(t.miljo, 'Produksjon');
  assert.equal(t.eier, 'Tony Danielsen');
  assert.equal(t.opprettetAv, 'Kenneth Nordbakk');
  assert.equal(t.dato, '2026-11-03');
  assert.equal(t.kilde, 'renhold-kpi');
  assert.equal(t.kpiId, 'farlige');
  assert.equal(t.kpiAar, 2026);
  assert.equal(t.kpiNavn, 'Antall farlige forhold');
});

test('KPI-tiltak: kategori følger område, og feil input avvises', async () => {
  const { deps, db } = await medOppsett();
  const res = await core.createRenholdKpiTiltak(deps, LESER, { aar: 2026, kpiId: 'score', tittel: 'Syrevask B-linje', eier: 'Kenneth Nordbakk', frist: '2026-12-01' });
  assert.equal((await val(db, `/tiltak/${res.tiltakId}`)).kategori, 'Kvalitet');
  const kjor = (data) => core.createRenholdKpiTiltak(deps, TONY, { aar: 2026, kpiId: 'farlige', tittel: 'X', eier: 'Tony Danielsen', frist: '2026-12-01', ...data });
  await assert.rejects(kjor({ tittel: '' }), /Tittel/);
  await assert.rejects(kjor({ frist: '1. des' }), /frist/);
  await assert.rejects(kjor({ kpiId: 'finnes-ikke' }), koder('not-found'));
  await assert.rejects(kjor({ prioritet: 'Supert' }), /prioritet/);
  await assert.rejects(core.createRenholdKpiTiltak(deps, FREMMED, { aar: 2026, kpiId: 'farlige' }), koder('permission-denied'));
});
