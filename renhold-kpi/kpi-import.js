/*
 * kpi-import.js — leser dagens Excel-ark («KPI 2026 Renhold») og lager oppsett + verdier for appen.
 *
 * Arkstruktur (per månedsark Januar … Desember, rad 8 og nedover til første tomme KPI-celle):
 *   B Område · C KPI · D Enhet · E Oppnådd i fjor · F Mål · H Retning · I Fjorårets månedsverdi · J Årets månedsverdi
 *   M Aggregat (Sum/Snitt) · N Måltype (HIA/Fast)
 * Definisjonene hentes fra Januar-arket (de andre arkene peker dit). Året leses fra «Mål 2026» i F6.
 *
 * Avtalte rettelser ved import: «Antall HMS-hendelser» skal ha retning Ned (Excel hadde Opp).
 * Prosent lagres som prosentpoeng (0,948 i Excel -> 94,8).
 *
 * Ren funksjon: tar en celle-leser (ark, adresse) -> verdi, slik at den kan testes uten SheetJS.
 */
(function (root, factory) {
  var api = factory(root.OpExKpiLogic || (typeof require === 'function' ? require('./kpi-logic.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OpExKpiImport = api;
}(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  var RETTELSER = { 'antall hms-hendelser': { retning: 'Ned' } };

  function slug(navn) {
    return String(navn).toLowerCase()
      .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kpi';
  }

  function tall(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') { var n = L.parseTall(v); return typeof n === 'number' && isFinite(n) ? n : null; }
    return null;
  }

  function tekst(v) { return v === null || v === undefined ? '' : String(v).trim(); }

  function prosent(v, enhet) {
    if (v === null) return null;
    if (enhet === '%' && Math.abs(v) <= 1.5) return Math.round(v * 1000) / 10;
    return v;
  }

  function normEnhet(e) {
    var t = tekst(e);
    var hit = L.ENHETER.filter(function (x) { return x.toLowerCase() === t.toLowerCase(); })[0];
    return hit || 'Antall';
  }

  /**
   * celle(ark, 'C8') -> verdi. arkNavn: liste over arkene i boka.
   * Returnerer { aar, config, verdier, fjorVerdier, advarsler, maaneder }.
   */
  function lesBok(celle, arkNavn) {
    var advarsler = [];
    var finnes = function (n) { return arkNavn.indexOf(n) >= 0; };
    if (!finnes('Januar')) throw new Error('Fant ikke arket «Januar». Er dette KPI-arket for renhold?');
    if (tekst(celle('Januar', 'C6')).toLowerCase() !== 'kpi') throw new Error('Arket «Januar» har ikke forventet oppsett (mangler «KPI» i C6).');

    var aarMatch = /(\d{4})/.exec(tekst(celle('Januar', 'F6')));
    var aar = aarMatch ? Number(aarMatch[1]) : new Date().getFullYear();

    var kpier = {};
    var rader = []; // { rad, id, enhet }
    for (var r = 8; r < 60; r++) {
      var navn = tekst(celle('Januar', 'C' + r));
      if (!navn) break;
      var enhet = normEnhet(celle('Januar', 'D' + r));
      var id = slug(navn);
      while (kpier[id]) id = (id + '-2').slice(0, 40);
      var def = {
        navn: navn,
        omrade: tekst(celle('Januar', 'B' + r)) || 'Annet',
        enhet: enhet,
        retning: tekst(celle('Januar', 'H' + r)) === 'Ned' ? 'Ned' : 'Opp',
        aggregat: tekst(celle('Januar', 'M' + r)) === 'Snitt' ? 'Snitt' : 'Sum',
        maaltype: tekst(celle('Januar', 'N' + r)) === 'Fast' ? 'Fast' : 'HIA',
        maal: prosent(tall(celle('Januar', 'F' + r)), enhet),
        fjorResultat: prosent(tall(celle('Januar', 'E' + r)), enhet),
        sortering: (rader.length + 1) * 10,
        aktiv: true,
      };
      var rett = RETTELSER[navn.toLowerCase()];
      if (rett) {
        Object.keys(rett).forEach(function (k) {
          if (def[k] !== rett[k]) advarsler.push('«' + navn + '»: ' + k + ' endret fra ' + def[k] + ' til ' + rett[k] + ' (avtalt rettelse).');
          def[k] = rett[k];
        });
      }
      kpier[id] = def;
      rader.push({ rad: r, id: id, enhet: enhet });
    }
    if (!rader.length) throw new Error('Fant ingen KPI-er i arket «Januar».');

    var verdier = {}, fjor = {}, maaneder = [];
    L.MAANEDER.forEach(function (mnd, i) {
      if (!finnes(mnd)) return;
      var key = L.mndKey(i + 1);
      // Sjekk at radene i månedsarket er de samme KPI-ene (arkene kan ha blitt endret for hånd).
      rader.forEach(function (x) {
        var navn = tekst(celle(mnd, 'C' + x.rad));
        if (navn && navn !== kpier[x.id].navn) advarsler.push(mnd + ' rad ' + x.rad + ': «' + navn + '» forventet «' + kpier[x.id].navn + '». Hoppet over.');
        if (navn && navn !== kpier[x.id].navn) return;
        var v = prosent(tall(celle(mnd, 'J' + x.rad)), x.enhet);
        var f = prosent(tall(celle(mnd, 'I' + x.rad)), x.enhet);
        if (v !== null) { verdier[key] = verdier[key] || {}; verdier[key][x.id] = v; }
        if (f !== null) { fjor[key] = fjor[key] || {}; fjor[key][x.id] = f; }
      });
      if (verdier[key]) maaneder.push(i + 1);
    });

    return {
      aar: aar,
      config: { naerMaalProsent: L.STANDARD_GRENSE, kpier: kpier },
      verdier: verdier, fjorVerdier: fjor, advarsler: advarsler, maaneder: maaneder,
    };
  }

  /** Leser en SheetJS-arbeidsbok (XLSX.read). */
  function lesSheetJs(wb) {
    return lesBok(function (ark, adr) {
      var ws = wb.Sheets[ark];
      var c = ws && ws[adr];
      return c ? c.v : null;
    }, wb.SheetNames || []);
  }

  return Object.freeze({ lesBok: lesBok, lesSheetJs: lesSheetJs, slug: slug });
}));
