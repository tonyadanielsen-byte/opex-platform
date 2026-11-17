'use strict';

// KPI: beregningsregler (HIÅ, mål, status, grenser) og Excel-import mot et syntetisk ark med samme struktur.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../kpi/kpi-logic.js');
const I = require('../kpi/kpi-import.js');

const FARLIGE = { id: 'farlige', navn: 'Antall farlige forhold', omrade: 'HMS', enhet: 'Antall', retning: 'Opp', aggregat: 'Sum', maaltype: 'HIA', maal: 24 };
const HENDELSER = { id: 'hendelser', navn: 'Antall HMS-hendelser', omrade: 'HMS', enhet: 'Antall', retning: 'Ned', aggregat: 'Sum', maaltype: 'HIA', maal: 12 };
const SCORE = { id: 'score', navn: 'Snitt fabrikk', omrade: 'Renholdsresultater', enhet: 'Score', retning: 'Ned', aggregat: 'Snitt', maaltype: 'Fast', maal: 1.5 };
const TILSTEDE = { id: 'tilstede', navn: 'Tilstedeværelse', omrade: 'HMS', enhet: '%', retning: 'Opp', aggregat: 'Snitt', maaltype: 'Fast', maal: 94 };
const CONFIG = { naerMaalProsent: 20, kpier: { farlige: FARLIGE, hendelser: HENDELSER, score: SCORE, tilstede: TILSTEDE } };

function v(map) { // { farlige: [1,2,...] } -> { '01': { farlige: 1 } }
  const out = {};
  Object.entries(map).forEach(([id, arr]) => arr.forEach((x, i) => { if (x === null || x === undefined) return; const m = L.mndKey(i + 1); out[m] = out[m] || {}; out[m][id] = x; }));
  return out;
}

test('Sum + årsmål: faktisk = summen t.o.m. måneden, mål = årsmål/12 × måned', () => {
  const r = L.vurderKpi(FARLIGE, CONFIG, v({ farlige: [3, 2, 2] }), {}, 3);
  assert.equal(r.faktisk, 7);
  assert.equal(r.maal, 6);
  assert.equal(r.status, L.STATUS.PAA);
  assert.equal(r.rest, 17);
});

test('Opp: «nær mål» innenfor grensen under målet, ellers «ikke på mål»', () => {
  // mål t.o.m. mars = 6. 20 % under = 4,8
  assert.equal(L.vurderKpi(FARLIGE, CONFIG, v({ farlige: [2, 2, 1] }), {}, 3).status, L.STATUS.NAER); // 5
  assert.equal(L.vurderKpi(FARLIGE, CONFIG, v({ farlige: [2, 1, 1] }), {}, 3).status, L.STATUS.IKKE); // 4
});

test('Ned (HMS-hendelser): over målet er dårlig, innenfor grensen er «nær mål»', () => {
  // mål t.o.m. juni = 6
  assert.equal(L.vurderKpi(HENDELSER, CONFIG, v({ hendelser: [1, 1, 1, 1, 1, 1] }), {}, 6).status, L.STATUS.PAA);
  assert.equal(L.vurderKpi(HENDELSER, CONFIG, v({ hendelser: [2, 1, 1, 1, 1, 1] }), {}, 6).status, L.STATUS.NAER); // 7 <= 7,2
  assert.equal(L.vurderKpi(HENDELSER, CONFIG, v({ hendelser: [3, 2, 1, 1, 1, 1] }), {}, 6).status, L.STATUS.IKKE); // 9
});

test('Snitt + fast mål: gjennomsnitt av registrerte måneder; tomme måneder teller ikke', () => {
  const r = L.vurderKpi(SCORE, CONFIG, v({ score: [1.4, null, 1.6] }), {}, 3);
  assert.equal(r.faktisk, 1.5);
  assert.equal(r.maal, 1.5);
  assert.equal(r.status, L.STATUS.PAA);
  assert.equal(r.antallRegistrert, 2);
});

