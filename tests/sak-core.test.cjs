'use strict';

// Kjør: node --test tests/*.test.cjs
// Datalaget testes mot en SIMULERT database (tests/helpers/fake-rtdb.cjs). Det beviser logikken og
// konsistensen i skrivingene, ikke at ekte Firebase oppfører seg likt. Se docs/saker-mvp0.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../functions/sak-core');
const L = require('../saker/sak-logic');
const { FakeRtdb } = require('./helpers/fake-rtdb.cjs');

const A = 'uid-a';
const B = 'uid-b';
const NEI = 'uid-nei';
const T0 = Date.parse('2026-10-09T10:00:00.000Z');

function env(initial = {}, opts = {}) {
  const db = new FakeRtdb({ authorizedUsers: { [A]: true, [B]: true, [NEI]: false }, ...initial }, opts);
  let t = T0;
  const errors = [];
  const deps = { db, now: () => new Date(t), sleep: async () => {}, log: { error: (...a) => errors.push(a) } };
  return { db, deps, errors, tick: (ms = 1000) => { t += ms; } };
}

const tiltak = (over = {}) => ({
  tittel: 'Datokontroll ved mottak', beskrivelse: 'INTERN BESKRIVELSE', status: 'Aktiv', eier: 'Kenneth Nordbakk',
  frist: '2026-10-20', miljo: 'Produksjon', livssyklus: 'Aktiv',
  kommentarer: { k1: { tekst: 'gammel kommentar', bruker: 'A', tidspunkt: '2026-10-01T10:00:00.000Z' } },
  ...over,
});

const PROBLEM = 'Restlager av ribbefett fra 2025 er blitt identifisert med utgått holdbarhet. Saken skal avklare hvorfor restlageret oppsto, hvorfor varen endte som kassasjon og hvilke barrierer som skal forhindre gjentakelse.';

async function ribbefett(e, uid = A) {
  const r = await core.createSak(e.deps, uid, {
    tittel: 'Ribbefett 2025 – restlager og kassasjon',
    problemstilling: PROBLEM,
    omrader: ['Ferdigmat', 'Frysa', 'Plan', 'Kvalitet'],
    spor: [{ sporsmal: 'Hvorfor oppsto restlageret?' }, { sporsmal: 'Hvorfor endte restlageret som kassasjon?' }],
  });
  return { ...r, sporA: r.sporIds[0].sporId, sporB: r.sporIds[1].sporId };
}

async function rejectsWith(promise, code, message) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof core.SakError, 'forventet SakError, fikk ' + (err && err.stack));
    assert.equal(err.code, code, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
}

const sakEvents = (db, sakId) => Object.entries(db.at(`/sakEvents/${sakId}`) || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
const typer = (db, sakId) => sakEvents(db, sakId).map((e) => e.type);

/* ============================================================== tilgang */

const OPERASJONER = [
  ['createSak', (e, uid) => core.createSak(e.deps, uid, { tittel: 'Testsak' })],
  ['getSaker', (e, uid) => core.getSaker(e.deps, uid, {})],
  ['getSak', (e, uid) => core.getSak(e.deps, uid, { sakId: '-Os1' })],
  ['updateSak', (e, uid) => core.updateSak(e.deps, uid, { sakId: '-Os1', status: 'Løst' })],
  ['setTiltakSak', (e, uid) => core.setTiltakSak(e.deps, uid, { sakId: '-Os1', tiltakId: '-Ot1' })],
  ['removeTiltakSak', (e, uid) => core.removeTiltakSak(e.deps, uid, { sakId: '-Os1', tiltakId: '-Ot1' })],
  ['createArsak', (e, uid) => core.createArsak(e.deps, uid, { sakId: '-Os1', sporId: '-Op1', tekst: 'Årsak' })],
  ['updateArsak', (e, uid) => core.updateArsak(e.deps, uid, { sakId: '-Os1', arsakId: '-Oa1', status: 'støttet', grunnlag: 'Grunnlag' })],
];

test('uten innlogging avvises alle operasjoner (unauthenticated)', async () => {
  for (const [navn, kjor] of OPERASJONER) {
    for (const uid of [undefined, null, '', '   ']) {
      await rejectsWith(kjor(env(), uid), 'unauthenticated').catch((e) => { throw new Error(`${navn}: ${e.message}`); });
    }
  }
});

test('bruker som ikke er i authorizedUsers avvises (permission-denied) og ingenting skrives', async () => {
  for (const [navn, kjor] of OPERASJONER) {
    for (const uid of [NEI, 'uid-ukjent', 'a/b', '../x']) {
      const e = env();
      await rejectsWith(kjor(e, uid), 'permission-denied').catch((err) => { throw new Error(`${navn}/${uid}: ${err.message}`); });
      assert.equal(e.db.updateCalls.length, 0, navn);
      assert.equal(e.db.at('/counters'), null, navn);
      assert.equal(e.db.at('/saker'), null, navn);
    }
  }
});

test('ukjente felt i forespørselen avvises, så forfalsket identitet/tidsstempel aldri kan sendes inn', async () => {
  const e = env();
  const r = await ribbefett(e);
  for (const forged of [{ vurdertAv: B }, { actorUid: B }, { opprettetAv: B }, { opprettetAt: '2000-01-01T00:00:00Z' }, { vurdertAt: '2000-01-01T00:00:00Z' }, { kode: 'SAK-9999' }]) {
    await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Årsak', ...forged }), 'invalid-argument', /Ukjente felt/);
    await rejectsWith(core.createSak(e.deps, A, { tittel: 'Ny sak', ...forged }), 'invalid-argument', /Ukjente felt/);
    await rejectsWith(core.updateSak(e.deps, A, { sakId: r.sakId, status: 'Løst', ...forged }), 'invalid-argument', /Ukjente felt/);
    await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', ...forged }), 'invalid-argument', /Ukjente felt/);
  }
  await rejectsWith(core.getSaker(e.deps, A, { filter: 'x' }), 'invalid-argument');
  await rejectsWith(core.createSak(e.deps, A, 'tekst'), 'invalid-argument');
  await rejectsWith(core.createSak(e.deps, A, [1]), 'invalid-argument');
});

/* ============================================================== opprette sak */

test('opprette Ribbefett: servergenerert SAK-0001, spor A/B, hendelse med riktig bruker, ÉN atomisk skriving', async () => {
  const e = env();
  const r = await ribbefett(e);
  assert.equal(r.kode, 'SAK-0001');
  assert.match(r.sakId, /^-Ofake/, 'primærnøkkel er push-id');
  assert.deepEqual(r.sporIds.map((s) => s.kode), ['A', 'B']);

  assert.deepEqual(e.db.at(`/saker/${r.sakId}`), {
    kode: 'SAK-0001', tittel: 'Ribbefett 2025 – restlager og kassasjon', problemstilling: PROBLEM,
    eierUid: A, status: 'Åpen', omrader: { Ferdigmat: true, Frysa: true, Plan: true, Kvalitet: true },
    opprettetAt: '2026-10-09T10:00:00.000Z', opprettetAv: A,
  });
  assert.deepEqual(e.db.at(`/sakSpor/${r.sakId}/${r.sporA}`), { kode: 'A', sporsmal: 'Hvorfor oppsto restlageret?', rekkefolge: 1 });
  assert.deepEqual(e.db.at(`/sakSpor/${r.sakId}/${r.sporB}`), { kode: 'B', sporsmal: 'Hvorfor endte restlageret som kassasjon?', rekkefolge: 2 });
  assert.equal(e.db.at('/counters/sak'), 1);

  const ev = sakEvents(e.db, r.sakId);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { type: 'sak_opprettet', createdAt: '2026-10-09T10:00:00.000Z', actorUid: A, entityId: r.sakId, felt: 'kode', etter: 'SAK-0001' });

  assert.equal(e.db.updateCalls.length, 1, 'sak, spor og hendelse i én atomisk update');
  const paths = Object.keys(e.db.updateCalls[0]);
  assert.ok(paths.some((p) => p.startsWith('/saker/')) && paths.some((p) => p.startsWith('/sakSpor/')) && paths.some((p) => p.startsWith('/sakEvents/')));
  assert.equal('sistOppdatert' in e.db.at(`/saker/${r.sakId}`), false, 'aggregater lagres ikke');
});

