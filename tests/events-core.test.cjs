'use strict';

// Kjør: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../functions/events-core');

const T0 = '2026-10-09T08:15:30.123Z';
const MS0 = Date.parse(T0);

const base = Object.freeze({
  tittel: 'Datokontroll ved mottak Frysa',
  beskrivelse: 'INTERN BESKRIVELSE SOM IKKE SKAL LOGGES',
  status: 'Aktiv',
  eier: 'Kenneth Nordbakk',
  prioritet: 'Høy',
  frist: '2026-10-20',
  kategori: 'Kvalitet',
  omrade: 'Ferdigmat',
  nestesteg: 'Avklar med Frysa',
  miljo: 'Produksjon',
  livssyklus: 'Aktiv',
});

const ctx = (before, after, extra = {}) => ({ before, after, eventId: 'evt-1', eventTimeIso: T0, ...extra });

test('statusendring gir én endret-hendelse med foer/etter og tidspunkt', () => {
  const events = core.buildTiltakEvents(ctx(base, { ...base, status: 'Fullført' }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].entry, { type: 'endret', felt: 'status', foer: 'Aktiv', etter: 'Fullført', createdAt: T0 });
});

test('flere felt endret gir én hendelse per felt, med unike og kronologisk sorterbare nøkler', () => {
  const events = core.buildTiltakEvents(ctx(base, { ...base, status: 'Fullført', eier: 'Tony Danielsen', frist: '2026-11-01', prioritet: 'Kritisk', kategori: 'HMS', omrade: 'Renhold' }));
  assert.deepEqual(events.map(e => e.entry.felt).sort(), ['eier', 'frist', 'kategori', 'omrade', 'prioritet', 'status']);
  assert.equal(new Set(events.map(e => e.key)).size, events.length);
  const keys = events.map(e => e.key);
  assert.deepEqual(keys, [...keys].sort());
  for (const { key } of events) assert.match(key, /^\d{13}-evt-1-[A-Za-z]+$/);
});

test('endringer i felt som ikke logges (tittel, beskrivelse, systemId) gir ingen hendelser', () => {
  const events = core.buildTiltakEvents(ctx(base, { ...base, tittel: 'Ny tittel', beskrivelse: 'Ny tekst', systemId: 'KVAL-0001' }));
  assert.deepEqual(events, []);
});

test('uendret tiltak og to tomme sider gir ingen hendelser', () => {
  assert.deepEqual(core.buildTiltakEvents(ctx(base, { ...base })), []);
  assert.deepEqual(core.buildTiltakEvents(ctx(null, null)), []);
  assert.deepEqual(core.buildTiltakEvents({}), []);
});

test('sakId: første kobling har ingen foer, frakobling har ingen etter, bytte har begge', () => {
  const set = core.buildTiltakEvents(ctx(base, { ...base, sakId: '-OsakA' }));
  assert.deepEqual(set[0].entry, { type: 'endret', felt: 'sakId', etter: '-OsakA', createdAt: T0 });
  const clear = core.buildTiltakEvents(ctx({ ...base, sakId: '-OsakA' }, { ...base }));
  assert.deepEqual(clear[0].entry, { type: 'endret', felt: 'sakId', foer: '-OsakA', createdAt: T0 });
  const move = core.buildTiltakEvents(ctx({ ...base, sakId: '-OsakA' }, { ...base, sakId: '-OsakB' }));
  assert.equal(move[0].entry.foer, '-OsakA');
  assert.equal(move[0].entry.etter, '-OsakB');
});

test('nyopprettet tiltak logger en opprettet-hendelse med bare de loggede feltene', () => {
  const events = core.buildTiltakEvents(ctx(null, base));
  assert.equal(events.length, 1);
  assert.equal(events[0].entry.type, 'opprettet');
  assert.equal(events[0].entry.etter.status, 'Aktiv');
  assert.equal(events[0].entry.etter.nestesteg, 'Avklar med Frysa');
  assert.equal('tittel' in events[0].entry.etter, false);
  assert.equal('beskrivelse' in events[0].entry.etter, false);
});

test('slettet tiltak logger en slettet-hendelse', () => {
  const events = core.buildTiltakEvents(ctx(base, null));
  assert.equal(events.length, 1);
  assert.equal(events[0].entry.type, 'slettet');
  assert.equal(events[0].entry.foer.eier, 'Kenneth Nordbakk');
});

