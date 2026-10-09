'use strict';

/*
 * Ren hendelseslogikk for Saker MVP-0 (ingen avhengighet til firebase-functions).
 * Brukes av tiltak-events.js (triggere) og senere av sak-callables (sakEvents).
 *
 * Regler:
 *  - Hendelser er append-only og skrives bare av server (Cloud Functions / admin SDK).
 *  - Hendelses-id er deterministisk for triggere (event.id), slik at levering "minst én gang"
 *    ikke gir duplikater.
 *  - Fritekst logges ikke ukritisk: aldri beskrivelse, tittel eller kommentartekst.
 *    nestesteg kuttes til NESTESTEG_MAX tegn.
 *  - Tomme verdier utelates (RTDB lagrer ikke null). Fravær av foer/etter betyr "tom".
 */

const TILTAK_EVENT_FIELDS = Object.freeze([
  'status', 'eier', 'prioritet', 'frist', 'kategori', 'omrade', 'sakId', 'nestesteg',
  'livssyklus', 'miljo',
]);
const NESTESTEG_MAX = 200;
const VALUE_MAX = 300;
const MAX_LEGACY_COMMENTS_PER_WRITE = 20;

const SAK_EVENT_TYPES = Object.freeze([
  'sak_opprettet', 'sak_endret',
  'tiltak_koblet', 'tiltak_frakoblet', 'spor_koblet', 'spor_frakoblet',
  'arsak_opprettet', 'arsak_endret', 'arsak_fjernet',
]);