test('neste sak får SAK-0002, og nummeret leses ikke ved å skanne eksisterende saker', async () => {
  const e = env();
  await ribbefett(e);
  e.db.reads.length = 0;
  const r2 = await core.createSak(e.deps, B, { tittel: 'Neste sak' });
  assert.equal(r2.kode, 'SAK-0002');
  assert.equal(e.db.at(`/saker/${r2.sakId}/opprettetAv`), B, 'identitet fra innlogget bruker');
  assert.equal(e.db.at(`/saker/${r2.sakId}/eierUid`), B, 'eier defaulter til innlogget bruker');
  assert.equal(e.db.reads.includes('/saker'), false, 'ingen skanning av /saker');
  assert.equal(e.db.at('/counters/sak'), 2);
});

test('samtidige opprettelser (og kald transaksjonscache) gir unike saksnummer uten duplikater', async () => {
  for (const cold of [false, true]) {
    const e = env({}, { coldTransactions: cold });
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => core.createSak(e.deps, i % 2 ? A : B, { tittel: 'Sak nummer ' + i })));
    const koder = res.map((r) => r.kode).sort();
    assert.deepEqual(koder, ['SAK-0001', 'SAK-0002', 'SAK-0003', 'SAK-0004', 'SAK-0005', 'SAK-0006'], 'cold=' + cold);
    assert.equal(new Set(res.map((r) => r.sakId)).size, 6);
    assert.equal(e.db.at('/counters/sak'), 6);
  }
});

test('eier kan settes til annen godkjent bruker, aldri til ukjent/ikke-godkjent', async () => {
  const e = env();
  const ok = await core.createSak(e.deps, A, { tittel: 'Eier er B', eierUid: B });
  assert.equal(e.db.at(`/saker/${ok.sakId}/eierUid`), B);
  assert.equal(e.db.at(`/saker/${ok.sakId}/opprettetAv`), A);
  await rejectsWith(core.createSak(e.deps, A, { tittel: 'Ugyldig eier', eierUid: NEI }), 'invalid-argument', /godkjent/);
  await rejectsWith(core.createSak(e.deps, A, { tittel: 'Ugyldig eier', eierUid: 'uid-finnes-ikke' }), 'invalid-argument', /godkjent/);
  await rejectsWith(core.createSak(e.deps, A, { tittel: 'Ugyldig eier', eierUid: 'a/b' }), 'invalid-argument', /eierUid/);
  await rejectsWith(core.createSak(e.deps, A, { tittel: 'Ugyldig eier', eierUid: 5 }), 'invalid-argument', /eierUid/);
});

test('validering ved opprettelse: tittel, problemstilling, områder og spor', async () => {
  const e = env();
  const bad = async (input, re) => rejectsWith(core.createSak(e.deps, A, input), 'invalid-argument', re);
  await bad({}, /Tittel mangler/);
  await bad({ tittel: '   ' }, /Tittel mangler/);
  await bad({ tittel: 'ab' }, /minst 3/);
  await bad({ tittel: 'x'.repeat(121) }, /maks 120/);
  await bad({ tittel: 42 }, /må være tekst/);
  await bad({ tittel: 'Ok tittel', problemstilling: 'x'.repeat(1501) }, /maks 1500/);
  await bad({ tittel: 'Ok tittel', problemstilling: 5 }, /må være tekst/);
  await bad({ tittel: 'Ok tittel', omrader: 'Ferdigmat' }, /liste/);
  await bad({ tittel: 'Ok tittel', omrader: ['a/b'] }, /Områdenavn/);
  await bad({ tittel: 'Ok tittel', omrader: ['a.b'] }, /Områdenavn/);
  await bad({ tittel: 'Ok tittel', omrader: ['$x'] }, /Områdenavn/);
  await bad({ tittel: 'Ok tittel', omrader: ['x'.repeat(41)] }, /maks 40/);
  await bad({ tittel: 'Ok tittel', omrader: Array.from({ length: 11 }, (_, i) => 'O' + i) }, /Maks 10/);
  await bad({ tittel: 'Ok tittel', spor: 'A' }, /liste/);
  await bad({ tittel: 'Ok tittel', spor: Array.from({ length: 9 }, (_, i) => ({ sporsmal: 'Spørsmål ' + i })) }, /Maks 8/);
  await bad({ tittel: 'Ok tittel', spor: [{ sporsmal: 'Et spørsmål', kode: 'A' }, { sporsmal: 'Et annet', kode: 'a' }] }, /flere ganger/);
  await bad({ tittel: 'Ok tittel', spor: [{ sporsmal: 'Et spørsmål', kode: 'A/B' }] }, /Sporkode/);
  await bad({ tittel: 'Ok tittel', spor: [{ sporsmal: 'ab' }] }, /minst 3/);
  await bad({ tittel: 'Ok tittel', spor: [{ kode: 'A' }] }, /mangler/);
  await bad({ tittel: 'Ok tittel', spor: [{ sporsmal: 'Et spørsmål', rekkefolge: 1 }] }, /Ukjente felt/);
  assert.equal(e.db.at('/saker'), null, 'ingenting ble opprettet');
  assert.equal(e.db.at('/counters'), null, 'og ingen saksnumre ble brukt opp av ugyldige forespørsler');
});

test('tekst renses: linjeskift i tittel flates ut, kontrolltegn fjernes, tom problemstilling/områder lagres ikke', async () => {
  const e = env();
  const r = await core.createSak(e.deps, A, { tittel: '  Linje 1\n\nLinje 2\u0007  ', problemstilling: '   ', omrader: [], spor: [{ sporsmal: 'Spørsmål\nmed linjeskift' }] });
  const sak = e.db.at(`/saker/${r.sakId}`);
  assert.equal(sak.tittel, 'Linje 1 Linje 2');
  assert.equal('problemstilling' in sak, false);
  assert.equal('omrader' in sak, false);
  assert.equal(e.db.at(`/sakSpor/${r.sakId}/${r.sporIds[0].sporId}/sporsmal`), 'Spørsmål med linjeskift');
  const med = await core.createSak(e.deps, A, { tittel: 'Med flere linjer', problemstilling: 'Linje 1\r\nLinje 2\n\nLinje 3' });
  assert.equal(e.db.at(`/saker/${med.sakId}/problemstilling`), 'Linje 1\nLinje 2\n\nLinje 3', 'problemstilling beholder linjeskift');
});

test('feiler skrivingen (alle forsøk): ingenting delvis lagret; nummeret er brukt (hull, aldri duplikat)', async () => {
  const e = env();
  e.db.failUpdates = 3;
  await rejectsWith(core.createSak(e.deps, A, { tittel: 'Feiler', spor: [{ sporsmal: 'Et spørsmål' }] }), 'internal', /opprettes/);
  assert.equal(e.db.at('/saker'), null);
  assert.equal(e.db.at('/sakSpor'), null);
  assert.equal(e.db.at('/sakEvents'), null);
  assert.equal(e.db.at('/counters/sak'), 1, 'nummer 1 er brukt opp');
  const neste = await core.createSak(e.deps, A, { tittel: 'Etterpå' });
  assert.equal(neste.kode, 'SAK-0002', 'ingen duplikat; hullet er akseptert');
  assert.ok(e.errors.length >= 1, 'feilen ble logget');
});

test('en forbigående feil på første forsøk rettes av nytt forsøk, uten duplikater', async () => {
  const e = env();
  e.db.failUpdates = 1;
  const r = await core.createSak(e.deps, A, { tittel: 'Prøver på nytt' });
  assert.equal(r.kode, 'SAK-0001');
  assert.equal(Object.keys(e.db.at('/saker')).length, 1);
  assert.equal(sakEvents(e.db, r.sakId).length, 1);
});

test('ødelagt teller avbryter uten å skrive (aldri duplikat saksnummer)', async () => {
  for (const bad of ['tekst', -3, 2.5, { x: 1 }]) {
    const e = env({ counters: { sak: bad } });
    await rejectsWith(core.createSak(e.deps, A, { tittel: 'Ny sak' }), 'internal', /saksnummer/);
    assert.equal(e.db.at('/saker'), null);
  }
});

/* ============================================================== lese */