test('sensitiv fritekst havner aldri i hendelsene', () => {
  const all = [
    ...core.buildTiltakEvents(ctx(null, base)),
    ...core.buildTiltakEvents(ctx(base, null)),
    ...core.buildTiltakEvents(ctx(base, { ...base, status: 'Stanset', beskrivelse: 'HEMMELIG NY TEKST' })),
  ];
  const json = JSON.stringify(all);
  assert.equal(json.includes('INTERN BESKRIVELSE'), false);
  assert.equal(json.includes('HEMMELIG NY TEKST'), false);
  assert.equal(json.includes('Datokontroll ved mottak'), false);
});

test('nestesteg kuttes til 200 tegn og merkes avkortet', () => {
  const long = 'x'.repeat(500);
  const [event] = core.buildTiltakEvents(ctx(base, { ...base, nestesteg: long }));
  assert.equal(event.entry.etter.length, core.NESTESTEG_MAX);
  assert.equal(event.entry.avkortet, true);
  assert.equal(event.entry.foer, 'Avklar med Frysa');
});

test('endring etter tegn 200 i nestesteg oppdages selv om de kuttede tekstene er like', () => {
  const a = 'y'.repeat(300) + 'A';
  const b = 'y'.repeat(300) + 'B';
  const events = core.buildTiltakEvents(ctx({ ...base, nestesteg: a }, { ...base, nestesteg: b }));
  assert.equal(events.length, 1);
  assert.equal(events[0].entry.avkortet, true);
});

test('testtiltak (miljo=Test) logges også', () => {
  const events = core.buildTiltakEvents(ctx({ ...base, miljo: 'Test' }, { ...base, miljo: 'Test', status: 'Fullført' }));
  assert.equal(events.length, 1);
  assert.equal(events[0].entry.felt, 'status');
});

test('papirkurv og miljøbytte logges via livssyklus og miljo', () => {
  const events = core.buildTiltakEvents(ctx(base, { ...base, livssyklus: 'Papirkurv', miljo: 'Test' }));
  assert.deepEqual(events.map(e => e.entry.felt).sort(), ['livssyklus', 'miljo']);
});

test('aktør settes bare når plattformen leverer den', () => {
  const none = core.buildTiltakEvents(ctx(base, { ...base, status: 'Fullført' }));
  assert.equal('actorUid' in none[0].entry, false);
  assert.equal('actorType' in none[0].entry, false);
  const some = core.buildTiltakEvents(ctx(base, { ...base, status: 'Fullført' }, { authId: 'uid-123', authType: 'app_user' }));
  assert.equal(some[0].entry.actorUid, 'uid-123');
  assert.equal(some[0].entry.actorType, 'app_user');
});

test('samme levering to ganger gir identiske nøkler (idempotent)', () => {
  const after = { ...base, status: 'Fullført', eier: 'Tony Danielsen' };
  const a = core.buildTiltakEvents(ctx(base, after));
  const b = core.buildTiltakEvents(ctx(base, after));
  assert.deepEqual(a, b);
});

test('ugyldig eller manglende hendelsestid faller tilbake til now', () => {
  const now = new Date('2026-10-09T10:00:00.000Z');
  const [event] = core.buildTiltakEvents({ before: base, after: { ...base, status: 'Fullført' }, eventId: 'e', eventTimeIso: 'ikke-en-dato', now });
  assert.equal(event.entry.createdAt, now.toISOString());
});

test('verdier med mellomrom normaliseres: "Aktiv " og "Aktiv" er ikke en endring', () => {
  assert.deepEqual(core.buildTiltakEvents(ctx(base, { ...base, status: ' Aktiv ' })), []);
});

