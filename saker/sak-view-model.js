/*
 * sak-view-model.js — ren, DOM-fri visningsmodell for Saker-grensesnittet (fase 1d).
 *
 * Gjør om serverdata (getSakV1/getSakerV1) + appens tiltak (live) til det UI-et tegner: kortdata, gruppering etter spor,
 * «Krever handling», og lesbare aktivitetstekster. All forretningsregel for visning bor HER (testbart i Node), ikke i
 * malstrenger i UI-koden. Bygger på sak-logic.js (tall og datoer) og henter aldri data selv.
 *
 * Prinsipper: fakta kommer fra tiltakene og hendelsene; vurderinger (årsaksstatus) er menneskelige og vises med hvem/når;
 * ingenting her gjetter eller finner på årsaker.
 */
(function (root, factory) {
  var logic = (typeof module === 'object' && module && module.exports) ? require('./sak-logic.js') : root.OpExSakLogic;
  if (typeof module === 'object' && module && module.exports) module.exports = factory(logic);
  else root.OpExSakVm = factory(logic);
}(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  var SAK_STATUSER = ['Åpen', 'Under oppfølging', 'Avventer beslutning', 'Løst', 'Lukket'];
  var ARSAK_STATUSER = ['hypotese', 'støttet', 'bekreftet', 'avkreftet'];
  var LUKKEDE = ['Løst', 'Lukket'];
  var INAKTIV_DAGER = 14;

  /* ------------------------------------------------------------------ metadata (tone + ikon + tekst) */

  var SAK_STATUS_META = {
    'Åpen': { tone: 'info', icon: 'circle', beskrivelse: 'Saken er opprettet. Arbeidet er ikke kommet i gang.' },
    'Under oppfølging': { tone: 'accent', icon: 'activity', beskrivelse: 'Det jobbes aktivt med tiltak og årsaker.' },
    'Avventer beslutning': { tone: 'warn', icon: 'clock', beskrivelse: 'Saken venter på en beslutning.' },
    'Løst': { tone: 'ok', icon: 'check', beskrivelse: 'Problemet er løst. Saken følges opp til den lukkes.' },
    'Lukket': { tone: 'muted', icon: 'lock', beskrivelse: 'Saken er avsluttet og låst for endringer. Den kan åpnes igjen.' },
  };

  var ARSAK_STATUS_META = {
    'hypotese': { label: 'Hypotese', tone: 'muted', icon: 'help', beskrivelse: 'En antakelse som ennå ikke er vurdert.' },
    'støttet': { label: 'Støttet', tone: 'info', icon: 'circle-dot', beskrivelse: 'Det finnes indikasjoner eller delvis grunnlag.' },
    'bekreftet': { label: 'Bekreftet', tone: 'ok', icon: 'badge-check', beskrivelse: 'Verifisert med dokumentert grunnlag.' },
    'avkreftet': { label: 'Avkreftet', tone: 'danger', icon: 'ban', beskrivelse: 'Vist å ikke stemme.' },
  };

  function tiltakStatusMeta(status, forfalt) {
    if (forfalt) return { label: 'Forfalt', tone: 'danger', icon: 'alert' };
    switch (status) {
      case 'Fullført': return { label: 'Fullført', tone: 'ok', icon: 'check' };
      case 'Aktiv': return { label: 'Aktiv', tone: 'accent', icon: 'activity' };
      case 'Innmeldt': return { label: 'Innmeldt', tone: 'info', icon: 'circle' };
      case 'Til godkjenning': return { label: 'Til godkjenning', tone: 'warn', icon: 'clock' };
      case 'Stanset': return { label: 'Stanset', tone: 'muted', icon: 'pause' };
      case 'Avsluttet': return { label: 'Avsluttet', tone: 'muted', icon: 'lock' };
      default: return { label: status || 'Ukjent', tone: 'muted', icon: 'help' };
    }
  }

  /* ------------------------------------------------------------------ tekst */

  function flertall(n, ent, fl) { return n + ' ' + (n === 1 ? ent : fl); }

  /** «I dag», «Om 3 dager», «2 dager over frist» ... fra antall dager til fristen. */
  function fristTekst(dagerTil) {
    if (typeof dagerTil !== 'number') return 'Ingen frist';
    if (dagerTil === 0) return 'I dag';
    if (dagerTil === 1) return 'I morgen';
    if (dagerTil > 1) return 'Om ' + dagerTil + ' dager';
    if (dagerTil === -1) return '1 dag over frist';
    return (-dagerTil) + ' dager over frist';
  }

  /** «i dag», «i går», «3 dager siden» fra antall dager siden. */
  function dagerSidenTekst(dager) {
    if (typeof dager !== 'number') return '';
    if (dager <= 0) return 'i dag';
    if (dager === 1) return 'i går';
    return dager + ' dager siden';
  }

  function prosent(fremdrift) {
    return typeof fremdrift === 'number' ? Math.round(fremdrift * 100) : null;
  }

  function kutt(text, max) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  /* ------------------------------------------------------------------ tiltaksrader */

  function tasksById(tasks) {
    var map = {};
    (Array.isArray(tasks) ? tasks : []).forEach(function (t) { if (t && t.fbKey) map[t.fbKey] = t; });
    return map;
  }

  function lagRad(post, task, sporIds, idag) {
    var dagerTil = post.frist ? L.dagerMellom(idag, post.frist) : null;
    return {
      id: post.id,
      tittel: (task && task.tittel) || 'Uten tittel',
      eier: (task && task.eier) || '',
      systemId: (task && task.systemId) || '',
      status: post.status,
      klasse: post.klasse,
      forfalt: post.forfalt,
      frist: post.frist,
      dagerTil: dagerTil,
      fristTekst: post.frist ? fristTekst(dagerTil) : 'Ingen frist',
      statusMeta: tiltakStatusMeta(post.status, post.forfalt),
      arkivertIkkeFerdig: post.arkivertIkkeFerdig,
      sporIds: sporIds || [],
    };
  }

  // Forfalt først, så gjenstående, så fullført, så resten; innen gruppen etter frist (tidligst først).
  function radRang(r) { return r.forfalt ? 0 : r.klasse === 'gjenstar' ? 1 : r.klasse === 'gjort' ? 2 : 3; }

  function sorterRader(rader) {
    return rader.slice().sort(function (a, b) {
      if (radRang(a) !== radRang(b)) return radRang(a) - radRang(b);
      var fa = a.frist || '9999-99-99', fb = b.frist || '9999-99-99';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.tittel.localeCompare(b.tittel, 'nb');
    });
  }

  /* ------------------------------------------------------------------ krever handling */

  var NIVAA = { kritisk: 0, advarsel: 1, info: 2 };

  function byggKreverHandling(m) {
    var out = [];
    var s = m.summary;
    var apen = m.sak.status !== 'Lukket' && m.sak.status !== 'Løst';
    var lukket = m.sak.status === 'Lukket';
    if (lukket) return out; // lukket sak er låst: ingenting å følge opp

    m.forfalte.forEach(function (r) {
      out.push({ id: 'forfalt:' + r.id, nivaa: 'kritisk', ikon: 'alert', tekst: '«' + kutt(r.tittel, 70) + '» er ' + (r.dagerTil === -1 ? '1 dag' : (-r.dagerTil) + ' dager') + ' over frist', detalj: r.eier ? 'Eier: ' + r.eier : '', handling: { type: 'apneTiltak', tiltakId: r.id, label: 'Åpne tiltak' } });
    });

    if (s.totalt === 0 && s.ekskludert === 0) {
      out.push({ id: 'ingen-tiltak', nivaa: 'advarsel', ikon: 'link', tekst: 'Ingen tiltak er koblet til saken', detalj: 'Koble eksisterende tiltak for å få fremdrift og frister.', handling: { type: 'kobleTiltak', label: 'Koble tiltak' } });
    }

    if (m.ikkeKoblet.length && m.spor.length) {
      out.push({ id: 'uten-spor', nivaa: 'advarsel', ikon: 'flag', tekst: flertall(m.ikkeKoblet.length, 'tiltak er', 'tiltak er') + ' ikke koblet til noe spor', detalj: 'Spor viser hvilket spørsmål tiltaket svarer på.', handling: { type: 'sporForTiltak', tiltakId: m.ikkeKoblet[0].id, label: 'Velg spor' } });
    }

    var d = s.datakvalitet || {};
    if (d.ukjentStatus && d.ukjentStatus.antall) out.push({ id: 'dq-status', nivaa: 'advarsel', ikon: 'info', tekst: flertall(d.ukjentStatus.antall, 'tiltak har', 'tiltak har') + ' ukjent status', detalj: 'Telles som gjenstående til statusen rettes.', handling: { type: 'apneTiltak', tiltakId: d.ukjentStatus.tiltakIds[0], label: 'Åpne tiltak' } });
    if (d.ugyldigFrist && d.ugyldigFrist.antall) out.push({ id: 'dq-frist', nivaa: 'advarsel', ikon: 'info', tekst: flertall(d.ugyldigFrist.antall, 'tiltak har', 'tiltak har') + ' ugyldig frist', detalj: 'Telles ikke som forfalt før fristen rettes.', handling: { type: 'apneTiltak', tiltakId: d.ugyldigFrist.tiltakIds[0], label: 'Åpne tiltak' } });
    if (d.utenFrist && d.utenFrist.antall) out.push({ id: 'dq-uten-frist', nivaa: 'info', ikon: 'calendar', tekst: flertall(d.utenFrist.antall, 'gjenstående tiltak mangler', 'gjenstående tiltak mangler') + ' frist', detalj: '', handling: { type: 'apneTiltak', tiltakId: d.utenFrist.tiltakIds[0], label: 'Åpne tiltak' } });
    if (d.arkivertIkkeFerdig && d.arkivertIkkeFerdig.antall) out.push({ id: 'dq-arkiv', nivaa: 'advarsel', ikon: 'info', tekst: flertall(d.arkivertIkkeFerdig.antall, 'tiltak er', 'tiltak er') + ' arkivert uten å være ferdig', detalj: 'Regnes som gjenstående, men aldri som forfalt.', handling: { type: 'apneTiltak', tiltakId: d.arkivertIkkeFerdig.tiltakIds[0], label: 'Åpne tiltak' } });

    m.venterGodkjenning.forEach(function (r) {
      out.push({ id: 'godkjenning:' + r.id, nivaa: 'info', ikon: 'clock', tekst: '«' + kutt(r.tittel, 70) + '» venter på godkjenning', detalj: r.eier ? 'Eier: ' + r.eier : '', handling: { type: 'apneTiltak', tiltakId: r.id, label: 'Åpne tiltak' } });
    });

    m.spor.forEach(function (sp) {
      if (!sp.arsaker.length) out.push({ id: 'spor-uten-arsak:' + sp.sporId, nivaa: 'info', ikon: 'help', tekst: 'Spor ' + sp.kode + ' har ingen registrerte årsaker', detalj: sp.sporsmal, handling: { type: 'nyArsak', sporId: sp.sporId, label: 'Registrer årsak' } });
    });

    var hypoteser = m.spor.reduce(function (n, sp) { return n + sp.arsaker.filter(function (a) { return a.status === 'hypotese'; }).length; }, 0);
    if (hypoteser) out.push({ id: 'hypoteser', nivaa: 'info', ikon: 'help', tekst: flertall(hypoteser, 'årsak venter', 'årsaker venter') + ' på vurdering', detalj: 'Status er «Hypotese». Vurder om de er støttet, bekreftet eller avkreftet.', handling: null });

    if (apen && s.totalt > 0 && s.gjenstar === 0 && s.gjort > 0) {
      out.push({ id: 'alle-ferdig', nivaa: 'info', ikon: 'check', tekst: 'Alle tiltak er fullført', detalj: 'Vurder å sette saken til «Løst». Status endres bare manuelt.', handling: { type: 'status', label: 'Endre status' } });
    }

    var sa = s.sisteAktivitet;
    if (apen && sa && sa.dagerSiden >= INAKTIV_DAGER) {
      out.push({ id: 'inaktiv', nivaa: 'info', ikon: 'clock', tekst: 'Ingen registrert aktivitet på ' + sa.dagerSiden + ' dager', detalj: '', handling: null });
    }

    if (m.ugyldigeKoblinger.length) out.push({ id: 'foreldreløse', nivaa: 'info', ikon: 'info', tekst: flertall(m.ugyldigeKoblinger.length, 'gammel sporkobling', 'gamle sporkoblinger') + ' ignoreres', detalj: 'Gjelder tiltak som ikke lenger er koblet til saken.', handling: null });

    return out.sort(function (a, b) { return NIVAA[a.nivaa] - NIVAA[b.nivaa]; });
  }

  /* ------------------------------------------------------------------ aktivitet */

  function aktorNavn(uid, navn) { return uid ? (navn(uid) || 'Ukjent bruker') : ''; }

  function beskrivAktivitet(ev, ctx) {
    var tid = ev.tiltakId;
    var tittel = function (id) { var t = ctx.tasks[id]; return '«' + kutt((t && t.tittel) || 'et tiltak', 60) + '»'; };
    var sporKode = function (id) { var sp = ctx.sporById[id]; return sp ? 'Spor ' + sp.kode : 'et spor'; };
    var arsakTekst = function (id) { var a = ctx.arsakById[id]; return a ? '«' + kutt(a.tekst, 50) + '»' : 'en årsak'; };
    var v = function (x) { return x === undefined || x === null || x === '' ? '–' : String(x); };
    var e = ev.event;
    var type = e.type;
    var ikon = 'activity';
    var tekst = '';

    if (ev.kilde === 'tiltak') {
      if (type === 'kommentar') { ikon = 'message'; tekst = 'Ny kommentar på ' + tittel(tid); }
      else if (type === 'opprettet') { ikon = 'plus'; tekst = tittel(tid) + ' ble opprettet'; }
      else if (type === 'slettet') { ikon = 'x'; tekst = 'Et tiltak ble slettet'; }
      else if (type === 'endret') {
        switch (e.felt) {
          case 'status': tekst = tittel(tid) + ': status ' + v(e.foer) + ' → ' + v(e.etter); ikon = 'activity'; break;
          case 'eier': tekst = tittel(tid) + ': eier ' + v(e.foer) + ' → ' + v(e.etter); ikon = 'user'; break;
          case 'frist': tekst = tittel(tid) + ': frist ' + v(e.foer) + ' → ' + v(e.etter); ikon = 'calendar'; break;
          case 'prioritet': tekst = tittel(tid) + ': prioritet ' + v(e.foer) + ' → ' + v(e.etter); break;
          case 'kategori': tekst = tittel(tid) + ': kategori ' + v(e.foer) + ' → ' + v(e.etter); break;
          case 'omrade': tekst = tittel(tid) + ': område ' + v(e.foer) + ' → ' + v(e.etter); break;
          case 'nestesteg': tekst = tittel(tid) + ': neste steg oppdatert'; break;
          case 'livssyklus': tekst = tittel(tid) + (e.etter === 'Papirkurv' ? ' ble flyttet til papirkurven' : e.foer === 'Papirkurv' ? ' ble gjenopprettet fra papirkurven' : ': livssyklus ' + v(e.foer) + ' → ' + v(e.etter)); break;
          case 'miljo': tekst = tittel(tid) + ': miljø ' + v(e.foer) + ' → ' + v(e.etter); break;
          case 'sakId': tekst = tittel(tid) + (e.etter ? ' ble koblet til en sak' : ' ble fjernet fra en sak'); ikon = 'link'; break;
          default: tekst = tittel(tid) + ' ble endret';
        }
      } else tekst = 'Hendelse på ' + tittel(tid);
    } else {
      var ent = e.entityId;
      switch (type) {
        case 'sak_opprettet': ikon = 'plus'; tekst = 'Saken ble opprettet'; break;
        case 'sak_endret':
          if (e.felt === 'status') { tekst = 'Status endret: ' + v(e.foer) + ' → ' + v(e.etter); ikon = 'flag'; }
          else if (e.felt === 'eierUid') { tekst = 'Ny eier: ' + (aktorNavn(e.etter, ctx.navn) || '–'); ikon = 'user'; }
          else if (e.felt === 'tittel') tekst = 'Tittelen ble endret';
          else if (e.felt === 'problemstilling') tekst = 'Problemstillingen ble endret';
          else if (e.felt === 'omrader') tekst = 'Områdene ble endret';
          else tekst = 'Saken ble endret';
          break;
        case 'tiltak_koblet': ikon = 'link'; tekst = tittel(ent) + ' ble koblet til saken'; break;
        case 'tiltak_frakoblet': ikon = 'x'; tekst = tittel(ent) + ' ble fjernet fra saken'; break;
        case 'spor_koblet': ikon = 'flag'; tekst = tittel(ent) + ' ble koblet til ' + sporKode(e.etter); break;
        case 'spor_frakoblet': ikon = 'flag'; tekst = tittel(ent) + ' ble fjernet fra ' + sporKode(e.foer); break;
        case 'arsak_opprettet': ikon = 'help'; tekst = e.felt === 'erstatter' ? 'Årsaken ble revidert (ny versjon): ' + arsakTekst(ent) : 'Ny årsak registrert: ' + arsakTekst(ent) + (e.etter ? ' (' + e.etter + ')' : ''); break;
        case 'arsak_endret': ikon = 'badge-check'; tekst = e.felt === 'status' ? 'Årsaksstatus ' + arsakTekst(ent) + ': ' + v(e.foer) + ' → ' + v(e.etter) : 'Grunnlag oppdatert for ' + arsakTekst(ent); break;
        case 'arsak_fjernet': ikon = 'x'; tekst = e.felt === 'erstattetAv' ? 'En årsak ble erstattet av en ny versjon' : 'Årsak fjernet: ' + arsakTekst(ent); break;
        default: tekst = 'Hendelse';
      }
    }
    var aktorUid = e.actorUid || e.forfatterUid || '';
    return { ikon: ikon, tekst: tekst, aktor: aktorUid ? aktorNavn(aktorUid, ctx.navn) : '' };
  }

  function sorterHendelser(liste) {
    return liste.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.id < b.id ? 1 : -1); });
  }

  function byggAktivitet(detail, tasks, ctx) {
    var members = {};
    (detail.tiltakIds || []).forEach(function (id) { members[id] = true; });
    var sakEv = [];
    var kobling = []; // tiltak_koblet/frakoblet fra sak, for å unngå dobbeltvisning av sakId-endringer på tiltak
    var map = detail.sakEvents || {};
    Object.keys(map).forEach(function (k) {
      var e = map[k];
      if (!e || typeof e !== 'object' || isNaN(Date.parse(e.createdAt))) return;
      sakEv.push({ id: 's:' + k, kilde: 'sak', createdAt: new Date(Date.parse(e.createdAt)).toISOString(), event: e, tiltakId: null });
      if (e.type === 'tiltak_koblet' || e.type === 'tiltak_frakoblet') kobling.push({ tid: e.entityId, ms: Date.parse(e.createdAt) });
    });
    var tiltakEv = [];
    var tmap = detail.tiltakEvents || {};
    Object.keys(tmap).forEach(function (tid) {
      if (!members[tid]) return;
      var inner = tmap[tid] || {};
      Object.keys(inner).forEach(function (k) {
        var e = inner[k];
        if (!e || typeof e !== 'object' || isNaN(Date.parse(e.createdAt))) return;
        if (e.type === 'endret' && e.felt === 'sakId') {
          var ms = Date.parse(e.createdAt);
          var dekket = kobling.some(function (x) { return x.tid === tid && Math.abs(x.ms - ms) <= 30000; });
          if (dekket) return;
        }
        tiltakEv.push({ id: 't:' + tid + ':' + k, kilde: 'tiltak', createdAt: new Date(Date.parse(e.createdAt)).toISOString(), event: e, tiltakId: tid });
      });
    });
    var alle = sorterHendelser(sakEv.concat(tiltakEv));
    var rader = alle.map(function (ev) {
      var b = beskrivAktivitet(ev, ctx);
      var dato = L.osloDato(ev.createdAt);
      return { id: ev.id, kilde: ev.kilde, eventType: ev.event.type, createdAt: ev.createdAt, dato: dato, dagerSiden: L.dagerMellom(dato, ctx.idag), ikon: b.ikon, tekst: b.tekst, aktor: b.aktor, actorUid: ev.event.actorUid || '', tiltakId: ev.tiltakId || (ev.event.entityId && members[ev.event.entityId] ? ev.event.entityId : null) };
    });
    // Skjul bare påfølgende spor-koblinger til samme tiltak/aktør innen 30 sekunder.
    // Originalene bevares som detaljer; serverens hendelseslogg endres ikke.
    var gruppert = [];
    rader.forEach(function (rad) {
      var forrige = gruppert[gruppert.length - 1];
      var kombinasjon = forrige && rad.tiltakId && forrige.tiltakId === rad.tiltakId &&
        forrige.actorUid === rad.actorUid && Math.abs(Date.parse(forrige.createdAt) - Date.parse(rad.createdAt)) <= 30000 &&
        ((forrige.eventType === 'spor_koblet' && rad.eventType === 'tiltak_koblet') ||
         (forrige.eventType === 'tiltak_koblet' && rad.eventType === 'spor_koblet'));
      if (kombinasjon) {
        var sporRad = rad.eventType === 'spor_koblet' ? rad : forrige;
        var kobletRad = rad.eventType === 'tiltak_koblet' ? rad : forrige;
        gruppert[gruppert.length - 1] = Object.assign({}, kobletRad, {
          tekst: kobletRad.tekst + ' og ' + sporRad.tekst.replace(/^.*? ble koblet til /, 'koblet til '),
          detaljer: [forrige, rad],
        });
      } else gruppert.push(rad);
    });
    return gruppert;
  }

  /* ------------------------------------------------------------------ hele sak-modellen */

  /**
   * detail: resultatet av getSakV1.  tasks: appens tiltak (live).  opts: { idag, navn(uid) }
   */
  function byggSakModell(detail, tasks, opts) {
    var o = opts || {};
    var idag = o.idag || L.osloDato(new Date());
    var navn = typeof o.navn === 'function' ? o.navn : function () { return ''; };
    var sak = detail.sak;
    var summary = L.oppsummerSak(tasks, { sakId: sak.sakId, idag: idag, tiltakEvents: detail.tiltakEvents, sakEvents: detail.sakEvents });
    var byId = tasksById(tasks);
    var tiltakSpor = detail.tiltakSpor || {};

    var rader = summary.tiltak.filter(function (p) { return p.klasse !== 'ekskludert'; }).map(function (p) {
      return lagRad(p, byId[p.id], tiltakSpor[p.id] || [], idag);
    });
    var spor = (detail.spor || []).map(function (sp) {
      var arsakerAlle = (detail.arsaker || []).filter(function (a) { return a.sporId === sp.sporId; });
      return {
        sporId: sp.sporId, kode: sp.kode, sporsmal: sp.sporsmal, rekkefolge: sp.rekkefolge,
        arsaker: arsakerAlle.filter(function (a) { return !a.fjernet; }).map(medMeta),
        fjernede: arsakerAlle.filter(function (a) { return a.fjernet; }).map(medMeta),
        tiltak: sorterRader(rader.filter(function (r) { return r.sporIds.indexOf(sp.sporId) !== -1 && r.klasse !== 'stanset' && r.klasse !== 'avsluttet'; })),
      };
    });
    function medMeta(a) { var m = ARSAK_STATUS_META[a.status] || ARSAK_STATUS_META.hypotese; return Object.assign({}, a, { meta: m, vurdertAvNavn: navn(a.vurdertAv) || (a.vurdertAv ? 'Ukjent bruker' : ''), vurdertDato: a.vurdertAt ? L.osloDato(a.vurdertAt) : '' }); }

    var aktive = rader.filter(function (r) { return r.klasse === 'gjenstar' || r.klasse === 'gjort'; });
    var ikkeKoblet = sorterRader(aktive.filter(function (r) { return !r.sporIds.length; }));
    var forfalte = sorterRader(rader.filter(function (r) { return r.forfalt; }));
    var venterGodkjenning = sorterRader(rader.filter(function (r) { return r.klasse === 'gjenstar' && r.status === 'Til godkjenning' && !r.forfalt; }));

    var sporById = {}; spor.forEach(function (sp) { sporById[sp.sporId] = sp; });
    var arsakById = {}; (detail.arsaker || []).forEach(function (a) { arsakById[a.arsakId] = a; });
    var aktivitet = byggAktivitet(detail, tasks, { tasks: byId, sporById: sporById, arsakById: arsakById, navn: navn, idag: idag });
    var avkortet = detail.avkortet || { tiltakEvents: [], sakEvents: false };

    var modell = {
      sak: Object.assign({}, sak, { eierNavn: navn(sak.eierUid) || (sak.eierUid ? 'Ukjent bruker' : ''), statusMeta: SAK_STATUS_META[sak.status] || SAK_STATUS_META['Åpen'], lukket: sak.status === 'Lukket', opprettetDato: sak.opprettetAt ? L.osloDato(sak.opprettetAt) : '' }),
      idag: idag,
      summary: summary,
      prosent: prosent(summary.fremdrift),
      spor: spor,
      ikkeKoblet: ikkeKoblet,
      forfalte: forfalte,
      venterGodkjenning: venterGodkjenning,
      separate: { stanset: sorterRader(rader.filter(function (r) { return r.klasse === 'stanset'; })), avsluttet: sorterRader(rader.filter(function (r) { return r.klasse === 'avsluttet'; })) },
      alleTiltak: sorterRader(rader),
      ugyldigeKoblinger: detail.ugyldigeKoblinger || [],
      aktivitet: aktivitet,
      aktivitetAvkortet: !!(avkortet.sakEvents || (avkortet.tiltakEvents && avkortet.tiltakEvents.length)),
      aktivitetTom: aktivitet.length === 0,
      nesteFristTekst: summary.naermesteFrist ? fristTekst(summary.naermesteFrist.dagerTil) : '',
      sisteAktivitetTekst: summary.sisteAktivitet ? dagerSidenTekst(summary.sisteAktivitet.dagerSiden) : '',
      flagg: { ingenTiltak: summary.totalt === 0, ingenSpor: spor.length === 0, alleFerdig: summary.totalt > 0 && summary.gjenstar === 0 && summary.gjort > 0 },
    };
    modell.kreverHandling = byggKreverHandling(modell);
    return modell;
  }

  /* ------------------------------------------------------------------ oversikten */

  /**
   * saker: getSakerV1().saker.  detaljer: { sakId: getSakV1-resultat } (kan mangle; da vises «henter»).
   * Returnerer kort sortert etter hva som trenger oppmerksomhet først; løste/lukkede for seg.
   */
  function byggListeModell(saker, detaljer, tasks, opts) {
    var o = opts || {};
    var idag = o.idag || L.osloDato(new Date());
    var navn = typeof o.navn === 'function' ? o.navn : function () { return ''; };
    var det = detaljer || {};
    var kort = (Array.isArray(saker) ? saker : []).map(function (sak) {
      var d = det[sak.sakId];
      var summary = L.oppsummerSak(tasks, { sakId: sak.sakId, idag: idag, tiltakEvents: d && d.tiltakEvents, sakEvents: d && d.sakEvents });
      var lukket = LUKKEDE.indexOf(sak.status) !== -1;
      var q = summary.datakvalitet;
      var dq = q.ukjentStatus.antall + q.ugyldigFrist.antall + q.arkivertIkkeFerdig.antall;
      var nivaa = 'rolig';
      var arsak = '';
      if (!lukket) {
        if (summary.forfalt > 0) { nivaa = 'kritisk'; arsak = flertall(summary.forfalt, 'forfalt tiltak', 'forfalte tiltak'); }
        else if (summary.totalt === 0) { nivaa = 'advarsel'; arsak = 'Ingen tiltak koblet'; }
        else if (dq > 0) { nivaa = 'advarsel'; arsak = 'Datakvalitet'; }
        else if (summary.gjenstar === 0 && summary.gjort > 0) { nivaa = 'advarsel'; arsak = 'Alle tiltak fullført'; }
      }
      return {
        sakId: sak.sakId, kode: sak.kode, tittel: sak.tittel, status: sak.status, statusMeta: SAK_STATUS_META[sak.status] || SAK_STATUS_META['Åpen'],
        eierUid: sak.eierUid, eierNavn: navn(sak.eierUid) || (sak.eierUid ? 'Ukjent bruker' : ''), omrader: sak.omrader || [],
        summary: summary, prosent: prosent(summary.fremdrift), nivaa: nivaa, nivaaArsak: arsak, lukket: lukket,
        aktivitetLastet: !!d,
        sisteAktivitetTekst: d ? (summary.sisteAktivitet ? dagerSidenTekst(summary.sisteAktivitet.dagerSiden) : '') : '',
        nesteFristTekst: summary.naermesteFrist ? fristTekst(summary.naermesteFrist.dagerTil) : '',
      };
    });
    var rang = { kritisk: 0, advarsel: 1, rolig: 2 };
    var aktive = kort.filter(function (k) { return !k.lukket; }).sort(function (a, b) {
      return rang[a.nivaa] - rang[b.nivaa] || b.summary.forfalt - a.summary.forfalt || a.kode.localeCompare(b.kode);
    });
    var lukkede = kort.filter(function (k) { return k.lukket; }).sort(function (a, b) { return a.kode.localeCompare(b.kode); });
    return {
      aktive: aktive, lukkede: lukkede, totalt: kort.length,
      kreverOppmerksomhet: aktive.filter(function (k) { return k.nivaa !== 'rolig'; }).length,
    };
  }

  /* ------------------------------------------------------------------ valg av tiltak å koble */

  /** Tiltak som kan kobles: ikke test/papirkurv, uten sak. Ferdige tas med. Andre saker vises som utilgjengelige. */
  function kobleKandidater(tasks, saker, ordsok) {
    var sakKode = {};
    (saker || []).forEach(function (s) { sakKode[s.sakId] = s.kode; });
    var q = String(ordsok || '').trim().toLowerCase();
    var ledige = [], andreSaker = [];
    (Array.isArray(tasks) ? tasks : []).forEach(function (t) {
      if (!t || !t.fbKey || L.erTest(t) || L.erPapirkurv(t)) return;
      var hay = ((t.tittel || '') + ' ' + (t.systemId || '') + ' ' + (t.eier || '')).toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      var rad = { id: t.fbKey, tittel: t.tittel || 'Uten tittel', systemId: t.systemId || '', eier: t.eier || '', status: L.normStatus(t.status) || 'Innmeldt', frist: t.frist || '' };
      var sid = String(t.sakId || '').trim();
      if (sid) { rad.sakKode = sakKode[sid] || 'en annen sak'; andreSaker.push(rad); } else ledige.push(rad);
    });
    var sorter = function (a, b) { return a.tittel.localeCompare(b.tittel, 'nb'); };
    return { ledige: ledige.sort(sorter), andreSaker: andreSaker.sort(sorter) };
  }

  return Object.freeze({
    SAK_STATUSER: SAK_STATUSER, ARSAK_STATUSER: ARSAK_STATUSER, INAKTIV_DAGER: INAKTIV_DAGER,
    SAK_STATUS_META: SAK_STATUS_META, ARSAK_STATUS_META: ARSAK_STATUS_META,
    tiltakStatusMeta: tiltakStatusMeta, fristTekst: fristTekst, dagerSidenTekst: dagerSidenTekst, prosent: prosent, kutt: kutt,
    byggSakModell: byggSakModell, byggListeModell: byggListeModell, kobleKandidater: kobleKandidater,
  });
}));