test('getSaker: sortert på kode, med riktig form; tom database gir tom liste', async () => {
  const e = env();
  assert.deepEqual((await core.getSaker(e.deps, A, {})).saker, []);
  const r1 = await ribbefett(e);
  const r2 = await core.createSak(e.deps, B, { tittel: 'Andre sak', omrader: ['Renhold', 'Ferdigmat'] });
  const { saker, hentetAt } = await core.getSaker(e.deps, B, undefined);
  assert.equal(hentetAt, '2026-10-09T10:00:00.000Z');
  assert.deepEqual(saker.map((s) => s.kode), ['SAK-0001', 'SAK-0002']);
  assert.deepEqual(saker[0], {
    sakId: r1.sakId, kode: 'SAK-0001', tittel: 'Ribbefett 2025 – restlager og kassasjon', problemstilling: PROBLEM, eierUid: A,
    status: 'Åpen', omrader: ['Ferdigmat', 'Frysa', 'Kvalitet', 'Plan'], opprettetAt: '2026-10-09T10:00:00.000Z', opprettetAv: A,
  });
  assert.deepEqual(saker[1].omrader, ['Ferdigmat', 'Renhold']);
  assert.equal(saker[1].sakId, r2.sakId);
});

test('getSak: saksdetaljer med spor, årsaker, tiltak, spor-koblinger og hendelser i rå RTDB-form', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak(), '-Ot2': tiltak({ status: 'Fullført' }), '-Oannet': tiltak() } });
  const r = await ribbefett(e);
  e.tick();
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA, r.sporB] });
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot2', sporIds: [r.sporB] });
  const a = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Manglende rutine for restlager' });
  e.db.data.tiltakEvents = { '-Ot1': { '0000000000001-e1-status': { type: 'endret', felt: 'status', createdAt: '2026-10-09T09:00:00.000Z' } }, '-Oannet': { x: { type: 'endret', createdAt: '2026-10-09T09:30:00.000Z' } } };

  const d = await core.getSak(e.deps, B, { sakId: r.sakId });
  assert.equal(d.sak.kode, 'SAK-0001');
  assert.deepEqual(d.spor.map((s) => [s.kode, s.rekkefolge]), [['A', 1], ['B', 2]]);
  assert.deepEqual(d.tiltakIds, ['-Ot1', '-Ot2']);
  assert.deepEqual(d.tiltakSpor, { '-Ot1': [r.sporA, r.sporB].sort(), '-Ot2': [r.sporB] });
  assert.deepEqual(Object.keys(d.tiltakSpor).sort(), d.tiltakIds, 'alle medlemmer har en oppføring');
  assert.deepEqual(d.ugyldigeKoblinger, []);
  assert.equal(d.arsaker.length, 1);
  assert.equal(d.arsaker[0].arsakId, a.arsakId);
  assert.deepEqual(Object.keys(d.tiltakEvents), ['-Ot1'], 'bare hendelser for saksens egne tiltak');
  assert.equal(Object.keys(d.sakEvents).length, 7, 'sak_opprettet, 2×tiltak_koblet, 3×spor_koblet, arsak_opprettet');
  assert.ok(d.hentetAt);
  assert.equal(JSON.stringify(d).includes('INTERN BESKRIVELSE'), false, 'tiltakenes innhold returneres ikke');
});

test('getSak: ukjent sak og ugyldig id', async () => {
  const e = env();
  await rejectsWith(core.getSak(e.deps, A, { sakId: '-Oukjent' }), 'not-found');
  await rejectsWith(core.getSak(e.deps, A, { sakId: 'a/b' }), 'invalid-argument');
  await rejectsWith(core.getSak(e.deps, A, {}), 'invalid-argument');
});

test('getSak: foreldreløse og ugyldige spor-koblinger ignoreres og rapporteres', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  e.db.data.sakTiltakSpor[r.sakId]['-Oborte'] = { [r.sporA]: true };          // tiltak uten sakId = foreldreløs
  e.db.data.sakTiltakSpor[r.sakId]['-Ot1']['-OfinnesIkke'] = true;            // spor som ikke finnes
  const d = await core.getSak(e.deps, A, { sakId: r.sakId });
  assert.deepEqual(d.tiltakSpor, { '-Ot1': [r.sporA] });
  assert.deepEqual(d.ugyldigeKoblinger, ['-Oborte']);
});

test('getSak: begrenser hendelser til de nyeste per tiltak', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' });
  const many = {};
  for (let i = 0; i < 150; i++) many[String(i).padStart(13, '0') + '-evt'] = { type: 'endret', createdAt: '2026-10-09T09:00:00.000Z' };
  e.db.data.tiltakEvents = { '-Ot1': many };
  const d = await core.getSak(e.deps, A, { sakId: r.sakId });
  const keys = Object.keys(d.tiltakEvents['-Ot1']);
  assert.equal(keys.length, core.LIMITS.tiltakEventsPerTiltak);
  assert.ok(keys.includes('0000000000149-evt'));
  assert.equal(keys.includes('0000000000000-evt'), false);
});

test('getSak-resultatet kan mates rett inn i sak-logic (én sannhet for beregningen)', async () => {
  const e = env({
    tiltak: {
      '-Ot1': tiltak({ status: 'Aktiv', frist: '2026-10-08' }),
      '-Ot2': tiltak({ status: 'Fullført', livssyklus: 'Arkivert', arkivert: true }),
      '-Ot3': tiltak({ miljo: 'Test' }),
      '-Oannet': tiltak(),
    },
  });
  const r = await ribbefett(e);
  for (const id of ['-Ot1', '-Ot2', '-Ot3']) { e.tick(); await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: id, sporIds: [r.sporA] }); }
  e.db.data.tiltakEvents = { '-Ot1': { '0000000000001-e': { type: 'endret', felt: 'frist', createdAt: '2026-10-09T09:00:00.000Z' } } };
  const d = await core.getSak(e.deps, A, { sakId: r.sakId });
  const tasks = Object.entries(e.db.at('/tiltak')).map(([fbKey, v]) => ({ ...v, fbKey }));
  const s = L.oppsummerSak(tasks, { sakId: r.sakId, idag: '2026-10-09', tiltakEvents: d.tiltakEvents, sakEvents: d.sakEvents });
  assert.equal(s.totalt, 2);
  assert.equal(s.gjort, 1);
  assert.equal(s.gjenstar, 1);
  assert.equal(s.forfalt, 1);
  assert.equal(s.ekskludert, 1);
  assert.equal(s.fremdrift, 0.5);
  assert.equal(s.sisteAktivitet.kilde, 'sak', 'siste kobling (10:00:02) er nyere enn tiltakshendelsen (09:00)');
  assert.ok(['tiltak_koblet', 'spor_koblet'].includes(s.sisteAktivitet.type), 'siste operasjon er koblingen av -Ot3');
  assert.equal(s.sisteAktivitet.createdAt, '2026-10-09T10:00:03.000Z');
});

/* ============================================================== oppdatere sak */

test('status endres manuelt, med før/etter og riktig bruker i hendelsen', async () => {
  const e = env();
  const r = await ribbefett(e);
  for (const [i, status] of ['Under oppfølging', 'Avventer beslutning', 'Løst', 'Lukket', 'Åpen'].entries()) {
    e.tick();
    const uid = i % 2 ? B : A;
    const before = e.db.at(`/saker/${r.sakId}/status`);
    const res = await core.updateSak(e.deps, uid, { sakId: r.sakId, status });
    assert.deepEqual(res, { sakId: r.sakId, endret: true, felter: ['status'] });
    assert.equal(e.db.at(`/saker/${r.sakId}/status`), status);
    const last = sakEvents(e.db, r.sakId).pop();
    assert.deepEqual(last, { type: 'sak_endret', createdAt: new Date(T0 + (i + 1) * 1000).toISOString(), actorUid: uid, entityId: r.sakId, felt: 'status', foer: before, etter: status });
  }
});

test('ugyldig status avvises, og status endres aldri av andre operasjoner (ingen automatikk)', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak({ status: 'Fullført' }) } });
  const r = await ribbefett(e);
  for (const status of ['Ferdig', 'åpen', '', null, 5, 'Lukket ']) {
    if (status === null) continue;
    await rejectsWith(core.updateSak(e.deps, A, { sakId: r.sakId, status }), 'invalid-argument', /Ugyldig status/);
  }
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Årsak', status: 'bekreftet', grunnlag: 'Dokumentert' });
  assert.equal(e.db.at(`/saker/${r.sakId}/status`), 'Åpen', 'alle tiltak fullført og årsak bekreftet, men status er uendret');
});

