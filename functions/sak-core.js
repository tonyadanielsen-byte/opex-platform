'use strict';

/*
 * Saker MVP-0, fase 1c: datalag for saker (ren logikk, ingen avhengighet til firebase-functions).
 * Databasen injiseres (`deps.db`), slik at alt kan testes mot en simulert database.
 * Callable-bindingen ligger i sak-api.js.
 *
 * Arkitekturregler (låst):
 *  1. tiltak.sakId er eneste kilde til hvilken sak et tiltak tilhører.
 *  2. Aggregater lagres ikke (ingen tellere, ingen «sist oppdatert» på saken).
 *  3. Historikk (sakEvents) er append-only og skrives av server, i SAMME atomiske update som endringen.
 *  4. (UI/modul – ikke relevant her.)
 *  5. AI skriver aldri i disse datafeltene.
 *
 * Tilgang (pilot): innlogget bruker som finnes i /authorizedUsers/{uid} === true. Ingen hardkodede uid-er.
 * Identitet i hendelser og vurdertAv/opprettetAv kommer ALLTID fra request.auth.uid, aldri fra klienten.
 *
 * Konsistens uten delvis fullførte oppdateringer:
 *  - Alle skriveoperasjoner som berører flere noder gjøres som ÉN multi-path update() (atomisk).
 *  - Eneste unntak er «koble tiltak til sak»: medlemskapet (tiltak.sakId) avgjøres med en transaksjon på
 *    tiltaket (kun én sak kan «vinne»), og resten (spor-koblinger + sakEvents) skrives deretter i én
 *    atomisk update. Feiler den, rulles medlemskapet tilbake. Operasjonen er idempotent, så den kan
 *    trygt kjøres på nytt. Se docs/saker-mvp0.md for begrensninger.
 */

const { buildSakEvent, sakEventWrites } = require('./events-core');

const SAK_STATUSER = Object.freeze(['Åpen', 'Under oppfølging', 'Avventer beslutning', 'Løst', 'Lukket']);
const ARSAK_STATUSER = Object.freeze(['hypotese', 'støttet', 'bekreftet', 'avkreftet']);
const STATUS_KREVER_GRUNNLAG = Object.freeze(['støttet', 'bekreftet']);

const LIMITS = Object.freeze({
  tittel: { min: 3, max: 120 },
  problemstilling: { max: 1500 },
  omradeNavn: { min: 1, max: 40 },
  omraderMax: 10,
  sporMax: 8,
  sporsmal: { min: 3, max: 200 },
  arsakTekst: { min: 3, max: 600 },
  grunnlag: { min: 3, max: 1500 },
  sakerMax: 500,
  tiltakEventsPerTiltak: 100,
  sakEvents: 300,
  updateAttempts: 3,
});

// RTDB-nøkler: ikke . $ # [ ] / eller kontrolltegn.
const SAFE_ID = /^[^.#$\[\]/\u0000-\u001f\u007f]{1,700}$/;
const SPOR_KODE = /^[A-Za-z0-9]{1,4}$/;

class SakError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SakError';
    this.code = code; // samme koder som HttpsError
  }
}

function fail(code, message) {
  throw new SakError(code, message);
}

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ---------------------------------------------------------------- validering */

function objectInput(raw, allowed) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isObject(input)) fail('invalid-argument', 'Ugyldig forespørsel.');
  const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
  if (unknown.length) fail('invalid-argument', `Ukjente felt i forespørselen: ${unknown.slice(0, 5).join(', ')}`);
  return input;
}

function requireId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('invalid-argument', `${label} er ugyldig.`);
  return value;
}

function idList(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('invalid-argument', `${label} må være en liste.`);
  if (value.length > max) fail('invalid-argument', `${label} kan ha maks ${max} elementer.`);
  const ids = value.map((v) => requireId(v, label));
  return [...new Set(ids)];
}

function cleanText(value, label, { min = 0, max, single = false, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('invalid-argument', `${label} mangler.`);
    return undefined;
  }
  if (typeof value !== 'string') fail('invalid-argument', `${label} må være tekst.`);
  let text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (single) text = text.replace(/\s*\n+\s*/g, ' ');
  text = text.trim();
  if (required && !text) fail('invalid-argument', `${label} mangler.`);
  if (text && text.length < min) fail('invalid-argument', `${label} må ha minst ${min} tegn.`);
  if (text.length > max) fail('invalid-argument', `${label} kan ha maks ${max} tegn.`);
  return text;
}

