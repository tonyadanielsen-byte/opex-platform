/*
 * kpi-oversikt.js — Oversikten som et tilpassbart dashboard.
 *
 * Oversikten består av bokser (widgets) i et 12-kolonners rutenett som bruker hele skjermbredden:
 *   status          ring + fordeling hittil i år
 *   oppfolging      «Krever oppfølging»: alle KPI-er som ikke er på mål, med avvik, trend og tiltak
 *   registrering    måneder registrert, hvem/når, snarvei til registrering
 *   nokkeltall      én flis per KPI med graf
 *   graf-…          utvikling per måned per område og enhet (stolpe / linje / område)
 *   tabell-…        detaljer og tiltak per område (åpne en rad for stor graf og tiltak)
 *
 * «Tilpass oversikt»: dra boksene for å flytte dem, dra i høyre kant (eller velg bredde) for å endre størrelse,
 * velg graftype, skjul/vis bokser, velg fargetema og tetthet. Oppsettet lagres per bruker (saveKpiPreferanserV1).
 *
 * Avhenger av kjernen i kpi-app.js (window.OpExKpiKjerne), som slås opp når siden tegnes.
 */
(function (root) {
  'use strict';

  var K = function () { return root.OpExKpiKjerne; };
  var BREDDER = [3, 4, 5, 6, 7, 8, 9, 12];
  var BREDDE_NAVN = { 3: '¼', 4: '⅓', 5: '5/12', 6: '½', 7: '7/12', 8: '⅔', 9: '¾', 12: 'Hel' };
  var GRAF_NAVN = { stolpe: 'Stolper', linje: 'Linje', omraade: 'Område' };

  var redigerer = false;
  var aapneRader = {};

  function slug(t) { return String(t).toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'x'; }
  function naermesteBredde(n) { return BREDDER.reduce(function (a, b) { return Math.abs(b - n) < Math.abs(a - n) ? b : a; }, 6); }

  /* ================================================================== hjelpere for innhold */

  /** Hvor langt unna målet, relativt (0 = på mål). */
  function avvik(r) {
    var L = K().L;
    if (!L.erTall(r.faktisk) || !L.erTall(r.maal)) return 0;
    var diff = r.def.retning === 'Ned' ? r.faktisk - r.maal : r.maal - r.faktisk;
    return Math.max(diff, 0) / Math.max(Math.abs(r.maal), 1);
  }

  /** Andel av målet nådd (0–1). */
  function maaloppnaaelse(r) {
    var L = K().L;
    if (!L.erTall(r.faktisk) || !L.erTall(r.maal)) return 0;
    if (r.def.retning === 'Ned') { if (r.faktisk <= r.maal) return 1; return r.maal <= 0 ? 0 : Math.max(0, r.maal / r.faktisk); }
    if (r.maal <= 0) return 1;
    return Math.max(0, Math.min(1, r.faktisk / r.maal));
  }

  function avvikTekst(r) {
    var k = K(), L = k.L;
    if (!L.erTall(r.faktisk) || !L.erTall(r.maal)) return '';
    var diff = r.faktisk - r.maal;
    var tegn = diff > 0 ? '+' : diff < 0 ? '−' : '±';
    var abs = Math.abs(diff);
    var verdi = r.def.enhet === '%' ? L.fmtTall(abs, 1) + ' %-poeng' : k.fmt(abs, r.def, true);
    return tegn + verdi + ' mot mål';
  }

  /* ================================================================== widgets */

  var ENHET_TEKST = { Antall: 'antall per måned', '%': 'prosent per måned', Kr: 'kroner per måned', Score: 'score per måned' };

  function grafGrupper(vurd) {
    var ut = [];
    vurd.grupper.forEach(function (g) {
      var perEnhet = {}, rekkefolge = [];
      g.rader.forEach(function (r) { if (!perEnhet[r.def.enhet]) { perEnhet[r.def.enhet] = []; rekkefolge.push(r.def.enhet); } perEnhet[r.def.enhet].push(r); });
      rekkefolge.forEach(function (enhet) {
        var rader = perEnhet[enhet];
        var biter = Math.ceil(rader.length / 4), str = Math.ceil(rader.length / biter), nr = 0;
        for (var i = 0; i < rader.length; i += str) {
          nr++;
          ut.push({ id: 'graf-' + slug(g.omrade) + '-' + slug(enhet === '%' ? 'prosent' : enhet) + '-' + nr, omrade: g.omrade, enhet: enhet, rader: rader.slice(i, i + str) });
        }
      });
    });
    return ut;
  }

  /** Alle bokser med standard plassering. Rekkefølgen her er standardoppsettet. */
  function standardWidgets(d, vurd, n) {
    var liste = [
      { id: 'status', tittel: 'Status hittil i år', bredde: 3, bygg: function () { return byggStatus(d, vurd, n); } },
      { id: 'oppfolging', tittel: 'Krever oppfølging', bredde: 6, rod: vurd.fokus.length > 0, bygg: function () { return byggOppfolging(d, vurd, n); } },
      { id: 'registrering', tittel: 'Registrering ' + d.aar, bredde: 3, bygg: function () { return byggRegistrering(d, vurd, n); } },
      { id: 'nokkeltall', tittel: 'Nøkkeltall', bredde: 12, bygg: function () { return byggNokkeltall(vurd, n); } },
    ];
    var grafer = grafGrupper(vurd);
    grafer.forEach(function (gr) {
      var en = gr.rader.length === 1 ? gr.rader[0] : null;
      liste.push({
        id: gr.id, type: 'graf', bredde: grafer.length >= 3 ? 4 : 6, standardGraf: gr.enhet === '%' || gr.enhet === 'Score' ? 'linje' : 'stolpe',
        tittel: en ? en.def.navn : gr.omrade + ' – ' + ENHET_TEKST[gr.enhet],
        under: en ? gr.omrade + ' · ' + ENHET_TEKST[gr.enhet] : gr.rader.map(function (r) { return r.def.navn; }).join(' · '),
        bygg: function (w) { return byggGraf(d, gr, n, w.graf); },
      });
    });
    vurd.grupper.forEach(function (g) {
      liste.push({ id: 'tabell-' + slug(g.omrade), type: 'tabell', tittel: g.omrade, bredde: 6, bygg: function () { return byggOmradeTabell(g, n, d); }, hode: function () { return omradeTell(g); } });
    });
    return liste;
  }

  /** Standardoppsett slått sammen med brukerens innstillinger. */
  function widgets(d, vurd, n) {
    var pref = (K().prefs().widgets) || {};
    return standardWidgets(d, vurd, n).map(function (w, i) {
      var p = pref[w.id] || {};
      return Object.assign(w, {
        rekkefolge: Number.isInteger(p.rekkefolge) ? p.rekkefolge : (i + 1) * 10,
        bredde: BREDDER.indexOf(p.bredde) >= 0 ? p.bredde : w.bredde,
        skjult: p.skjult === true,
        graf: p.graf || w.standardGraf,
        standardIndeks: i,
      });
    }).sort(function (a, b) { return a.rekkefolge - b.rekkefolge || a.standardIndeks - b.standardIndeks; });
  }

  /* ---------------------------------------------------------------- status */

  function byggStatus(d, vurd, n) {
    var k = K(), h = k.h, t = vurd.tell;
    var ring = k.C.statusring([
      { antall: t.paa, tone: 'ok' }, { antall: t.naer, tone: 'warn' }, { antall: t.ikke, tone: 'danger' }, { antall: t.ingen, tone: 'muted' },
    ], { tall: t.paa + t.naer + '/' + vurd.totalt, tekst: 'på eller nær mål' }, 120);
    var linjer = [[t.ikke, 'ikke på mål', 'danger'], [t.naer, 'nær mål', 'warn'], [t.paa, 'på mål', 'ok'], [t.ingen, 'uten data', 'muted']]
      .filter(function (x) { return x[0] || x[2] !== 'muted'; });
    return h('div', { class: 'kpi-status' }, [
      ring,
      h('div', { class: 'kpi-status-tekst' }, [
        h('div', { class: 'kpi-status-periode' }, 't.o.m. ' + k.L.mndNavn(n).toLowerCase() + ' ' + d.aar),
        h('ul', { class: 'kpi-status-liste' }, linjer.map(function (x) {
          return h('li', { class: 'kpi-status-' + x[2] }, [h('i', { class: 'kc-dot-ikon kc-bg-' + x[2], 'aria-hidden': 'true' }), h('b', null, String(x[0])), h('span', null, ' ' + x[1])]);
        })),
      ]),
    ]);
  }

  /* ---------------------------------------------------------------- krever oppfølging */

  function byggOppfolging(d, vurd, n) {
    var k = K(), h = k.h, L = k.L;
    var rode = vurd.fokus.slice().sort(function (a, b) { return avvik(b) - avvik(a); });
    if (!rode.length) {
      return h('div', { class: 'kpi-oppf-tom' }, [k.U.icon('badge-check', 22), h('div', null, [h('b', null, 'Ingen KPI-er under grensen'), h('div', { class: 'sak-muted sak-small' }, vurd.naer.length ? vurd.naer.length + ' KPI-er er nær mål – følg med på dem.' : 'Alle KPI-er er på mål.')])]);
    }
    var utenTiltak = rode.filter(function (r) { return !k.apneTiltak(k.kpiTiltak(r.id)).length; }).length;
    return h('div', { class: 'kpi-oppf' }, [
      h('div', { class: 'kpi-oppf-sammendrag' }, [
        h('span', { class: 'kpi-oppf-tall' }, String(rode.length)),
        h('span', null, rode.length === 1 ? ' KPI er ikke på mål' : ' KPI-er er ikke på mål'),
        utenTiltak ? h('span', { class: 'kpi-oppf-mangler' }, [k.U.icon('alert', 14), h('span', null, utenTiltak + ' uten tiltak')]) : h('span', { class: 'kpi-oppf-ok' }, 'alle har tiltak'),
      ]),
      h('ol', { class: 'kpi-oppf-liste' }, rode.map(function (r) {
        var aapne = k.apneTiltak(k.kpiTiltak(r.id)).length;
        return h('li', { class: 'kpi-oppf-rad' }, [
          h('div', { class: 'kpi-oppf-hoved' }, [
            h('button', { type: 'button', class: 'kpi-oppf-navn', on: { click: function () { aapneRad(r.id); } } }, r.def.navn),
            h('div', { class: 'kpi-oppf-meta' }, [
              h('span', { class: 'kpi-oppf-verdi' }, k.fmt(r.faktisk, r.def) + ' / ' + k.fmt(r.maal, r.def, true)),
              h('span', { class: 'kpi-oppf-avvik' }, avvikTekst(r)),
              h('span', { class: 'sak-muted' }, r.def.omrade),
            ]),
          ]),
          k.C.sparkline({ verdier: r.serie, valgt: n, type: r.def.aggregat === 'Snitt' ? 'linje' : 'stolpe', tone: 'danger', farget: true, bredde: 96, hoyde: 30, maal: r.aarsmaal === null ? null : (r.def.maaltype === 'HIA' ? r.aarsmaal / 12 : r.aarsmaal), label: 'Trend for ' + r.def.navn }),
          aapne ? h('span', { class: 'kpi-oppf-tiltak' }, aapne + (aapne === 1 ? ' tiltak' : ' tiltak'))
            : h('button', { type: 'button', class: 'kpi-oppf-lag', 'aria-label': 'Nytt tiltak for ' + r.def.navn, on: { click: function () { k.nyttTiltak(r.def, r); } } }, [k.U.icon('plus', 14), h('span', null, 'Tiltak')]),
        ]);
      })),
    ]);
  }

  /* ---------------------------------------------------------------- registrering */

  function byggRegistrering(d, vurd, n) {
    var k = K(), h = k.h, L = k.L;
    var ruter = L.MAANEDER.map(function (m, i) {
      var key = L.mndKey(i + 1);
      var antall = Object.keys((d.verdier && d.verdier[key]) || {}).filter(function (id) { return d.config.kpier[id] && d.config.kpier[id].aktiv !== false; }).length;
      var tilstand = antall >= vurd.totalt ? 'full' : antall ? 'delvis' : 'tom';
      return h('button', {
        type: 'button', class: 'kpi-mnd kpi-mnd-' + tilstand + (i + 1 === n ? ' is-valgt' : ''),
        title: m + ': ' + antall + ' av ' + vurd.totalt + ' registrert', 'aria-label': m + ', ' + antall + ' av ' + vurd.totalt + ' registrert',
        'aria-pressed': i + 1 === n ? 'true' : 'false',
        on: { click: function () { k.settMaaned(i + 1); } },
      }, m.charAt(0));
    });
    var reg = d.registrert && d.registrert[L.mndKey(n)];
    var mangler = L.manglerVerdi(d.config, d.verdier, n);
    return h('div', { class: 'kpi-reg-widget' }, [
      h('div', { class: 'kpi-mnd-rad' }, ruter),
      h('div', { class: 'kpi-reg-linje' }, reg
        ? [k.U.icon('check', 15), h('span', null, L.mndNavn(n) + ' registrert av ' + k.navnFraUid(reg.av).split(' ')[0] + ' · ' + k.datoTid(reg.at))]
        : [k.U.icon('clock', 15), h('span', null, L.mndNavn(n) + ' er ikke registrert')]),
      mangler.length && mangler.length < vurd.totalt ? h('div', { class: 'kpi-reg-mangler' }, 'Mangler ' + mangler.length + ': ' + mangler.map(function (x) { return x.navn; }).join(', ')) : null,
      d.kanRegistrere ? k.U.button(mangler.length ? 'Registrer ' + L.mndNavn(n).toLowerCase() : 'Endre ' + L.mndNavn(n).toLowerCase(), { small: true, icon: 'pencil', variant: mangler.length ? 'primary' : 'secondary', on: { click: function () { k.gaaTil('registrer'); } } }) : null,
    ]);
  }

  /* ---------------------------------------------------------------- nøkkeltall */

  function byggNokkeltall(vurd, n) {
    var k = K(), h = k.h;
    return h('div', { class: 'kpi-fliser' }, vurd.rader.map(function (r) {
      var tone = k.TONE[r.status];
      var andel = maaloppnaaelse(r);
      return h('button', {
        type: 'button', class: 'kpi-flis kpi-flis-' + tone,
        'aria-label': r.def.navn + ': ' + k.fmt(r.faktisk, r.def) + ', mål ' + k.fmt(r.maal, r.def, true) + ', ' + r.status,
        on: { click: function () { aapneRad(r.id); } },
      }, [
        h('span', { class: 'kpi-flis-topp' }, [h('span', { class: 'kpi-flis-omrade' }, r.def.omrade), h('span', { class: 'kpi-flis-merke kpi-merke-' + tone }, [k.U.icon(k.STATUS_IKON[r.status], 12), h('span', null, r.status)])]),
        h('span', { class: 'kpi-flis-navn' }, r.def.navn),
        h('span', { class: 'kpi-flis-verdi' }, [h('b', null, k.fmt(r.faktisk, r.def)), h('span', null, r.maal !== null ? ' / ' + k.fmt(r.maal, r.def, true) : '')]),
        h('span', { class: 'kpi-meter', 'aria-hidden': 'true' }, h('span', { class: 'kpi-meter-fyll kc-bg-' + tone, style: 'width:' + Math.round(andel * 100) + '%' })),
        k.C.sparklineFull({ verdier: r.serie, valgt: n, type: r.def.aggregat === 'Snitt' ? 'linje' : 'stolpe', tone: tone, farget: true, hoyde: 40, maal: r.aarsmaal === null ? null : (r.def.maaltype === 'HIA' ? r.aarsmaal / 12 : r.aarsmaal), label: 'Utvikling per måned for ' + r.def.navn }),
      ]);
    }));
  }

  /* ---------------------------------------------------------------- grafer */

  function byggGraf(d, gr, n, type) {
    var k = K();
    var en = gr.rader.length === 1 ? gr.rader[0] : null;
    var maal = en && en.aarsmaal !== null ? [{ navn: en.def.maaltype === 'HIA' ? 'Mål per måned' : 'Mål', verdi: en.def.maaltype === 'HIA' ? en.aarsmaal / 12 : en.aarsmaal }] : [];
    return k.C.maanedsgraf({
      type: type, valgt: n, fmt: k.chartFmt(gr.enhet), heltall: gr.enhet === 'Antall', hoyde: 200,
      tittel: en ? en.def.navn : gr.omrade + ' – ' + ENHET_TEKST[gr.enhet],
      serier: gr.rader.map(function (r, i) { return { navn: r.def.navn, verdier: r.serie, farge: i + 1 }; }),
      fjor: en ? { navn: String(d.aar - 1), verdier: en.fjorSerie } : null,
      maal: maal,
    });
  }

  /* ---------------------------------------------------------------- tabeller per område */

  function omradeTell(g) {
    var k = K(), h = k.h, tell = { ok: 0, warn: 0, danger: 0 };
    g.rader.forEach(function (r) { var t = k.TONE[r.status]; if (tell[t] !== undefined) tell[t]++; });
    return h('div', { class: 'kpi-panel-tell' }, [
      tell.danger ? k.tellChip('danger', tell.danger, 'ikke på mål') : null, tell.warn ? k.tellChip('warn', tell.warn, 'nær') : null, tell.ok ? k.tellChip('ok', tell.ok, 'på mål') : null,
    ]);
  }

  function aapneRad(id) {
    aapneRader[id] = true;
    K().render({ tvinges: true });
    var el = document.getElementById('kpi-rad-' + id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); }
  }

  function byggOmradeTabell(g, n, d) {
    var k = K(), h = k.h, L = k.L;
    var rader = [];
    g.rader.forEach(function (r) {
      var def = r.def, tone = k.TONE[r.status];
      var tiltak = k.kpiTiltak(r.id), aapne = k.apneTiltak(tiltak);
      var aapen = !!aapneRader[r.id];
      rader.push(h('tr', { class: 'kpi-rad kpi-rad-' + tone + (aapen ? ' is-aapen' : ''), id: 'kpi-rad-' + r.id, tabindex: '-1' }, [
        h('th', { scope: 'row' }, h('button', { type: 'button', class: 'kpi-rad-knapp', 'aria-expanded': aapen ? 'true' : 'false', on: { click: function () { aapneRader[r.id] = !aapen; k.render({ tvinges: true }); } } }, [
          k.U.icon('chevron-right', 16), h('span', null, def.navn),
        ])),
        h('td', { class: 'kpi-num kpi-kol-mnd', 'data-label': L.mndNavn(n) }, k.fmt(r.periode, def)),
        h('td', { class: 'kpi-num kpi-num-sterk', 'data-label': 'Hittil i år' }, k.fmt(r.faktisk, def)),
        h('td', { class: 'kpi-num', 'data-label': 'Mål' }, k.fmt(r.maal, def, true)),
        h('td', { class: 'kpi-num kpi-kol-fjor', 'data-label': 'I fjor' }, k.fmt(r.fjorHia, def)),
        h('td', { 'data-label': 'Status' }, k.statusChip(r.status)),
        h('td', { class: 'kpi-kol-trend', 'data-label': 'Trend' }, k.C.sparkline({ verdier: r.serie, valgt: n, type: def.aggregat === 'Snitt' ? 'linje' : 'stolpe', tone: tone, label: 'Trend for ' + def.navn })),
        h('td', { class: 'kpi-kol-tiltak', 'data-label': 'Tiltak' }, aapne.length
          ? h('span', { class: 'kpi-tiltak-antall' }, aapne.length + ' åpne')
          : h('span', { class: tone === 'danger' ? 'kpi-tiltak-mangler' : 'sak-muted' }, tone === 'danger' ? 'Mangler' : '–')),
      ]));
      if (aapen) rader.push(h('tr', { class: 'kpi-detalj-rad' }, h('td', { colspan: '8' }, byggDetalj(r, n, d, tiltak))));
    });
    return h('div', { class: 'kpi-tabell-wrap' }, h('table', { class: 'kpi-tabell' }, [
      h('thead', null, h('tr', null, [
        h('th', { scope: 'col' }, 'KPI'), h('th', { scope: 'col', class: 'kpi-num kpi-kol-mnd' }, L.mndNavn(n)), h('th', { scope: 'col', class: 'kpi-num' }, 'Hittil i år'),
        h('th', { scope: 'col', class: 'kpi-num' }, 'Mål'), h('th', { scope: 'col', class: 'kpi-num kpi-kol-fjor' }, 'I fjor'), h('th', { scope: 'col' }, 'Status'),
        h('th', { scope: 'col', class: 'kpi-kol-trend' }, 'Trend'), h('th', { scope: 'col', class: 'kpi-kol-tiltak' }, 'Tiltak'),
      ])),
      h('tbody', null, rader),
    ]));
  }

  function byggDetalj(r, n, d, tiltak) {
    var k = K(), h = k.h, L = k.L, def = r.def;
    var maalMnd = r.aarsmaal === null ? null : def.maaltype === 'HIA' ? r.aarsmaal / 12 : r.aarsmaal;
    var fakta = [
      ['Hittil i år', k.fmt(r.faktisk, def)], ['Mål hittil i år', k.fmt(r.maal, def, true)], ['Årsmål', k.fmt(r.aarsmaal, def)],
      def.aggregat === 'Sum' && def.retning === 'Opp' ? ['Gjenstår av årsmål', L.erTall(r.rest) ? k.fmt(Math.max(r.rest, 0), def, true) : '–'] : null,
      ['I fjor samme periode', k.fmt(r.fjorHia, def)], ['Retning', def.retning === 'Ned' ? 'Lavere er bedre' : 'Høyere er bedre'],
      ['Grense «nær mål»', '±' + L.fmtTall(r.grense, 0) + ' %'],
    ].filter(Boolean);
    return h('div', { class: 'kpi-detalj' }, [
      h('div', { class: 'kpi-detalj-graf' }, k.C.maanedsgraf({
        type: def.aggregat === 'Snitt' ? 'linje' : 'stolpe', valgt: n, fmt: k.chartFmt(def.enhet), hoyde: 210, heltall: def.enhet === 'Antall', tittel: def.navn,
        serier: [{ navn: String(d.aar), verdier: r.serie, farge: 1 }],
        fjor: { navn: String(d.aar - 1), verdier: r.fjorSerie },
        maal: maalMnd !== null ? [{ navn: def.maaltype === 'HIA' ? 'Mål per måned' : 'Mål', verdi: maalMnd }] : [],
      })),
      h('div', { class: 'kpi-detalj-side' }, [
        h('dl', { class: 'kpi-fakta' }, fakta.map(function (f) { return h('div', null, [h('dt', null, f[0]), h('dd', null, f[1])]); })),
        h('div', { class: 'kpi-detalj-tiltak' }, [
          h('div', { class: 'kpi-etikett' }, 'Tiltak'),
          tiltak.length ? h('div', { class: 'kpi-tiltak' }, tiltak.slice(0, 6).map(function (t) {
            var lukket = k.TERMINAL.indexOf(t.status) >= 0;
            var forsinket = !lukket && t.frist && t.frist < k.idagIso();
            return h('button', { type: 'button', class: 'kpi-tiltak-rad' + (forsinket ? ' is-forsinket' : '') + (lukket ? ' is-lukket' : ''), on: { click: function () { k.host().openTiltak(t.fbKey); } } }, [
              h('span', { class: 'kpi-tiltak-tittel' }, t.tittel || 'Uten tittel'),
              h('span', { class: 'sak-small sak-muted' }, [t.status || '', t.eier ? ' · ' + t.eier : '', t.frist && !lukket ? ' · ' + (forsinket ? 'forfalt ' : 'frist ') + k.U.fmtDato(t.frist, k.idagIso()) : ''].join('')),
            ]);
          })) : h('p', { class: 'sak-muted sak-small' }, 'Ingen tiltak koblet til denne KPI-en.'),
          k.U.button('Nytt tiltak', { small: true, icon: 'plus', variant: 'primary', ariaLabel: 'Nytt tiltak for ' + def.navn, on: { click: function () { k.nyttTiltak(def, r); } } }),
        ]),
      ]),
    ]);
  }

  /* ================================================================== tilpasning */

  function endreWidget(id, endring) {
    K().endrePrefs(function (p) {
      p.widgets = p.widgets || {};
      p.widgets[id] = Object.assign({}, p.widgets[id] || {}, endring);
    });
  }

  /** Lagrer gjeldende rekkefølge (alle bokser får fast plass, så rekkefølgen er entydig). */
  function lagreRekkefolge(ider) {
    K().endrePrefs(function (p) {
      p.widgets = p.widgets || {};
      ider.forEach(function (id, i) { p.widgets[id] = Object.assign({}, p.widgets[id] || {}, { rekkefolge: (i + 1) * 10 }); });
    });
  }

  function flytt(liste, id, retning) {
    var ider = liste.map(function (w) { return w.id; });
    var i = ider.indexOf(id), j = i + retning;
    if (i < 0 || j < 0 || j >= ider.length) return;
    ider.splice(i, 1); ider.splice(j, 0, id);
    lagreRekkefolge(ider);
  }

  var TEMAER = [
    { id: 'gronn', navn: 'Nortura grønn', farger: ['#173a1c', '#6f7f2a'] },
    { id: 'bla', navn: 'Blå', farger: ['#0c2638', '#317ee8'] },
    { id: 'grafitt', navn: 'Grafitt', farger: ['#273444', '#64748b'] },
    { id: 'lilla', navn: 'Lilla', farger: ['#2b2554', '#7563e9'] },
    { id: 'natt', navn: 'Natt', farger: ['#0b0f14', '#14b8a6'] },
  ];

  function byggVerktoy(liste) {
    var k = K(), h = k.h, p = k.prefs();
    var skjulte = liste.filter(function (w) { return w.skjult; });
    var tema = p.tema || 'gronn', tetthet = p.tetthet || 'normal';
    return h('section', { class: 'kpi-tilpass', 'aria-label': 'Tilpass oversikten' }, [
      h('div', { class: 'kpi-tilpass-rad' }, [
        h('div', { class: 'kpi-tilpass-gruppe' }, [
          h('span', { class: 'kpi-etikett' }, 'Fargetema'),
          h('div', { class: 'kpi-tema-valg', role: 'radiogroup', 'aria-label': 'Fargetema' }, TEMAER.map(function (t) {
            return h('button', {
              type: 'button', role: 'radio', 'aria-checked': t.id === tema ? 'true' : 'false', class: 'kpi-tema' + (t.id === tema ? ' is-valgt' : ''), title: t.navn, 'aria-label': t.navn,
              style: 'background:linear-gradient(135deg,' + t.farger[0] + ' 0 55%,' + t.farger[1] + ' 55% 100%)',
              on: { click: function () { k.endrePrefs(function (pp) { pp.tema = t.id; }); } },
            });
          })),
        ]),
        h('div', { class: 'kpi-tilpass-gruppe' }, [
          h('span', { class: 'kpi-etikett' }, 'Tetthet'),
          h('div', { class: 'kpi-segment', role: 'radiogroup', 'aria-label': 'Tetthet' }, [['kompakt', 'Kompakt'], ['normal', 'Normal'], ['luftig', 'Luftig']].map(function (x) {
            return h('button', { type: 'button', role: 'radio', 'aria-checked': x[0] === tetthet ? 'true' : 'false', class: x[0] === tetthet ? 'is-valgt' : '', on: { click: function () { k.endrePrefs(function (pp) { pp.tetthet = x[0]; }); } } }, x[1]);
          })),
        ]),
        h('span', { class: 'kpi-spacer' }),
        h('span', { class: 'kpi-lagret sak-small', role: 'status' }, k.prefsStatus()),
        k.U.button('Tilbakestill', { small: true, variant: 'ghost', icon: 'refresh', on: { click: function () { k.endrePrefs(function (pp) { delete pp.widgets; delete pp.tema; delete pp.tetthet; }); } } }),
        k.U.button('Ferdig', { small: true, variant: 'primary', icon: 'check', on: { click: function () { redigerer = false; k.render({ tvinges: true }); } } }),
      ]),
      h('p', { class: 'kpi-tilpass-hjelp sak-small' }, 'Dra en boks i håndtaket for å flytte den, og dra i høyre kant for å endre bredden. Graftype, bredde og skjul finner du i hodet på hver boks. Oppsettet lagres for deg.'),
      skjulte.length ? h('div', { class: 'kpi-skjulte' }, [h('span', { class: 'kpi-etikett' }, 'Skjulte bokser')].concat(skjulte.map(function (w) {
        return k.U.button(w.tittel, { small: true, icon: 'plus', variant: 'secondary', ariaLabel: 'Vis ' + w.tittel, on: { click: function () { endreWidget(w.id, { skjult: false }); } } });
      }))) : null,
    ]);
  }

  /* ---------------------------------------------------------------- én boks */

  function byggWidget(w, liste) {
    var k = K(), h = k.h;
    var mdBredde = w.bredde >= 6 ? 12 : 6;
    var verktoy = null;
    if (redigerer) {
      var bredde = k.select(BREDDER.map(function (b) { return { value: b, label: BREDDE_NAVN[b] + ' bredde' }; }), w.bredde, { 'aria-label': 'Bredde for ' + w.tittel, class: 'kpi-w-valg' });
      bredde.addEventListener('change', function () { endreWidget(w.id, { bredde: Number(bredde.value) }); });
      var graf = null;
      if (w.type === 'graf') {
        graf = k.select(Object.keys(GRAF_NAVN).map(function (g) { return { value: g, label: GRAF_NAVN[g] }; }), w.graf, { 'aria-label': 'Graftype for ' + w.tittel, class: 'kpi-w-valg' });
        graf.addEventListener('change', function () { endreWidget(w.id, { graf: graf.value }); });
      }
      verktoy = h('div', { class: 'kpi-w-verktoy' }, [
        graf, bredde,
        k.U.button('', { small: true, variant: 'ghost', icon: 'chevron-left', ariaLabel: 'Flytt ' + w.tittel + ' bakover', title: 'Flytt bakover', on: { click: function () { flytt(liste, w.id, -1); } } }),
        k.U.button('', { small: true, variant: 'ghost', icon: 'chevron-right', ariaLabel: 'Flytt ' + w.tittel + ' fremover', title: 'Flytt fremover', on: { click: function () { flytt(liste, w.id, 1); } } }),
        k.U.button('', { small: true, variant: 'ghost', icon: 'x', ariaLabel: 'Skjul ' + w.tittel, title: 'Skjul boksen', on: { click: function () { endreWidget(w.id, { skjult: true }); } } }),
      ]);
    }
    var hode = h('header', { class: 'kpi-w-hode' }, [
      redigerer ? h('span', { class: 'kpi-w-handtak', title: 'Dra for å flytte', 'aria-hidden': 'true' }, '⠿') : null,
      h('div', { class: 'kpi-w-titler' }, [h('h2', null, w.tittel), w.under ? h('div', { class: 'kpi-w-under' }, w.under) : null]),
      w.hode ? w.hode() : null,
      verktoy,
    ]);
    var el = h('section', {
      class: 'kpi-w kpi-w-' + (w.type || w.id) + (w.rod ? ' is-rod' : '') + (redigerer ? ' is-redigerer' : ''),
      'data-widget': w.id, 'aria-label': w.tittel,
      style: '--b:' + w.bredde + ';--b-md:' + mdBredde,
    }, [hode, h('div', { class: 'kpi-w-innhold' }, w.bygg(w))]);

    if (redigerer) {
      el.appendChild(h('div', { class: 'kpi-w-storrelse', title: 'Dra for å endre bredde', 'aria-hidden': 'true' }));
      kobleDra(el, w, liste);
      kobleStorrelse(el, w);
    }
    return el;
  }

  /* ---------------------------------------------------------------- dra og slipp */

  var draId = null;
  function kobleDra(el, w, liste) {
    var handtak = el.querySelector('.kpi-w-hode');
    handtak.setAttribute('draggable', 'true');
    handtak.addEventListener('dragstart', function (e) {
      draId = w.id; el.classList.add('is-dras');
      try { e.dataTransfer.setData('text/plain', w.id); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* */ }
    });
    handtak.addEventListener('dragend', function () { draId = null; el.classList.remove('is-dras'); Array.prototype.forEach.call(document.querySelectorAll('.kpi-w.is-mal-for, .kpi-w.is-mal-etter'), function (x) { x.classList.remove('is-mal-for', 'is-mal-etter'); }); });
    el.addEventListener('dragover', function (e) {
      if (!draId || draId === w.id) return;
      e.preventDefault();
      var r = el.getBoundingClientRect();
      var etter = (e.clientX - r.left) > r.width / 2;
      el.classList.toggle('is-mal-etter', etter); el.classList.toggle('is-mal-for', !etter);
    });
    el.addEventListener('dragleave', function () { el.classList.remove('is-mal-for', 'is-mal-etter'); });
    el.addEventListener('drop', function (e) {
      if (!draId || draId === w.id) return;
      e.preventDefault();
      var r = el.getBoundingClientRect();
      var etter = (e.clientX - r.left) > r.width / 2;
      var ider = liste.map(function (x) { return x.id; }).filter(function (id) { return id !== draId; });
      var i = ider.indexOf(w.id) + (etter ? 1 : 0);
      ider.splice(i, 0, draId);
      draId = null;
      lagreRekkefolge(ider);
    });
  }

  function kobleStorrelse(el, w) {
    var grep = el.querySelector('.kpi-w-storrelse');
    grep.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var dash = el.parentElement;
      var stil = getComputedStyle(dash);
      var gap = parseFloat(stil.columnGap) || 14;
      var kol = (dash.clientWidth - 11 * gap) / 12;
      var venstre = el.getBoundingClientRect().left;
      var ny = w.bredde;
      grep.setPointerCapture(e.pointerId);
      el.classList.add('is-endrer');
      function flytte(ev) {
        ny = naermesteBredde(Math.round((ev.clientX - venstre + gap) / (kol + gap)));
        el.style.setProperty('--b', ny);
        el.dataset.bredde = BREDDE_NAVN[ny];
      }
      function slipp() {
        grep.removeEventListener('pointermove', flytte);
        grep.removeEventListener('pointerup', slipp);
        el.classList.remove('is-endrer');
        if (ny !== w.bredde) endreWidget(w.id, { bredde: ny });
      }
      grep.addEventListener('pointermove', flytte);
      grep.addEventListener('pointerup', slipp);
    });
  }

  /* ================================================================== hele oversikten */

  function bygg(d) {
    var k = K(), h = k.h, L = k.L;
    var n = k.state().maaned;
    var vurd = L.vurderAar(d.config, d.verdier, d.fjorVerdier, n);
    var liste = widgets(d, vurd, n);
    var synlige = liste.filter(function (w) { return !w.skjult; });
    var mangler = L.manglerVerdi(d.config, d.verdier, n);
    var varsel = null;
    if (d.kanRegistrere && mangler.length && !redigerer) {
      var alle = mangler.length === vurd.totalt;
      varsel = h('div', { class: 'sak-alert sak-tone-' + (alle ? 'info' : 'warn') + ' kpi-varsel', role: 'status' }, [
        k.U.icon(alle ? 'info' : 'alert', 16),
        h('span', null, alle ? 'Ingen verdier registrert for ' + L.mndNavn(n).toLowerCase() + ' ennå.'
          : L.mndNavn(n) + ' mangler ' + mangler.length + ' av ' + vurd.totalt + ' verdier: ' + mangler.map(function (x) { return x.navn; }).join(', ') + '.'),
        k.U.button(alle ? 'Registrer nå' : 'Registrer', { small: true, variant: alle ? 'primary' : undefined, on: { click: function () { k.gaaTil('registrer'); } } }),
      ]);
    }
    return [
      redigerer ? byggVerktoy(liste) : null,
      varsel,
      h('div', { class: 'kpi-dash' + (redigerer ? ' is-redigerer' : '') }, synlige.map(function (w) { return byggWidget(w, liste); })),
    ];
  }

  function tilpassKnapp() {
    var k = K();
    return k.U.button(redigerer ? 'Ferdig' : 'Tilpass oversikt', {
      small: true, icon: redigerer ? 'check' : 'pencil', variant: redigerer ? 'primary' : 'secondary', class: 'kpi-tilpass-knapp',
      on: { click: function () { redigerer = !redigerer; k.render({ tvinges: true }); } },
    });
  }

  root.OpExKpiOversikt = Object.freeze({
    bygg: bygg, tilpassKnapp: tilpassKnapp, aapneRad: aapneRad,
    erRedigering: function () { return redigerer; }, avsluttRedigering: function () { redigerer = false; },
    _intern: { standardWidgets: standardWidgets, widgets: widgets, grafGrupper: grafGrupper, avvik: avvik },
  });
}(typeof self !== 'undefined' ? self : this));