test('uendret sak gir ingen skriving og ingen hendelse', async () => {
  const e = env();
  const r = await ribbefett(e);
  const before = e.db.updateCalls.length;
  const res = await core.updateSak(e.deps, A, { sakId: r.sakId, tittel: 'Ribbefett 2025 – restlager og kassasjon', status: 'Åpen', eierUid: A, omrader: ['Plan', 'Kvalitet', 'Frysa', 'Ferdigmat'], problemstilling: PROBLEM });
  assert.deepEqual(res, { sakId: r.sakId, endret: false, felter: [] });
  assert.equal(e.db.updateCalls.length, before);
  assert.equal(sakEvents(e.db, r.sakId).length, 1);
});

test('flere felt i én oppdatering: én atomisk skriving, én hendelse per felt, fritekst logges ikke', async () => {
  const e = env();
  const r = await ribbefett(e);
  const before = e.db.updateCalls.length;
  const res = await core.updateSak(e.deps, B, { sakId: r.sakId, tittel: 'HEMMELIG NY TITTEL', problemstilling: 'HEMMELIG NY PROBLEMSTILLING', eierUid: B, omrader: ['Renhold'], status: 'Under oppfølging' });
  assert.deepEqual(res.felter.sort(), ['eierUid', 'omrader', 'problemstilling', 'status', 'tittel']);
  assert.equal(e.db.updateCalls.length, before + 1);
  const sak = e.db.at(`/saker/${r.sakId}`);
  assert.equal(sak.tittel, 'HEMMELIG NY TITTEL');
  assert.deepEqual(sak.omrader, { Renhold: true });
  assert.equal(sak.eierUid, B);
  assert.equal(sak.opprettetAv, A, 'opprettetAv endres aldri');
  const nye = sakEvents(e.db, r.sakId).filter((x) => x.type === 'sak_endret');
  assert.equal(nye.length, 5);
  assert.ok(nye.every((x) => x.actorUid === B));
  const json = JSON.stringify(nye);
  assert.equal(json.includes('HEMMELIG'), false);
  assert.deepEqual(nye.find((x) => x.felt === 'eierUid'), { ...nye.find((x) => x.felt === 'eierUid') });
  assert.equal(nye.find((x) => x.felt === 'eierUid').foer, A);
  assert.equal(nye.find((x) => x.felt === 'eierUid').etter, B);
});

test('ny eier må være godkjent bruker; uendret eier krever ikke ny sjekk', async () => {
  const e = env();
  const r = await ribbefett(e);
  await rejectsWith(core.updateSak(e.deps, A, { sakId: r.sakId, eierUid: NEI }), 'invalid-argument', /godkjent/);
  await rejectsWith(core.updateSak(e.deps, A, { sakId: r.sakId, eierUid: 'a/b' }), 'invalid-argument', /eierUid/);
  assert.equal(e.db.at(`/saker/${r.sakId}/eierUid`), A);
});

test('problemstilling kan tømmes (feltet fjernes), og tittel valideres ved endring', async () => {
  const e = env();
  const r = await ribbefett(e);
  await core.updateSak(e.deps, A, { sakId: r.sakId, problemstilling: '' });
  assert.equal('problemstilling' in e.db.at(`/saker/${r.sakId}`), false);
  await rejectsWith(core.updateSak(e.deps, A, { sakId: r.sakId, tittel: 'ab' }), 'invalid-argument', /minst 3/);
  await rejectsWith(core.updateSak(e.deps, A, { sakId: r.sakId, tittel: '' }), 'invalid-argument', /mangler/);
  await rejectsWith(core.updateSak(e.deps, A, { sakId: 'a/b', status: 'Løst' }), 'invalid-argument');
  await rejectsWith(core.updateSak(e.deps, A, { sakId: '-Oukjent', status: 'Løst' }), 'not-found');
});

test('lukket sak: innhold kan ikke endres før den åpnes, men status kan alltid settes', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await core.updateSak(e.deps, A, { sakId: r.sakId, status: 'Lukket' });
  await rejectsWith(core.updateSak(e.deps, A, { sakId: r.sakId, tittel: 'Ny tittel her' }), 'failed-precondition', /lukket/);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' }), 'failed-precondition', /lukket/);
  await rejectsWith(core.removeTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' }), 'failed-precondition', /lukket/);
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Ny årsak' }), 'failed-precondition', /lukket/);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), null);
  const reopen = await core.updateSak(e.deps, A, { sakId: r.sakId, status: 'Under oppfølging', tittel: 'Åpnet og omdøpt' });
  assert.deepEqual(reopen.felter.sort(), ['status', 'tittel']);
});

/* ============================================================== koble tiltak */

test('koble tiltak til sak og begge spor: bare sakId endres på tiltaket; hendelser med riktig bruker', async () => {
  const original = tiltak();
  const e = env({ tiltak: { '-Ot1': original } });
  const r = await ribbefett(e);
  e.tick();
  const before = e.db.updateCalls.length;
  const res = await core.setTiltakSak(e.deps, B, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA, r.sporB] });
  assert.deepEqual(res, { sakId: r.sakId, tiltakId: '-Ot1', endret: true, tilknyttet: true, sporIds: [r.sporA, r.sporB] });

  assert.deepEqual(e.db.at('/tiltak/-Ot1'), { ...original, sakId: r.sakId }, 'resten av tiltaket er urørt (inkl. kommentarer)');
  assert.deepEqual(e.db.at(`/sakTiltakSpor/${r.sakId}/-Ot1`), { [r.sporA]: true, [r.sporB]: true });
  assert.equal(e.db.updateCalls.length, before + 1, 'spor-koblinger og hendelser i én atomisk update');
  assert.equal(e.db.transactionCalls.filter((c) => c.path === '/tiltak/-Ot1' && c.committed).length, 1);

  const ev = sakEvents(e.db, r.sakId).slice(1);
  assert.deepEqual(ev.map((x) => x.type).sort(), ['spor_koblet', 'spor_koblet', 'tiltak_koblet']);
  assert.ok(ev.every((x) => x.actorUid === B && x.entityId === '-Ot1' && x.createdAt === '2026-10-09T10:00:01.000Z'));
  assert.deepEqual(ev.find((x) => x.type === 'tiltak_koblet'), { type: 'tiltak_koblet', createdAt: '2026-10-09T10:00:01.000Z', actorUid: B, entityId: '-Ot1', felt: 'sakId', etter: r.sakId });
});

test('koble uten spor: bare medlemskap og én hendelse; ingen tom sporkobling lagres', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  const res = await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' });
  assert.equal(res.endret, true);
  assert.deepEqual(res.sporIds, []);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), r.sakId);
  assert.equal(e.db.at(`/sakTiltakSpor/${r.sakId}`), null);
  assert.deepEqual(typer(e.db, r.sakId).sort(), ['sak_opprettet', 'tiltak_koblet']);
});

test('koblingen er idempotent: samme kall igjen gir ingen endring, ingen hendelser og ingen skriving', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  const calls = e.db.updateCalls.length;
  const events = sakEvents(e.db, r.sakId).length;
  const again = await core.setTiltakSak(e.deps, B, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  assert.deepEqual(again, { sakId: r.sakId, tiltakId: '-Ot1', endret: false, sporIds: [r.sporA] });
  assert.equal(e.db.updateCalls.length, calls);
  assert.equal(sakEvents(e.db, r.sakId).length, events);
});

test('endre spor-settet erstatter det forrige og logger hvert spor som kobles/frakobles', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  e.tick();
  const res = await core.setTiltakSak(e.deps, B, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporB] });
  assert.equal(res.endret, true);
  assert.equal(res.tilknyttet, false, 'allerede medlem: ingen ny tiltak_koblet');
  assert.deepEqual(e.db.at(`/sakTiltakSpor/${r.sakId}/-Ot1`), { [r.sporB]: true });
  const siste = sakEvents(e.db, r.sakId).filter((x) => x.createdAt === '2026-10-09T10:00:01.000Z');
  assert.deepEqual(siste.map((x) => [x.type, x.foer, x.etter]).sort(), [['spor_frakoblet', r.sporA, undefined], ['spor_koblet', undefined, r.sporB]].sort());
  // tøm alle spor
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [] });
  assert.equal(e.db.at(`/sakTiltakSpor/${r.sakId}`), null);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), r.sakId, 'fortsatt medlem');
});