function omraderMap(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail('invalid-argument', 'Områder må være en liste.');
  if (value.length > LIMITS.omraderMax) fail('invalid-argument', `Maks ${LIMITS.omraderMax} områder.`);
  const out = {};
  for (const raw of value) {
    const name = cleanText(raw, 'Område', { min: LIMITS.omradeNavn.min, max: LIMITS.omradeNavn.max, single: true, required: true });
    if (!SAFE_ID.test(name)) fail('invalid-argument', 'Områdenavn kan ikke inneholde . $ # [ ] /');
    out[name] = true;
  }
  return Object.keys(out).length ? out : null; // null = ingen områder
}

function sporInput(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('invalid-argument', 'Spor må være en liste.');
  if (value.length > LIMITS.sporMax) fail('invalid-argument', `Maks ${LIMITS.sporMax} spor.`);
  const koder = new Set();
  return value.map((item, i) => {
    const s = objectInput(item, ['sporsmal', 'kode']);
    const sporsmal = cleanText(s.sporsmal, 'Spørsmål', { min: LIMITS.sporsmal.min, max: LIMITS.sporsmal.max, single: true, required: true });
    let kode = s.kode === undefined ? String.fromCharCode(65 + i) : clean(s.kode).toUpperCase();
    if (!SPOR_KODE.test(kode)) fail('invalid-argument', 'Sporkode må være 1–4 bokstaver/tall.');
    if (koder.has(kode)) fail('invalid-argument', `Sporkode ${kode} er brukt flere ganger.`);
    koder.add(kode);
    return { kode, sporsmal };
  });
}

/* ---------------------------------------------------------------- tilgang */

async function requireAuthorized(deps, uid) {
  const id = clean(uid);
  if (!id) fail('unauthenticated', 'Du må være logget inn.');
  if (!SAFE_ID.test(id)) fail('permission-denied', 'Brukeren har ikke tilgang til OpEx.');
  const snap = await deps.db.ref(`/authorizedUsers/${id}`).get();
  if (snap.val() !== true) fail('permission-denied', 'Brukeren har ikke tilgang til OpEx.');
  return id;
}

async function requireAuthorizedUser(deps, uid, label) {
  const snap = await deps.db.ref(`/authorizedUsers/${uid}`).get();
  if (snap.val() !== true) fail('invalid-argument', `${label} er ikke en godkjent OpEx-bruker.`);
  return uid;
}

/* ------------------------------------------------------------ skrivehjelpere */

/** Én atomisk multi-path update, med nye forsøk (idempotent: samme absolutte verdier og faste hendelsesnøkler). */
async function atomicUpdate(deps, updates) {
  let last;
  for (let attempt = 1; attempt <= LIMITS.updateAttempts; attempt++) {
    try {
      await deps.db.ref().update(updates);
      return;
    } catch (error) {
      last = error;
      if (attempt < LIMITS.updateAttempts) await deps.sleep(150 * attempt);
    }
  }
  throw last;
}

async function commit(deps, updates, message) {
  try {
    await atomicUpdate(deps, updates);
  } catch (error) {
    deps.log.error('sak-core: update feilet', { error: String(error?.message || error), paths: Object.keys(updates).length });
    fail('internal', message);
  }
}

function eventsFor(deps, actor, list) {
  const now = deps.now();
  return list.map((e) => buildSakEvent({ ...e, actorUid: actor, now }));
}

async function loadSak(deps, sakId) {
  const sak = (await deps.db.ref(`/saker/${sakId}`).get()).val();
  if (!isObject(sak)) fail('not-found', 'Saken finnes ikke.');
  return sak;
}

function assertOpen(sak) {
  if (sak.status === 'Lukket') fail('failed-precondition', 'Saken er lukket. Åpne den på nytt (endre status) før du endrer innholdet.');
}

function publicSak(sakId, s) {
  return {
    sakId,
    kode: s.kode || '',
    tittel: s.tittel || '',
    problemstilling: s.problemstilling || '',
    eierUid: s.eierUid || '',
    status: s.status || 'Åpen',
    omrader: Object.keys(isObject(s.omrader) ? s.omrader : {}).sort((a, b) => a.localeCompare(b, 'nb')),
    opprettetAt: s.opprettetAt || '',
    opprettetAv: s.opprettetAv || '',
  };
}