test('egen grense på KPI overstyrer felles grense', () => {
  const streng = { ...SCORE, naerMaalProsent: 5 };
  // 1,6 er 6,7 % over 1,5 -> nær mål med 20 %, ikke på mål med 5 %
  assert.equal(L.vurderKpi(SCORE, CONFIG, v({ score: [1.6] }), {}, 1).status, L.STATUS.NAER);
  assert.equal(L.vurderKpi(streng, CONFIG, v({ score: [1.6] }), {}, 1).status, L.STATUS.IKKE);
  assert.equal(L.vurderKpi(SCORE, { ...CONFIG, naerMaalProsent: 0 }, v({ score: [1.51] }), {}, 1).status, L.STATUS.IKKE);
});

test('mål 0 med retning Ned (skader): 0 er på mål, alt over er ikke på mål', () => {
  const skader = { id: 'skader', navn: 'Skader', retning: 'Ned', aggregat: 'Sum', maaltype: 'HIA', maal: 0, enhet: 'Antall' };
  assert.equal(L.vurderKpi(skader, CONFIG, v({ skader: [0, 0] }), {}, 2).status, L.STATUS.PAA);
  assert.equal(L.vurderKpi(skader, CONFIG, v({ skader: [0, 1] }), {}, 2).status, L.STATUS.IKKE);
});

test('ingen verdier eller ingen mål gir «Ingen data»', () => {
  assert.equal(L.vurderKpi(FARLIGE, CONFIG, {}, {}, 5).status, L.STATUS.INGEN);
  assert.equal(L.vurderKpi({ ...FARLIGE, maal: null }, CONFIG, v({ farlige: [1] }), {}, 1).status, L.STATUS.INGEN);
});

test('verdier etter valgt måned tas ikke med', () => {
  const r = L.vurderKpi(FARLIGE, CONFIG, v({ farlige: [1, 1, 10] }), {}, 2);
  assert.equal(r.faktisk, 2);
});

test('fjorårets HIÅ beregnes på samme måte for sammenligning', () => {
  const r = L.vurderKpi(FARLIGE, CONFIG, v({ farlige: [1] }), v({ farlige: [4, 5] }), 2);
  assert.equal(r.fjorHia, 9);
  assert.equal(r.fjorPeriode, 5);
});

test('vurderAar teller status, grupperer på område og lister fokus/styrker', () => {
  const res = L.vurderAar(CONFIG, v({ farlige: [3], hendelser: [5], score: [1.4] }), {}, 1);
  assert.equal(res.totalt, 4);
  assert.deepEqual(res.tell, { paa: 2, naer: 0, ikke: 1, ingen: 1 });
  assert.deepEqual(res.fokus.map((r) => r.id), ['hendelser']);
  assert.deepEqual(res.grupper.map((g) => g.omrade), ['HMS', 'Renholdsresultater']);
});

test('inaktive KPI-er vises ikke', () => {
  const cfg = { ...CONFIG, kpier: { ...CONFIG.kpier, score: { ...SCORE, aktiv: false } } };
  assert.equal(L.aktiveKpier(cfg).length, 3);
});

test('sisteMaanedMedData og manglerVerdi', () => {
  const verdier = v({ farlige: [1, 2, null, 4], hendelser: [1, 1, 1, null] });
  assert.equal(L.sisteMaanedMedData(verdier), 4);
  assert.equal(L.sisteMaanedMedData({}), 1);
  assert.deepEqual(L.manglerVerdi(CONFIG, verdier, 4).map((k) => k.id).sort(), ['hendelser', 'score', 'tilstede']);
});

test('parseTall leser norsk tallformat', () => {
  assert.equal(L.parseTall('94,8'), 94.8);
  assert.equal(L.parseTall('94,8 %'), 94.8);
  assert.equal(L.parseTall('500 000 kr'), 500000);
  assert.equal(L.parseTall('  '), null);
  assert.ok(Number.isNaN(L.parseTall('abc')));
  assert.ok(Number.isNaN(L.parseTall('1,2,3')));
});

test('fmtVerdi formaterer etter enhet', () => {
  assert.equal(L.fmtVerdi(94.8, '%').replace(/\s/g, ' '), '94,8 %');
  assert.equal(L.fmtVerdi(1.674, 'Score'), '1,67');
  assert.equal(L.fmtVerdi(416666.67, 'Kr').replace(/\s/g, ' '), '416 667 kr');
  assert.equal(L.fmtVerdi(13, 'Antall'), '13');
  assert.equal(L.fmtVerdi(20.83, 'Antall', { brok: true }), '20,8');
  assert.equal(L.fmtVerdi(null, 'Antall'), '–');
});

