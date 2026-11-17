'use strict';

// KPI Renhold: varsler (påminnelse/purring, «ikke på mål», månedsoppsummering) mot simulert database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const varsler = require('../functions/renhold-kpi-varsler-core');
const { FakeRtdb } = require('./helpers/fake-rtdb.cjs');

const TONY = 'TJKI3zlDKSR7jvFXksVFgEgjS432';
const KENNETH = 'gibm3aDi1KWlNyl7P3jTktQoGsM2';
const BESIM = 'uid-besim';

const KPIER = {
  farlige: { navn: 'Antall farlige forhold', omrade: 'HMS', enhet: 'Antall', retning: 'Opp', aggregat: 'Sum', maaltype: 'HIA', maal: 24, aktiv: true, sortering: 10 },
  score: { navn: 'Snitt fabrikk', omrade: 'Renholdsresultater', enhet: 'Score', retning: 'Ned', aggregat: 'Snitt', maaltype: 'Fast', maal: 1.5, aktiv: true, sortering: 20 },
};

function oppsett({ verdier = {}, registrert = {}, now = '2026-11-03T07:10:00Z', ekstra = {} } = {}) {
  const db = new FakeRtdb({ renholdKpi: { config: { 2026: { naerMaalProsent: 20, kpier: KPIER } }, verdier: { 2026: verdier }, registrert: { 2026: registrert }, ...ekstra } });
  const sendt = [];
  const deps = { db, now: () => new Date(now), send: async (uid, m) => { sendt.push({ uid, ...m }); }, log: { error() {} } };
  return { db, deps, sendt };
}

test('serverens kopi av beregningslogikken er lik appens', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'renhold-kpi', 'kpi-logic.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'functions', 'renhold-kpi-logic.js'), 'utf8');
  assert.equal(b, a, 'Kopier renhold-kpi/kpi-logic.js til functions/renhold-kpi-logic.js');
});

