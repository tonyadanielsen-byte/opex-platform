/*
 * kpi-logic.js — ren beregningslogikk for KPI Renhold (ingen DOM, ingen Firebase). Brukes i nettleseren og i tester.
 *
 * Én felles statusregel (erstatter de ulike formlene i Excel-arket):
 *   Faktisk HIÅ  : Sum  -> summen av registrerte måneder t.o.m. valgt måned
 *                  Snitt -> gjennomsnittet av registrerte måneder t.o.m. valgt måned
 *   Mål HIÅ      : HIA  -> årsmål / 12 × månedsnummer
 *                  Fast -> årsmålet slik det står
 *   Status       : Opp: faktisk ≥ mål -> «På mål»; faktisk ≥ mål × (1 − grense) -> «Nær mål»; ellers «Ikke på mål»
 *                  Ned: faktisk ≤ mål -> «På mål»; faktisk ≤ mål × (1 + grense) -> «Nær mål»; ellers «Ikke på mål»
 *                  Ingen registrerte verdier -> «Ingen data»
 *   Grense       : KPI-ens egen naerMaalProsent hvis satt, ellers årets felles naerMaalProsent (standard 20 %).
 *
 * Verdier lagres i visningsenhet (prosent som 94,8 – ikke 0,948).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OpExKpiLogic = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAANEDER = ['Januar', 'Februar', 'Mars', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Desember'];
  var MND_KEYS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
  var STATUS = { PAA: 'På mål', NAER: 'Nær mål', IKKE: 'Ikke på mål', INGEN: 'Ingen data' };
  var STANDARD_GRENSE = 20;
  var ENHETER = ['Antall', '%', 'Kr', 'Score'];
  var OMRAADER = ['HMS', 'KF', 'Renholdsresultater'];

  function mndKey(n) { return MND_KEYS[n - 1]; }
  function mndNavn(n) { return MAANEDER[n - 1] || ''; }
  function erTall(v) { return typeof v === 'number' && isFinite(v); }

  /** Sorterte, aktive KPI-er fra en årskonfigurasjon: [{id, ...def}] */
  function aktiveKpier(config) {
    var k = (config && config.kpier) || {};
    return Object.keys(k).map(function (id) { return Object.assign({ id: id }, k[id]); })
      .filter(function (d) { return d.aktiv !== false; })
      .sort(function (a, b) { return (a.sortering || 0) - (b.sortering || 0) || String(a.navn).localeCompare(String(b.navn), 'nb'); });
  }

  /** Verdiene for én KPI måned for måned: array med 12 elementer (tall eller null). verdier = { '01': { kpiId: tall } } */
  function serie(verdier, kpiId) {
    return MND_KEYS.map(function (m) {
      var v = verdier && verdier[m] && verdier[m][kpiId];
      return erTall(v) ? v : null;
    });
  }

  function grenseFor(def, config) {
    if (def && erTall(def.naerMaalProsent)) return def.naerMaalProsent;
    if (config && erTall(config.naerMaalProsent)) return config.naerMaalProsent;
    return STANDARD_GRENSE;
  }

  /** Faktisk verdi hittil i år t.o.m. måned n (1–12). null hvis ingen registrerte verdier. */
  function faktiskHia(def, s, n) {
    var tall = s.slice(0, n).filter(erTall);
    if (!tall.length) return null;
    var sum = tall.reduce(function (a, b) { return a + b; }, 0);
    return def.aggregat === 'Snitt' ? sum / tall.length : sum;
  }

  /** Mål hittil i år t.o.m. måned n. null hvis KPI-en ikke har mål. */
  function maalHia(def, n) {
    if (!erTall(def.maal)) return null;
    return def.maaltype === 'HIA' ? def.maal / 12 * n : def.maal;
  }

  function status(def, faktisk, maal, grenseProsent) {
    if (!erTall(faktisk) || !erTall(maal)) return STATUS.INGEN;
    var g = (erTall(grenseProsent) ? grenseProsent : STANDARD_GRENSE) / 100;
    var eps = 1e-9;
    if (def.retning === 'Ned') {
      if (faktisk <= maal + eps) return STATUS.PAA;
      if (faktisk <= maal * (1 + g) + eps) return STATUS.NAER;
      return STATUS.IKKE;
    }
    if (faktisk >= maal - eps) return STATUS.PAA;
    if (faktisk >= maal * (1 - g) - eps) return STATUS.NAER;
    return STATUS.IKKE;
  }

  /**
   * Full vurdering av én KPI for måned n.
   * fjorVerdier: fjorårets verdier (samme kpiId) for sammenligning, kan mangle.
   */
  function vurderKpi(def, config, verdier, fjorVerdier, n) {
    var s = serie(verdier, def.id);
    var fs = serie(fjorVerdier, def.id);
    var faktisk = faktiskHia(def, s, n);
    var maal = maalHia(def, n);
    var grense = grenseFor(def, config);
    var st = status(def, faktisk, maal, grense);
    return {
      id: def.id, def: def, serie: s, fjorSerie: fs,
      periode: s[n - 1], fjorPeriode: fs[n - 1],
      faktisk: faktisk, maal: maal, aarsmaal: erTall(def.maal) ? def.maal : null,
      fjorHia: faktiskHia(def, fs, n),
      rest: erTall(def.maal) && erTall(faktisk) ? def.maal - faktisk : null,
      grense: grense, status: st,
      antallRegistrert: s.slice(0, n).filter(erTall).length,
    };
  }

  /** Vurdering av alle aktive KPI-er + oppsummering for dashboard. */
  function vurderAar(config, verdier, fjorVerdier, n) {
    var rader = aktiveKpier(config).map(function (def) { return vurderKpi(def, config, verdier, fjorVerdier, n); });
    var tell = { paa: 0, naer: 0, ikke: 0, ingen: 0 };
    rader.forEach(function (r) {
      if (r.status === STATUS.PAA) tell.paa++;
      else if (r.status === STATUS.NAER) tell.naer++;
      else if (r.status === STATUS.IKKE) tell.ikke++;
      else tell.ingen++;
    });
    var grupper = [];
    rader.forEach(function (r) {
      var navn = r.def.omrade || 'Annet';
      var g = grupper.filter(function (x) { return x.omrade === navn; })[0];
      if (!g) { g = { omrade: navn, rader: [] }; grupper.push(g); }
      g.rader.push(r);
    });
    return {
      maaned: n, maanedNavn: mndNavn(n), rader: rader, grupper: grupper, tell: tell, totalt: rader.length,
      fokus: rader.filter(function (r) { return r.status === STATUS.IKKE; }),
      naer: rader.filter(function (r) { return r.status === STATUS.NAER; }),
      styrker: rader.filter(function (r) { return r.status === STATUS.PAA; }),
    };
  }

  /** Siste måned (1–12) som har minst én registrert verdi, ellers 1. */
  function sisteMaanedMedData(verdier) {
    for (var i = 12; i >= 1; i--) {
      var m = verdier && verdier[mndKey(i)];
      if (m && Object.keys(m).some(function (k) { return erTall(m[k]); })) return i;
    }
    return 1;
  }

  /** KPI-er som mangler verdi for måned n. */
  function manglerVerdi(config, verdier, n) {
    var m = (verdier && verdier[mndKey(n)]) || {};
    return aktiveKpier(config).filter(function (d) { return !erTall(m[d.id]); });
  }

  /* ---------------------------------------------------------------- formatering */

  function fmtTall(v, desimaler) {
    if (!erTall(v)) return '–';
    return v.toLocaleString('nb-NO', { minimumFractionDigits: desimaler, maximumFractionDigits: desimaler });
  }

  /** Formaterer en verdi etter KPI-ens enhet. hia=true gir én desimal på antall når målet er brøkdel (f.eks. 20,8). */
  function fmtVerdi(v, enhet, opts) {
    if (!erTall(v)) return '–';
    var o = opts || {};
    if (enhet === '%') return fmtTall(v, 1) + ' %';
    if (enhet === 'Kr') return fmtTall(Math.round(v), 0) + ' kr';
    if (enhet === 'Score') return fmtTall(v, 2);
    if (o.brok && Math.round(v) !== v) return fmtTall(v, 1);
    return fmtTall(Math.round(v * 10) / 10, Math.round(v) === v ? 0 : 1);
  }

  /** Leser et tall skrevet på norsk («1 234,5», «94,8 %», «500 000 kr»). Tom streng -> null. Ugyldig -> NaN. */
  function parseTall(tekst) {
    var t = String(tekst == null ? '' : tekst).trim().replace(/\s| |kr|%/gi, '').replace(',', '.');
    if (t === '') return null;
    if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
    return Number(t);
  }

  return Object.freeze({
    MAANEDER: MAANEDER, MND_KEYS: MND_KEYS, STATUS: STATUS, STANDARD_GRENSE: STANDARD_GRENSE, ENHETER: ENHETER, OMRAADER: OMRAADER,
    mndKey: mndKey, mndNavn: mndNavn, erTall: erTall, aktiveKpier: aktiveKpier, serie: serie, grenseFor: grenseFor,
    faktiskHia: faktiskHia, maalHia: maalHia, status: status, vurderKpi: vurderKpi, vurderAar: vurderAar,
    sisteMaanedMedData: sisteMaanedMedData, manglerVerdi: manglerVerdi, fmtTall: fmtTall, fmtVerdi: fmtVerdi, parseTall: parseTall,
  });
}));
