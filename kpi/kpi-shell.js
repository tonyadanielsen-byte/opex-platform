/*
 * kpi-shell.js — rammen rundt KPI-appen (kpi/<enhet>/index.html, f.eks. kpi/renhold/).
 * Avdelingen settes av siden (window.KPI_ENHET) og slås opp i kpi-enheter.js (navn i topplinje og fanetittel).
 *
 * - Samme Firebase-prosjekt og samme innlogging som OpEx Hub (samme opprinnelse: er du logget inn der, er du logget inn her).
 * - Kobling til tiltakslista: leser /tiltak (for å vise tiltak koblet til KPI-er) og åpner tiltak i OpEx Hub.
 *   KPI-tiltak opprettes via callable og havner i den felles lista.
 * - Setter opp window.OpExHost, den samme vertsflaten KPI-modulen bruker.
 *
 * Demomodus (window.KPI_DEMO = { backend }) brukes av den publiserte forhåndsvisningen: ingen Firebase,
 * kall går til en lokal, simulert backend i nettleseren.
 */
(function (root) {
  'use strict';

  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDT6bW6kErdyhVK3WTMDEERsCLRTdjnoTg', authDomain: 'opex-nortura.firebaseapp.com',
    databaseURL: 'https://opex-nortura-default-rtdb.europe-west1.firebasedatabase.app', projectId: 'opex-nortura',
    storageBucket: 'opex-nortura.firebasestorage.app', messagingSenderId: '72695195747', appId: '1:72695195747:web:cb8ca9c1970b4fc3c9b056',
  };
  var FUNCTIONS_BASE = 'https://europe-west1-opex-nortura.cloudfunctions.net';
  var OPEX_URL = '../../';
  var PROFILER = {
    TJKI3zlDKSR7jvFXksVFgEgjS432: 'Tony Danielsen',
    gibm3aDi1KWlNyl7P3jTktQoGsM2: 'Kenneth Nordbakk',
    lJ7bn7HkbcZnhDoxfaBYQKEFL083: 'Erling Magnussen',
  };

  var $ = function (id) { return document.getElementById(id); };
  var tasks = [];
  var bruker = null; // { uid, name, getIdToken }

  /* ---------------------------------------------------------------- tema og toast */

  function lesTema() { try { return localStorage.getItem('kpiTema') || ''; } catch (e) { return ''; } }
  function settTema(t) {
    var mork = t ? t === 'dark' : (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.dataset.appearance = mork ? 'dark' : 'light';
    $('kpiTema').textContent = mork ? '☀' : '☾';
  }
  var toastTimer;
  function toast(melding, feil) {
    var t = $('kpiToast');
    t.textContent = melding;
    t.classList.toggle('is-feil', !!feil);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, feil ? 6000 : 3500);
  }

  function initialer(navn) { var d = String(navn || '').split(/\s+/).filter(Boolean); return d.length ? (d[0][0] + (d.length > 1 ? d[d.length - 1][0] : '')).toUpperCase() : '?'; }

  /* ---------------------------------------------------------------- vertsflate */

  function render(opts) { if (root.OpExKpi) root.OpExKpi.render(opts); }

  root.OpExHost = {
    functionsBase: root.KPI_DEMO ? root.KPI_DEMO.functionsBase : FUNCTIONS_BASE,
    getIdToken: function () { return bruker ? bruker.getIdToken() : Promise.reject(new Error('Ikke innlogget')); },
    getUser: function () { return bruker ? { uid: bruker.uid, name: bruker.name } : { uid: '', name: '' }; },
    isAdmin: function () { return false; },
    getTasks: function () { return tasks; },
    getUsers: function () { return Object.keys(PROFILER).map(function (uid) { return { uid: uid, name: PROFILER[uid] }; }); },
    nameOf: function (uid) { return PROFILER[uid] || ''; },
    openTiltak: function (key) {
      if (root.KPI_DEMO) { toast('I appen åpnes tiltaket i tiltakslista (OpEx Hub).'); return; }
      root.open(OPEX_URL + '?openTask=' + encodeURIComponent(key), '_blank', 'noopener');
    },
    toast: toast,
    show: function () { render({ ny: true }); },
  };

  function settTasks(map) {
    tasks = Object.keys(map || {}).map(function (k) { return Object.assign({}, map[k], { fbKey: k }); });
    render();
  }

  function visInnlogget(b) {
    bruker = b;
    $('kpiLogin').hidden = true;
    $('kpi').hidden = false;
    $('kpiBruker').hidden = false;
    $('kpiBrukerNavn').textContent = b.name.split(' ')[0];
    $('kpiAvatar').textContent = initialer(b.name);
    render({ ny: true });
  }
  function visLogin(feil) {
    bruker = null; tasks = [];
    $('kpi').hidden = true;
    $('kpiBruker').hidden = true;
    $('kpiLogin').hidden = false;
    var f = $('kpiLoginFeil');
    f.hidden = !feil; f.textContent = feil || '';
  }

  /* ---------------------------------------------------------------- oppstart */

  function startDemo() {
    var demo = root.KPI_DEMO;
    $('kpiTiltakLenke').addEventListener('click', function (e) { e.preventDefault(); toast('I appen går denne lenken til tiltakslista i OpEx Hub.'); });
    $('kpiLoggUt').hidden = true;
    demo.onTiltak = settTasks;
    visInnlogget({ uid: demo.uid, name: PROFILER[demo.uid] || 'Demo', getIdToken: function () { return Promise.resolve('demo'); } });
    settTasks(demo.tiltak());
  }

  function startFirebase() {
    if (!root.firebase) { visLogin('Kunne ikke laste Firebase. Sjekk nettforbindelsen og last siden på nytt.'); return; }
    if (!(root.firebase.apps && root.firebase.apps.length)) root.firebase.initializeApp(FIREBASE_CONFIG);
    var auth = root.firebase.auth(), db = root.firebase.database();
    var tiltakRef = db.ref('tiltak');
    var lytter = null;

    $('kpiLoginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var epost = $('kpiEpost').value.trim(), passord = $('kpiPassord').value;
      if (!epost || !passord) { visLogin('Fyll inn e-post og passord.'); return; }
      auth.signInWithEmailAndPassword(epost, passord).catch(function () { visLogin('Feil e-post eller passord.'); });
    });
    $('kpiLoggUt').addEventListener('click', function () { auth.signOut(); });

    auth.setPersistence(root.firebase.auth.Auth.Persistence.LOCAL).then(function () {
      auth.onAuthStateChanged(function (u) {
        if (lytter) { tiltakRef.off('value', lytter); lytter = null; }
        if (!u) { visLogin(''); return; }
        db.ref('authorizedUsers/' + u.uid).once('value').then(function (s) {
          if (s.val() !== true) { visLogin('Kontoen er ikke godkjent for OpEx. Kontakt administrator.'); return auth.signOut(); }
          visInnlogget({ uid: u.uid, name: PROFILER[u.uid] || u.displayName || u.email || 'Bruker', getIdToken: function () { return u.getIdToken(); } });
          lytter = tiltakRef.on('value', function (snap) { settTasks(snap.val()); }, function () { toast('Kunne ikke lese tiltakslista.', true); });
        }, function () { visLogin('Tilgangen kunne ikke kontrolleres. Prøv igjen.'); });
      });
    });
  }

  function visAvdeling() {
    var E = root.OpExKpiEnheter, e = E && E.hent(root.KPI_ENHET);
    if (!e) return;
    document.title = e.navn + ' · Nortura Sarpsborg';
    var t = $('kpiTittel'); if (t) t.textContent = e.navn;
    var l = $('kpiLoginTittel'); if (l) l.textContent = e.navn;
  }

  function start() {
    visAvdeling();
    settTema(lesTema());
    $('kpiTema').addEventListener('click', function () {
      var ny = document.body.dataset.appearance === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('kpiTema', ny); } catch (e) { /* privat modus */ }
      settTema(ny);
      render({ tvinges: true });
    });
    $('kpi').classList.add('active');
    if (root.KPI_DEMO) startDemo(); else startFirebase();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}(typeof self !== 'undefined' ? self : this));