test('a) påminnelse den 3. for forrige måned til Tony og Kenneth, bare én gang', async () => {
  const { deps, sendt } = oppsett({ verdier: { '10': { farlige: 1 } } });
  const res = await varsler.paaminnelse(deps);
  assert.equal(res.sendt, true);
  assert.equal(res.maaned, 10);
  assert.deepEqual(sendt.map((s) => s.uid).sort(), [KENNETH, TONY].sort());
  assert.equal(sendt[0].title, 'Tid for KPI-registrering');
  assert.match(sendt[0].body, /Oktober mangler 1 av 2 verdier: Snitt fabrikk/);
  assert.match(sendt[0].link, /renhold-kpi\//);
  assert.equal((await varsler.paaminnelse(deps)).sendt, false, 'ikke dobbelt');
  assert.equal(sendt.length, 2);
});

test('a) ingen påminnelse når alt er registrert, eller på andre dager', async () => {
  let s = oppsett({ verdier: { '10': { farlige: 1, score: 1.6 } } });
  assert.equal((await varsler.paaminnelse(s.deps)).sendt, false);
  s = oppsett({ now: '2026-11-05T07:10:00Z' });
  assert.equal((await varsler.paaminnelse(s.deps)).sendt, false);
  assert.equal(s.sendt.length, 0);
});

test('a) purring den 7. når noe fortsatt mangler; januar gjelder desember året før', async () => {
  let s = oppsett({ now: '2026-11-07T07:10:00Z' });
  await varsler.paaminnelse(s.deps);
  assert.equal(s.sendt[0].title, 'Påminnelse: KPI for oktober mangler');
  assert.equal(s.sendt[0].eventType, 'renhold-kpi-purring');
  s = oppsett({ now: '2027-01-03T07:10:00Z' });
  const res = await varsler.paaminnelse(s.deps);
  assert.equal(res.aar, 2026);
  assert.equal(res.maaned, 12);
});

test('ekstra mottakere (f.eks. Besim) legges til i databasen', async () => {
  const { deps, sendt } = oppsett({ ekstra: { varselMottakere: { [BESIM]: true } } });
  await varsler.paaminnelse(deps);
  assert.deepEqual(sendt.map((s) => s.uid).sort(), [BESIM, KENNETH, TONY].sort());
});

test('b) varsel når en KPI faller til «Ikke på mål» ved ny måned', async () => {
  // t.o.m. sept: 18 mot mål 18 (på mål). Oktober = 0 -> 18 mot 20 (nær). Med grense 5 %: ikke på mål.
  const sep = [2, 2, 2, 2, 2, 2, 2, 2, 2];
  const verdier = {};
  sep.forEach((v, i) => { verdier[String(i + 1).padStart(2, '0')] = { farlige: v, score: 1.5 }; });
  verdier['10'] = { farlige: 0 };
  const s = oppsett({ verdier, registrert: { '10': { av: TONY, at: 'x' } } });
  await s.db.ref('/renholdKpi/config/2026/naerMaalProsent').set(5);
  const res = await varsler.vedEndring(s.deps, { aar: '2026', mm: '10', foer: null });
  assert.deepEqual(res.sendt, ['ikke-paa-maal:farlige']);
  assert.equal(s.sendt[0].title, 'Antall farlige forhold er ikke på mål');
  assert.match(s.sendt[0].body, /18 hittil i år mot mål 20/);
  // samme lagring en gang til (retry) gir ikke nytt varsel
  assert.deepEqual((await varsler.vedEndring(s.deps, { aar: '2026', mm: '10', foer: null })).sendt, []);
});

test('b) ingen varsel når KPI-en allerede var under mål, eller for en eldre måned', async () => {
  const s = oppsett({ verdier: { '01': { farlige: 0, score: 3 }, '02': { farlige: 0, score: 3 } } });
  assert.deepEqual((await varsler.vedEndring(s.deps, { aar: '2026', mm: '02', foer: null })).sendt.filter((x) => x.startsWith('ikke')), []);
  assert.equal((await varsler.vedEndring(s.deps, { aar: '2026', mm: '01', foer: { farlige: 1 } })).grunn, 'eldre måned');
});

test('d) månedsoppsummering når siste verdi for måneden registreres', async () => {
  const s = oppsett({ verdier: { '10': { farlige: 20, score: 1.4 } } });
  const res = await varsler.vedEndring(s.deps, { aar: '2026', mm: '10', foer: { farlige: 20 } });
  assert.ok(res.sendt.includes('oppsummering'));
  const m = s.sendt.find((x) => x.eventType === 'renhold-kpi-oppsummering');
  assert.equal(m.title, 'KPI Renhold: oktober er registrert');
  assert.match(m.body, /2 på mål · 0 nær mål · 0 ikke på mål/);
  assert.deepEqual((await varsler.vedEndring(s.deps, { aar: '2026', mm: '10', foer: { farlige: 20 } })).sendt, []);
});

test('import fra Excel gir ingen varsler', async () => {
  const s = oppsett({ verdier: { '10': { farlige: 0, score: 3 } }, registrert: { '10': { av: TONY, at: 'x', import: true } } });
  const res = await varsler.vedEndring(s.deps, { aar: '2026', mm: '10', foer: null });
  assert.equal(res.grunn, 'import');
  assert.equal(s.sendt.length, 0);
});

const hasDeps = fs.existsSync(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-functions'));
test('varslene er koblet til riktig databasesti og tidsplan', { skip: !hasDeps && 'functions/node_modules mangler' }, () => {
  const entry = require('../functions/entry.js');
  const endring = entry.notifyRenholdKpiEndringV1.__endpoint;
  assert.equal(endring.eventTrigger.eventFilterPathPatterns.ref, 'renholdKpi/verdier/{aar}/{mm}');
  assert.deepEqual(endring.region, ['europe-west1']);
  const plan = entry.notifyRenholdKpiPaaminnelseV1.__endpoint;
  assert.equal(plan.scheduleTrigger.schedule, '10 8 * * *');
  assert.equal(plan.scheduleTrigger.timeZone, 'Europe/Oslo');
});
