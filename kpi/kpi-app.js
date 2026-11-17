/*
 * kpi-app.js — KPI-appen (felles for alle avdelinger, se kpi-enheter.js): kjerne med datalag (callables), ruting (#kpi, #kpi/registrer, #kpi/oppsett) og visninger.
 *
 * Integrasjon med verten (index.html) skjer KUN via:
 *   - window.OpExHost (bruker, tiltak, navn, token, openTiltak, toast, show)
 *   - window.OpExKpi.render()  — kalles fra renderAllViews()
 * Gjenbruker Saker-modulens UI-hjelpere (OpExSakUi) og dialog (OpExSakForms.openDialog).
 * Brukertekst settes aldri via innerHTML.
 */
(function (root) {
  'use strict';

  // Avdelingen siden gjelder (settes av kpi/<enhet>/index.html). Alle kall til serveren sendes med { enhet }.
  function enhetInfo() { var E = root.OpExKpiEnheter; return (E && E.hent(root.KPI_ENHET)) || { id: root.KPI_ENHET || '', navn: 'KPI', avdeling: '', tiltakOmrade: '' }; }
  var U = root.OpExSakUi, F = root.OpExSakForms, L = root.OpExKpiLogic, I = root.OpExKpiImport, C = root.OpExKpiCharts;
  var h = U.h;
  var host = function () { return root.OpExHost; };
  var TIMEOUT_MS = 25000;

  /* ================================================================== datalag */

  var state = { uid: null, aar: null, data: null, laster: false, feil: null, maaned: null, lagrer: false };
  var lyttere = [];
  function varsle() { lyttere.forEach(function (fn) { try { fn(); } catch (e) { /* */ } }); }

  async function call(name, data) {
    var hh = host();
    var token;
    try { token = await hh.getIdToken(); } catch (e) { throw new Error('Du er ikke innlogget. Last siden på nytt og logg inn.'); }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    var response;
    try {
      response = await fetch(hh.functionsBase + '/' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ data: Object.assign({ enhet: enhetInfo().id }, data || {}) }),
        signal: controller ? controller.signal : undefined,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Serveren svarte ikke i tide. Oppdater og sjekk før du prøver igjen.');
      throw new Error('Kunne ikke nå serveren. Sjekk nettforbindelsen og prøv igjen.');
    } finally { if (timer) clearTimeout(timer); }
    var payload = null;
    try { payload = await response.json(); } catch (e) { payload = null; }
    if (!response.ok || (payload && payload.error)) {
      var err = new Error((payload && payload.error && payload.error.message) || 'Operasjonen feilet. Prøv igjen.');
      err.status = payload && payload.error && payload.error.status;
      throw err;
    }
    return payload.result;
  }

  function last(aar) {
    state.laster = true; state.feil = null; varsle();
    return call('getKpiV1', aar ? { aar: aar } : {}).then(function (res) {
      var nyttAar = state.aar !== res.aar;
      state.data = res; state.aar = res.aar; state.laster = false;
      if (nyttAar || !state.maaned) state.maaned = standardMaaned(res);
      varsle();
      return res;
    }, function (e) { state.laster = false; state.feil = e; varsle(); throw e; });
  }

  function standardMaaned(res) {
    var n = L.sisteMaanedMedData(res.verdier);
    var hasData = res.verdier && Object.keys(res.verdier).length;
    if (!hasData) {
      var now = new Date();
      return res.aar === now.getFullYear() ? Math.max(1, now.getMonth()) : 1;
    }
    return n;
  }

  function nullstill(uid) { state = { uid: uid, aar: null, data: null, laster: false, feil: null, maaned: null, lagrer: false }; }

  /* ================================================================== personlige innstillinger */

  // Brukerens oppsett av oversikten (tema, tetthet, bokser). Endringer vises med en gang og lagres samlet etter en kort pause.
  var prefs = { kilde: null, verdi: {}, skitten: false, status: '', timer: null };
  function hentPrefs() {
    var d = state.data;
    if (d && prefs.kilde !== d && !prefs.skitten) { prefs.verdi = JSON.parse(JSON.stringify(d.preferanser || {})); delete prefs.verdi.oppdatertAt; }
    if (d) prefs.kilde = d;
    return prefs.verdi;
  }
  function settPrefsStatus(t) { prefs.status = t; var el = document.querySelector('.kpi-lagret'); if (el) el.textContent = t; }
  function endrePrefs(fn) {
    hentPrefs();
    fn(prefs.verdi);
    prefs.skitten = true;
    settPrefsStatus('Lagrer …');
    render({ tvinges: true });
    clearTimeout(prefs.timer);
    prefs.timer = setTimeout(function () {
      var sendes = JSON.parse(JSON.stringify(prefs.verdi));
      call('saveKpiPreferanserV1', { preferanser: Object.keys(sendes).length ? sendes : null }).then(function () {
        prefs.skitten = false;
        if (state.data) state.data.preferanser = sendes;
        settPrefsStatus('Lagret ✓');
      }, function (err) {
        settPrefsStatus('Ikke lagret');
        host().toast(err.message || 'Kunne ikke lagre oppsettet av oversikten', true);
      });
    }, 700);
  }
  function brukTema() {
    var p = hentPrefs();
    document.body.dataset.kpiTema = p.tema || 'gronn';
    document.body.dataset.kpiTetthet = p.tetthet || 'normal';
  }
  function settMaaned(n) { state.maaned = n; render({ tvinges: true }); }

  /* ================================================================== ruting */

  var VISNINGER = ['oversikt', 'registrer', 'oppsett'];
  function container() { return document.getElementById('kpi'); }
  function erAktiv() { var c = container(); return !!c && c.classList.contains('active'); }
  function lesRute() {
    var m = /^#kpi(?:\/([a-z]+))?/.exec(location.hash || '');
    var v = m && m[1];
    return VISNINGER.indexOf(v) >= 0 ? v : 'oversikt';
  }
  function gaaTil(visning) {
    var hash = visning && visning !== 'oversikt' ? '#kpi/' + visning : '#kpi';
    if (location.hash !== hash) history.pushState({ kpi: true }, '', hash);
    render({ ny: true });
  }
  function onNav() {
    if (/^#kpi(?:\/|$)/.test(location.hash || '')) {
      if (!erAktiv() && host() && host().show) host().show('kpi'); else render({ ny: true });
    }
  }

  /* ================================================================== hjelpere */

  var TONE = {}; TONE[L.STATUS.PAA] = 'ok'; TONE[L.STATUS.NAER] = 'warn'; TONE[L.STATUS.IKKE] = 'danger'; TONE[L.STATUS.INGEN] = 'muted';
  var STATUS_IKON = {}; STATUS_IKON[L.STATUS.PAA] = 'badge-check'; STATUS_IKON[L.STATUS.NAER] = 'alert'; STATUS_IKON[L.STATUS.IKKE] = 'flag'; STATUS_IKON[L.STATUS.INGEN] = 'circle';

  function statusChip(st) { return U.chip({ tone: TONE[st] || 'muted', icon: STATUS_IKON[st] || 'circle', label: st }); }
  function fmt(v, def, brok) { return L.fmtVerdi(v, def.enhet, { brok: brok }); }
  function navnFraUid(uid) { var hh = host(); return (hh && hh.nameOf && hh.nameOf(uid)) || 'ukjent'; }
  function idagIso() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date()); }
  function plussDager(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function datoTid(iso) {
    var ms = Date.parse(iso); if (isNaN(ms)) return '';
    return new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' }).format(new Date(ms));
  }

  var TERMINAL = ['Fullført', 'Stanset', 'Avsluttet'];
  function kpiTiltak(kpiId) {
    var hh = host();
    var tasks = (hh && hh.getTasks && hh.getTasks()) || [];
    return tasks.filter(function (t) {
      return t && t.kpiId === kpiId && Number(t.kpiAar) === state.aar && t.livssyklus !== 'Papirkurv' && t.papirkurv !== true;
    }).sort(function (a, b) { return String(a.frist || '9999').localeCompare(String(b.frist || '9999')); });
  }
  function apneTiltak(list) { return list.filter(function (t) { return TERMINAL.indexOf(t.status) < 0; }); }

  function select(opts, verdi, attrs) {
    return h('select', attrs || {}, opts.map(function (o) {
      var v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o;
      return h('option', { value: String(v), selected: String(v) === String(verdi) }, l);
    }));
  }

  function felt(label, input, hint) {
    var id = U.nextId('kpi-f');
    input.id = input.id || id;
    return h('div', { class: 'sak-field' }, [h('label', { for: input.id }, label), input, hint ? h('div', { class: 'sak-hint sak-muted sak-small' }, hint) : null]);
  }

  /* ================================================================== oversikt */

  function sideHode(tittel, under, handlinger) {
    return h('div', { class: 'sak-pagehead' }, [
      h('div', null, [h('h1', null, tittel), under ? h('p', { class: 'sak-muted' }, under) : null]),
      h('div', { class: 'kpi-head-actions' }, handlinger),
    ]);
  }

  function velgere(d, medMaaned) {
    var aarListe = (d.aarListe && d.aarListe.length ? d.aarListe : [d.aar]);
    if (aarListe.indexOf(d.aar) < 0) aarListe = aarListe.concat([d.aar]);
    var aarSel = select(aarListe.map(function (a) { return { value: a, label: String(a) }; }), d.aar, { 'aria-label': 'Velg år', class: 'kpi-sel' });
    aarSel.addEventListener('change', function () { last(Number(aarSel.value)).catch(function () {}); });
    var kids = [aarSel];
    if (medMaaned) {
      var mSel = select(L.MAANEDER.map(function (m, i) { return { value: i + 1, label: m }; }), state.maaned, { 'aria-label': 'Velg måned', class: 'kpi-sel' });
      mSel.addEventListener('change', function () { settMaaned(Number(mSel.value)); });
      kids.unshift(mSel);
    }
    return h('div', { class: 'kpi-velgere' }, kids);
  }

  function nav(aktiv, kanRegistrere) {
    if (!kanRegistrere) return null; // bare oversikten: ingen fanelinje
    var faner = [['oversikt', 'Oversikt', 'activity']];
    if (kanRegistrere) faner.push(['registrer', 'Registrer', 'pencil'], ['oppsett', 'Oppsett', 'list']);
    return h('div', { class: 'kpi-faner', role: 'tablist', 'aria-label': enhetInfo().navn }, faner.map(function (f) {
      return h('button', {
        type: 'button', role: 'tab', class: 'kpi-fane' + (aktiv === f[0] ? ' is-aktiv' : ''), 'aria-selected': aktiv === f[0] ? 'true' : 'false',
        on: { click: function () { gaaTil(f[0]); } },
      }, [U.icon(f[2], 16), h('span', null, f[1])]);
    }));
  }

  /**
   * Ikonmeny nederst på mobil (skjult på større skjermer, der fanene over brukes):
   * Oversikt · Følg opp (antall KPI-er under mål) · Registrer · Oppsett · Tiltak (tiltakslista i OpEx Hub).
   */
  // Strekikoner for menyen nederst (faste konstanter, ingen brukerdata).
  var BUNN_IKONER = {
    hjem: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
    flagg: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    kalender: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="m9 15 2 2 4-4"/>',
    juster: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    tiltak: '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="m8 9 1.5 1.5L12 8M8 15l1.5 1.5L12 14M14.5 9.5H17M14.5 15.5H17"/>',
  };
  function bunnIkon(navn) {
    var span = document.createElement('span');
    span.className = 'kpi-bunn-svg';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + BUNN_IKONER[navn] + '</svg>';
    return span;
  }

  function bunnmeny(aktiv, d) {
    var rode = 0;
    if (d && d.config) { try { rode = L.vurderAar(d.config, d.verdier, d.fjorVerdier, state.maaned).fokus.length; } catch (e) { rode = 0; } }
    function folgOpp() {
      var finn = function () { var el = document.querySelector('[data-widget="oppfolging"]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      if (lesRute() !== 'oversikt') { gaaTil('oversikt'); setTimeout(finn, 60); } else finn();
    }
    var punkter = [{ id: 'oversikt', tekst: 'Oversikt', ikon: 'hjem', klikk: function () { gaaTil('oversikt'); } }];
    if (d && d.config) punkter.push({ id: 'folgopp', tekst: 'Følg opp', ikon: 'flagg', merke: rode, klikk: folgOpp });
    if (d && d.kanRegistrere) {
      punkter.push({ id: 'registrer', tekst: 'Registrer', ikon: 'kalender', klikk: function () { gaaTil('registrer'); } });
      punkter.push({ id: 'oppsett', tekst: 'Oppsett', ikon: 'juster', klikk: function () { gaaTil('oppsett'); } });
    }
    punkter.push({ id: 'tiltak', tekst: 'Tiltak', ikon: 'tiltak', klikk: function () { var l = document.getElementById('kpiTiltakLenke'); if (l) l.click(); else root.location.href = '../../'; } });
    return h('nav', { class: 'kpi-bunnmeny', 'aria-label': 'Hovedmeny' }, punkter.map(function (p) {
      var erAktiv = p.id === aktiv;
      return h('button', { type: 'button', class: 'kpi-bunn-knapp' + (erAktiv ? ' is-aktiv' : ''), 'aria-current': erAktiv ? 'page' : null, on: { click: p.klikk } }, [
        h('span', { class: 'kpi-bunn-ikon' }, [bunnIkon(p.ikon), p.merke ? h('span', { class: 'kpi-bunn-merke', 'aria-label': p.merke + ' under mål' }, String(p.merke)) : null]),
        h('span', { class: 'kpi-bunn-tekst' }, p.tekst),
      ]);
    }));
  }

  var ENHET_TEKST = { Antall: 'antall per måned', '%': 'prosent per måned', Kr: 'kroner per måned', Score: 'score per måned' };

  function chartFmt(enhet) {
    return function (v, akse) {
      if (!L.erTall(v)) return '–';
      if (enhet === 'Kr') return akse && Math.abs(v) >= 1000 ? L.fmtTall(v / 1000, 0) + 'k' : L.fmtTall(Math.round(v), 0) + (akse ? '' : ' kr');
      if (enhet === '%') return L.fmtTall(v, akse ? 0 : 1) + (akse ? '' : ' %');
      if (enhet === 'Score') return L.fmtTall(v, akse ? 1 : 2);
      return L.fmtTall(v, Math.round(v) === v ? 0 : 1);
    };
  }


  function tellChip(tone, antall, label) {
    return h('span', { class: 'sak-chip sak-tone-' + tone }, [h('b', null, String(antall)), h('span', null, ' ' + label)]);
  }

  /* ---------------------------------------------------------------- nytt tiltak */

  var KATEGORI_FOR_OMRADE = { HMS: 'HMS', KF: 'KF', Renholdsresultater: 'Kvalitet' };

  function nyttTiltak(def, r) {
    var hh = host();
    var meg = hh.getUser().name;
    var brukere = (hh.getUsers ? hh.getUsers() : []).map(function (u) { return u.name; }).filter(Boolean);
    var tittel = h('input', { type: 'text', maxlength: '160', 'data-autofocus': true, value: '' });
    var eier = select(brukere.length ? brukere : [meg], meg);
    var frist = h('input', { type: 'date', value: plussDager(idagIso(), 30) });
    var prio = select(['Lav', 'Middels', 'Høy', 'Kritisk'], r.status === L.STATUS.IKKE ? 'Høy' : 'Middels');
    var kat = select(['HMS', 'Kvalitet', 'KF', 'GPP', 'LOR', 'Annet'], KATEGORI_FOR_OMRADE[def.omrade] || 'Annet');
    var beskr = h('textarea', { rows: '3', maxlength: '2000' });
    beskr.value = def.navn + ': ' + fmt(r.faktisk, def) + ' mot mål ' + fmt(r.maal, def, true) + ' hittil i år (' + L.mndNavn(state.maaned).toLowerCase() + ' ' + state.aar + ', ' + r.status.toLowerCase() + ').';
    var body = h('div', { class: 'sak-form' }, [
      felt('Hva skal gjøres?', tittel),
      h('div', { class: 'kpi-to-kol' }, [felt('Eier', eier), felt('Frist', frist)]),
      h('div', { class: 'kpi-to-kol' }, [felt('Prioritet', prio), felt('Kategori', kat)]),
      felt('Beskrivelse', beskr, 'Tiltaket legges i den felles tiltakslista (område ' + enhetInfo().tiltakOmrade + ') og kobles til KPI-en. Eier får varsel.'),
    ]);
    F.openDialog({
      title: 'Nytt tiltak', subtitle: def.navn, submitLabel: 'Opprett tiltak', body: body,
      onSubmit: async function () {
        if (!tittel.value.trim()) throw new Error('Skriv hva som skal gjøres.');
        if (!frist.value) throw new Error('Velg en frist.');
        await call('createKpiTiltakV1', {
          aar: state.aar, kpiId: def.id, tittel: tittel.value, eier: eier.value, frist: frist.value,
          prioritet: prio.value, kategori: kat.value, beskrivelse: beskr.value, opprettetAv: meg,
        });
        hh.toast('Tiltaket er lagt i tiltakslista ✓');
      },
    });
  }

  /* ================================================================== render */

  var sist = { aktiv: false, sig: '' };

  function render(opts) {
    var o = opts || {};
    var c = container();
    if (!c || !host() || !erAktiv()) { sist.aktiv = false; return; }
    var uid = host().getUser().uid || '';
    if (state.uid !== uid) {
      nullstill(uid);
      prefs = { kilde: null, verdi: {}, skitten: false, status: '', timer: null };
      if (root.OpExKpiOppsett) root.OpExKpiOppsett.nullstill();
      if (root.OpExKpiOversikt) root.OpExKpiOversikt.avsluttRedigering();
    }
    if (!/^#kpi(?:\/|$)/.test(location.hash || '')) history.replaceState(history.state, '', '#kpi');
    var kommerInn = !sist.aktiv;
    sist.aktiv = true;
    if (kommerInn && !state.laster && uid) last(state.aar).catch(function () {});

    var visning = lesRute();
    var d = state.data;
    if (d && !d.kanRegistrere && visning !== 'oversikt') visning = 'oversikt';
    var tasks = (host().getTasks && host().getTasks()) || [];
    var tiltakSig = tasks.filter(function (t) { return t && t.kpiId; }).map(function (t) { return [t.fbKey, t.status, t.frist, t.tittel, t.eier, t.livssyklus].join('|'); }).join(';');
    var sig = JSON.stringify([visning, state.aar, state.maaned, state.laster, state.lagrer, state.feil && state.feil.message, d && d.config && d.config.oppdatertAt, d && d.registrert, tiltakSig]);
    // Skjemaer tegnes ikke på nytt av bakgrunnsoppdateringer (tiltak i sanntid) mens man skriver.
    if (!o.tvinges && !o.ny && !kommerInn && sig === sist.sig) return;
    if (!o.tvinges && !o.ny && !kommerInn && visning !== 'oversikt' && d) { sist.sig = sig; return; }
    sist.sig = sig;

    var innhold;
    if (!d && state.feil) {
      innhold = [h('div', { class: 'sak-alert sak-tone-danger', role: 'alert' }, [U.icon('alert', 16), h('span', null, state.feil.message || 'Kunne ikke laste KPI-ene.'),
        U.button('Prøv igjen', { small: true, on: { click: function () { last(state.aar).catch(function () {}); } } })])];
    } else if (!d) {
      innhold = [h('div', { class: 'sak-card sak-skeleton sak-skeleton-lg', 'aria-label': 'Laster KPI-er' })];
    } else if (!d.config && visning === 'oversikt') {
      innhold = [h('div', { class: 'sak-card sak-empty' }, [
        h('h2', { class: 'kpi-h2' }, 'Ingen KPI-er for ' + d.aar + ' ennå'),
        h('p', { class: 'sak-muted' }, d.kanRegistrere ? 'Start med å importere dagens Excel-ark, eller sett opp KPI-ene for hånd.' : 'KPI-ene er ikke satt opp ennå.'),
        d.kanRegistrere ? U.button('Gå til oppsett', { variant: 'primary', on: { click: function () { gaaTil('oppsett'); } } }) : null,
      ])];
    } else if (visning === 'registrer') {
      innhold = d.config ? root.OpExKpiRegistrer.bygg(d) : [h('div', { class: 'sak-alert sak-tone-info' }, 'Sett opp KPI-ene for ' + d.aar + ' først (fanen Oppsett).')];
    } else if (visning === 'oppsett') {
      innhold = root.OpExKpiOppsett.bygg(d);
    } else {
      innhold = root.OpExKpiOversikt.bygg(d);
    }
    brukTema();

    var underTekst = enhetInfo().avdeling + ' · Nortura Sarpsborg' + (d ? ' · ' + d.aar : '');
    var tilpass = d && d.config && visning === 'oversikt' && root.OpExKpiOversikt ? root.OpExKpiOversikt.tilpassKnapp() : null;
    var side = h('div', { class: 'sak-page kpi-page kpi-page-' + visning }, [
      sideHode(enhetInfo().navn, underTekst, d ? [tilpass, velgere(d, visning !== 'oppsett'), U.button('', { icon: 'refresh', variant: 'ghost', ariaLabel: 'Oppdater', title: 'Oppdater', on: { click: function () { last(state.aar).catch(function () {}); } } })] : []),
      d && d.kanRegistrere ? nav(visning, d.kanRegistrere) : null,
      d ? bunnmeny(visning, d) : null,
      state.laster && d ? h('div', { class: 'sak-small sak-muted', role: 'status' }, 'Oppdaterer …') : null,
    ].concat(innhold));

    var scrollY = root.scrollY;
    c.textContent = '';
    c.appendChild(side);
    c.setAttribute('aria-busy', state.laster ? 'true' : 'false');
    if (o.ny) root.scrollTo(0, 0); else root.scrollTo(0, scrollY);
  }

  function start() {
    lyttere.push(function () { render({ tvinges: true }); });
    root.addEventListener('popstate', onNav);
    root.addEventListener('hashchange', onNav);
  }

  // Kjernen som visningene (kpi-oversikt.js, kpi-registrer.js, kpi-oppsett.js) bruker.
  root.OpExKpiKjerne = Object.freeze({
    h: h, U: U, F: F, L: L, I: I, C: C, host: host, enhetInfo: enhetInfo,
    state: function () { return state; }, call: call, last: last, render: function (o) { render(o); }, gaaTil: gaaTil, settMaaned: settMaaned,
    TONE: TONE, STATUS_IKON: STATUS_IKON, TERMINAL: TERMINAL, statusChip: statusChip, fmt: fmt, navnFraUid: navnFraUid, idagIso: idagIso, datoTid: datoTid,
    kpiTiltak: kpiTiltak, apneTiltak: apneTiltak, select: select, felt: felt, nyttTiltak: nyttTiltak, chartFmt: chartFmt, tellChip: tellChip,
    prefs: hentPrefs, endrePrefs: endrePrefs, prefsStatus: function () { return prefs.status; },
  });

  start();
  root.OpExKpi = Object.freeze({ render: render, gaaTil: gaaTil, last: last, _state: function () { return state; } });
}(typeof self !== 'undefined' ? self : this));
