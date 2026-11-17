/*
 * kpi-oppsett.js — oppsett av KPI-ene for et år (bare registratorer).
 *
 * Faner: KPI-er (gruppert per område med farger; hver KPI er en sammendragsrad som kan foldes ut for redigering),
 * Felles (grense for «nær mål»), Nytt år og Import fra Excel. Lagrelinjen ligger fast nederst og viser ulagrede endringer.
 * Avhenger av kjernen i kpi-app.js (window.OpExKpiKjerne).
 */
(function (root) {
  'use strict';

  var K = function () { return root.OpExKpiKjerne; };
  var OMRADE_FARGER = ['#eb6834', '#2a78d6', '#1baf7a', '#6250d6', '#e87ba4', '#eda100'];
  var utkast = null;      // { aar, basis, naerMaalProsent, kpier: [def med id], endret }
  var fane = null;        // fanen brukeren har valgt: 'kpier' | 'aar' | 'import' (null = standard)
  var aapne = {};         // KPI-indeks (nøkkel) som er foldet ut

  function nokkel(def, i) { return def.id || 'ny-' + i; }

  function start(d) {
    var L = K().L;
    var cfg = d.config || { naerMaalProsent: L.STANDARD_GRENSE, kpier: {} };
    utkast = {
      aar: d.aar, basis: (d.config && d.config.oppdatertAt) || '', endret: false,
      naerMaalProsent: L.erTall(cfg.naerMaalProsent) ? cfg.naerMaalProsent : L.STANDARD_GRENSE,
      kpier: Object.keys(cfg.kpier || {}).map(function (id) { return Object.assign({ id: id }, cfg.kpier[id]); })
        .sort(function (a, b) { return (a.sortering || 0) - (b.sortering || 0); }),
    };
    aapne = {};
  }

  function tallTekst(v) { return K().L.erTall(v) ? String(v).replace('.', ',') : ''; }

  /** Segmentert valg (radioknapper som ser ut som knapper). */
  function segment(navn, valg, verdi, onChange) {
    var h = K().h;
    var gruppe = h('div', { class: 'kpi-segment', role: 'radiogroup', 'aria-label': navn });
    valg.forEach(function (v) {
      var b = h('button', { type: 'button', role: 'radio', 'aria-checked': v.value === verdi ? 'true' : 'false', class: v.value === verdi ? 'is-valgt' : '', title: v.hjelp || '' }, v.label);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(gruppe.children, function (x) { x.classList.remove('is-valgt'); x.setAttribute('aria-checked', 'false'); });
        b.classList.add('is-valgt'); b.setAttribute('aria-checked', 'true');
        onChange(v.value);
      });
      gruppe.appendChild(b);
    });
    return gruppe;
  }

  function merkEndret() { if (utkast) utkast.endret = true; var bar = document.querySelector('.kpi-oppsett-lagrelinje'); if (bar) bar.classList.add('is-endret'); var t = document.querySelector('.kpi-oppsett-status'); if (t) t.textContent = 'Ulagrede endringer'; }

  /* ---------------------------------------------------------------- KPI-er */

  function sammendrag(def) {
    var k = K(), h = k.h, L = k.L;
    var biter = [
      h('span', { class: 'kpi-enhet-merke' }, def.enhet || 'Antall'),
      h('span', { class: 'kpi-oppsett-chip' }, [h('small', null, 'Mål'), h('b', null, L.erTall(def.maal) ? L.fmtVerdi(def.maal, def.enhet) : '–'), h('small', null, def.maaltype === 'Fast' ? 'fast' : 'per år')]),
      h('span', { class: 'kpi-oppsett-chip kpi-retning-' + (def.retning === 'Ned' ? 'ned' : 'opp') }, def.retning === 'Ned' ? '↓ Lavere er bedre' : '↑ Høyere er bedre'),
      h('span', { class: 'kpi-oppsett-chip' }, def.aggregat === 'Snitt' ? 'Snitt hittil i år' : 'Sum hittil i år'),
      L.erTall(def.naerMaalProsent) ? h('span', { class: 'kpi-oppsett-chip' }, 'Grense ±' + L.fmtTall(def.naerMaalProsent, 0) + ' %') : null,
    ];
    return h('div', { class: 'kpi-oppsett-sammendrag' }, biter);
  }

  function redigeringsPanel(def, d, omrader) {
    var k = K(), h = k.h, L = k.L;
    function inp(felt, type, attrs) {
      var e = h('input', Object.assign({ type: 'text', inputmode: type === 'tall' ? 'decimal' : undefined, value: type === 'tall' ? tallTekst(def[felt]) : (def[felt] || '') }, attrs || {}));
      e.addEventListener('input', function () { def[felt] = type === 'tall' ? L.parseTall(e.value) : e.value; merkEndret(); });
      return e;
    }
    var omrade = k.select(omrader, def.omrade);
    omrade.addEventListener('change', function () { def.omrade = omrade.value; merkEndret(); k.render({ tvinges: true }); });
    var enhet = k.select(L.ENHETER, def.enhet);
    enhet.addEventListener('change', function () { def.enhet = enhet.value; merkEndret(); });
    return h('div', { class: 'kpi-oppsett-panel' }, [
      h('div', { class: 'kpi-oppsett-grid' }, [
        k.felt('Navn', inp('navn', null, { 'data-autofocus': true })),
        k.felt('Område', omrade),
        k.felt('Enhet', enhet),
        k.felt('Mål ' + d.aar, inp('maal', 'tall')),
        k.felt('Oppnådd i fjor', inp('fjorResultat', 'tall')),
        k.felt('Grense «nær mål» %', inp('naerMaalProsent', 'tall'), 'Tom = felles grense'),
      ]),
      h('div', { class: 'kpi-oppsett-valg' }, [
        h('div', { class: 'kpi-oppsett-valggruppe' }, [h('span', { class: 'kpi-etikett' }, 'Retning'), segment('Retning', [{ value: 'Opp', label: '↑ Høyere er bedre' }, { value: 'Ned', label: '↓ Lavere er bedre' }], def.retning || 'Opp', function (v) { def.retning = v; merkEndret(); })]),
        h('div', { class: 'kpi-oppsett-valggruppe' }, [h('span', { class: 'kpi-etikett' }, 'Beregning hittil i år'), segment('Beregning', [{ value: 'Sum', label: 'Sum' }, { value: 'Snitt', label: 'Snitt' }], def.aggregat || 'Sum', function (v) { def.aggregat = v; merkEndret(); })]),
        h('div', { class: 'kpi-oppsett-valggruppe' }, [h('span', { class: 'kpi-etikett' }, 'Måltype'), segment('Måltype', [{ value: 'HIA', label: 'Årsmål', hjelp: 'Fordeles per måned (årsmål / 12 × måned)' }, { value: 'Fast', label: 'Fast nivå', hjelp: 'Samme mål hele året' }], def.maaltype || 'HIA', function (v) { def.maaltype = v; merkEndret(); })]),
      ]),
    ]);
  }

  function byggKpier(d) {
    var k = K(), h = k.h, L = k.L, U = k.U, u = utkast;
    var brukte = {};
    Object.keys(d.verdier || {}).forEach(function (m) { Object.keys(d.verdier[m] || {}).forEach(function (id) { brukte[id] = true; }); });
    var omrader = L.OMRAADER.slice();
    u.kpier.forEach(function (x) { if (x.omrade && omrader.indexOf(x.omrade) < 0) omrader.push(x.omrade); });
    var brukteOmrader = [];
    u.kpier.forEach(function (x) { if (brukteOmrader.indexOf(x.omrade) < 0) brukteOmrader.push(x.omrade); });

    function flytt(i, dir) {
      var j = i + dir; if (j < 0 || j >= u.kpier.length) return;
      var t = u.kpier[i]; u.kpier[i] = u.kpier[j]; u.kpier[j] = t; merkEndret(); k.render({ tvinges: true });
    }

    var grense = h('input', { type: 'text', inputmode: 'decimal', value: tallTekst(u.naerMaalProsent), class: 'kpi-grense-input', id: 'kpi-grense-felles' });
    grense.addEventListener('input', function () { u.naerMaalProsent = L.parseTall(grense.value); merkEndret(); });

    var seksjoner = brukteOmrader.map(function (omrade, oi) {
      var farge = OMRADE_FARGER[oi % OMRADE_FARGER.length];
      var rader = [];
      u.kpier.forEach(function (def, i) {
        if (def.omrade !== omrade) return;
        var key = nokkel(def, i), aapen = !!aapne[key];
        var aktiv = h('input', { type: 'checkbox', checked: def.aktiv !== false, 'aria-label': 'Aktiv: ' + (def.navn || 'ny KPI') });
        aktiv.addEventListener('change', function () { def.aktiv = aktiv.checked; merkEndret(); k.render({ tvinges: true }); });
        rader.push(h('div', { class: 'kpi-oppsett-kpi' + (def.aktiv === false ? ' is-inaktiv' : '') + (aapen ? ' is-aapen' : '') }, [
          h('div', { class: 'kpi-oppsett-rad' }, [
            h('button', { type: 'button', class: 'kpi-oppsett-utvid', 'aria-expanded': aapen ? 'true' : 'false', on: { click: function () { aapne[key] = !aapen; k.render({ tvinges: true }); } } }, [
              U.icon('chevron-right', 16), h('span', { class: 'kpi-oppsett-navn' }, def.navn || 'Ny KPI'),
            ]),
            sammendrag(def),
            h('div', { class: 'kpi-oppsett-radverktoy' }, [
              h('label', { class: 'kpi-bryter', title: 'Aktiv' }, [aktiv, h('span', { class: 'kpi-bryter-spor', 'aria-hidden': 'true' }), h('span', { class: 'kpi-bryter-tekst' }, def.aktiv === false ? 'Inaktiv' : 'Aktiv')]),
              U.button('', { small: true, variant: 'ghost', icon: 'chevron-left', class: 'kpi-opp', ariaLabel: 'Flytt ' + (def.navn || 'KPI') + ' opp', title: 'Flytt opp', disabled: i === 0, on: { click: function () { flytt(i, -1); } } }),
              U.button('', { small: true, variant: 'ghost', icon: 'chevron-right', class: 'kpi-ned', ariaLabel: 'Flytt ' + (def.navn || 'KPI') + ' ned', title: 'Flytt ned', disabled: i === u.kpier.length - 1, on: { click: function () { flytt(i, 1); } } }),
              brukte[def.id] ? null : U.button('', { small: true, variant: 'ghost', icon: 'x', ariaLabel: 'Fjern ' + (def.navn || 'KPI'), title: 'Fjern', on: { click: function () { u.kpier.splice(i, 1); merkEndret(); k.render({ tvinges: true }); } } }),
            ]),
          ]),
          aapen ? redigeringsPanel(def, d, omrader) : null,
        ]));
      });
      return h('section', { class: 'kpi-oppsett-omrade', style: '--omr:' + farge }, [
        h('header', { class: 'kpi-oppsett-omrade-hode' }, [
          h('h2', null, omrade),
          h('span', { class: 'kpi-regs-antall' }, rader.length + (rader.length === 1 ? ' KPI' : ' KPI-er')),
          h('span', { class: 'kpi-spacer' }),
          U.button('Ny KPI i ' + omrade, { small: true, variant: 'ghost', icon: 'plus', on: { click: function () { leggTil(omrade); } } }),
        ]),
        h('div', { class: 'kpi-oppsett-rader' }, rader),
      ]);
    });

    function leggTil(omrade) {
      u.kpier.push({ id: '', navn: '', omrade: omrade || 'HMS', enhet: 'Antall', retning: 'Opp', aggregat: 'Sum', maaltype: 'HIA', maal: null, aktiv: true });
      aapne[nokkel(u.kpier[u.kpier.length - 1], u.kpier.length - 1)] = true;
      merkEndret(); k.render({ tvinges: true });
    }

    return [
      h('section', { class: 'kpi-oppsett-felles' }, [
        h('div', null, [h('h2', null, 'Felles for ' + d.aar), h('p', { class: 'sak-muted sak-small' }, 'Opp: «nær mål» når resultatet er inntil så mange prosent under målet. Ned: inntil så mange prosent over. Gjelder alle KPI-er uten egen grense.')]),
        h('div', { class: 'sak-field kpi-grense-felt' }, [h('label', { for: 'kpi-grense-felles' }, 'Grense for «nær mål» (%)'), h('div', { class: 'kpi-grense-wrap' }, [grense, h('span', null, '%')])]),
      ]),
    ].concat(seksjoner).concat([
      h('div', { class: 'kpi-oppsett-ny' }, [U.button('Legg til KPI', { icon: 'plus', variant: 'secondary', on: { click: function () { leggTil(brukteOmrader[0]); } } })]),
    ]);
  }

  function configFraUtkast(u) {
    var L = K().L, I = K().I;
    var g = u.naerMaalProsent;
    if (typeof g === 'number' && (isNaN(g) || g < 0 || g > 100)) throw new Error('Grensen for «nær mål» må være et tall mellom 0 og 100.');
    if (!u.kpier.length) throw new Error('Oppsettet må ha minst én KPI.');
    var kpier = {}, brukt = {};
    u.kpier.forEach(function (x, i) {
      var navn = String(x.navn || '').trim();
      if (!navn) throw new Error('KPI nummer ' + (i + 1) + ' mangler navn.');
      ['maal', 'fjorResultat', 'naerMaalProsent'].forEach(function (f) { if (typeof x[f] === 'number' && isNaN(x[f])) throw new Error('Ugyldig tall i «' + navn + '».'); });
      var id = x.id || I.slug(navn);
      while (brukt[id] || (!x.id && u.kpier.some(function (y) { return y !== x && y.id === id; }))) id = (id + '-2').slice(0, 40);
      brukt[id] = true; x.id = id;
      kpier[id] = {
        navn: navn, omrade: x.omrade || 'Annet', enhet: x.enhet || 'Antall', retning: x.retning || 'Opp', aggregat: x.aggregat || 'Sum',
        maaltype: x.maaltype || 'HIA', maal: L.erTall(x.maal) ? x.maal : null, fjorResultat: L.erTall(x.fjorResultat) ? x.fjorResultat : null,
        naerMaalProsent: L.erTall(x.naerMaalProsent) ? x.naerMaalProsent : null, sortering: (i + 1) * 10, aktiv: x.aktiv !== false,
      };
    });
    return { naerMaalProsent: L.erTall(g) ? g : L.STANDARD_GRENSE, kpier: kpier };
  }

  /* ---------------------------------------------------------------- nytt år */

  function byggNyttAar(d) {
    var k = K(), h = k.h, U = k.U, L = k.L;
    var nyttAar = d.aar + 1, harNytt = (d.aarListe || []).indexOf(nyttAar) >= 0;
    return [h('section', { class: 'kpi-oppsett-kort' }, [
      h('h2', null, 'Nytt år'),
      h('p', { class: 'sak-muted' }, harNytt
        ? 'Oppsett for ' + nyttAar + ' finnes allerede. Velg året øverst for å endre det.'
        : 'Lag oppsett for ' + nyttAar + ' med de samme KPI-ene. Årets resultat (hittil i år) blir «oppnådd i fjor». Målene kan justeres etterpå.'),
      harNytt || !d.config ? null : U.button('Lag oppsett for ' + nyttAar, { icon: 'plus', variant: 'primary', on: { click: function () {
        var vurd = L.vurderAar(d.config, d.verdier, d.fjorVerdier, 12);
        var resultat = {}; vurd.rader.forEach(function (r) { resultat[r.id] = r.faktisk; });
        var kpier = {};
        Object.keys(d.config.kpier).forEach(function (id) {
          var x = Object.assign({}, d.config.kpier[id]);
          x.fjorResultat = L.erTall(resultat[id]) ? Math.round(resultat[id] * 1000) / 1000 : null;
          kpier[id] = x;
        });
        k.F.openDialog({
          title: 'Lag oppsett for ' + nyttAar, submitLabel: 'Lag oppsett',
          body: h('p', null, 'Kopierer ' + Object.keys(kpier).length + ' KPI-er med dagens mål til ' + nyttAar + '. Du kan endre mål, grenser og KPI-er etterpå.'),
          onSubmit: async function () {
            await k.call('saveKpiConfigV1', { aar: nyttAar, config: { naerMaalProsent: d.config.naerMaalProsent, kpier: kpier } });
            k.host().toast('Oppsett for ' + nyttAar + ' er laget ✓');
            utkast = null;
            await k.last(nyttAar);
          },
        });
      } } }),
    ])];
  }

  /* ---------------------------------------------------------------- import */

  function byggImport(d) {
    var k = K(), h = k.h;
    var fil = h('input', { type: 'file', accept: '.xlsx,.xlsm', class: 'kpi-fil' });
    var resultat = h('div', { class: 'kpi-import-resultat' });
    fil.addEventListener('change', function () {
      resultat.textContent = '';
      var f = fil.files && fil.files[0];
      if (!f) return;
      if (!root.XLSX) { resultat.appendChild(h('div', { class: 'sak-alert sak-tone-danger' }, 'Excel-leseren er ikke lastet. Sjekk nettforbindelsen og last siden på nytt.')); return; }
      f.arrayBuffer().then(function (buf) {
        visImportForslag(resultat, k.I.lesSheetJs(root.XLSX.read(buf, { type: 'array' })), d);
      }).catch(function (err) {
        resultat.appendChild(h('div', { class: 'sak-alert sak-tone-danger', role: 'alert' }, 'Kunne ikke lese filen: ' + (err.message || err)));
      });
    });
    return [h('section', { class: 'kpi-oppsett-kort kpi-import' }, [
      h('h2', null, 'Importer fra Excel'),
      h('p', { class: 'sak-muted' }, 'Les inn KPI-arket fra Excel (samme oppsett som «KPI 2026 Renhold»): KPI-er, mål, månedsverdier og fjorårets tall. Ingenting lagres før du bekrefter.'),
      k.felt('Velg Excel-fil', fil),
      resultat,
    ])];
  }

  function visImportForslag(boks, lest, d) {
    var k = K(), h = k.h, L = k.L, U = k.U;
    var antKpi = Object.keys(lest.config.kpier).length;
    var antVerdier = Object.keys(lest.verdier).reduce(function (s, m) { return s + Object.keys(lest.verdier[m]).length; }, 0);
    var antFjor = Object.keys(lest.fjorVerdier).reduce(function (s, m) { return s + Object.keys(lest.fjorVerdier[m]).length; }, 0);
    var finnes = (d.aarListe || []).indexOf(lest.aar) >= 0;
    var importer = U.button('Importer til ' + lest.aar, { variant: finnes ? 'danger' : 'primary', on: { click: function () {
      importer.disabled = true;
      k.call('importKpiV1', { aar: lest.aar, config: lest.config, verdier: lest.verdier, fjorVerdier: lest.fjorVerdier, overskriv: finnes }).then(function (res) {
        k.host().toast('Importert: ' + res.kpier + ' KPI-er, ' + res.verdier + ' verdier for ' + res.aar + ' og ' + res.fjorVerdier + ' fra ' + (res.aar - 1) + ' ✓');
        utkast = null; fane = null;
        return k.last(res.aar);
      }).then(function () { k.gaaTil('oversikt'); }, function (err) { importer.disabled = false; k.host().toast(err.message || 'Importen feilet', true); });
    } } });
    boks.textContent = '';
    boks.appendChild(h('div', { class: 'kpi-import-forslag' }, [
      h('p', null, [h('b', null, 'Fant ' + antKpi + ' KPI-er for ' + lest.aar), ', ' + antVerdier + ' månedsverdier (' + lest.maaneder.map(L.mndNavn).join(', ').toLowerCase() + ') og ' + antFjor + ' verdier fra ' + (lest.aar - 1) + '.']),
      h('ul', { class: 'sak-small kpi-import-kpier' }, Object.keys(lest.config.kpier).map(function (id) {
        var x = lest.config.kpier[id];
        return h('li', null, x.omrade + ' · ' + x.navn + ' · mål ' + L.fmtVerdi(x.maal, x.enhet) + ' · ' + x.retning + ' · ' + x.aggregat + '/' + x.maaltype);
      })),
      lest.advarsler.length ? h('div', { class: 'sak-alert sak-tone-warn' }, [U.icon('alert', 16), h('div', null, lest.advarsler.map(function (a) { return h('div', null, a); }))]) : null,
      finnes ? h('div', { class: 'sak-alert sak-tone-danger' }, [U.icon('alert', 16), h('span', null, 'Det finnes allerede data for ' + lest.aar + '. Importen erstatter oppsett og alle verdier for ' + lest.aar + ' og ' + (lest.aar - 1) + '.')]) : null,
      h('div', { class: 'kpi-oppsett-handlinger' }, [h('span', { class: 'kpi-spacer' }), importer]),
    ]));
  }

  /* ---------------------------------------------------------------- hele siden */

  function bygg(d) {
    var k = K(), h = k.h, U = k.U, state = k.state();
    // Utkastet bygges på nytt når oppsettet på serveren er en annen versjon (etter lagring, import eller nytt år).
    if (!utkast || utkast.aar !== d.aar || utkast.basis !== ((d.config && d.config.oppdatertAt) || '')) start(d);
    // Standardfanen følger dataene (uten oppsett: import), helt til brukeren selv velger en fane.
    var aktiv = fane || (d.config ? 'kpier' : 'import');
    var FANER = [['kpier', 'KPI-er', 'list'], ['aar', 'Nytt år', 'calendar'], ['import', 'Import fra Excel', 'layers']];
    var faner = h('div', { class: 'kpi-oppsett-faner', role: 'tablist', 'aria-label': 'Oppsett' }, FANER.map(function (f) {
      return h('button', { type: 'button', role: 'tab', 'aria-selected': aktiv === f[0] ? 'true' : 'false', class: 'kpi-oppsett-fane' + (aktiv === f[0] ? ' is-aktiv' : ''), on: { click: function () { fane = f[0]; k.render({ tvinges: true }); } } }, [U.icon(f[2], 16), h('span', null, f[1])]);
    }));

    var innhold = aktiv === 'aar' ? byggNyttAar(d) : aktiv === 'import' ? byggImport(d) : byggKpier(d);
    var feilBoks = h('div', { class: 'sak-alert sak-tone-danger', role: 'alert', hidden: true });
    var lagre = U.button(state.lagrer ? 'Lagrer …' : 'Lagre oppsett for ' + d.aar, { variant: 'primary', icon: 'check', disabled: state.lagrer, on: { click: function () {
      var cfg;
      try { cfg = configFraUtkast(utkast); } catch (e) { feilBoks.hidden = false; feilBoks.textContent = e.message; return; }
      state.lagrer = true; k.render({ tvinges: true });
      k.call('saveKpiConfigV1', { aar: d.aar, config: cfg }).then(function () {
        k.host().toast('Oppsettet for ' + d.aar + ' er lagret ✓');
        utkast = null;
        return k.last(d.aar);
      }).then(function () { state.lagrer = false; k.render({ tvinges: true }); }, function (err) {
        state.lagrer = false; k.render({ tvinges: true }); k.host().toast(err.message || 'Kunne ikke lagre', true);
      });
    } } });

    return [
      d.config ? null : h('div', { class: 'sak-alert sak-tone-info', role: 'status' }, [U.icon('info', 16), h('span', null, 'Det finnes ikke noe oppsett for ' + d.aar + ' ennå. Importer fra Excel, eller legg til KPI-er for hånd.')]),
      faner,
      h('div', { class: 'kpi-oppsett-innhold' }, innhold),
      feilBoks,
      aktiv === 'kpier' ? h('div', { class: 'kpi-oppsett-lagrelinje' + (utkast.endret ? ' is-endret' : '') }, [
        h('span', { class: 'kpi-oppsett-status' }, utkast.endret ? 'Ulagrede endringer' : 'Ingen ulagrede endringer'),
        h('span', { class: 'kpi-spacer' }),
        U.button('Forkast endringer', { variant: 'ghost', on: { click: function () { utkast = null; k.render({ tvinges: true }); } } }),
        lagre,
      ]) : null,
    ];
  }

  root.OpExKpiOppsett = Object.freeze({ bygg: bygg, nullstill: function () { utkast = null; fane = null; } });
}(typeof self !== 'undefined' ? self : this));