function publicArsak(arsakId, a) {
  const out = {
    arsakId,
    sporId: a.sporId || '',
    tekst: a.tekst || '',
    status: a.status || 'hypotese',
    grunnlag: a.grunnlag || '',
    vurdertAv: a.vurdertAv || '',
    vurdertAt: a.vurdertAt || '',
    opprettetAv: a.opprettetAv || '',
    opprettetAt: a.opprettetAt || '',
    fjernet: a.fjernet === true,
  };
  if (a.erstatter) out.erstatter = a.erstatter;
  return out;
}

/* ================================================================== operasjoner */

/** Oppretter en sak med servergenerert SAK-nummer, spor og sakhendelse i én atomisk skriving. */
async function createSak(deps, uid, raw) {
  const input = objectInput(raw, ['tittel', 'problemstilling', 'eierUid', 'omrader', 'spor']);
  const actor = await requireAuthorized(deps, uid);
  const tittel = cleanText(input.tittel, 'Tittel', { min: LIMITS.tittel.min, max: LIMITS.tittel.max, single: true, required: true });
  const problemstilling = cleanText(input.problemstilling, 'Problemstilling', { max: LIMITS.problemstilling.max });
  const eierUid = input.eierUid === undefined
    ? actor
    : await requireAuthorizedUser(deps, requireId(input.eierUid, 'eierUid'), 'Eier');
  const omrader = omraderMap(input.omrader);
  const spor = sporInput(input.spor);

  // Servergenerert nummer. Ingen skanning av eksisterende saker. Hull i nummerrekken kan oppstå hvis
  // skrivingen under feiler etter at nummeret er tildelt (akseptert; aldri duplikater).
  const tx = await deps.db.ref('/counters/sak').transaction((cur) => {
    if (cur === null || cur === undefined) return 1;
    if (typeof cur !== 'number' || !Number.isInteger(cur) || cur < 0) return undefined; // ødelagt teller: avbryt
    return cur + 1;
  });
  if (!tx.committed || typeof tx.snapshot.val() !== 'number') fail('internal', 'Kunne ikke tildele saksnummer. Prøv igjen.');
  const kode = 'SAK-' + String(tx.snapshot.val()).padStart(4, '0');

  const now = deps.now();
  const sakId = deps.db.ref('/saker').push().key;
  const sporIds = spor.map(() => deps.db.ref(`/sakSpor/${sakId}`).push().key);

  const sak = { kode, tittel, eierUid, status: 'Åpen', opprettetAt: now.toISOString(), opprettetAv: actor };
  if (problemstilling) sak.problemstilling = problemstilling;
  if (omrader) sak.omrader = omrader;

  const updates = { [`/saker/${sakId}`]: sak };
  spor.forEach((s, i) => {
    updates[`/sakSpor/${sakId}/${sporIds[i]}`] = { kode: s.kode, sporsmal: s.sporsmal, rekkefolge: i + 1 };
  });
  Object.assign(updates, sakEventWrites(sakId, eventsFor(deps, actor, [
    { type: 'sak_opprettet', entityId: sakId, felt: 'kode', etter: kode },
  ])));

  await commit(deps, updates, `Saken kunne ikke opprettes (${kode} er brukt opp). Prøv igjen.`);
  return { sakId, kode, sporIds: spor.map((s, i) => ({ sporId: sporIds[i], kode: s.kode })) };
}

/** Alle saker (lett liste, uten spor/årsaker/hendelser). */
async function getSaker(deps, uid, raw) {
  objectInput(raw, []);
  await requireAuthorized(deps, uid);
  const all = (await deps.db.ref('/saker').get()).val() || {};
  const saker = Object.entries(all)
    .filter(([, s]) => isObject(s))
    .map(([sakId, s]) => publicSak(sakId, s))
    .sort((a, b) => a.kode.localeCompare(b.kode) || a.sakId.localeCompare(b.sakId))
    .slice(0, LIMITS.sakerMax);
  return { saker, hentetAt: deps.now().toISOString() };
}

/**
 * Saksdetaljer. Hendelsene returneres i rå RTDB-form, direkte brukbare som `tiltakEvents`/`sakEvents`
 * i saker/sak-logic.js. Tiltakene selv returneres ikke (klienten har dem allerede).
 */
