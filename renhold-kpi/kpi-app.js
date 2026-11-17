/*
 * kpi-app.js — KPI Renhold: datalag (callables), ruting (#kpi, #kpi/registrer, #kpi/oppsett) og visninger.
 *
 * Integrasjon med verten (index.html) skjer KUN via:
 *   - window.OpExHost (bruker, tiltak, navn, token, openTiltak, toast, show)
 *   - window.OpExKpi.render()  — kalles fra renderAllViews()
 * Gjenbruker Saker-modulens UI-hjelpere (OpExSakUi) og dialog (OpExSakForms.openDialog).
 * Brukertekst settes aldri via innerHTML.
 */
(function (root) {
  'use strict';

  var U = root.OpExSakUi, F = root.OpExSakForms, L = root.OpExKpiLogic, I = root.OpExKpiImport;
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
        body: JSON.stringify({ data: data || {} }),
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
    return call('getRenholdKpiV1', aar ? { aar: aar } : {}).then(function (res) {
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

  /* ---------------------------------------------------------------- minigraf */

  var SVG = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) { var e = document.createElementNS(SVG, tag); Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }

  /** 12 måneder: stolper (Sum) eller linje (Snitt), stiplet mållinje (mål per måned), fjoråret som tynn linje. */
  function minigraf(r, n) {
    var W = 240, H = 64, P = 4;
    var maalMnd = r.aarsmaal === null ? null : (r.def.maaltype === 'HIA' ? r.aarsmaal / 12 : r.aarsmaal);
    var alle = r.serie.concat(r.fjorSerie).filter(L.erTall);
    if (maalMnd !== null) alle.push(maalMnd);
    var maks = Math.max.apply(null, alle.concat([0])), min = r.def.aggregat === 'Snitt' ? Math.min.apply(null, alle.concat([maks])) : 0;
    if (r.def.aggregat === 'Snitt') { var pad = (maks - min) * 0.25 || 0.5; min -= pad; maks += pad; }
    if (maks === min) maks = min + 1;
    var y = function (v) { return H - P - (v - min) / (maks - min) * (H - 2 * P); };
    var bw = (W - 2 * P) / 12;
    var x = function (i) { return P + bw * i + bw / 2; };
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'kpi-graf', role: 'img', 'aria-label': 'Utvikling per måned for ' + r.def.navn, preserveAspectRatio: 'none' });
    var fjor = r.fjorSerie.map(function (v, i) { return L.erTall(v) ? [x(i), y(v)] : null; }).filter(Boolean);
    if (fjor.length > 1) svg.appendChild(svgEl('polyline', { points: fjor.map(function (p) { return p.join(','); }).join(' '), class: 'kpi-graf-fjor' }));
    if (r.def.aggregat === 'Sum') {
      r.serie.forEach(function (v, i) {
        if (!L.erTall(v)) return;
        var top = y(Math.max(v, 0)), bunn = y(0);
        svg.appendChild(svgEl('rect', { x: P + bw * i + bw * 0.18, y: Math.min(top, bunn - 1.5), width: bw * 0.64, height: Math.max(bunn - top, 1.5), rx: 2, class: 'kpi-graf-stolpe' + (i === n - 1 ? ' is-valgt' : i >= n ? ' is-etter' : '') }));
      });
    } else {
      var pts = r.serie.map(function (v, i) { return L.erTall(v) ? [x(i), y(v)] : null; });
      var seg = [];
      pts.forEach(function (p) { if (p) seg.push(p); else if (seg.length) { tegnLinje(seg); seg = []; } });
      if (seg.length) tegnLinje(seg);
      pts.forEach(function (p, i) { if (p) svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: i === n - 1 ? 3.6 : 2.2, class: 'kpi-graf-punkt' + (i === n - 1 ? ' is-valgt' : '') })); });
    }
    function tegnLinje(s) { if (s.length > 1) svg.appendChild(svgEl('polyline', { points: s.map(function (p) { return p.join(','); }).join(' '), class: 'kpi-graf-linje' })); }
    if (maalMnd !== null) svg.appendChild(svgEl('line', { x1: P, x2: W - P, y1: y(maalMnd), y2: y(maalMnd), class: 'kpi-graf-maal' }));
    return svg;
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
      mSel.addEventListener('change', function () { state.maaned = Number(mSel.value); render({ tvinges: true }); });
      kids.unshift(mSel);
    }
    return h('div', { class: 'kpi-velgere' }, kids);
  }

  function nav(aktiv, kanRegistrere) {
    if (!kanRegistrere) return null; // bare oversikten: ingen fanelinje
    var faner = [['oversikt', 'Oversikt', 'activity']];
    if (kanRegistrere) faner.push(['registrer', 'Registrer', 'pencil'], ['oppsett', 'Oppsett', 'list']);
    return h('div', { class: 'kpi-faner', role: 'tablist', 'aria-label': 'KPI Renhold' }, faner.map(function (f) {
      return h('button', {
        type: 'button', role: 'tab', class: 'kpi-fane' + (aktiv === f[0] ? ' is-aktiv' : ''), 'aria-selected': aktiv === f[0] ? 'true' : 'false',
        on: { click: function () { gaaTil(f[0]); } },
      }, [U.icon(f[2], 16), h('span', null, f[1])]);
    }));
  }

  function byggOversikt(d) {
    var n = state.maaned;
    var vurd = L.vurderAar(d.config, d.verdier, d.fjorVerdier, n);
    var reg = d.registrert && d.registrert[L.mndKey(n)];
    var mangler = L.manglerVerdi(d.config, d.verdier, n);

    var sammendrag = h('div', { class: 'kpi-sammendrag sak-card' }, [
      h('div', { class: 'kpi-sammendrag-hoved' }, [
        h('div', { class: 'kpi-stor' }, [h('b', null, String(vurd.tell.paa)), h('span', null, ' av ' + vurd.totalt + ' på mål')]),
        h('div', { class: 'sak-muted sak-small' }, 'Hittil i år t.o.m. ' + vurd.maanedNavn.toLowerCase() + ' ' + d.aar),
      ]),
      h('div', { class: 'kpi-tell' }, [
        tellChip('ok', vurd.tell.paa, 'på mål'), tellChip('warn', vurd.tell.naer, 'nær mål'),
        tellChip('danger', vurd.tell.ikke, 'ikke på mål'), vurd.tell.ingen ? tellChip('muted', vurd.tell.ingen, 'uten data') : null,
      ]),
      h('div', { class: 'sak-muted sak-small kpi-reg' }, reg
        ? 'Registrert av ' + navnFraUid(reg.av) + ' · ' + datoTid(reg.at) + (reg.import ? ' (import fra Excel)' : '')
        : 'Ingen registrering for ' + vurd.maanedNavn.toLowerCase()),
    ]);

    var varsel = null;
    if (mangler.length && mangler.length < vurd.totalt) {
      varsel = h('div', { class: 'sak-alert sak-tone-warn kpi-varsel', role: 'status' }, [
        U.icon('alert', 16),
        h('span', null, vurd.maanedNavn + ' mangler ' + mangler.length + ' av ' + vurd.totalt + ' verdier: ' + mangler.map(function (k) { return k.navn; }).join(', ') + '.'),
        d.kanRegistrere ? U.button('Registrer', { small: true, on: { click: function () { gaaTil('registrer'); } } }) : null,
      ]);
    } else if (mangler.length === vurd.totalt && d.kanRegistrere) {
      varsel = h('div', { class: 'sak-alert sak-tone-info kpi-varsel', role: 'status' }, [
        U.icon('info', 16), h('span', null, 'Ingen verdier registrert for ' + vurd.maanedNavn.toLowerCase() + ' ennå.'),
        U.button('Registrer nå', { small: true, variant: 'primary', on: { click: function () { gaaTil('registrer'); } } }),
      ]);
    }

    var fokus = vurd.fokus.length ? h('section', { class: 'kpi-fokus sak-card' }, [
      h('h2', { class: 'kpi-h2' }, [U.icon('flag', 16), h('span', null, 'Fokusområder')]),
      h('ul', { class: 'kpi-fokus-liste' }, vurd.fokus.map(function (r) {
        var aapne = apneTiltak(kpiTiltak(r.id)).length;
        return h('li', null, [
          h('a', { href: '#kpi-' + r.id, on: { click: function (e) { e.preventDefault(); var el = document.getElementById('kpi-' + r.id); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); } } } }, r.def.navn),
          h('span', { class: 'kpi-fokus-tall' }, fmt(r.faktisk, r.def) + ' / ' + fmt(r.maal, r.def, true)),
          h('span', { class: 'sak-small ' + (aapne ? 'sak-muted' : 'kpi-uten-tiltak') }, aapne ? aapne + ' åpne tiltak' : 'ingen tiltak'),
        ]);
      })),
    ]) : null;

    var grupper = vurd.grupper.map(function (g) {
      return h('section', { class: 'kpi-gruppe' }, [
        h('h2', { class: 'kpi-h2' }, g.omrade),
        h('div', { class: 'kpi-kort-grid' }, g.rader.map(function (r) { return kpiKort(r, n, d); })),
      ]);
    });

    return [sammendrag, varsel, fokus].concat(grupper);
  }

  function tellChip(tone, antall, label) {
    return h('span', { class: 'sak-chip sak-tone-' + tone }, [h('b', null, String(antall)), h('span', null, ' ' + label)]);
  }

  function kpiKort(r, n, d) {
    var def = r.def;
    var tiltak = kpiTiltak(r.id), aapne = apneTiltak(tiltak);
    var maalTekst = r.maal === null ? 'Ingen mål satt'
      : def.maaltype === 'HIA' ? 'Mål HIÅ ' + fmt(r.maal, def, true) + ' (år ' + fmt(r.aarsmaal, def) + ')'
        : 'Mål ' + fmt(r.maal, def);
    var retningTekst = def.retning === 'Ned' ? 'Lavere er bedre' : 'Høyere er bedre';
    var fjorTekst = L.erTall(r.fjorHia) ? 'I fjor samme periode: ' + fmt(r.fjorHia, def) : null;
    var tiltakListe = h('div', { class: 'kpi-tiltak', hidden: !aapne.length }, aapne.slice(0, 4).map(function (t) {
      var forsinket = t.frist && t.frist < idagIso();
      return h('button', { type: 'button', class: 'kpi-tiltak-rad' + (forsinket ? ' is-forsinket' : ''), on: { click: function () { host().openTiltak(t.fbKey); } } }, [
        h('span', { class: 'kpi-tiltak-tittel' }, t.tittel || 'Uten tittel'),
        h('span', { class: 'sak-small sak-muted' }, [t.eier || '', t.frist ? ' · ' + (forsinket ? 'forfalt ' : 'frist ') + U.fmtDato(t.frist, idagIso()) : ''].join('')),
      ]);
    }));
    return h('article', { class: 'sak-card kpi-kort kpi-tone-' + TONE[r.status], id: 'kpi-' + r.id, tabindex: '-1', 'aria-label': def.navn + ': ' + r.status }, [
      h('div', { class: 'kpi-kort-top' }, [h('h3', null, def.navn), statusChip(r.status)]),
      h('div', { class: 'kpi-kort-verdi' }, [
        h('b', null, fmt(r.faktisk, def)),
        h('span', { class: 'sak-muted sak-small' }, def.aggregat === 'Snitt' ? 'snitt hittil i år' : 'hittil i år'),
      ]),
      h('div', { class: 'kpi-kort-meta sak-small' }, [
        h('span', null, maalTekst), h('span', { class: 'sak-muted' }, retningTekst + (r.status !== L.STATUS.INGEN ? ' · grense ±' + L.fmtTall(r.grense, 0) + ' %' : '')),
        h('span', { class: 'sak-muted' }, L.mndNavn(n) + ': ' + fmt(r.periode, def) + (L.erTall(r.fjorPeriode) ? ' (i fjor ' + fmt(r.fjorPeriode, def) + ')' : '')),
        fjorTekst ? h('span', { class: 'sak-muted' }, fjorTekst) : null,
      ]),
      minigraf(r, n),
      tiltakListe,
      h('div', { class: 'kpi-kort-foot' }, [
        h('span', { class: 'sak-small sak-muted' }, tiltak.length ? aapne.length + ' åpne · ' + (tiltak.length - aapne.length) + ' lukket tiltak' : 'Ingen tiltak'),
        U.button('Tiltak', { small: true, icon: 'plus', variant: 'secondary', ariaLabel: 'Nytt tiltak for ' + def.navn, on: { click: function () { nyttTiltak(def, r, d); } } }),
      ]),
    ]);
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
      felt('Beskrivelse', beskr, 'Tiltaket legges i den felles tiltakslista (område Renhold) og kobles til KPI-en. Eier får varsel.'),
    ]);
    F.openDialog({
      title: 'Nytt tiltak', subtitle: def.navn, submitLabel: 'Opprett tiltak', body: body,
      onSubmit: async function () {
        if (!tittel.value.trim()) throw new Error('Skriv hva som skal gjøres.');
        if (!frist.value) throw new Error('Velg en frist.');
        await call('createRenholdKpiTiltakV1', {
          aar: state.aar, kpiId: def.id, tittel: tittel.value, eier: eier.value, frist: frist.value,
          prioritet: prio.value, kategori: kat.value, beskrivelse: beskr.value, opprettetAv: meg,
        });
        hh.toast('Tiltaket er lagt i tiltakslista ✓');
      },
    });
  }

  /* ================================================================== registrering */

  var utkast = { nokkel: '', verdier: {} };

  function byggRegistrering(d) {
    var n = state.maaned, mm = L.mndKey(n);
    var kpier = L.aktiveKpier(d.config);
    var naa = (d.verdier && d.verdier[mm]) || {};
    var forrige = n > 1 ? (d.verdier && d.verdier[L.mndKey(n - 1)]) || {} : {};
    var fjor = (d.fjorVerdier && d.fjorVerdier[mm]) || {};
    var nokkel = d.aar + '-' + mm;
    if (utkast.nokkel !== nokkel) utkast = { nokkel: nokkel, verdier: {} };
    var reg = d.registrert && d.registrert[mm];

    var inputs = {};
    var feilBoks = h('div', { class: 'sak-alert sak-tone-danger', role: 'alert', hidden: true });
    var lagreBtn = U.button(state.lagrer ? 'Lagrer …' : 'Lagre ' + L.mndNavn(n).toLowerCase(), { variant: 'primary', type: 'submit', disabled: state.lagrer });

    var rader = [];
    var forrigeOmrade = null;
    kpier.forEach(function (k) {
      if (k.omrade !== forrigeOmrade) { rader.push(h('h2', { class: 'kpi-h2 kpi-reg-omrade' }, k.omrade)); forrigeOmrade = k.omrade; }
      var startVerdi = Object.prototype.hasOwnProperty.call(utkast.verdier, k.id) ? utkast.verdier[k.id]
        : (L.erTall(naa[k.id]) ? L.fmtTall(naa[k.id], k.enhet === 'Score' ? 2 : k.enhet === '%' ? 1 : 0).replace(/ /g, ' ') : '');
      var inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: startVerdi, 'aria-describedby': 'kpi-hj-' + k.id, class: 'kpi-tall-input' });
      inp.addEventListener('input', function () { utkast.verdier[k.id] = inp.value; inp.removeAttribute('aria-invalid'); });
      inputs[k.id] = inp;
      var maalMnd = L.erTall(k.maal) ? (k.maaltype === 'HIA' ? k.maal / 12 : k.maal) : null;
      rader.push(h('div', { class: 'kpi-reg-rad' }, [
        h('label', { for: inp.id = 'kpi-inp-' + k.id }, [h('b', null, k.navn), h('span', { class: 'sak-muted sak-small' }, ' ' + k.enhet)]),
        h('div', { class: 'kpi-reg-input' }, [inp, k.enhet === '%' ? h('span', { class: 'sak-muted' }, '%') : k.enhet === 'Kr' ? h('span', { class: 'sak-muted' }, 'kr') : null]),
        h('div', { class: 'kpi-reg-hjelp sak-small sak-muted', id: 'kpi-hj-' + k.id }, [
          n > 1 ? h('span', null, L.mndNavn(n - 1) + ': ' + fmt(forrige[k.id], k)) : null,
          h('span', null, 'I fjor: ' + fmt(fjor[k.id], k)),
          maalMnd !== null ? h('span', null, (k.maaltype === 'HIA' ? 'Mål/mnd: ' : 'Mål: ') + fmt(maalMnd, k, true)) : null,
        ]),
      ]));
    });

    var form = h('form', { class: 'sak-card kpi-reg-form', novalidate: true }, [
      h('div', { class: 'kpi-reg-head' }, [
        h('div', null, [h('h2', { class: 'kpi-h2' }, 'Verdier for ' + L.mndNavn(n).toLowerCase() + ' ' + d.aar),
          h('div', { class: 'sak-muted sak-small' }, reg ? 'Sist lagret av ' + navnFraUid(reg.av) + ' · ' + datoTid(reg.at) : 'Ikke registrert ennå')]),
      ]),
      h('p', { class: 'sak-muted sak-small kpi-reg-intro' }, 'Skriv månedens tall (ikke hittil i år). Prosent skrives som 94,8. La feltet stå tomt hvis tallet ikke finnes ennå.'),
    ].concat(rader).concat([feilBoks, h('div', { class: 'kpi-reg-foot' }, [lagreBtn])]));

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.lagrer) return;
      var verdier = {}, feil = [];
      kpier.forEach(function (k) {
        var v = L.parseTall(inputs[k.id].value);
        if (typeof v === 'number' && isNaN(v)) { feil.push(k.navn); inputs[k.id].setAttribute('aria-invalid', 'true'); return; }
        if (k.enhet === '%' && v !== null && (v < 0 || v > 100)) { feil.push(k.navn + ' (0–100)'); inputs[k.id].setAttribute('aria-invalid', 'true'); return; }
        verdier[k.id] = v;
      });
      if (feil.length) {
        feilBoks.hidden = false; feilBoks.textContent = 'Sjekk tallene for: ' + feil.join(', ') + '.';
        var forste = form.querySelector('[aria-invalid="true"]'); if (forste) forste.focus();
        return;
      }
      state.lagrer = true; render({ tvinges: true });
      call('saveRenholdKpiMaanedV1', { aar: d.aar, maaned: n, verdier: verdier }).then(function (res) {
        utkast = { nokkel: '', verdier: {} };
        host().toast(res.endret ? res.endret + ' verdier lagret for ' + L.mndNavn(n).toLowerCase() + ' ✓' : 'Ingen endringer å lagre');
        return last(d.aar);
      }).then(function () { state.lagrer = false; gaaTil('oversikt'); }, function (err) {
        state.lagrer = false; render({ tvinges: true });
        host().toast(err.message || 'Kunne ikke lagre', true);
      });
    });
    return [form];
  }

  /* ================================================================== oppsett */

  var oppsettUtkast = null; // { aar, naerMaalProsent, kpier: [def med id] }

  function startOppsettUtkast(d) {
    var cfg = d.config || { naerMaalProsent: L.STANDARD_GRENSE, kpier: {} };
    oppsettUtkast = {
      aar: d.aar, basis: (d.config && d.config.oppdatertAt) || '', naerMaalProsent: L.erTall(cfg.naerMaalProsent) ? cfg.naerMaalProsent : L.STANDARD_GRENSE,
      kpier: Object.keys(cfg.kpier || {}).map(function (id) { return Object.assign({ id: id }, cfg.kpier[id]); })
        .sort(function (a, b) { return (a.sortering || 0) - (b.sortering || 0); }),
    };
  }

  function tallTekst(v) { return L.erTall(v) ? String(v).replace('.', ',') : ''; }

  function byggOppsett(d) {
    // Utkastet bygges på nytt når oppsettet på serveren er en annen versjon (etter lagring, import eller nytt år).
    if (!oppsettUtkast || oppsettUtkast.aar !== d.aar || oppsettUtkast.basis !== ((d.config && d.config.oppdatertAt) || '')) startOppsettUtkast(d);
    var u = oppsettUtkast;
    var brukte = {};
    Object.keys(d.verdier || {}).forEach(function (m) { Object.keys(d.verdier[m] || {}).forEach(function (k) { brukte[k] = true; }); });
    var omrader = L.OMRAADER.slice();
    u.kpier.forEach(function (k) { if (k.omrade && omrader.indexOf(k.omrade) < 0) omrader.push(k.omrade); });

    var grense = h('input', { type: 'text', inputmode: 'decimal', value: tallTekst(u.naerMaalProsent), class: 'kpi-kort-input' });
    grense.addEventListener('input', function () { u.naerMaalProsent = L.parseTall(grense.value); });

    var liste = h('div', { class: 'kpi-oppsett-liste' }, u.kpier.map(function (k, i) {
      function inp(felt, type) {
        var e = h('input', { type: 'text', inputmode: type === 'tall' ? 'decimal' : undefined, value: type === 'tall' ? tallTekst(k[felt]) : (k[felt] || '') });
        e.addEventListener('input', function () { k[felt] = type === 'tall' ? L.parseTall(e.value) : e.value; });
        return e;
      }
      function sel(felt, opts) {
        var e = select(opts, k[felt]);
        e.addEventListener('change', function () { k[felt] = e.value; });
        return e;
      }
      var aktiv = h('input', { type: 'checkbox', checked: k.aktiv !== false });
      aktiv.addEventListener('change', function () { k.aktiv = aktiv.checked; });
      var flytt = function (dir) { var j = i + dir; if (j < 0 || j >= u.kpier.length) return; var t = u.kpier[i]; u.kpier[i] = u.kpier[j]; u.kpier[j] = t; render({ tvinges: true }); };
      return h('fieldset', { class: 'sak-fieldset kpi-oppsett-kpi' + (k.aktiv === false ? ' is-inaktiv' : '') }, [
        h('legend', null, k.navn || 'Ny KPI'),
        h('div', { class: 'kpi-oppsett-grid' }, [
          felt('Navn', inp('navn')), felt('Område', sel('omrade', omrader)), felt('Enhet', sel('enhet', L.ENHETER)),
          felt('Mål ' + d.aar, inp('maal', 'tall')), felt('Måltype', sel('maaltype', [{ value: 'HIA', label: 'Årsmål (fordeles per måned)' }, { value: 'Fast', label: 'Fast nivå' }])),
          felt('Beregning', sel('aggregat', [{ value: 'Sum', label: 'Sum hittil i år' }, { value: 'Snitt', label: 'Snitt hittil i år' }])),
          felt('Retning', sel('retning', [{ value: 'Opp', label: 'Opp (høyere er bedre)' }, { value: 'Ned', label: 'Ned (lavere er bedre)' }])),
          felt('Grense «nær mål» %', inp('naerMaalProsent', 'tall'), 'Tom = felles grense'),
          felt('Oppnådd i fjor', inp('fjorResultat', 'tall')),
        ]),
        h('div', { class: 'kpi-oppsett-foot' }, [
          h('label', { class: 'kpi-inline-check' }, [aktiv, h('span', null, 'Aktiv')]),
          h('span', { class: 'kpi-spacer' }),
          U.button('', { small: true, icon: 'chevron-left', class: 'kpi-opp', ariaLabel: 'Flytt opp', title: 'Flytt opp', disabled: i === 0, on: { click: function () { flytt(-1); } } }),
          U.button('', { small: true, icon: 'chevron-right', class: 'kpi-ned', ariaLabel: 'Flytt ned', title: 'Flytt ned', disabled: i === u.kpier.length - 1, on: { click: function () { flytt(1); } } }),
          brukte[k.id] ? h('span', { class: 'sak-small sak-muted' }, 'Har verdier – kan settes inaktiv') :
            U.button('Fjern', { small: true, variant: 'ghost', on: { click: function () { u.kpier.splice(i, 1); render({ tvinges: true }); } } }),
        ]),
      ]);
    }));

    var leggTil = U.button('Legg til KPI', { icon: 'plus', variant: 'secondary', on: { click: function () {
      u.kpier.push({ id: '', navn: '', omrade: 'HMS', enhet: 'Antall', retning: 'Opp', aggregat: 'Sum', maaltype: 'HIA', maal: null, aktiv: true });
      render({ tvinges: true });
    } } });

    var feilBoks = h('div', { class: 'sak-alert sak-tone-danger', role: 'alert', hidden: true });
    var lagre = U.button(state.lagrer ? 'Lagrer …' : 'Lagre oppsett for ' + d.aar, { variant: 'primary', disabled: state.lagrer, on: { click: function () {
      var cfg;
      try { cfg = configFraUtkast(u); } catch (e) { feilBoks.hidden = false; feilBoks.textContent = e.message; return; }
      state.lagrer = true; render({ tvinges: true });
      call('saveRenholdKpiConfigV1', { aar: d.aar, config: cfg }).then(function () {
        host().toast('Oppsettet for ' + d.aar + ' er lagret ✓');
        oppsettUtkast = null;
        return last(d.aar);
      }).then(function () { state.lagrer = false; render({ tvinges: true }); }, function (err) {
        state.lagrer = false; render({ tvinges: true }); host().toast(err.message || 'Kunne ikke lagre', true);
      });
    } } });
    var angre = U.button('Forkast endringer', { variant: 'ghost', on: { click: function () { oppsettUtkast = null; render({ tvinges: true }); } } });

    var nyttAar = d.aar + 1;
    var harNytt = (d.aarListe || []).indexOf(nyttAar) >= 0;
    var aarKort = h('section', { class: 'sak-card kpi-oppsett-aar' }, [
      h('h2', { class: 'kpi-h2' }, 'Nytt år'),
      h('p', { class: 'sak-muted sak-small' }, harNytt
        ? 'Oppsett for ' + nyttAar + ' finnes allerede. Velg året øverst for å endre det.'
        : 'Lag oppsett for ' + nyttAar + ' med de samme KPI-ene. Årets resultat (hittil i år) blir «oppnådd i fjor». Målene kan justeres etterpå.'),
      harNytt || !d.config ? null : U.button('Lag oppsett for ' + nyttAar, { icon: 'plus', variant: 'secondary', on: { click: function () { lagNyttAar(d, nyttAar); } } }),
    ]);

    return [
      d.config ? null : h('div', { class: 'sak-alert sak-tone-info', role: 'status' }, [U.icon('info', 16), h('span', null, 'Det finnes ikke noe oppsett for ' + d.aar + ' ennå. Importer fra Excel nedenfor, eller legg til KPI-er for hånd.')]),
      h('section', { class: 'sak-card kpi-oppsett-felles' }, [
        h('h2', { class: 'kpi-h2' }, 'Felles for ' + d.aar),
        felt('Grense for «nær mål» (%)', grense, 'Opp: «nær mål» når resultatet er inntil så mange prosent under målet. Ned: inntil så mange prosent over. Gjelder alle KPI-er uten egen grense.'),
      ]),
      liste,
      h('div', { class: 'kpi-oppsett-handlinger' }, [leggTil, h('span', { class: 'kpi-spacer' }), angre, lagre]),
      feilBoks,
      aarKort,
      byggImport(d),
    ];
  }

  function configFraUtkast(u) {
    var g = u.naerMaalProsent;
    if (typeof g === 'number' && (isNaN(g) || g < 0 || g > 100)) throw new Error('Grensen for «nær mål» må være et tall mellom 0 og 100.');
    if (!u.kpier.length) throw new Error('Oppsettet må ha minst én KPI.');
    var kpier = {}, brukt = {};
    u.kpier.forEach(function (k, i) {
      var navn = String(k.navn || '').trim();
      if (!navn) throw new Error('KPI nummer ' + (i + 1) + ' mangler navn.');
      ['maal', 'fjorResultat', 'naerMaalProsent'].forEach(function (f) {
        if (typeof k[f] === 'number' && isNaN(k[f])) throw new Error('Ugyldig tall i «' + navn + '».');
      });
      var id = k.id || I.slug(navn);
      while (brukt[id] || (!k.id && u.kpier.some(function (x) { return x !== k && x.id === id; }))) id = (id + '-2').slice(0, 40);
      brukt[id] = true; k.id = id;
      kpier[id] = {
        navn: navn, omrade: k.omrade || 'Annet', enhet: k.enhet || 'Antall', retning: k.retning || 'Opp', aggregat: k.aggregat || 'Sum',
        maaltype: k.maaltype || 'HIA', maal: L.erTall(k.maal) ? k.maal : null, fjorResultat: L.erTall(k.fjorResultat) ? k.fjorResultat : null,
        naerMaalProsent: L.erTall(k.naerMaalProsent) ? k.naerMaalProsent : null, sortering: (i + 1) * 10, aktiv: k.aktiv !== false,
      };
    });
    return { naerMaalProsent: L.erTall(g) ? g : L.STANDARD_GRENSE, kpier: kpier };
  }

  function lagNyttAar(d, nyttAar) {
    var vurd = L.vurderAar(d.config, d.verdier, d.fjorVerdier, 12);
    var resultat = {}; vurd.rader.forEach(function (r) { resultat[r.id] = r.faktisk; });
    var kpier = {};
    Object.keys(d.config.kpier).forEach(function (id) {
      var k = Object.assign({}, d.config.kpier[id]);
      k.fjorResultat = L.erTall(resultat[id]) ? Math.round(resultat[id] * 1000) / 1000 : null;
      kpier[id] = k;
    });
    F.openDialog({
      title: 'Lag oppsett for ' + nyttAar, submitLabel: 'Lag oppsett',
      body: h('p', null, 'Kopierer ' + Object.keys(kpier).length + ' KPI-er med dagens mål til ' + nyttAar + '. Du kan endre mål, grenser og KPI-er etterpå.'),
      onSubmit: async function () {
        await call('saveRenholdKpiConfigV1', { aar: nyttAar, config: { naerMaalProsent: d.config.naerMaalProsent, kpier: kpier } });
        host().toast('Oppsett for ' + nyttAar + ' er laget ✓');
        oppsettUtkast = null;
        await last(nyttAar);
      },
    });
  }

  /* ---------------------------------------------------------------- import */

  function byggImport(d) {
    var fil = h('input', { type: 'file', accept: '.xlsx,.xlsm', class: 'kpi-fil' });
    var resultat = h('div', { class: 'kpi-import-resultat' });
    fil.addEventListener('change', function () {
      resultat.textContent = '';
      var f = fil.files && fil.files[0];
      if (!f) return;
      if (!root.XLSX) { resultat.appendChild(h('div', { class: 'sak-alert sak-tone-danger' }, 'Excel-leseren er ikke lastet. Sjekk nettforbindelsen og last siden på nytt.')); return; }
      f.arrayBuffer().then(function (buf) {
        var lest = I.lesSheetJs(root.XLSX.read(buf, { type: 'array' }));
        visImportForslag(resultat, lest, d);
      }).catch(function (err) {
        resultat.appendChild(h('div', { class: 'sak-alert sak-tone-danger', role: 'alert' }, 'Kunne ikke lese filen: ' + (err.message || err)));
      });
    });
    return h('section', { class: 'sak-card kpi-import' }, [
      h('h2', { class: 'kpi-h2' }, 'Importer fra Excel'),
      h('p', { class: 'sak-muted sak-small' }, 'Les inn KPI-arket («KPI 2026 Renhold»): KPI-er, mål, månedsverdier og fjorårets tall. Ingenting lagres før du bekrefter.'),
      felt('Velg Excel-fil', fil),
      resultat,
    ]);
  }

  function visImportForslag(boks, lest, d) {
    var antKpi = Object.keys(lest.config.kpier).length;
    var antVerdier = Object.keys(lest.verdier).reduce(function (s, m) { return s + Object.keys(lest.verdier[m]).length; }, 0);
    var antFjor = Object.keys(lest.fjorVerdier).reduce(function (s, m) { return s + Object.keys(lest.fjorVerdier[m]).length; }, 0);
    var finnes = (d.aarListe || []).indexOf(lest.aar) >= 0;
    var importer = U.button('Importer til ' + lest.aar, { variant: finnes ? 'danger' : 'primary', on: { click: function () {
      importer.disabled = true;
      call('importRenholdKpiV1', { aar: lest.aar, config: lest.config, verdier: lest.verdier, fjorVerdier: lest.fjorVerdier, overskriv: finnes }).then(function (res) {
        host().toast('Importert: ' + res.kpier + ' KPI-er, ' + res.verdier + ' verdier for ' + res.aar + ' og ' + res.fjorVerdier + ' fra ' + (res.aar - 1) + ' ✓');
        oppsettUtkast = null;
        return last(res.aar);
      }).then(function () { gaaTil('oversikt'); }, function (err) { importer.disabled = false; host().toast(err.message || 'Importen feilet', true); });
    } } });
    boks.textContent = '';
    boks.appendChild(h('div', { class: 'kpi-import-forslag' }, [
      h('p', null, [h('b', null, 'Fant ' + antKpi + ' KPI-er for ' + lest.aar), ', ' + antVerdier + ' månedsverdier (' + lest.maaneder.map(L.mndNavn).join(', ').toLowerCase() + ') og ' + antFjor + ' verdier fra ' + (lest.aar - 1) + '.']),
      h('ul', { class: 'sak-small kpi-import-kpier' }, Object.keys(lest.config.kpier).map(function (id) {
        var k = lest.config.kpier[id];
        return h('li', null, k.omrade + ' · ' + k.navn + ' · mål ' + L.fmtVerdi(k.maal, k.enhet) + ' · ' + k.retning + ' · ' + k.aggregat + '/' + k.maaltype);
      })),
      lest.advarsler.length ? h('div', { class: 'sak-alert sak-tone-warn' }, [U.icon('alert', 16), h('div', null, lest.advarsler.map(function (a) { return h('div', null, a); }))]) : null,
      finnes ? h('div', { class: 'sak-alert sak-tone-danger' }, [U.icon('alert', 16), h('span', null, 'Det finnes allerede data for ' + lest.aar + '. Importen erstatter oppsett og alle verdier for ' + lest.aar + ' og ' + (lest.aar - 1) + '.')]) : null,
      h('div', { class: 'kpi-oppsett-handlinger' }, [h('span', { class: 'kpi-spacer' }), importer]),
    ]));
  }

  /* ================================================================== render */

  var sist = { aktiv: false, sig: '' };

  function render(opts) {
    var o = opts || {};
    var c = container();
    if (!c || !host() || !erAktiv()) { sist.aktiv = false; return; }
    var uid = host().getUser().uid || '';
    if (state.uid !== uid) { nullstill(uid); oppsettUtkast = null; utkast = { nokkel: '', verdier: {} }; }
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
      innhold = d.config ? byggRegistrering(d) : [h('div', { class: 'sak-alert sak-tone-info' }, 'Sett opp KPI-ene for ' + d.aar + ' først (fanen Oppsett).')];
    } else if (visning === 'oppsett') {
      innhold = byggOppsett(d);
    } else {
      innhold = byggOversikt(d);
    }

    var underTekst = 'Renhold · Nortura Sarpsborg' + (d ? ' · ' + d.aar : '');
    var side = h('div', { class: 'sak-page kpi-page' }, [
      sideHode('KPI Renhold', underTekst, d ? [velgere(d, visning !== 'oppsett'), U.button('', { icon: 'refresh', variant: 'ghost', ariaLabel: 'Oppdater', title: 'Oppdater', on: { click: function () { last(state.aar).catch(function () {}); } } })] : []),
      d ? nav(visning, d.kanRegistrere) : null,
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

  start();
  root.OpExKpi = Object.freeze({ render: render, gaaTil: gaaTil, last: last, _state: function () { return state; } });
}(typeof self !== 'undefined' ? self : this));