test('kobling virker også med kald transaksjonscache (første kall får null)', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } }, { coldTransactions: true });
  const r = await ribbefett(e);
  const res = await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  assert.equal(res.tilknyttet, true);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), r.sakId);
  const again = await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  assert.equal(again.endret, false);
});

test('validering ved kobling: ukjent spor, ukjent tiltak/sak, ugyldige id-er, for mange spor', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: ['-OfinnesIkke'] }), 'invalid-argument', /Ukjent spor/);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: 'A' }), 'invalid-argument', /liste/);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: ['a/b'] }), 'invalid-argument');
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: Array.from({ length: 9 }, (_, i) => '-Ox' + i) }), 'invalid-argument', /maks 8/);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Oborte' }), 'not-found', /Tiltaket/);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: '-Oborte', tiltakId: '-Ot1' }), 'not-found', /Saken/);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: 'a.b' }), 'invalid-argument');
  await rejectsWith(core.setTiltakSak(e.deps, A, { tiltakId: '-Ot1' }), 'invalid-argument');
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), null, 'ingen av de ugyldige kallene koblet noe');
  assert.equal(e.db.at(`/sakTiltakSpor`), null);
  // spor fra en ANNEN sak godtas ikke
  const annen = await core.createSak(e.deps, A, { tittel: 'Annen sak', spor: [{ sporsmal: 'Annet spørsmål' }] });
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [annen.sporIds[0].sporId] }), 'invalid-argument', /Ukjent spor/);
});

test('tiltak i papirkurv kan ikke kobles; testtiltak kan (så kobling kan verifiseres uten ekte data)', async () => {
  const e = env({ tiltak: { '-Op1': tiltak({ livssyklus: 'Papirkurv' }), '-Op2': tiltak({ papirkurv: true }), '-Otest': tiltak({ miljo: 'Test' }) } });
  const r = await ribbefett(e);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Op1' }), 'failed-precondition', /papirkurv/);
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Op2' }), 'failed-precondition', /papirkurv/);
  assert.equal((await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Otest' })).endret, true);
});

test('ett tiltak kan bare tilhøre én sak: forsøk på en annen sak avvises med saksnummeret', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r1 = await ribbefett(e);
  const r2 = await core.createSak(e.deps, A, { tittel: 'Annen sak', spor: [{ sporsmal: 'Hvorfor skjedde dette?' }] });
  await core.setTiltakSak(e.deps, A, { sakId: r1.sakId, tiltakId: '-Ot1', sporIds: [r1.sporA] });
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r2.sakId, tiltakId: '-Ot1', sporIds: [r2.sporIds[0].sporId] }), 'failed-precondition', /SAK-0001/);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), r1.sakId);
  assert.equal(e.db.at(`/sakTiltakSpor/${r2.sakId}`), null);
  assert.equal(sakEvents(e.db, r2.sakId).length, 1, 'bare sak_opprettet på den andre saken');
});

test('samtidighet: annen sak vinner midt i kobling => aborted, og INGENTING skrives for den tapende saken', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r1 = await ribbefett(e);
  const r2 = await core.createSak(e.deps, A, { tittel: 'Konkurrerende sak', spor: [{ sporsmal: 'Hvorfor skjedde dette?' }] });
  let fired = false;
  e.db.beforeCommit = (p) => { if (p === '/tiltak/-Ot1' && !fired) { fired = true; e.db.data.tiltak['-Ot1'].sakId = r1.sakId; } };
  const calls = e.db.updateCalls.length;
  await rejectsWith(core.setTiltakSak(e.deps, B, { sakId: r2.sakId, tiltakId: '-Ot1', sporIds: [r2.sporIds[0].sporId] }), 'aborted', /samtidig/);
  assert.equal(fired, true);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), r1.sakId, 'vinnerens kobling står');
  assert.equal(e.db.at(`/sakTiltakSpor/${r2.sakId}`), null);
  assert.equal(e.db.updateCalls.length, calls, 'ingen skriving av spor/hendelser');
});

test('samtidighet: to saker kobler samme tiltak samtidig => nøyaktig én vinner', async () => {
  for (const cold of [false, true]) {
    const e = env({ tiltak: { '-Ot1': tiltak() } }, { coldTransactions: cold });
    const r1 = await core.createSak(e.deps, A, { tittel: 'Sak en' });
    const r2 = await core.createSak(e.deps, B, { tittel: 'Sak to' });
    const res = await Promise.allSettled([
      core.setTiltakSak(e.deps, A, { sakId: r1.sakId, tiltakId: '-Ot1' }),
      core.setTiltakSak(e.deps, B, { sakId: r2.sakId, tiltakId: '-Ot1' }),
    ]);
    assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1, 'cold=' + cold);
    const eier = e.db.at('/tiltak/-Ot1/sakId');
    assert.ok([r1.sakId, r2.sakId].includes(eier));
    const tapt = res.find((x) => x.status === 'rejected').reason;
    assert.ok(tapt instanceof core.SakError && ['aborted', 'failed-precondition'].includes(tapt.code), tapt.message);
    const taper = eier === r1.sakId ? r2.sakId : r1.sakId;
    assert.deepEqual(typer(e.db, taper), ['sak_opprettet'], 'taperen har ingen kobling i historikken');
  }
});

test('skrivefeil etter medlemskap: koblingen rulles tilbake (ingen delvis tilstand), og kan trygt gjentas', async () => {
  const original = tiltak();
  const e = env({ tiltak: { '-Ot1': original } });
  const r = await ribbefett(e);
  e.db.failUpdates = 3;
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] }), 'internal', /rullet tilbake/);
  assert.deepEqual(e.db.at('/tiltak/-Ot1'), original, 'tiltaket er identisk med før');
  assert.equal(e.db.at('/sakTiltakSpor'), null);
  assert.deepEqual(typer(e.db, r.sakId), ['sak_opprettet']);
  // gjenta
  const ok = await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  assert.equal(ok.tilknyttet, true);
  assert.deepEqual(typer(e.db, r.sakId).sort(), ['sak_opprettet', 'spor_koblet', 'tiltak_koblet']);
});

test('forbigående skrivefeil: nytt forsøk lykkes uten tilbakerulling eller dupliserte hendelser', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  e.db.failUpdates = 2;
  const ok = await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA, r.sporB] });
  assert.equal(ok.endret, true);
  assert.equal(typer(e.db, r.sakId).filter((t) => t === 'tiltak_koblet').length, 1);
  assert.equal(typer(e.db, r.sakId).filter((t) => t === 'spor_koblet').length, 2);
});

test('KJENT BEGRENSNING: feiler både skriving og tilbakerulling, står medlemskapet igjen; gjentakelse fullfører sporene (men tiltak_koblet mangler i sakEvents)', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  e.db.failUpdates = 3;
  let tx = 0;
  e.db.onTransaction = () => { tx += 1; if (tx >= 2) throw new Error('transaksjon nede'); };
  await rejectsWith(core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] }), 'internal', /delvis/);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), r.sakId, 'medlemskapet står (rollback feilet)');
  assert.equal(e.db.at('/sakTiltakSpor'), null);
  e.db.onTransaction = null;
  const rep = await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  assert.equal(rep.endret, true);
  assert.equal(rep.tilknyttet, false);
  assert.deepEqual(e.db.at(`/sakTiltakSpor/${r.sakId}/-Ot1`), { [r.sporA]: true }, 'sporene er rettet opp');
  assert.equal(typer(e.db, r.sakId).includes('tiltak_koblet'), false, 'dokumentert hull: kobling er bare logget i tiltakEvents (uten bruker)');
});

/* ============================================================== frakoble tiltak */

test('frakoble: sakId fjernes, spor-koblinger og hendelser skrives atomisk, resten av tiltaket er urørt', async () => {
  const original = tiltak();
  const e = env({ tiltak: { '-Ot1': original } });
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA, r.sporB] });
  e.tick(5000);
  const calls = e.db.updateCalls.length;
  const res = await core.removeTiltakSak(e.deps, B, { sakId: r.sakId, tiltakId: '-Ot1' });
  assert.deepEqual(res, { sakId: r.sakId, tiltakId: '-Ot1', endret: true });
  assert.deepEqual(e.db.at('/tiltak/-Ot1'), original, 'identisk med original: sakId er borte, alt annet er uendret');
  assert.equal(e.db.at(`/sakTiltakSpor/${r.sakId}`), null);
  assert.equal(e.db.updateCalls.length, calls + 1);
  const siste = sakEvents(e.db, r.sakId).filter((x) => x.createdAt === '2026-10-09T10:00:05.000Z');
  assert.deepEqual(siste.map((x) => x.type).sort(), ['spor_frakoblet', 'spor_frakoblet', 'tiltak_frakoblet']);
  assert.ok(siste.every((x) => x.actorUid === B));
  assert.equal(siste.find((x) => x.type === 'tiltak_frakoblet').foer, r.sakId);
});