async function getSak(deps, uid, raw) {
  const input = objectInput(raw, ['sakId']);
  await requireAuthorized(deps, uid);
  const sakId = requireId(input.sakId, 'sakId');
  const sak = await loadSak(deps, sakId);

  const [sporVal, arsakVal, koblingVal, medlemmer, sakEvents] = await Promise.all([
    deps.db.ref(`/sakSpor/${sakId}`).get(),
    deps.db.ref(`/sakArsaker/${sakId}`).get(),
    deps.db.ref(`/sakTiltakSpor/${sakId}`).get(),
    // Uten .indexOn leser admin-SDK-et alle tiltak og filtrerer; greit i pilot (hundrevis av tiltak).
    deps.db.ref('/tiltak').orderByChild('sakId').equalTo(sakId).get(),
    deps.db.ref(`/sakEvents/${sakId}`).orderByKey().limitToLast(LIMITS.sakEvents).get(),
  ]);

  const tiltakIds = Object.keys(medlemmer.val() || {}).sort();
  const medlemSet = new Set(tiltakIds);

  const spor = Object.entries(sporVal.val() || {})
    .map(([sporId, s]) => ({ sporId, kode: s.kode || '', sporsmal: s.sporsmal || '', rekkefolge: Number(s.rekkefolge) || 0 }))
    .sort((a, b) => a.rekkefolge - b.rekkefolge || a.sporId.localeCompare(b.sporId));
  const sporIds = new Set(spor.map((s) => s.sporId));

  const arsaker = Object.entries(arsakVal.val() || {})
    .filter(([, a]) => isObject(a))
    .map(([arsakId, a]) => publicArsak(arsakId, a))
    .sort((a, b) => a.opprettetAt.localeCompare(b.opprettetAt) || a.arsakId.localeCompare(b.arsakId));

  // Spor-koblinger gjelder bare for tiltak som faktisk har tiltak.sakId === sakId. Resten er foreldreløse.
  // Alle medlemmer får en oppføring (tom liste = «ikke koblet til spor»).
  const tiltakSpor = {};
  for (const tiltakId of tiltakIds) tiltakSpor[tiltakId] = [];
  const ugyldigeKoblinger = [];
  for (const [tiltakId, map] of Object.entries(koblingVal.val() || {})) {
    if (!medlemSet.has(tiltakId)) { ugyldigeKoblinger.push(tiltakId); continue; }
    tiltakSpor[tiltakId] = Object.keys(isObject(map) ? map : {}).filter((id) => map[id] === true && sporIds.has(id)).sort();
  }

  const tiltakEvents = {};
  await Promise.all(tiltakIds.map(async (tiltakId) => {
    const ev = (await deps.db.ref(`/tiltakEvents/${tiltakId}`).orderByKey().limitToLast(LIMITS.tiltakEventsPerTiltak).get()).val();
    if (ev) tiltakEvents[tiltakId] = ev;
  }));

  return {
    sak: publicSak(sakId, sak),
    spor,
    arsaker,
    tiltakIds,
    tiltakSpor,
    ugyldigeKoblinger: ugyldigeKoblinger.sort(),
    tiltakEvents,
    sakEvents: sakEvents.val() || {},
    hentetAt: deps.now().toISOString(),
  };
}

/** Oppdaterer tittel, problemstilling, status, eier og/eller områder. Status settes bare manuelt. */
async function updateSak(deps, uid, raw) {
  const input = objectInput(raw, ['sakId', 'tittel', 'problemstilling', 'status', 'eierUid', 'omrader']);
  const actor = await requireAuthorized(deps, uid);
  const sakId = requireId(input.sakId, 'sakId');
  const sak = await loadSak(deps, sakId);

  const updates = {};
  const hendelser = [];
  const felter = [];
  const endre = (felt, path, value, event) => {
    updates[`/saker/${sakId}/${path}`] = value;
    felter.push(felt);
    hendelser.push({ type: 'sak_endret', entityId: sakId, felt, ...event });
  };

  if (input.tittel !== undefined) {
    const tittel = cleanText(input.tittel, 'Tittel', { min: LIMITS.tittel.min, max: LIMITS.tittel.max, single: true, required: true });
    if (tittel !== sak.tittel) endre('tittel', 'tittel', tittel, {}); // tekst logges ikke
  }
  if (input.problemstilling !== undefined) {
    const p = cleanText(input.problemstilling, 'Problemstilling', { max: LIMITS.problemstilling.max });
    if (p !== (sak.problemstilling || '')) endre('problemstilling', 'problemstilling', p || null, {});
  }
  if (input.status !== undefined) {
    if (!SAK_STATUSER.includes(input.status)) fail('invalid-argument', `Ugyldig status. Tillatt: ${SAK_STATUSER.join(', ')}.`);
    if (input.status !== sak.status) endre('status', 'status', input.status, { foer: sak.status, etter: input.status });
  }
  if (input.eierUid !== undefined) {
    const eier = requireId(input.eierUid, 'eierUid');
    if (eier !== sak.eierUid) {
      await requireAuthorizedUser(deps, eier, 'Eier');
      endre('eierUid', 'eierUid', eier, { foer: sak.eierUid, etter: eier });
    }
  }
  if (input.omrader !== undefined) {
    const nytt = omraderMap(input.omrader);
    const gammelt = isObject(sak.omrader) ? sak.omrader : null;
    if (JSON.stringify(Object.keys(nytt || {}).sort()) !== JSON.stringify(Object.keys(gammelt || {}).sort())) {
      endre('omrader', 'omrader', nytt, {});
    }
  }

  if (!felter.length) return { sakId, endret: false, felter: [] };
  if (sak.status === 'Lukket' && !felter.includes('status')) assertOpen(sak);

  Object.assign(updates, sakEventWrites(sakId, eventsFor(deps, actor, hendelser)));
  await commit(deps, updates, 'Saken kunne ikke oppdateres. Prøv igjen.');
  return { sakId, endret: true, felter };
}

