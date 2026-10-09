/*
 * sak-store.js — klientens datalag for Saker. KUN kall til de eksisterende callablene (1c) via fetch.
 *
 * Regler:
 *  - Ingen direkte klientskriving til Firebase. Alle endringer går via callables som validerer på server.
 *  - Ingen optimistiske oppdateringer: etter en vellykket endring hentes ferske data fra serveren, og først da oppdateres UI.
 *    «Vellykket» betyr at serveren har svart OK. Feil gir SakApiError med norsk melding, aldri falsk suksess.
 *  - Hentet data cacheres i minnet (aldri i localStorage).
 *
 * Avhenger av vertsflaten window.OpExHost (getIdToken, functionsBase, getUser).
 */
(function (root) {
  'use strict';

  var TIMEOUT_MS = 25000;
  var FRESH_MS = 30000;
  var DETAIL_CONCURRENCY = 3;

  var STATUS_TIL_KODE = {
    INVALID_ARGUMENT: 'invalid-argument', UNAUTHENTICATED: 'unauthenticated', PERMISSION_DENIED: 'permission-denied',
    NOT_FOUND: 'not-found', ABORTED: 'aborted', FAILED_PRECONDITION: 'failed-precondition', INTERNAL: 'internal',
    ALREADY_EXISTS: 'already-exists', UNAVAILABLE: 'unavailable', DEADLINE_EXCEEDED: 'deadline-exceeded',
  };

  function SakApiError(code, message, status) {
    var e = new Error(message);
    e.name = 'SakApiError';
    e.code = code;
    e.status = status || 0;
    return e;
  }

  function standardMelding(code) {
    switch (code) {
      case 'unauthenticated': return 'Du er ikke innlogget. Last siden på nytt og logg inn.';
      case 'permission-denied': return 'Du har ikke tilgang til Saker.';
      case 'not-found': return 'Fant ikke det du ba om. Det kan være slettet. Oppdater siden.';
      case 'aborted': return 'Noen andre endret dette samtidig. Prøv igjen om litt.';
      case 'network': return 'Kunne ikke nå serveren. Sjekk nettforbindelsen og prøv igjen.';
      case 'timeout': return 'Serveren svarte ikke i tide. Endringen kan ha gått gjennom: oppdater og sjekk før du prøver igjen.';
      case 'internal': return 'Noe gikk galt hos serveren. Prøv igjen.';
      default: return 'Operasjonen feilet. Prøv igjen.';
    }
  }

  function host() {
    var h = root.OpExHost;
    if (!h) throw SakApiError('internal', 'Appen er ikke ferdig lastet. Last siden på nytt.');
    return h;
  }

  async function call(name, data) {
    var h = host();
    var token;
    try { token = await h.getIdToken(); } catch (e) { throw SakApiError('unauthenticated', standardMelding('unauthenticated')); }
    if (!token) throw SakApiError('unauthenticated', standardMelding('unauthenticated'));
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    var response;
    try {
      response = await fetch(h.functionsBase + '/' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ data: data === undefined ? {} : data }),
        signal: controller ? controller.signal : undefined,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw SakApiError('timeout', standardMelding('timeout'));
      throw SakApiError('network', standardMelding('network'));
    } finally {
      if (timer) clearTimeout(timer);
    }
    var payload = null;
    try { payload = await response.json(); } catch (e) { payload = null; }
    if (!response.ok || (payload && payload.error)) {
      var err = payload && payload.error ? payload.error : {};
      var code = STATUS_TIL_KODE[err.status] || (response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'permission-denied' : response.status === 404 ? 'not-found' : response.status >= 500 ? 'internal' : 'invalid-argument');
      throw SakApiError(code, (err.message && String(err.message)) || standardMelding(code), response.status);
    }
    if (!payload || payload.result === undefined) throw SakApiError('internal', 'Uventet svar fra serveren. Prøv igjen.');
    return payload.result;
  }

  /* ------------------------------------------------------------------ tilstand */

  var state = {
    uid: '',
    saker: null,            // getSakerV1().saker, eller null før første henting
    sakerLastet: 0,
    sakerLaster: false,
    sakerFeil: null,        // SakApiError | null
    detaljer: {},           // sakId -> getSakV1-resultat
    detaljLastet: {},       // sakId -> ms
    detaljLaster: {},       // sakId -> true
    detaljFeil: {},         // sakId -> SakApiError
    visningUtdatert: null,  // melding hvis en endring lyktes men oppfriskingen feilet
  };
  var subs = [];
  var inflight = { saker: null, detaljer: {} };

  function emit() { subs.slice().forEach(function (fn) { try { fn(state); } catch (e) { console.error('[Saker] lytter feilet', e); } }); }
  function subscribe(fn) { subs.push(fn); return function () { subs = subs.filter(function (f) { return f !== fn; }); }; }

  function nullstill(uid) {
    state.uid = uid || '';
    state.saker = null; state.sakerLastet = 0; state.sakerFeil = null; state.sakerLaster = false;
    state.detaljer = {}; state.detaljLastet = {}; state.detaljLaster = {}; state.detaljFeil = {};
    state.visningUtdatert = null;
    inflight = { saker: null, detaljer: {} };
  }

  /** Kall ved render: bytter bruker => tøm all cache (ingen data lekker mellom brukere). */
  function sikreBruker() {
    var u = host().getUser().uid || '';
    if (state.uid !== u) nullstill(u);
  }

  function friskt(ts) { return ts && Date.now() - ts < FRESH_MS; }

  /* ------------------------------------------------------------------ henting */

  function loadSaker(opts) {
    var force = !!(opts && opts.force);
    sikreBruker();
    if (!force && state.saker && friskt(state.sakerLastet)) return Promise.resolve(state.saker);
    if (inflight.saker) return inflight.saker;
    state.sakerLaster = true; state.sakerFeil = null; emit();
    inflight.saker = call('getSakerV1', {}).then(function (r) {
      state.saker = r.saker || [];
      state.sakerLastet = Date.now();
      state.sakerFeil = null;
      return state.saker;
    }).catch(function (e) {
      state.sakerFeil = e;
      throw e;
    }).finally(function () {
      state.sakerLaster = false; inflight.saker = null; emit();
    });
    return inflight.saker;
  }

  function loadSak(sakId, opts) {
    var force = !!(opts && opts.force);
    sikreBruker();
    if (!force && state.detaljer[sakId] && friskt(state.detaljLastet[sakId])) return Promise.resolve(state.detaljer[sakId]);
    if (inflight.detaljer[sakId]) return inflight.detaljer[sakId];
    state.detaljLaster[sakId] = true; delete state.detaljFeil[sakId]; emit();
    inflight.detaljer[sakId] = call('getSakV1', { sakId: sakId }).then(function (r) {
      state.detaljer[sakId] = r;
      state.detaljLastet[sakId] = Date.now();
      delete state.detaljFeil[sakId];
      return r;
    }).catch(function (e) {
      state.detaljFeil[sakId] = e;
      throw e;
    }).finally(function () {
      delete state.detaljLaster[sakId]; delete inflight.detaljer[sakId]; emit();
    });
    return inflight.detaljer[sakId];
  }

  /** Henter detaljer for flere saker (til «siste aktivitet» på kortene), maks 3 om gangen. Feil på én sak stopper ikke de andre. */
  function ensureDetaljer(sakIds) {
    var kø = (sakIds || []).filter(function (id) { return !(state.detaljer[id] && friskt(state.detaljLastet[id])) && !inflight.detaljer[id]; });
    var workers = [];
    for (var i = 0; i < Math.min(DETAIL_CONCURRENCY, kø.length); i++) {
      workers.push((async function () {
        while (kø.length) {
          var id = kø.shift();
          try { await loadSak(id); } catch (e) { /* vises som feil på kortet; de andre fortsetter */ }
        }
      })());
    }
    return Promise.all(workers);
  }

  /** Henter alt på nytt etter en vellykket endring. Feiler oppfriskingen, er endringen likevel lagret: si det tydelig. */
  async function oppdaterEtterEndring(sakId) {
    try {
      var jobber = [loadSaker({ force: true })];
      if (sakId) jobber.push(loadSak(sakId, { force: true }));
      await Promise.all(jobber);
      state.visningUtdatert = null;
    } catch (e) {
      state.visningUtdatert = 'Endringen er lagret, men visningen kunne ikke oppdateres. Trykk «Oppdater».';
    }
    emit();
  }

  /* ------------------------------------------------------------------ endringer (serverbekreftet) */

  async function skriv(navn, data, sakId, opts) {
    sikreBruker();
    var r = await call(navn, data); // kaster ved feil: ingen oppdatering, ingen falsk suksess
    if (!(opts && opts.refresh === false)) await oppdaterEtterEndring(sakId || r.sakId);
    return r;
  }

  var ops = {
    createSak: function (input) { return skriv('createSakV1', input, null); },
    updateSak: function (input) { return skriv('updateSakV1', input, input.sakId); },
    setTiltakSak: function (input, opts) { return skriv('setTiltakSakV1', input, input.sakId, opts); },
    removeTiltakSak: function (input, opts) { return skriv('removeTiltakSakV1', input, input.sakId, opts); },
    createArsak: function (input) { return skriv('createArsakV1', input, input.sakId); },
    updateArsak: function (input) { return skriv('updateArsakV1', input, input.sakId); },
    refreshSak: oppdaterEtterEndring,
  };

  root.OpExSakStore = Object.freeze({
    state: state, subscribe: subscribe, loadSaker: loadSaker, loadSak: loadSak, ensureDetaljer: ensureDetaljer,
    createSak: ops.createSak, updateSak: ops.updateSak, setTiltakSak: ops.setTiltakSak, removeTiltakSak: ops.removeTiltakSak,
    createArsak: ops.createArsak, updateArsak: ops.updateArsak, refreshSak: ops.refreshSak,
    SakApiError: SakApiError, call: call, nullstill: nullstill,
  });
}(typeof self !== 'undefined' ? self : this));