test('frakoble er idempotent og ryddet: ikke-koblet tiltak gir ingen endring; foreldreløse koblinger ryddes', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  const calls = e.db.updateCalls.length;
  assert.deepEqual(await core.removeTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' }), { sakId: r.sakId, tiltakId: '-Ot1', endret: false });
  assert.equal(e.db.updateCalls.length, calls);
  e.db.data.sakTiltakSpor = { [r.sakId]: { '-Ot1': { [r.sporA]: true } } }; // foreldreløs
  const rydd = await core.removeTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' });
  assert.equal(rydd.endret, true);
  assert.equal(e.db.at('/sakTiltakSpor'), null);
  assert.deepEqual(typer(e.db, r.sakId).sort(), ['sak_opprettet', 'spor_frakoblet']);
});

test('frakoble fra feil sak avvises; ukjent tiltak/sak gir not-found', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r1 = await ribbefett(e);
  const r2 = await core.createSak(e.deps, A, { tittel: 'Annen sak' });
  await core.setTiltakSak(e.deps, A, { sakId: r1.sakId, tiltakId: '-Ot1' });
  await rejectsWith(core.removeTiltakSak(e.deps, A, { sakId: r2.sakId, tiltakId: '-Ot1' }), 'failed-precondition', /annen sak/);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), r1.sakId);
  await rejectsWith(core.removeTiltakSak(e.deps, A, { sakId: r1.sakId, tiltakId: '-Oborte' }), 'not-found');
  await rejectsWith(core.removeTiltakSak(e.deps, A, { sakId: '-Oborte', tiltakId: '-Ot1' }), 'not-found');
});

test('frakoble: samtidig flytting til annen sak midt i operasjonen gir aborted og rører ingenting', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r1 = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r1.sakId, tiltakId: '-Ot1', sporIds: [r1.sporA] });
  let fired = false;
  e.db.beforeCommit = (p) => { if (p === '/tiltak/-Ot1' && !fired) { fired = true; e.db.data.tiltak['-Ot1'].sakId = '-AnnenSak'; } };
  await rejectsWith(core.removeTiltakSak(e.deps, A, { sakId: r1.sakId, tiltakId: '-Ot1' }), 'aborted');
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), '-AnnenSak');
  assert.deepEqual(e.db.at(`/sakTiltakSpor/${r1.sakId}/-Ot1`), { [r1.sporA]: true }, 'koblingene er ikke slettet');
});

test('frakoble: skrivefeil etter frikobling gir tydelig feil; foreldreløse koblinger ignoreres og erstattes ved ny kobling', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  e.db.failUpdates = 3;
  await rejectsWith(core.removeTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' }), 'internal', /på nytt/);
  assert.equal(e.db.at('/tiltak/-Ot1/sakId'), null, 'medlemskap (sannheten) er fjernet');
  const d = await core.getSak(e.deps, A, { sakId: r.sakId });
  assert.deepEqual(d.tiltakSpor, {});
  assert.deepEqual(d.ugyldigeKoblinger, ['-Ot1'], 'foreldreløs kobling rapporteres, men teller ikke');
  // ny kobling til samme sak med et ANNET spor: gamle koblinger skal ikke dukke opp igjen
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporB] });
  assert.deepEqual(e.db.at(`/sakTiltakSpor/${r.sakId}/-Ot1`), { [r.sporB]: true });
});

/* ============================================================== årsaker */

test('registrere årsak: standard status hypotese, vurdertAv/vurdertAt/opprettetAv settes av server', async () => {
  const e = env();
  const r = await ribbefett(e);
  e.tick(60000);
  const res = await core.createArsak(e.deps, B, { sakId: r.sakId, sporId: r.sporA, tekst: 'Manglende fast rutine for restlager etter sesong' });
  assert.deepEqual(e.db.at(`/sakArsaker/${r.sakId}/${res.arsakId}`), {
    sporId: r.sporA, tekst: 'Manglende fast rutine for restlager etter sesong', status: 'hypotese',
    vurdertAv: B, vurdertAt: '2026-10-09T10:01:00.000Z', opprettetAv: B, opprettetAt: '2026-10-09T10:01:00.000Z', fjernet: false,
  });
  const ev = sakEvents(e.db, r.sakId).pop();
  assert.deepEqual(ev, { type: 'arsak_opprettet', createdAt: '2026-10-09T10:01:00.000Z', actorUid: B, entityId: res.arsakId, felt: 'status', etter: 'hypotese' });
  assert.equal(JSON.stringify(ev).includes('Manglende fast rutine'), false, 'fritekst logges ikke');
});

test('støttet og bekreftet krever grunnlag; hypotese og avkreftet gjør ikke', async () => {
  const e = env();
  const r = await ribbefett(e);
  const base = { sakId: r.sakId, sporId: r.sporB, tekst: 'Utgått batch ble pakket uten datokontroll' };
  for (const status of ['støttet', 'bekreftet']) {
    await rejectsWith(core.createArsak(e.deps, A, { ...base, status }), 'invalid-argument', /krever et grunnlag/);
    await rejectsWith(core.createArsak(e.deps, A, { ...base, status, grunnlag: '  ' }), 'invalid-argument', /krever et grunnlag/);
    await rejectsWith(core.createArsak(e.deps, A, { ...base, status, grunnlag: 'ab' }), 'invalid-argument', /krever et grunnlag/);
    const ok = await core.createArsak(e.deps, A, { ...base, status, grunnlag: 'Kvalitet bekreftet dato på pakkeseddel' });
    assert.equal(e.db.at(`/sakArsaker/${r.sakId}/${ok.arsakId}/status`), status);
  }
  for (const status of ['hypotese', 'avkreftet']) await core.createArsak(e.deps, A, { ...base, status });
  await rejectsWith(core.createArsak(e.deps, A, { ...base, status: 'sannsynlig' }), 'invalid-argument', /Ugyldig status/);
  await rejectsWith(core.createArsak(e.deps, A, { ...base, status: 'Hypotese' }), 'invalid-argument', /Ugyldig status/);
});

test('validering av årsak: tekst, spor, sak og ukjente spor fra annen sak', async () => {
  const e = env();
  const r = await ribbefett(e);
  const annen = await core.createSak(e.deps, A, { tittel: 'Annen sak', spor: [{ sporsmal: 'Et annet spørsmål' }] });
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA }), 'invalid-argument', /Tekst mangler/);
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'ab' }), 'invalid-argument', /minst 3/);
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'x'.repeat(601) }), 'invalid-argument', /maks 600/);
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Årsak', grunnlag: 'x'.repeat(1501) }), 'invalid-argument', /maks 1500/);
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: '-OfinnesIkke', tekst: 'Årsak' }), 'invalid-argument', /Ukjent spor/);
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: annen.sporIds[0].sporId, tekst: 'Årsak' }), 'invalid-argument', /Ukjent spor/);
  await rejectsWith(core.createArsak(e.deps, A, { sakId: '-Oborte', sporId: r.sporA, tekst: 'Årsak' }), 'not-found');
  await rejectsWith(core.createArsak(e.deps, A, { sakId: r.sakId, sporId: 'a/b', tekst: 'Årsak' }), 'invalid-argument');
  assert.equal(e.db.at(`/sakArsaker`), null);
});