/**
 * Kobler et eksisterende tiltak til saken og setter hvilke spor det hører til (erstatter forrige sett).
 * Idempotent: kan kjøres på nytt, også for å rette opp etter en feil.
 */
async function setTiltakSak(deps, uid, raw) {
  const input = objectInput(raw, ['sakId', 'tiltakId', 'sporIds']);
  const actor = await requireAuthorized(deps, uid);
  const sakId = requireId(input.sakId, 'sakId');
  const tiltakId = requireId(input.tiltakId, 'tiltakId');
  const sporIds = idList(input.sporIds, 'sporIds', LIMITS.sporMax);

  const sak = await loadSak(deps, sakId);
  assertOpen(sak);
  const sporVal = (await deps.db.ref(`/sakSpor/${sakId}`).get()).val() || {};
  for (const id of sporIds) if (!isObject(sporVal[id])) fail('invalid-argument', 'Ukjent spor for denne saken.');

  const tiltak = (await deps.db.ref(`/tiltak/${tiltakId}`).get()).val();
  if (!isObject(tiltak)) fail('not-found', 'Tiltaket finnes ikke.');
  if (tiltak.livssyklus === 'Papirkurv' || tiltak.papirkurv === true) fail('failed-precondition', 'Tiltak i papirkurven kan ikke kobles til en sak.');
  const eksisterende = clean(tiltak.sakId);
  if (eksisterende && eksisterende !== sakId) {
    const annen = (await deps.db.ref(`/saker/${eksisterende}`).get()).val();
    fail('failed-precondition', `Tiltaket tilhører allerede ${isObject(annen) && annen.kode ? annen.kode : 'en annen sak'}. Fjern det derfra først.`);
  }

  // Medlemskap avgjøres atomisk på selve tiltaket: bare én sak kan «vinne», også ved samtidige forsøk.
  let claimed = false;
  const tx = await deps.db.ref(`/tiltak/${tiltakId}`).transaction((cur) => {
    if (cur === null || cur === undefined) return null; // kald cache: serveren prøver på nytt med ekte verdi
    if (!isObject(cur)) return undefined;
    const have = clean(cur.sakId);
    if (have && have !== sakId) return undefined;
    claimed = !have;
    return have ? cur : { ...cur, sakId };
  });
  if (!tx.snapshot.exists()) fail('not-found', 'Tiltaket finnes ikke.');
  if (!tx.committed) fail('aborted', 'Tiltaket ble koblet til en annen sak samtidig. Last inn på nytt.');

  const forrige = (await deps.db.ref(`/sakTiltakSpor/${sakId}/${tiltakId}`).get()).val();
  const forrigeIds = claimed ? [] : Object.keys(isObject(forrige) ? forrige : {}).filter((k) => forrige[k] === true);
  const lagtTil = sporIds.filter((id) => !forrigeIds.includes(id));
  const fjernet = forrigeIds.filter((id) => !sporIds.includes(id));
  if (!claimed && !lagtTil.length && !fjernet.length) return { sakId, tiltakId, endret: false, sporIds };

  const hendelser = [];
  if (claimed) hendelser.push({ type: 'tiltak_koblet', entityId: tiltakId, felt: 'sakId', etter: sakId });
  for (const id of lagtTil) hendelser.push({ type: 'spor_koblet', entityId: tiltakId, felt: 'sporId', etter: id });
  for (const id of fjernet) hendelser.push({ type: 'spor_frakoblet', entityId: tiltakId, felt: 'sporId', foer: id });

  const updates = {
    // Hele settet skrives på nytt: fjerner også eventuelle gamle, foreldreløse koblinger.
    [`/sakTiltakSpor/${sakId}/${tiltakId}`]: sporIds.length ? Object.fromEntries(sporIds.map((id) => [id, true])) : null,
    ...sakEventWrites(sakId, eventsFor(deps, actor, hendelser)),
  };

  try {
    await atomicUpdate(deps, updates);
  } catch (error) {
    deps.log.error('sak-core: kobling feilet etter medlemskap', { sakId, tiltakId, error: String(error?.message || error) });
    let rullet = !claimed;
    if (claimed) {
      try {
        await deps.db.ref(`/tiltak/${tiltakId}`).transaction((cur) => {
          if (cur === null || cur === undefined) return null;
          if (!isObject(cur) || clean(cur.sakId) !== sakId) return undefined;
          const { sakId: _fjernet, ...rest } = cur;
          return rest;
        });
        rullet = true;
      } catch (rollbackError) {
        deps.log.error('sak-core: tilbakerulling feilet', { sakId, tiltakId, error: String(rollbackError?.message || rollbackError) });
      }
    }
    fail('internal', rullet
      ? 'Koblingen kunne ikke fullføres og ble rullet tilbake. Prøv igjen.'
      : 'Koblingen ble bare delvis lagret. Prøv samme operasjon på nytt; den er trygg å gjenta.');
  }
  return { sakId, tiltakId, endret: true, tilknyttet: claimed, sporIds };
}

