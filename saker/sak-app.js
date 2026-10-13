/*
 * sak-app.js — Saker-modulen: ruting (#saker, #saker/<sakId>), rendering, og kobling mellom store, view-modell, visning og skjemaer.
 *
 * Integrasjon med verten (index.html) skjer KUN via:
 *   - window.OpExHost (leser: bruker, tiltak, navn, token, openTiltak, toast)  — satt opp av index.html
 *   - window.OpExSaker.render()  — kalles fra renderAllViews() når Saker-fanen er aktiv
 * Ingen overstyring av eksisterende funksjoner, ingen MutationObserver.
 */
(function (root) {
  'use strict';

  var U = root.OpExSakUi, S = root.OpExSakStore, VM = root.OpExSakVm, F = root.OpExSakForms, L = root.OpExSakList, D = root.OpExSakDetail, LG = root.OpExSakLogic;
  var host = function () { return root.OpExHost; };

  var ui = { visFjernet: {}, aktivitetAntall: 15, visLukkede: false };
  var sist = { signatur: '', rute: '', aktiv: false };
  var forespurt = {};   // sakId -> true (detaljer til kortene hentes én gang per besøk)
  var started = false;

  function container() { return document.getElementById('saker'); }
  function erAktiv() { var c = container(); return !!c && c.classList.contains('active'); }

  /* ------------------------------------------------------------------ rute */

  function lesRute() {
    var m = /^#saker(?:\/([^/?#]+))?/.exec(location.hash || '');
    return m ? { sakId: m[1] ? decodeURIComponent(m[1]) : null } : { sakId: null };
  }

  function gaaTil(sakId) {
    var hash = sakId ? '#saker/' + encodeURIComponent(sakId) : '#saker';
    if (location.hash !== hash) history.pushState({ saker: true }, '', hash);
    ui = { visFjernet: {}, aktivitetAntall: 15, visLukkede: ui.visLukkede };
    render({ nyVisning: true });
  }

  function onNav() {
    if (/^#saker/.test(location.hash || '')) {
      if (!erAktiv() && host() && host().show) host().show('saker'); else render({ nyVisning: true });
    }
  }

  /* ------------------------------------------------------------------ modell */

  function ctxBase() {
    var hh = host();
    return { idag: LG.osloDato(new Date()), navn: function (uid) { return hh.nameOf ? hh.nameOf(uid) : ''; } };
  }

  function bygg(rute) {
    var hh = host(), st = S.state, base = ctxBase();
    var tasks = hh.getTasks();
    if (rute.sakId) {
      var d = st.detaljer[rute.sakId];
      var modell = d && d.sak ? VM.byggSakModell(d, tasks, base) : null;
      return {
        visning: 'detalj', modell: modell, laster: !!st.detaljLaster[rute.sakId] || (!modell && !st.detaljFeil[rute.sakId]),
        feil: st.detaljFeil[rute.sakId] || null, utdatert: st.visningUtdatert, detail: d, sakId: rute.sakId,
      };
    }
    var listeModell = st.saker ? VM.byggListeModell(st.saker, st.detaljer, tasks, base) : null;
    return { visning: 'liste', modell: listeModell, laster: st.sakerLaster, feil: st.sakerFeil, utdatert: st.visningUtdatert };
  }

  /* ------------------------------------------------------------------ handlinger */

  function tilbake() {
    if (history.state && history.state.saker && /^#saker\//.test(location.hash)) history.back();
    else gaaTil(null);
  }

  function lastInn(sakId) {
    if (sakId) return S.loadSak(sakId, { force: true }).catch(function () {});
    return S.loadSaker({ force: true }).then(function (saker) {
      forespurt = {};
      return S.ensureDetaljer(saker.map(function (s) { return s.sakId; }));
    }).catch(function () {});
  }

  function handlers(ctx) {
    var hh = host();
    var sak = ctx.modell && ctx.modell.sak;
    var tasks = function () { return hh.getTasks(); };
    return {
      apne: function (id) { gaaTil(id); },
      ny: function () { F.nySak({ onDone: function (r) { gaaTil(r.sakId); } }); },
      pruv: function () { lastInn(ctx.sakId); },
      oppdater: function () { lastInn(ctx.sakId); },
      lukkedeToggle: function (open) { ui.visLukkede = open; },
      tilbake: tilbake,
      tegnPaaNytt: function () { render({ tvinges: true }); },
      apneTiltak: function (id) { hh.openTiltak(id); },
      endreStatus: function (anbefalt) { F.endreStatus(sak, anbefalt); },
      rediger: function () { F.endreSak(sak); },
      kobleTiltak: function () { F.kobleTiltak(ctx.modell, ctx.detail, tasks(), S.state.saker || []); },
      endreSpor: function (rad) { F.endreSporForTiltak(ctx.modell, rad); },
      frakoble: function (rad) { F.frakobleTiltak(ctx.modell, rad); },
      nySpor: function () { F.nySpor(ctx.modell); },
      nyArsak: function (sp) { F.nyArsak(ctx.modell, sp); },
      vurder: function (sp, a) { F.vurderArsak(ctx.modell, sp, a); },
      fjernArsak: function (a) { F.fjernArsak(ctx.modell, a); },
    };
  }

  /* ------------------------------------------------------------------ render */

  function hentNaarNodvendig(rute, ctx) {
    var st = S.state;
    if (rute.sakId) {
      if (!st.detaljer[rute.sakId] && !st.detaljFeil[rute.sakId] && !st.detaljLaster[rute.sakId]) S.loadSak(rute.sakId).catch(function () {});
      if (!st.saker && !st.sakerFeil && !st.sakerLaster) S.loadSaker().catch(function () {}); // for «Koble tiltak» (andre saker)
    } else {
      if (!st.saker && !st.sakerFeil && !st.sakerLaster) S.loadSaker().catch(function () {});
      if (st.saker) {
        var mangler = st.saker.map(function (s) { return s.sakId; }).filter(function (id) { return !forespurt[id] && !st.detaljer[id]; });
        if (mangler.length) { mangler.forEach(function (id) { forespurt[id] = true; }); S.ensureDetaljer(mangler); }
      }
    }
  }

  function render(opts) {
    var o = opts || {};
    var c = container();
    if (!c || !host() || !erAktiv()) { sist.aktiv = false; return; }
    // Bytter bruker: cachen tømmes først, slik at data fra forrige bruker aldri vises.
    var uid = host().getUser().uid || '';
    if (S.state.uid !== uid) S.nullstill(uid);
    if (!/^#saker/.test(location.hash || '')) history.replaceState(history.state, '', '#saker'); // fanen får en delbar adresse uten ny historikkoppføring
    var rute = lesRute();
    var kommerInn = !sist.aktiv;
    sist.aktiv = true;
    if (kommerInn) {
      forespurt = {};
      if (rute.sakId) S.loadSak(rute.sakId).catch(function () {});
      else S.loadSaker().then(function (saker) { return S.ensureDetaljer(saker.map(function (s) { return s.sakId; })); }).catch(function () {});
    }

    hentNaarNodvendig(rute);
    var ctx = bygg(rute);
    var sig;
    try { sig = JSON.stringify([rute, ctx.visning, ctx.modell, ctx.laster, ctx.feil && ctx.feil.message, ctx.utdatert, ui.aktivitetAntall, ui.visFjernet, ui.visLukkede]); } catch (e) { sig = String(Math.random()); }
    var ruteKey = rute.sakId || '';
    var nyVisning = o.nyVisning || ruteKey !== sist.rute || kommerInn;
    if (!o.tvinges && !nyVisning && sig === sist.signatur) return;
    sist.signatur = sig; sist.rute = ruteKey;

    ctx.ui = ui;
    ctx.visLukkede = ui.visLukkede;
    ctx.handlers = handlers(ctx);
    var scrollY = root.scrollY;
    var focusHint = !nyVisning ? aktivtElementNokkel() : null;
    var side = ctx.visning === 'detalj' ? D.byggDetalj(ctx) : L.byggListe(ctx);
    c.textContent = '';
    c.classList.add('sak-scope');
    c.appendChild(side);
    c.setAttribute('aria-busy', ctx.laster ? 'true' : 'false');
    if (nyVisning) {
      root.scrollTo(0, 0);
      var h1 = side.querySelector('h1');
      if (h1) { h1.setAttribute('tabindex', '-1'); if (!kommerInn) h1.focus({ preventScroll: true }); }
    } else {
      root.scrollTo(0, scrollY);
      gjenopprettFokus(c, focusHint);
    }
  }

  // Beholder tastaturfokus på «samme» knapp når siden tegnes på nytt (f.eks. etter «Vis flere»).
  function aktivtElementNokkel() {
    var a = document.activeElement, c = container();
    if (!a || !c || !c.contains(a) || a === c) return null;
    var label = (a.getAttribute('aria-label') || a.textContent || '').trim();
    return { tag: a.tagName, label: label };
  }
  function gjenopprettFokus(c, hint) {
    if (!hint) return;
    var kandidater = c.querySelectorAll(hint.tag.toLowerCase());
    for (var i = 0; i < kandidater.length; i++) {
      var k = kandidater[i];
      var l = (k.getAttribute('aria-label') || k.textContent || '').trim();
      if (l === hint.label || l.indexOf(hint.label.replace(/\(\d+.*$/, '').trim()) === 0) { k.focus({ preventScroll: true }); return; }
    }
  }

  function start() {
    if (started) return;
    started = true;
    S.subscribe(function () { render(); });
    root.addEventListener('popstate', onNav);
    root.addEventListener('hashchange', onNav);
  }

  start();
  root.OpExSaker = Object.freeze({ render: render, gaaTil: gaaTil, rute: lesRute });
}(typeof self !== 'undefined' ? self : this));