test('nøkkelen er sikker for RTDB selv med rare hendelses-id-er', () => {
  const key = core.eventKey(MS0, 'a/b.c$d#e[f]g', 'sak/Id');
  assert.match(key, /^\d{13}-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/);
  assert.equal(/[.#$\[\]/]/.test(key), false);
});

/* ---------- kommentarer ---------- */

test('ny kommentar i taskComments logger id, forfatter, tidspunkt og aldri tekst', () => {
  const event = core.buildCommentEvent({
    commentId: '-Ocomment1',
    comment: { text: 'FØLSOM KOMMENTARTEKST', authorName: 'Kenneth Nordbakk', authorUid: 'uid-k', createdAt: '2026-10-09T07:00:00.000Z' },
    eventId: 'evt-9', eventTimeIso: T0,
  });
  assert.deepEqual(event.entry, {
    type: 'kommentar', kommentarId: '-Ocomment1', kilde: 'taskComments', createdAt: '2026-10-09T07:00:00.000Z', forfatterUid: 'uid-k',
  });
  assert.equal(JSON.stringify(event).includes('FØLSOM'), false);
  assert.equal(JSON.stringify(event).includes('Kenneth'), false);
});

test('kommentar uten gyldig createdAt bruker hendelsestid, og uten forfatter utelates forfatterUid', () => {
  const event = core.buildCommentEvent({ commentId: 'c1', comment: { text: 'x', createdAt: 'rot' }, eventId: 'e', eventTimeIso: T0 });
  assert.equal(event.entry.createdAt, T0);
  assert.equal('forfatterUid' in event.entry, false);
});

test('kommentar uten id gir ingen hendelse', () => {
  assert.equal(core.buildCommentEvent({ commentId: '', comment: {}, eventId: 'e', eventTimeIso: T0 }), null);
});

test('eldre kommentar skrevet direkte på tiltaket (kommentarer/{key}) oppdages, uten tekst og navn', () => {
  const before = { ...base, kommentarer: { k1: { tekst: 'gammel', bruker: 'A', tidspunkt: '2026-10-01T10:00:00.000Z' } } };
  const after = {
    ...before,
    kommentarer: { ...before.kommentarer, k2: { tekst: 'HEMMELIG LEGACY', bruker: 'Erling Magnussen', tidspunkt: '2026-10-09T08:00:00.000Z' } },
  };
  const events = core.buildTiltakEvents(ctx(before, after, { authId: 'uid-e' }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].entry, {
    type: 'kommentar', kommentarId: 'k2', kilde: 'kommentarer', createdAt: '2026-10-09T08:00:00.000Z', forfatterUid: 'uid-e',
  });
  assert.equal(JSON.stringify(events).includes('HEMMELIG'), false);
  assert.equal(JSON.stringify(events).includes('Erling'), false);
});

test('eksisterende eldre kommentarer gir ingen nye hendelser', () => {
  const t = { ...base, kommentarer: { k1: { tekst: 'a', tidspunkt: '2026-10-01T10:00:00.000Z' } } };
  assert.deepEqual(core.buildTiltakEvents(ctx(t, { ...t, status: 'Aktiv' })), []);
});

/* ---------- sakEvents ---------- */

test('sakhendelse bygges med aktør og gyldig type', () => {
  const now = new Date('2026-10-09T09:00:00.000Z');
  const { key, entry } = core.buildSakEvent({ type: 'tiltak_koblet', entityId: '-Otiltak1', felt: 'sakId', etter: '-Osak1', actorUid: 'uid-t', now, rand: () => 'abcd1234' });
  assert.deepEqual(entry, { type: 'tiltak_koblet', createdAt: now.toISOString(), actorUid: 'uid-t', entityId: '-Otiltak1', felt: 'sakId', etter: '-Osak1' });
  assert.equal(key, `${String(now.getTime()).padStart(13, '0')}-abcd1234-sakId`);
});

test('sakhendelse avvises ved ukjent type, manglende aktør eller usikker id', () => {
  assert.throws(() => core.buildSakEvent({ type: 'noe_annet', actorUid: 'u' }), /Ukjent sakhendelse/);
  assert.throws(() => core.buildSakEvent({ type: 'sak_endret' }), /actorUid/);
  assert.throws(() => core.buildSakEvent({ type: 'sak_endret', actorUid: 'u', entityId: 'a/b' }), /entityId/);
});

test('sakhendelse kutter lange verdier og beholder tall/boolean', () => {
  const { entry } = core.buildSakEvent({ type: 'arsak_endret', entityId: 'a1', felt: 'status', foer: 'z'.repeat(1000), etter: 3, actorUid: 'u' });
  assert.equal(entry.foer.length, 300);
  assert.equal(entry.etter, 3);
});

test('sakEventWrites lager flate stier og avviser usikker sakId', () => {
  const ev = core.buildSakEvent({ type: 'sak_opprettet', entityId: 's1', actorUid: 'u', rand: () => 'r1' });
  const writes = core.sakEventWrites('-Osak1', [ev]);
  assert.deepEqual(Object.keys(writes), [`/sakEvents/-Osak1/${ev.key}`]);
  assert.throws(() => core.sakEventWrites('a/b', [ev]), /sakId/);
});

/* ---------- skriving med fake database ---------- */

function fakeDb() {
  const calls = [];
  return { calls, ref() { return { update: async updates => { calls.push(updates); } }; } };
}

test('processTiltakWrite skriver alle hendelser i ÉN atomisk update under /tiltakEvents/{id}', async () => {
  const db = fakeDb();
  const n = await core.processTiltakWrite({ taskId: '-Ot1', ...ctx(base, { ...base, status: 'Fullført', eier: 'Tony Danielsen' }) }, db);
  assert.equal(n, 2);
  assert.equal(db.calls.length, 1);
  const paths = Object.keys(db.calls[0]);
  assert.equal(paths.length, 2);
  for (const p of paths) assert.match(p, /^\/tiltakEvents\/-Ot1\/\d{13}-evt-1-/);
});

test('processTiltakWrite uten relevante endringer gjør ingen skriving', async () => {
  const db = fakeDb();
  assert.equal(await core.processTiltakWrite({ taskId: '-Ot1', ...ctx(base, { ...base, tittel: 'x' }) }, db), 0);
  assert.equal(db.calls.length, 0);
});

test('processTiltakWrite svelger byggefeil (ingen retry-storm) men kaster databasefeil', async () => {
  const errors = [];
  const log = { error: (...a) => errors.push(a) };
  const poison = { before: base, get after() { throw new Error('kaboom'); }, eventId: 'e', eventTimeIso: T0, taskId: '-Ot1' };
  assert.equal(await core.processTiltakWrite(poison, fakeDb(), log), 0);
  assert.equal(errors.length, 1);
  const failing = { ref() { return { update: async () => { throw new Error('db nede'); } }; } };
  await assert.rejects(core.processTiltakWrite({ taskId: '-Ot1', ...ctx(base, { ...base, status: 'Fullført' }) }, failing), /db nede/);
});

test('processCommentCreated skriver kommentar-hendelse under tiltaket', async () => {
  const db = fakeDb();
  const n = await core.processCommentCreated({ taskId: '-Ot1', commentId: '-Oc1', comment: { text: 't', authorUid: 'u1', createdAt: T0 }, eventId: 'evt-2', eventTimeIso: T0 }, db);
  assert.equal(n, 1);
  const [path, entry] = Object.entries(db.calls[0])[0];
  assert.match(path, /^\/tiltakEvents\/-Ot1\/\d{13}-evt-2-kommentar$/);
  assert.equal(entry.kommentarId, '-Oc1');
});

test('writeTiltakEvents avviser usikker tiltak-id', async () => {
  await assert.rejects(core.writeTiltakEvents(fakeDb(), 'a/b', [{ key: 'k', entry: {} }]), /taskId/);
});

test('id-er med mellomrom er gyldige RTDB-nøkler, men / . # $ [ ] avvises', async () => {
  const db = fakeDb();
  await core.writeTiltakEvents(db, 'gammel nøkkel 1', [{ key: 'k', entry: { type: 'endret' } }]);
  assert.deepEqual(Object.keys(db.calls[0]), ['/tiltakEvents/gammel nøkkel 1/k']);
  for (const bad of ['a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', '', 'a\u0000b']) {
    await assert.rejects(core.writeTiltakEvents(fakeDb(), bad, [{ key: 'k', entry: {} }]), /taskId/, JSON.stringify(bad));
  }
});

test('ugyldig tiltak-id i en trigger logges og svelges (ingen retry-løkke)', async () => {
  const errors = [];
  const log = { error: (...a) => errors.push(a) };
  const db = fakeDb();
  assert.equal(await core.processTiltakWrite({ taskId: 'a/b', ...ctx(base, { ...base, status: 'Fullført' }) }, db, log), 0);
  assert.equal(await core.processCommentCreated({ taskId: undefined, commentId: 'c', comment: {}, eventId: 'e', eventTimeIso: T0 }, db, log), 0);
  assert.equal(errors.length, 2);
  assert.equal(db.calls.length, 0);
});

test('kommentartid i fremtiden (klient-satt) erstattes av hendelsestiden; små avvik beholdes', () => {
  const future = core.buildCommentEvent({ commentId: 'c1', comment: { createdAt: '2030-01-01T00:00:00.000Z' }, eventId: 'e', eventTimeIso: T0 });
  assert.equal(future.entry.createdAt, T0);
  const skew = core.buildCommentEvent({ commentId: 'c2', comment: { createdAt: '2026-10-09T08:17:00.000Z' }, eventId: 'e', eventTimeIso: T0 });
  assert.equal(skew.entry.createdAt, '2026-10-09T08:17:00.000Z');
  const before = { ...base, kommentarer: {} };
  const after = { ...base, kommentarer: { k1: { tekst: 'x', tidspunkt: '2031-05-05T00:00:00.000Z' } } };
  const [legacy] = core.buildTiltakEvents(ctx(before, after));
  assert.equal(legacy.entry.createdAt, T0);
});