/** Fjerner tiltaket fra saken (tiltak.sakId fjernes). Idempotent. */
async function removeTiltakSak(deps, uid, raw) {
  const input = objectInput(raw, ['sakId', 'tiltakId']);
  const actor = await requireAuthorized(deps, uid);
  const sakId = requireId(input.sakId, 'sakId');
  const tiltakId = requireId(input.tiltakId, 'tiltakId');
  const sak = await loadSak(deps, sakId);
  assertOpen(sak);

  const tiltak = (await deps.db.ref(`/tiltak/${tiltakId}`).get()).val();
  if (!isObject(tiltak)) fail('not-found', 'Tiltaket finnes ikke.');
  const eksisterende = clean(tiltak.sakId);
  if (eksisterende && eksisterende !== sakId) fail('failed-precondition', 'Tiltaket tilhører en annen sak.');

  let released = false;
  const tx = await deps.db.ref(`/tiltak/${tiltakId}`).transaction((cur) => {
    if (cur === null || cur === undefined) return null;
    if (!isObject(cur)) return undefined;
    const have = clean(cur.sakId);
    if (have && have !== sakId) return undefined;
    released = have === sakId;
    if (!have) return cur;
    const { sakId: _fjernet, ...rest } = cur;
    return rest;
  });
  if (!tx.snapshot.exists()) fail('not-found', 'Tiltaket finnes ikke.');
  if (!tx.committed) fail('aborted', 'Tiltaket ble koblet til en annen sak samtidig. Last inn på nytt.');

  const forrige = (await deps.db.ref(`/sakTiltakSpor/${sakId}/${tiltakId}`).get()).val();
  const forrigeIds = Object.keys(isObject(forrige) ? forrige : {}).filter((k) => forrige[k] === true);
  if (!released && !forrigeIds.length) return { sakId, tiltakId, endret: false };

  const hendelser = [];
  if (released) hendelser.push({ type: 'tiltak_frakoblet', entityId: tiltakId, felt: 'sakId', foer: sakId });
  for (const id of forrigeIds) hendelser.push({ type: 'spor_frakoblet', entityId: tiltakId, felt: 'sporId', foer: id });

  const updates = {
    [`/sakTiltakSpor/${sakId}/${tiltakId}`]: null,
    ...sakEventWrites(sakId, eventsFor(deps, actor, hendelser)),
  };
  try {
    await atomicUpdate(deps, updates);
  } catch (error) {
    // Tiltaket er frikoblet (medlemskap er sannheten). Gjenværende spor-koblinger er foreldreløse og
    // ignoreres; de ryddes ved neste kobling. Hendelsen om frakobling finnes likevel i tiltakEvents.
    deps.log.error('sak-core: frakobling feilet etter medlemskap', { sakId, tiltakId, error: String(error?.message || error) });
    fail('internal', 'Tiltaket er fjernet fra saken, men historikken ble ikke fullt oppdatert. Prøv samme operasjon på nytt.');
  }
  return { sakId, tiltakId, endret: true };
}

