/*
 * sak-logic.js — ren, DOM-fri beregning av en Sak (Saker MVP-0, fase 1b).
 *
 * Én testbar sannhet for hvordan en sak beregnes. Brukes av UI nå og av AI/evidence builder senere.
 *
 * Krav:
 *  - Ingen DOM, ingen Firebase, ingen nettverk, ingen globale nettleserfunksjoner.
 *  - Henter aldri data selv: alt kommer inn som argumenter.
 *  - Muterer aldri argumentene.
 *  - Lastes både i nettleser (klassisk <script>, setter window.OpExSakLogic) og i Node (require).
 *
 * Datoer:
 *  - «I dag» er alltid Europe/Oslo-dato. Fristlogikk er ren strenglogikk på ÅÅÅÅ-MM-DD
 *    (kalenderregning i UTC, aldri lokal Date-parsing), slik at tidssone aldri kan gi feil dag.
 *  - Dagens app bruker UTC-dato (today()) og får dermed «forfalt» feil med én dag mellom 00:00 og
 *    ca. 02:00 norsk tid. Denne modulen gjør ikke den feilen.
 *
 * Definisjoner (matcher dagens app: normStatus / computedStatus / isTest / isTrash):
 *  - EKSKLUDERT: papirkurv (livssyklus === 'Papirkurv' eller papirkurv === true) eller test
 *                (miljo === 'Test' eller test === true). Gjelder uansett status.
 *  - GJORT:      Fullført
 *  - GJENSTÅR:   Innmeldt, Til godkjenning, Aktiv. Tom status regnes som Innmeldt (som computedStatus).
 *                Ukjent status regnes som gjenstår (som dagens app, der den ikke er «terminal»),
 *                men rapporteres i datakvalitet.ukjentStatus.
 *  - FORFALT:    delmengde av GJENSTÅR med gyldig frist STRENGT FØR dagens Oslo-dato.
 *                Frist lik i dag er ikke forfalt.
 *  - STANSET / AVSLUTTET: egne tellere. Inngår ikke i fremdriftsnevneren.
 *  - Normalisering: Åpen → Innmeldt, Pågår → Aktiv, Avvist → Avsluttet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.OpExSakLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TIME_ZONE = 'Europe/Oslo';
  var KJENTE_STATUSER = ['Innmeldt', 'Til godkjenning', 'Aktiv', 'Fullført', 'Stanset', 'Avsluttet'];
  var DATO_MONSTER = /^(\d{4})-(\d{2})-(\d{2})$/;

  /* ---------------------------------------------------------------- hjelpere */

  function clean(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function erObjekt(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function erDato(value) {
    return Object.prototype.toString.call(value) === '[object Date]'; // tåler flere JS-realms
  }

  /* ------------------------------------------------------------------- datoer */

  var osloFormat = null;
  function formatter() {
    if (!osloFormat) {
      osloFormat = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      });
    }
    return osloFormat;
  }

  function tilMs(input) {
    var ms;
    if (erDato(input)) ms = input.getTime();
    else if (typeof input === 'number') ms = input;
    else if (typeof input === 'string') {
      if (DATO_MONSTER.test(input)) throw new TypeError('osloDato forventer et tidspunkt, ikke en ren dato: ' + input);
      ms = Date.parse(input);
    } else throw new TypeError('osloDato forventer Date, millisekunder eller ISO-tidspunkt');
    if (!isFinite(ms)) throw new TypeError('Ugyldig tidspunkt');
    return ms;
  }

  /** Kalenderdatoen i Europe/Oslo for et tidspunkt, som 'ÅÅÅÅ-MM-DD'. */
  function osloDato(input) {
    var parts = formatter().formatToParts(new Date(tilMs(input)));
    var y = '', m = '', d = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'year') y = parts[i].value;
      else if (parts[i].type === 'month') m = parts[i].value;
      else if (parts[i].type === 'day') d = parts[i].value;
    }
    return y + '-' + m + '-' + d;
  }

  /** Er strengen en ekte kalenderdato på formen ÅÅÅÅ-MM-DD? (2026-02-30 er ikke det.) */
  function gyldigDato(value) {
    if (typeof value !== 'string') return false;
    var m = DATO_MONSTER.exec(value);
    if (!m) return false;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  function dagnummer(dato) {
    var m = DATO_MONSTER.exec(dato);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  }

  /** Hele kalenderdager fra a til b (positivt hvis b er senere). Begge må være gyldige datoer. */
  function dagerMellom(a, b) {
    if (!gyldigDato(a) || !gyldigDato(b)) throw new TypeError('dagerMellom forventer gyldige ÅÅÅÅ-MM-DD-datoer');
    return Math.round(dagnummer(b) - dagnummer(a));
  }

  function finnIdag(opts) {
    if (opts && opts.idag !== undefined && opts.idag !== null) {
      if (!gyldigDato(opts.idag)) throw new TypeError('idag må være en gyldig ÅÅÅÅ-MM-DD-dato');
      return opts.idag;
    }
    return osloDato(opts && opts.now !== undefined && opts.now !== null ? opts.now : new Date());
  }

  /* ------------------------------------------------------ tiltaksklassifisering */

  /** Samme regler som normStatus i appen (eksakt sammenligning, ingen trimming). */
  function normStatus(s) {
    if (s === 'Åpen') return 'Innmeldt';
    if (s === 'Pågår') return 'Aktiv';
    if (s === 'Avvist') return 'Avsluttet';
    return typeof s === 'string' ? s : '';
  }

  function erTest(t) {
    return (t && t.miljo || 'Produksjon') === 'Test' || (t && t.test === true);
  }

  function erPapirkurv(t) {
    return !!t && (t.livssyklus === 'Papirkurv' || t.papirkurv === true);
  }

  function fristStatus(frist) {
    if (frist === undefined || frist === null || frist === '') return 'tom';
    return gyldigDato(frist) ? 'ok' : 'ugyldig';
  }

  function tiltakId(t) {
    var id = t && (t.fbKey !== undefined && t.fbKey !== null ? t.fbKey : t.id);
    return clean(id);
  }

  /**
   * Klassifiserer ett tiltak.
   * klasse: 'gjort' | 'gjenstar' | 'stanset' | 'avsluttet' | 'ekskludert'
   */
  function klassifiserTiltak(t, idag) {
    if (!gyldigDato(idag)) throw new TypeError('klassifiserTiltak krever idag som ÅÅÅÅ-MM-DD');
    var task = erObjekt(t) ? t : {};
    var ns = normStatus(task.status);
    var status = ns || 'Innmeldt'; // som computedStatus: tom status → Innmeldt
    var fs = fristStatus(task.frist);
    var out = {
      id: tiltakId(task),
      klasse: 'gjenstar',
      status: status,
      ukjentStatus: false,
      forfalt: false,
      ekskludertArsak: null,
      fristStatus: fs,
      frist: fs === 'ok' ? task.frist : null,
    };

    if (erPapirkurv(task)) { out.klasse = 'ekskludert'; out.ekskludertArsak = 'papirkurv'; return out; }
    if (erTest(task)) { out.klasse = 'ekskludert'; out.ekskludertArsak = 'test'; return out; }

    if (status === 'Fullført') out.klasse = 'gjort';
    else if (status === 'Stanset') out.klasse = 'stanset';
    else if (status === 'Avsluttet') out.klasse = 'avsluttet';
    else {
      out.klasse = 'gjenstar';
      out.ukjentStatus = KJENTE_STATUSER.indexOf(status) === -1;
      out.forfalt = fs === 'ok' && task.frist < idag; // ÅÅÅÅ-MM-DD sorterer leksikografisk = kronologisk
    }
    return out;
  }

  /** Tiltak som hører til saken: tiltak.sakId er eneste kilde til medlemskap. */
  function tiltakForSak(tasks, sakId) {
    var id = clean(sakId);
    if (!id || !Array.isArray(tasks)) return [];
    var out = [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (erObjekt(t) && clean(t.sakId) === id) out.push(t);
    }
    return out;
  }

  /* ----------------------------------------------------------- siste aktivitet */

  function ms(createdAt) {
    if (typeof createdAt !== 'string' || !createdAt) return NaN;
    return Date.parse(createdAt);
  }

  /** Normaliserer hendelser til [{event, tiltakId|null, kilde}]. Tåler array og rå RTDB-form. */
  function listeTiltakHendelser(input) {
    var out = [];
    if (Array.isArray(input)) {
      input.forEach(function (e) { if (erObjekt(e)) out.push({ event: e, tiltakId: clean(e.tiltakId) || null }); });
    } else if (erObjekt(input)) {
      Object.keys(input).forEach(function (tid) {
        var perTiltak = input[tid];
        if (!erObjekt(perTiltak)) return;
        Object.keys(perTiltak).forEach(function (key) {
          if (erObjekt(perTiltak[key])) out.push({ event: perTiltak[key], tiltakId: tid });
        });
      });
    }
    return out;
  }

  function listeSakHendelser(input) {
    var out = [];
    var values = Array.isArray(input) ? input : (erObjekt(input) ? Object.keys(input).map(function (k) { return input[k]; }) : []);
    values.forEach(function (e) { if (erObjekt(e)) out.push({ event: e, tiltakId: null }); });
    return out;
  }

  /**
   * Nyeste gyldige createdAt blant hendelsene.
   *  - tiltakEvents: array av hendelser (med tiltakId) ELLER rå form { tiltakId: { eventKey: event } }
   *  - sakEvents:    array ELLER rå form { eventKey: event }
   *  - tiltakIds:    hvis gitt, telles bare tiltakshendelser for disse tiltakene
   * Returnerer null hvis ingen gyldig hendelse finnes.
   */
  function sisteAktivitet(args) {
    var a = args || {};
    var tillatt = Array.isArray(a.tiltakIds) ? a.tiltakIds.map(clean) : null;
    var kandidater = [];
    listeTiltakHendelser(a.tiltakEvents).forEach(function (h) {
      if (tillatt && (h.tiltakId === null || tillatt.indexOf(h.tiltakId) === -1)) return;
      kandidater.push({ h: h, kilde: 'tiltak' });
    });
    listeSakHendelser(a.sakEvents).forEach(function (h) { kandidater.push({ h: h, kilde: 'sak' }); });

    var best = null;
    kandidater.forEach(function (k) {
      var t = ms(k.h.event.createdAt);
      if (!isFinite(t)) return;
      // Ved lik tid vinner sakshendelser; ellers beholdes den som kom først i inndata.
      if (!best || t > best.t || (t === best.t && (k.kilde === 'sak' && best.kilde !== 'sak'))) best = { t: t, kilde: k.kilde, h: k.h };
    });
    if (!best) return null;

    var ev = best.h.event;
    var iso = new Date(best.t).toISOString();
    var dato = osloDato(iso);
    var idag = finnIdag(a);
    return {
      createdAt: iso,
      dato: dato,
      dagerSiden: dagerMellom(dato, idag),
      kilde: best.kilde,
      type: clean(ev.type) || null,
      tiltakId: best.h.tiltakId,
      felt: clean(ev.felt) || null,
    };
  }

  /* ------------------------------------------------------------------ oppsummering */

  /**
   * Oppsummerer én sak.
   *
   * tasks: alle tiltak (som i appen: objekter med fbKey). Filtreres på opts.sakId.
   * opts:  { sakId, idag? 'ÅÅÅÅ-MM-DD', now? Date|ms|ISO, tiltakEvents?, sakEvents? }
   */
  function oppsummerSak(tasks, opts) {
    var o = opts || {};
    var idag = finnIdag(o);
    var medlemmer = tiltakForSak(tasks, o.sakId);
    var poster = medlemmer.map(function (t) { return klassifiserTiltak(t, idag); });

    var teller = { gjort: 0, gjenstar: 0, stanset: 0, avsluttet: 0, ekskludert: 0, forfalt: 0 };
    var ukjentStatus = [], ugyldigFrist = [], utenFrist = [];
    var kommende = [], forfalte = [], medlemIder = [];

    poster.forEach(function (p) {
      teller[p.klasse]++;
      if (p.klasse === 'ekskludert') return;
      medlemIder.push(p.id);
      if (p.klasse !== 'gjenstar') return;
      if (p.forfalt) teller.forfalt++;
      if (p.ukjentStatus) ukjentStatus.push(p.id);
      if (p.fristStatus === 'ugyldig') ugyldigFrist.push(p.id);
      else if (p.fristStatus === 'tom') utenFrist.push(p.id);
      else if (p.forfalt) forfalte.push(p);
      else kommende.push(p);
    });

    function tidligste(liste) {
      if (!liste.length) return null;
      var min = liste.reduce(function (acc, p) { return p.frist < acc ? p.frist : acc; }, liste[0].frist);
      return {
        dato: min,
        tiltakIds: liste.filter(function (p) { return p.frist === min; }).map(function (p) { return p.id; }).sort(),
      };
    }

    var nar = tidligste(kommende);
    if (nar) nar.dagerTil = dagerMellom(idag, nar.dato);
    var eldste = tidligste(forfalte);
    if (eldste) eldste.dagerSiden = dagerMellom(eldste.dato, idag);

    var nevner = teller.gjort + teller.gjenstar;
    return {
      sakId: clean(o.sakId),
      idag: idag,
      totalt: teller.gjort + teller.gjenstar + teller.stanset + teller.avsluttet,
      kobletTotalt: poster.length,
      gjort: teller.gjort,
      gjenstar: teller.gjenstar,
      forfalt: teller.forfalt,
      stanset: teller.stanset,
      avsluttet: teller.avsluttet,
      ekskludert: teller.ekskludert,
      fremdrift: nevner > 0 ? teller.gjort / nevner : null,
      naermesteFrist: nar,
      eldsteForfaltFrist: eldste,
      sisteAktivitet: sisteAktivitet({
        tiltakEvents: o.tiltakEvents, sakEvents: o.sakEvents, tiltakIds: medlemIder, idag: idag,
      }),
      datakvalitet: {
        ukjentStatus: { antall: ukjentStatus.length, tiltakIds: ukjentStatus },
        ugyldigFrist: { antall: ugyldigFrist.length, tiltakIds: ugyldigFrist },
        utenFrist: { antall: utenFrist.length, tiltakIds: utenFrist },
      },
      tiltak: poster,
    };
  }

  /**
   * Oppsummerer flere saker med samme datagrunnlag.
   * opts.sakEvents kan her være { sakId: events }.
   */
  function oppsummerSaker(tasks, sakIds, opts) {
    var o = opts || {};
    var out = {};
    (Array.isArray(sakIds) ? sakIds : []).forEach(function (sakId) {
      var perSak = erObjekt(o.sakEvents) && !Array.isArray(o.sakEvents) ? o.sakEvents[sakId] : undefined;
      out[sakId] = oppsummerSak(tasks, {
        sakId: sakId, idag: o.idag, now: o.now, tiltakEvents: o.tiltakEvents, sakEvents: perSak,
      });
    });
    return out;
  }

  return Object.freeze({
    osloDato: osloDato,
    gyldigDato: gyldigDato,
    dagerMellom: dagerMellom,
    normStatus: normStatus,
    erTest: erTest,
    erPapirkurv: erPapirkurv,
    klassifiserTiltak: klassifiserTiltak,
    tiltakForSak: tiltakForSak,
    sisteAktivitet: sisteAktivitet,
    oppsummerSak: oppsummerSak,
    oppsummerSaker: oppsummerSaker,
  });
}));