/* ------------------------------------------------------------------ import */

function syntetiskBok() {
  const ark = {};
  const defs = [
    ['HMS', 'Antall farlige forhold', 'Antall', 20, 25, 'Opp', 'Sum', 'HIA'],
    ['HMS', 'Antall HMS-hendelser', 'Antall', 8, 5, 'Opp', 'Sum', 'HIA'],
    ['HMS', 'Tilstedeværelse', '%', 0.866, 0.94, 'Opp', 'Snitt', 'Fast'],
    ['Renholdsresultater', 'Snitt fabrikk', 'Score', 1.63, 1.5, 'Ned', 'Snitt', 'Fast'],
  ];
  const mnd = { Januar: [[3, 1], [1, 0], [0.691, 0.85], [1.74, 1.6]], Februar: [[2, 2], [1, 1], [null, 0.86], [1.53, 1.7]], Mars: [[null, 0], [null, 0], [null, null], [null, null]] };
  for (const navn of L.MAANEDER) {
    const s = {};
    s.C6 = 'KPI'; s.F6 = 'Mål 2026';
    defs.forEach((d, i) => {
      const r = 8 + i;
      Object.assign(s, { ['B' + r]: d[0], ['C' + r]: d[1], ['D' + r]: d[2], ['E' + r]: d[3], ['F' + r]: d[4], ['H' + r]: d[5], ['M' + r]: d[6], ['N' + r]: d[7] });
      const m = mnd[navn] && mnd[navn][i];
      if (m) { s['J' + r] = m[0]; s['I' + r] = m[1]; }
    });
    s.B23 = 'Tiltaksliste HMS';
    ark[navn] = s;
  }
  return { celle: (a, adr) => (ark[a] ? ark[a][adr] ?? null : null), navn: Object.keys(ark).concat(['Dashboard', 'Liste']) };
}

test('import leser KPI-er, mål, retning og verdier fra månedsarkene', () => {
  const b = syntetiskBok();
  const res = I.lesBok(b.celle, b.navn);
  assert.equal(res.aar, 2026);
  assert.deepEqual(Object.keys(res.config.kpier), ['antall-farlige-forhold', 'antall-hms-hendelser', 'tilstedevaerelse', 'snitt-fabrikk']);
  const t = res.config.kpier.tilstedevaerelse;
  assert.equal(t.maal, 94);
  assert.equal(t.fjorResultat, 86.6);
  assert.equal(t.aggregat, 'Snitt');
  assert.equal(t.maaltype, 'Fast');
  assert.equal(res.verdier['01'].tilstedevaerelse, 69.1);
  assert.equal(res.verdier['01']['antall-farlige-forhold'], 3);
  assert.equal(res.verdier['02'].tilstedevaerelse, undefined);
  assert.equal(res.fjorVerdier['02'].tilstedevaerelse, 86);
  assert.deepEqual(res.maaneder, [1, 2]);
  assert.equal(res.verdier['03'], undefined);
  assert.equal(res.fjorVerdier['03']['antall-farlige-forhold'], 0);
});

test('import retter HMS-hendelser til retning Ned og melder det', () => {
  const b = syntetiskBok();
  const res = I.lesBok(b.celle, b.navn);
  assert.equal(res.config.kpier['antall-hms-hendelser'].retning, 'Ned');
  assert.equal(res.config.kpier['antall-farlige-forhold'].retning, 'Opp');
  assert.equal(res.advarsler.length, 1);
  assert.match(res.advarsler[0], /HMS-hendelser/);
});

test('import avviser en fil uten forventet oppsett', () => {
  assert.throws(() => I.lesBok(() => null, ['Ark1']), /Januar/);
  assert.throws(() => I.lesBok(() => null, ['Januar']), /KPI/);
});

test('slug lager trygge KPI-id-er', () => {
  assert.equal(I.slug('Økonomisk effekt av KF-tiltak'), 'okonomisk-effekt-av-kf-tiltak');
  assert.equal(I.slug('Snitt påleggsproduksjon'), 'snitt-paleggsproduksjon');
});