/* ------------------------------------------------------------------ årsaker */

function arsakStatus(value, fallback) {
  if (value === undefined) return fallback;
  if (!ARSAK_STATUSER.includes(value)) fail('invalid-argument', `Ugyldig status. Tillatt: ${ARSAK_STATUSER.join(', ')}.`);
  return value;
}

function requireGrunnlag(status, grunnlag) {
  if (STATUS_KREVER_GRUNNLAG.includes(status) && !(grunnlag && grunnlag.length >= LIMITS.grunnlag.min)) {
    fail('invalid-argument', `Status «${status}» krever et grunnlag (minst ${LIMITS.grunnlag.min} tegn).`);
  }
}

/** Registrerer en årsak (påstand) under et spor. vurdertAv/vurdertAt settes av serveren. */
async function createArsak(deps, uid, raw) {
  const input = objectInput(raw, ['sakId', 'sporId', 'tekst', 'status', 'grunnlag']);
  const actor = await requireAuthorized(deps, uid);
  const sakId = requireId(input.sakId, 'sakId');
  const sporId = requireId(input.sporId, 'sporId');
  const tekst = cleanText(input.tekst, 'Tekst', { min: LIMITS.arsakTekst.min, max: LIMITS.arsakTekst.max, required: true });
  const status = arsakStatus(input.status, 'hypotese');
  const grunnlag = cleanText(input.grunnlag, 'Grunnlag', { max: LIMITS.grunnlag.max });
  requireGrunnlag(status, grunnlag);

  const sak = await loadSak(deps, sakId);
  assertOpen(sak);
  const spor = (await deps.db.ref(`/sakSpor/${sakId}/${sporId}`).get()).val();
  if (!isObject(spor)) fail('invalid-argument', 'Ukjent spor for denne saken.');

  const iso = deps.now().toISOString();
  const arsakId = deps.db.ref(`/sakArsaker/${sakId}`).push().key;
  const rec = { sporId, tekst, status, vurdertAv: actor, vurdertAt: iso, opprettetAv: actor, opprettetAt: iso, fjernet: false };
  if (grunnlag) rec.grunnlag = grunnlag;

  const updates = {
    [`/sakArsaker/${sakId}/${arsakId}`]: rec,
    ...sakEventWrites(sakId, eventsFor(deps, actor, [
      { type: 'arsak_opprettet', entityId: arsakId, felt: 'status', etter: status },
    ])),
  };
  await commit(deps, updates, 'Årsaken kunne ikke lagres. Prøv igjen.');
  return { sakId, arsakId };
}

/**
 * Endrer status/grunnlag på stedet, reviderer teksten (ny årsak som erstatter den gamle), eller fjerner.
 *  - Revisjon av tekst nullstiller status til «hypotese» med mindre status oppgis eksplisitt, slik at
 *    «bekreftet» aldri stilltiende følger med over på endret ordlyd.
 *  - En fjernet årsak kan ikke endres (append-only): registrer en ny.
 */