test('endre årsaksstatus: lagres på stedet, vurdertAv/At oppdateres til den som endret, hendelse med før/etter', async () => {
  const e = env();
  const r = await ribbefett(e);
  const a = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Personavhengig prosess' });
  e.tick(3600000);
  await rejectsWith(core.updateArsak(e.deps, B, { sakId: r.sakId, arsakId: a.arsakId, status: 'støttet' }), 'invalid-argument', /krever et grunnlag/);
  assert.equal(e.db.at(`/sakArsaker/${r.sakId}/${a.arsakId}/status`), 'hypotese', 'avvist endring skrev ingenting');
  const res = await core.updateArsak(e.deps, B, { sakId: r.sakId, arsakId: a.arsakId, status: 'støttet', grunnlag: 'Rutinen falt bort ved rolleovergang (intervju med Plan)' });
  assert.deepEqual(res, { sakId: r.sakId, arsakId: a.arsakId, endret: true });
  const lagret = e.db.at(`/sakArsaker/${r.sakId}/${a.arsakId}`);
  assert.equal(lagret.status, 'støttet');
  assert.equal(lagret.vurdertAv, B);
  assert.equal(lagret.vurdertAt, '2026-10-09T11:00:00.000Z');
  assert.equal(lagret.opprettetAv, A, 'opprettetAv endres aldri');
  assert.equal(lagret.opprettetAt, '2026-10-09T10:00:00.000Z');
  const evs = sakEvents(e.db, r.sakId).filter((x) => x.entityId === a.arsakId && x.type === 'arsak_endret');
  assert.deepEqual(evs.map((x) => [x.felt, x.foer, x.etter, x.actorUid]).sort(), [['grunnlag', undefined, undefined, B], ['status', 'hypotese', 'støttet', B]].sort());
  // videre: støttet -> bekreftet bruker eksisterende grunnlag
  e.tick();
  await core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, status: 'bekreftet' });
  assert.equal(e.db.at(`/sakArsaker/${r.sakId}/${a.arsakId}/status`), 'bekreftet');
  // og kan åpnes igjen
  await core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, status: 'avkreftet' });
  assert.equal(e.db.at(`/sakArsaker/${r.sakId}/${a.arsakId}/status`), 'avkreftet');
});

test('grunnlag kan ikke fjernes fra en støttet/bekreftet årsak; endring av bare grunnlag logges uten tekst', async () => {
  const e = env();
  const r = await ribbefett(e);
  const a = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Volumstyring fremfor batchstyring', status: 'bekreftet', grunnlag: 'Opprinnelig grunnlag' });
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, grunnlag: '' }), 'invalid-argument', /krever et grunnlag/);
  e.tick();
  await core.updateArsak(e.deps, B, { sakId: r.sakId, arsakId: a.arsakId, grunnlag: 'HEMMELIG NYTT GRUNNLAG' });
  assert.equal(e.db.at(`/sakArsaker/${r.sakId}/${a.arsakId}/grunnlag`), 'HEMMELIG NYTT GRUNNLAG');
  const siste = sakEvents(e.db, r.sakId).pop();
  assert.deepEqual(siste, { type: 'arsak_endret', createdAt: '2026-10-09T10:00:01.000Z', actorUid: B, entityId: a.arsakId, felt: 'grunnlag' });
  assert.equal(JSON.stringify(sakEvents(e.db, r.sakId)).includes('HEMMELIG'), false);
});

test('uendret årsak gir endret:false uten skriving; tom endring og tom tekst avvises', async () => {
  const e = env();
  const r = await ribbefett(e);
  const a = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Utgått dato fanges ikke ved mottak' });
  const calls = e.db.updateCalls.length;
  assert.equal((await core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, status: 'hypotese' })).endret, false);
  assert.equal((await core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, tekst: 'Utgått dato fanges ikke ved mottak' })).endret, false);
  assert.equal(e.db.updateCalls.length, calls);
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId }), 'invalid-argument', /Ingenting å endre/);
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, tekst: '   ' }), 'invalid-argument', /tom/);
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: '-Oborte', status: 'avkreftet' }), 'not-found', /Årsaken/);
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, fjern: 'ja' }), 'invalid-argument', /fjern/);
});

test('ny ordlyd lager en NY årsak som erstatter den gamle; status nullstilles til hypotese', async () => {
  const e = env();
  const r = await ribbefett(e);
  const a = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporB, tekst: 'Frysa fanget ikke utgått dato', status: 'bekreftet', grunnlag: 'Bekreftet av Frysa' });
  e.tick(1000);
  const res = await core.updateArsak(e.deps, B, { sakId: r.sakId, arsakId: a.arsakId, tekst: 'Frysa og Ferdigmat fanget ikke utgått dato' });
  assert.equal(res.erstattet, a.arsakId);
  assert.notEqual(res.arsakId, a.arsakId);
  const gammel = e.db.at(`/sakArsaker/${r.sakId}/${a.arsakId}`);
  assert.equal(gammel.fjernet, true);
  assert.equal(gammel.tekst, 'Frysa fanget ikke utgått dato', 'den gamle teksten er bevart (append-only)');
  assert.equal(gammel.status, 'bekreftet', 'og den gamle statusen står som den var');
  const ny = e.db.at(`/sakArsaker/${r.sakId}/${res.arsakId}`);
  assert.deepEqual(ny, {
    sporId: r.sporB, tekst: 'Frysa og Ferdigmat fanget ikke utgått dato', status: 'hypotese', vurdertAv: B, vurdertAt: '2026-10-09T10:00:01.000Z',
    opprettetAv: B, opprettetAt: '2026-10-09T10:00:01.000Z', fjernet: false, erstatter: a.arsakId,
  });
  assert.equal('grunnlag' in ny, false, 'gammelt grunnlag følger ikke med');
  const evs = sakEvents(e.db, r.sakId).slice(-2);
  assert.deepEqual(evs.map((x) => x.type).sort(), ['arsak_fjernet', 'arsak_opprettet']);
  assert.ok(evs.every((x) => x.actorUid === B));
  // revisjon med eksplisitt status krever grunnlag
  await rejectsWith(core.updateArsak(e.deps, B, { sakId: r.sakId, arsakId: res.arsakId, tekst: 'Enda en ordlyd her', status: 'bekreftet' }), 'invalid-argument', /krever et grunnlag/);
  const rev2 = await core.updateArsak(e.deps, B, { sakId: r.sakId, arsakId: res.arsakId, tekst: 'Enda en ordlyd her', status: 'støttet', grunnlag: 'Nytt grunnlag' });
  assert.equal(e.db.at(`/sakArsaker/${r.sakId}/${rev2.arsakId}/status`), 'støttet');
  assert.equal(e.db.at(`/sakArsaker/${r.sakId}/${rev2.arsakId}/erstatter`), res.arsakId);
});

test('fjerne årsak: fjernet=true med hendelse; kan ikke endres eller fjernes igjen; kan ikke kombineres med andre felt', async () => {
  const e = env();
  const r = await ribbefett(e);
  const a = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Feilregistrert årsak' });
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, fjern: true, status: 'avkreftet' }), 'invalid-argument', /kombineres/);
  e.tick();
  assert.equal((await core.updateArsak(e.deps, B, { sakId: r.sakId, arsakId: a.arsakId, fjern: true })).endret, true);
  const lagret = e.db.at(`/sakArsaker/${r.sakId}/${a.arsakId}`);
  assert.equal(lagret.fjernet, true);
  assert.equal(lagret.tekst, 'Feilregistrert årsak', 'ikke slettet');
  assert.deepEqual(sakEvents(e.db, r.sakId).pop(), { type: 'arsak_fjernet', createdAt: '2026-10-09T10:00:01.000Z', actorUid: B, entityId: a.arsakId, felt: 'fjernet', etter: true });
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, status: 'bekreftet', grunnlag: 'Grunnlag her' }), 'failed-precondition', /fjernet/);
  await rejectsWith(core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, fjern: true }), 'failed-precondition', /fjernet/);
  const d = await core.getSak(e.deps, A, { sakId: r.sakId });
  assert.equal(d.arsaker[0].fjernet, true, 'fjernede årsaker returneres (med flagg) så historikken er synlig');
});

test('årsaker returneres i opprettelsesrekkefølge, med erstatter-kjede', async () => {
  const e = env();
  const r = await ribbefett(e);
  const a = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Første ordlyd' });
  e.tick();
  const b = await core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, tekst: 'Andre ordlyd' });
  e.tick();
  const c = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporB, tekst: 'Helt annen årsak' });
  const d = await core.getSak(e.deps, A, { sakId: r.sakId });
  assert.deepEqual(d.arsaker.map((x) => x.arsakId), [a.arsakId, b.arsakId, c.arsakId]);
  assert.equal(d.arsaker[1].erstatter, a.arsakId);
  assert.equal('erstatter' in d.arsaker[0], false);
});

/* ============================================================== tverrgående egenskaper */