// RTDB-nøkler: ikke . $ # [ ] / eller kontrolltegn, maks 700 tegn.
const SAFE_ID = /^[^.#$\[\]/\u0000-\u001f\u007f]{1,700}$/;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function clean(value) {
  return String(value ?? '').trim();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clip(value, max) {
  const text = clean(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function safeKeyPart(value, max) {
  return clean(value).replace(/[^A-Za-z0-9_-]/g, '').slice(0, max);
}

function assertSafeId(label, value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Ugyldig ${label}`);
  return value;
}

/** Gyldig tidspunkt som ISO-streng, ellers null. */
function isoOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Klient-satte tidspunkt (eldre kommentarer) kan være feil eller i fremtiden og ville forskjøvet
 * «siste aktivitet». Alt senere enn hendelsestiden + 5 min erstattes av hendelsestiden.
 */
function clampedIso(value, eventIso) {
  const own = isoOrNull(value);
  if (!own) return eventIso;
  return Date.parse(own) > Date.parse(eventIso) + FUTURE_SKEW_MS ? eventIso : own;
}

/** Kronologisk sorterbar, deterministisk nøkkel: 13 sifre epoch-ms + id + felt. */
function eventKey(ms, uniq, felt) {
  const time = String(Math.max(0, Math.trunc(Number(ms) || 0))).padStart(13, '0');
  const id = safeKeyPart(uniq, 32) || 'x';
  const field = felt ? '-' + safeKeyPart(felt, 48) : '';
  return `${time}-${id}${field}`;
}

function resolveTime(eventTimeIso, now) {
  const iso = isoOrNull(eventTimeIso) || (now instanceof Date ? now : new Date()).toISOString();
  return { iso, ms: Date.parse(iso) };
}

function actorFields(authId, authType) {
  const out = {};
  const uid = clean(authId);
  const type = clean(authType).slice(0, 30);
  if (uid) out.actorUid = uid;
  if (type) out.actorType = type;
  return out;
}

function fieldValue(task, field) {
  const text = clean(task?.[field]);
  return text;
}

function storedValue(field, text) {
  return field === 'nestesteg' ? clip(text, NESTESTEG_MAX) : text;
}

function snapshotFields(task) {
  const out = {};
  for (const field of TILTAK_EVENT_FIELDS) {
    const text = fieldValue(task, field);
    if (text) out[field] = storedValue(field, text);
  }
  return out;
}

/**
 * Bygger hendelser for én skriving på /tiltak/{taskId}.
 * Returnerer [{key, entry}] sortert på nøkkel. Tom liste hvis ingenting relevant er endret.
 */
function buildTiltakEvents({ before, after, eventId, eventTimeIso, authId, authType, now } = {}) {
  const prev = isObject(before) ? before : null;
  const next = isObject(after) ? after : null;
  if (!prev && !next) return [];

  const { iso, ms } = resolveTime(eventTimeIso, now);
  const actor = actorFields(authId, authType);
  const out = [];
  const push = (felt, entry) => out.push({ key: eventKey(ms, eventId, felt), entry: { ...entry, createdAt: iso, ...actor } });

  if (!prev && next) {
    const etter = snapshotFields(next);
    push('opprettet', { type: 'opprettet', ...(Object.keys(etter).length ? { etter } : {}) });
    return out;
  }
  if (prev && !next) {
    const foer = snapshotFields(prev);
    push('slettet', { type: 'slettet', ...(Object.keys(foer).length ? { foer } : {}) });
    return out;
  }

  for (const field of TILTAK_EVENT_FIELDS) {
    const a = fieldValue(prev, field);
    const b = fieldValue(next, field);
    if (a === b) continue;
    const entry = { type: 'endret', felt: field };
    if (a) entry.foer = storedValue(field, a);
    if (b) entry.etter = storedValue(field, b);
    if (field === 'nestesteg' && (a.length > NESTESTEG_MAX || b.length > NESTESTEG_MAX)) entry.avkortet = true;
    push(field, entry);
  }

  for (const legacy of buildLegacyCommentEvents({ before: prev, after: next, eventId, eventTimeIso: iso, authId })) {
    out.push(legacy);
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/**
 * Eldre kommentarer ligger som tiltak/{id}/kommentarer/{key} og skrives direkte av klienten.
 * Nye barn oppdages ved diff. Teksten og visningsnavnet logges aldri.
 */
function buildLegacyCommentEvents({ before, after, eventId, eventTimeIso, authId } = {}) {
  const prevComments = isObject(before?.kommentarer) || Array.isArray(before?.kommentarer) ? before.kommentarer : {};
  const nextComments = after?.kommentarer;
  if (!isObject(nextComments) && !Array.isArray(nextComments)) return [];
  const { iso, ms } = resolveTime(eventTimeIso);
  const uid = clean(authId);
  const out = [];
  for (const id of Object.keys(nextComments)) {
    if (out.length >= MAX_LEGACY_COMMENTS_PER_WRITE) break;
    if (Object.prototype.hasOwnProperty.call(prevComments, id)) continue;
    const comment = nextComments[id];
    const entry = {
      type: 'kommentar',
      kommentarId: safeKeyPart(id, 60) || 'x',
      kilde: 'kommentarer',
      createdAt: clampedIso(isObject(comment) ? comment.tidspunkt : null, iso),
    };
    if (uid) entry.forfatterUid = uid;
    out.push({ key: eventKey(ms, eventId, 'kommentar-' + entry.kommentarId), entry });
  }
  return out;
}

/** Hendelse for en ny kommentar i /taskComments/{taskId}/{commentId}. Ingen tekst, ingen visningsnavn. */
function buildCommentEvent({ commentId, comment, eventId, eventTimeIso, now } = {}) {
  const id = safeKeyPart(commentId, 60);
  if (!id) return null;
  const { iso, ms } = resolveTime(eventTimeIso, now);
  const entry = {
    type: 'kommentar',
    kommentarId: id,
    kilde: 'taskComments',
    createdAt: clampedIso(isObject(comment) ? comment.createdAt : null, iso),
  };
  const author = clean(isObject(comment) ? comment.authorUid : '');
  if (author) entry.forfatterUid = author;
  return { key: eventKey(ms, eventId, 'kommentar'), entry };
}

/* ---------- sakEvents (grunnlag; brukes av callables i senere steg) ---------- */

function randomHex(bytes = 4) {
  return require('node:crypto').randomBytes(bytes).toString('hex');
}

function sakEventValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = clip(value, VALUE_MAX);
  return text || undefined;
}

/**
 * Bygger én sakhendelse. Callable skriver den i samme atomiske update som selve endringen.
 * actorUid er påkrevd (callables har alltid request.auth.uid).
 */
function buildSakEvent({ type, entityId, felt, foer, etter, actorUid, now, rand } = {}) {
  if (!SAK_EVENT_TYPES.includes(type)) throw new Error(`Ukjent sakhendelse: ${type}`);
  const actor = clean(actorUid);
  if (!actor) throw new Error('actorUid mangler');
  const when = now instanceof Date ? now : new Date();
  const entry = { type, createdAt: when.toISOString(), actorUid: actor };
  if (entityId !== undefined && entityId !== null && entityId !== '') entry.entityId = assertSafeId('entityId', String(entityId));
  if (felt) entry.felt = safeKeyPart(felt, 24);
  const before = sakEventValue(foer);
  const after = sakEventValue(etter);
  if (before !== undefined) entry.foer = before;
  if (after !== undefined) entry.etter = after;
  const suffix = typeof rand === 'function' ? rand() : randomHex(4);
  return { key: eventKey(when.getTime(), suffix, entry.felt), entry };
}

/** Flat multi-path-map til admin.database().ref().update(...). */
function sakEventWrites(sakId, events) {
  assertSafeId('sakId', sakId);
  const writes = {};
  for (const { key, entry } of events) writes[`/sakEvents/${sakId}/${key}`] = entry;
  return writes;
}

/* ---------- skriving (DB injiseres, slik at alt kan testes uten Firebase) ---------- */

async function writeTiltakEvents(db, taskId, events) {
  assertSafeId('taskId', taskId);
  if (!events.length) return 0;
  const writes = {};
  for (const { key, entry } of events) writes[`/tiltakEvents/${taskId}/${key}`] = entry;
  await db.ref().update(writes);
  return events.length;
}

/**
 * Feil i selve byggingen (uventede data) logges og svelges: de skal ikke trigge retry i 7 dager.
 * Feil i databaseskrivingen kastes videre slik at plattformen kan prøve igjen (nøklene er deterministiske).
 */
async function processTiltakWrite(ctx, db, log = console) {
  let events;
  try {
    assertSafeId('taskId', ctx?.taskId);
    events = buildTiltakEvents(ctx);
  } catch (error) {
    log.error('logTiltakEventsV1: kunne ikke bygge hendelser', { taskId: ctx?.taskId, eventId: ctx?.eventId, error: String(error?.message || error) });
    return 0;
  }
  return writeTiltakEvents(db, ctx.taskId, events);
}

async function processCommentCreated(ctx, db, log = console) {
  let built;
  try {
    assertSafeId('taskId', ctx?.taskId);
    built = buildCommentEvent(ctx);
  } catch (error) {
    log.error('logTaskCommentEventV1: kunne ikke bygge hendelse', { taskId: ctx?.taskId, eventId: ctx?.eventId, error: String(error?.message || error) });
    return 0;
  }
  if (!built) return 0;
  return writeTiltakEvents(db, ctx.taskId, [built]);
}

module.exports = {
  TILTAK_EVENT_FIELDS,
  NESTESTEG_MAX,
  SAK_EVENT_TYPES,
  eventKey,
  isoOrNull,
  buildTiltakEvents,
  buildLegacyCommentEvents,
  buildCommentEvent,
  buildSakEvent,
  sakEventWrites,
  writeTiltakEvents,
  processTiltakWrite,
  processCommentCreated,
};