async function updateArsak(deps, uid, raw) {
  const input = objectInput(raw, ['sakId', 'arsakId', 'status', 'grunnlag', 'tekst', 'fjern']);
  const actor = await requireAuthorized(deps, uid);
  const sakId = requireId(input.sakId, 'sakId');
  const arsakId = requireId(input.arsakId, 'arsakId');
  if (input.fjern !== undefined && typeof input.fjern !== 'boolean') fail('invalid-argument', 'fjern må være true eller false.');
  const fjern = input.fjern === true;
  if (fjern && ['status', 'grunnlag', 'tekst'].some((k) => input[k] !== undefined)) {
    fail('invalid-argument', 'fjern kan ikke kombineres med andre endringer.');
  }
  const tekst = cleanText(input.tekst, 'Tekst', { min: LIMITS.arsakTekst.min, max: LIMITS.arsakTekst.max });
  if (input.tekst !== undefined && !tekst) fail('invalid-argument', 'Tekst kan ikke være tom.');
  const grunnlag = cleanText(input.grunnlag, 'Grunnlag', { max: LIMITS.grunnlag.max });
  const nyStatus = arsakStatus(input.status, undefined);
  if (!fjern && tekst === undefined && grunnlag === undefined && nyStatus === undefined) {
    fail('invalid-argument', 'Ingenting å endre.');
  }

  const sak = await loadSak(deps, sakId);
  assertOpen(sak);
  const gammel = (await deps.db.ref(`/sakArsaker/${sakId}/${arsakId}`).get()).val();
  if (!isObject(gammel)) fail('not-found', 'Årsaken finnes ikke.');
  if (gammel.fjernet === true) fail('failed-precondition', 'Årsaken er fjernet og kan ikke endres. Registrer en ny.');

  const iso = deps.now().toISOString();

  if (fjern) {
    const updates = {
      [`/sakArsaker/${sakId}/${arsakId}/fjernet`]: true,
      ...sakEventWrites(sakId, eventsFor(deps, actor, [{ type: 'arsak_fjernet', entityId: arsakId, felt: 'fjernet', etter: true }])),
    };
    await commit(deps, updates, 'Årsaken kunne ikke fjernes. Prøv igjen.');
    return { sakId, arsakId, endret: true };
  }

  // Revisjon: ny ordlyd => ny årsak som erstatter den gamle.
  if (tekst !== undefined && tekst !== gammel.tekst) {
    const status = nyStatus || 'hypotese';
    const nyttGrunnlag = grunnlag === undefined ? undefined : grunnlag;
    requireGrunnlag(status, nyttGrunnlag);
    const nyId = deps.db.ref(`/sakArsaker/${sakId}`).push().key;
    const rec = {
      sporId: gammel.sporId, tekst, status, vurdertAv: actor, vurdertAt: iso,
      opprettetAv: actor, opprettetAt: iso, fjernet: false, erstatter: arsakId,
    };
    if (nyttGrunnlag) rec.grunnlag = nyttGrunnlag;
    const updates = {
      [`/sakArsaker/${sakId}/${nyId}`]: rec,
      [`/sakArsaker/${sakId}/${arsakId}/fjernet`]: true,
      ...sakEventWrites(sakId, eventsFor(deps, actor, [
        { type: 'arsak_opprettet', entityId: nyId, felt: 'erstatter', etter: arsakId },
        { type: 'arsak_fjernet', entityId: arsakId, felt: 'erstattetAv', etter: nyId },
      ])),
    };
    await commit(deps, updates, 'Årsaken kunne ikke revideres. Prøv igjen.');
    return { sakId, arsakId: nyId, erstattet: arsakId, endret: true };
  }

  // Endring på stedet: status og/eller grunnlag.
  const status = nyStatus || gammel.status || 'hypotese';
  const effektivtGrunnlag = grunnlag === undefined ? clean(gammel.grunnlag) : grunnlag;
  requireGrunnlag(status, effektivtGrunnlag);
  const statusEndret = status !== (gammel.status || 'hypotese');
  const grunnlagEndret = grunnlag !== undefined && grunnlag !== clean(gammel.grunnlag);
  if (!statusEndret && !grunnlagEndret) return { sakId, arsakId, endret: false };

  const updates = {
    [`/sakArsaker/${sakId}/${arsakId}/vurdertAv`]: actor,
    [`/sakArsaker/${sakId}/${arsakId}/vurdertAt`]: iso,
  };
  const hendelser = [];
  if (statusEndret) {
    updates[`/sakArsaker/${sakId}/${arsakId}/status`] = status;
    hendelser.push({ type: 'arsak_endret', entityId: arsakId, felt: 'status', foer: gammel.status || 'hypotese', etter: status });
  }
  if (grunnlagEndret) {
    updates[`/sakArsaker/${sakId}/${arsakId}/grunnlag`] = grunnlag || null;
    hendelser.push({ type: 'arsak_endret', entityId: arsakId, felt: 'grunnlag' }); // fritekst logges ikke
  }
  Object.assign(updates, sakEventWrites(sakId, eventsFor(deps, actor, hendelser)));
  await commit(deps, updates, 'Årsaken kunne ikke oppdateres. Prøv igjen.');
  return { sakId, arsakId, endret: true };
}

module.exports = {
  SakError,
  SAK_STATUSER,
  ARSAK_STATUSER,
  LIMITS,
  createSak,
  getSaker,
  getSak,
  updateSak,
  setTiltakSak,
  removeTiltakSak,
  createArsak,
  updateArsak,
};