test('hver hendelse i alle flyter har innlogget brukers uid og serverens tid (aldri klientens)', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak(), '-Ot2': tiltak() } });
  const r = await ribbefett(e, A);
  e.tick();
  await core.setTiltakSak(e.deps, B, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA, r.sporB] });
  e.tick();
  await core.updateSak(e.deps, A, { sakId: r.sakId, status: 'Under oppfølging', eierUid: B });
  e.tick();
  const a = await core.createArsak(e.deps, B, { sakId: r.sakId, sporId: r.sporA, tekst: 'Første årsak' });
  e.tick();
  await core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: a.arsakId, status: 'bekreftet', grunnlag: 'Grunnlag' });
  e.tick();
  await core.removeTiltakSak(e.deps, B, { sakId: r.sakId, tiltakId: '-Ot1' });
  const ev = sakEvents(e.db, r.sakId);
  assert.ok(ev.length >= 10);
  for (const x of ev) {
    assert.ok(x.actorUid === A || x.actorUid === B, JSON.stringify(x));
    assert.match(x.createdAt, /^2026-10-09T10:00:0\d\.000Z$/);
    assert.ok(['sak_opprettet', 'sak_endret', 'tiltak_koblet', 'tiltak_frakoblet', 'spor_koblet', 'spor_frakoblet', 'arsak_opprettet', 'arsak_endret', 'arsak_fjernet'].includes(x.type));
  }
  const perType = (t) => ev.filter((x) => x.type === t).map((x) => x.actorUid);
  assert.deepEqual(perType('sak_opprettet'), [A]);
  assert.deepEqual(perType('tiltak_koblet'), [B]);
  assert.deepEqual(perType('sak_endret'), [A, A]);
  assert.deepEqual(perType('tiltak_frakoblet'), [B]);
});

test('hver skriveoperasjon er én atomisk skriving der endring og sakEvents ligger i samme update', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  const sjekk = async (navn, fn) => {
    const f = e.db.updateCalls.length;
    await fn();
    assert.equal(e.db.updateCalls.length, f + 1, navn + ': nøyaktig én update');
    const paths = Object.keys(e.db.updateCalls[f]);
    assert.ok(paths.some((p) => p.startsWith(`/sakEvents/${r.sakId}/`)), navn + ': hendelse i samme update som endringen');
    assert.ok(paths.some((p) => !p.startsWith('/sakEvents/')), navn + ': selve endringen i samme update');
    assert.equal(paths.filter((p) => p.startsWith('/tiltak/')).length, 0, navn + ': tiltak skrives bare via transaksjon');
  };
  await sjekk('updateSak', () => core.updateSak(e.deps, A, { sakId: r.sakId, status: 'Løst' }));
  await sjekk('setTiltakSak', () => core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] }));
  let aid;
  await sjekk('createArsak', async () => { aid = (await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Årsak' })).arsakId; });
  await sjekk('updateArsak', () => core.updateArsak(e.deps, A, { sakId: r.sakId, arsakId: aid, status: 'avkreftet' }));
  await sjekk('removeTiltakSak', () => core.removeTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' }));
});

test('ingen skriveoperasjon endrer andre felt på tiltak enn sakId, og ingen lagrer aggregater på saken', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak({ systemId: 'KVAL-0007' }) } });
  const before = e.db.at('/tiltak/-Ot1');
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  await core.updateSak(e.deps, A, { sakId: r.sakId, status: 'Under oppfølging' });
  await core.removeTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' });
  assert.deepEqual(e.db.at('/tiltak/-Ot1'), before);
  const sak = e.db.at(`/saker/${r.sakId}`);
  for (const forbudt of ['antall', 'totalt', 'gjort', 'gjenstar', 'forfalt', 'fremdrift', 'sistOppdatert', 'oppdatertAt', 'tiltak', 'tiltakIds']) {
    assert.equal(forbudt in sak, false, forbudt);
  }
});

test('Ribbefett-flyten ende til ende: opprett, koble 7 tiltak til ett eller begge spor, registrer årsaker', async () => {
  const seed = {};
  const navn = ['Fast lagergjennomgang', 'Batchstyring', 'Avvik Constellation', 'Datokontroll Frysa', 'Datokontroll Ferdigmat', 'Systemvarsel/sperre', 'Avklare tapskategori'];
  navn.forEach((n, i) => { seed['-Or' + (i + 1)] = tiltak({ tittel: n, frist: '2026-10-' + String(10 + i).padStart(2, '0') }); });
  const e = env({ tiltak: seed });
  const r = await ribbefett(e);
  const plan = { '-Or1': [r.sporA], '-Or2': [r.sporA, r.sporB], '-Or3': [r.sporB], '-Or4': [r.sporB], '-Or5': [r.sporB], '-Or6': [r.sporB], '-Or7': [] };
  for (const [id, spor] of Object.entries(plan)) { e.tick(); await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: id, sporIds: spor }); }
  const a1 = await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Manglende fast rutine for restlager etter sesong og før ny produksjon', status: 'støttet', grunnlag: 'Rutinen var personavhengig og falt bort ved rolleovergang' });
  await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporB, tekst: 'Constellation sendte gammel batch' });
  await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporB, tekst: 'Frysa og Ferdigmat fanget ikke utgått dato' });
  const d = await core.getSak(e.deps, B, { sakId: r.sakId });
  assert.equal(d.tiltakIds.length, 7);
  assert.deepEqual(d.tiltakSpor['-Or2'].sort(), [r.sporA, r.sporB].sort());
  assert.deepEqual(d.tiltakSpor['-Or7'], []);
  assert.equal(d.arsaker.length, 3);
  assert.equal(d.arsaker.find((a) => a.arsakId === a1.arsakId).status, 'støttet');
  const tasks = Object.entries(e.db.at('/tiltak')).map(([fbKey, v]) => ({ ...v, fbKey }));
  const s = L.oppsummerSak(tasks, { sakId: r.sakId, idag: '2026-10-09', sakEvents: d.sakEvents, tiltakEvents: d.tiltakEvents });
  assert.equal(s.totalt, 7);
  assert.equal(s.gjenstar, 7);
  assert.equal(e.db.at(`/saker/${r.sakId}/status`), 'Åpen');
});

/* ============================================================== statiske garantier */

test('ingen hardkodede bruker-id-er eller Firebase-avhengigheter i datalaget', () => {
  const dir = path.join(__dirname, '..', 'functions');
  const kjent = ['TJKI3zlDKSR7jvFXksVFgEgjS432', 'gibm3aDi1KWlNyl7P3jTktQoGsM2', 'lJ7bn7HkbcZnhDoxfaBYQKEFL083', 'Tony Danielsen', 'Kenneth Nordbakk', 'Erling Magnussen'];
  for (const fil of ['sak-core.js', 'sak-api.js']) {
    const kode = fs.readFileSync(path.join(dir, fil), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const id of kjent) assert.equal(kode.includes(id), false, `${fil} inneholder ${id}`);
    assert.equal(/['"`][A-Za-z0-9]{28}['"`]/.test(kode), false, `${fil} ser ut til å inneholde en hardkodet uid`);
    assert.equal(/ADMIN_UID|OWNER_UID/.test(kode), false, fil);
  }
  const core = fs.readFileSync(path.join(dir, 'sak-core.js'), 'utf8');
  const requires = [...core.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./events-core'], 'sak-core skal bare avhenge av events-core (ingen firebase-pakker)');
});

test('sak-core skriver aldri til noder utenfor den avtalte modellen', async () => {
  const e = env({ tiltak: { '-Ot1': tiltak() } });
  const r = await ribbefett(e);
  await core.setTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1', sporIds: [r.sporA] });
  await core.createArsak(e.deps, A, { sakId: r.sakId, sporId: r.sporA, tekst: 'Årsak' });
  await core.updateSak(e.deps, A, { sakId: r.sakId, status: 'Løst' });
  await core.removeTiltakSak(e.deps, A, { sakId: r.sakId, tiltakId: '-Ot1' });
  const roter = new Set();
  for (const call of e.db.updateCalls) for (const p of Object.keys(call)) roter.add(p.split('/')[1]);
  assert.deepEqual([...roter].sort(), ['sakArsaker', 'sakEvents', 'sakSpor', 'sakTiltakSpor', 'saker']);
  assert.deepEqual(Object.keys(e.db.data).sort(), ['authorizedUsers', 'counters', 'sakArsaker', 'sakEvents', 'sakSpor', 'saker', 'tiltak'].sort());
});
