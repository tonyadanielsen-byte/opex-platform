'use strict';

/*
 * Samtidighet og feilinjeksjon for setTiltakSak / removeTiltakSak.
 *
 * Koblingen er IKKE én atomisk operasjon: medlemskap (tiltak.sakId, en transaksjon på tiltaket) og
 * sporkoblinger + sakEvents (én atomisk update) skrives i to faser. Testene verifiserer derfor egenskaper
 * som må holde uansett hvordan operasjonene flettes eller hvor de feiler:
 *   1. Tilstand og historikk er konsistente (ingen foreldreløse koblinger, medlemskapshistorikken alternerer
 *      koblet/frakoblet og slutter i faktisk tilstand, spor-historikk gir faktiske spor-koblinger).
 *   2. En operasjon som meldte «ok» er faktisk gjeldende (ingen «ok» som senere er revet bort).
 *   3. En mislykket tilbakerulling fjerner aldri en nyere, gyldig kobling.
 *   4. Én ny kjøring etter en feil konverterer til ønsket sluttilstand (idempotens).
 * Alt kjøres mot den simulerte databasen (tests/helpers/fake-rtdb.cjs), som flettes på await-grensene.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../functions/sak-core');
const { FakeRtdb } = require('./helpers/fake-rtdb.cjs');

const A = 'uid-a';
const B = 'uid-b';
const T = '-Ot1';
const T0 = Date.parse('2026-10-09T10:00:00.000Z');

const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

const tiltak = (over = {}) => ({
  tittel: 'Datokontroll', beskrivelse: 'INTERN', status: 'Aktiv', eier: 'Kenneth Nordbakk', frist: '2026-10-20',
  miljo: 'Produksjon', livssyklus: 'Aktiv', ...over,
});

function env(initial = {}, opts = {}) {
  const db = new FakeRtdb({ authorizedUsers: { [A]: true, [B]: true }, tiltak: { [T]: tiltak() }, ...initial }, { coldTransactions: !!opts.cold });
  let t = T0;
  const errors = [];
  // Hver now() gir +1 ms: hendelsenes tidsstempel gir da en total rekkefølge lik byggerekkefølgen.
  const deps = { db, now: () => new Date(opts.frozen ? t : ++t), sleep: settle, log: { error: (...a) => errors.push(a) } };
  return { db, deps, errors, advance: (ms) => { t += ms; } };
}

async function setupSak(e, tittel = 'Ribbefett 2025') {
  const r = await core.createSak(e.deps, A, { tittel, spor: [{ sporsmal: 'Hvorfor oppsto restlageret?' }, { sporsmal: 'Hvorfor endte restlageret som kassasjon?' }] });
  return { sakId: r.sakId, a: r.sporIds[0].sporId, b: r.sporIds[1].sporId };
}

const set = (e, uid, sakId, sporIds, tiltakId = T) => core.setTiltakSak(e.deps, uid, { sakId, tiltakId, sporIds });
const remove = (e, uid, sakId, tiltakId = T) => core.removeTiltakSak(e.deps, uid, { sakId, tiltakId });
const outcome = (p) => p.then((r) => ({ ok: true, r }), (err) => ({ ok: false, code: err.code, message: err.message }));

function sakEventList(db, sakId) {
  return Object.values(db.at(`/sakEvents/${sakId}`) || {}).sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
}

/** Egenskap 1: tilstand og historikk henger sammen. */
function assertConsistent(db, sakId, tiltakId, label = '', { history = true } = {}) {
  const member = db.at(`/tiltak/${tiltakId}/sakId`) === sakId;
  const links = db.at(`/sakTiltakSpor/${sakId}/${tiltakId}`);
  if (!member) assert.equal(links, null, `${label}: foreldreløse spor-koblinger: ${JSON.stringify(links)}`);
  if (!history) return;
  const ev = sakEventList(db, sakId).filter((x) => x.entityId === tiltakId);
  const mem = ev.filter((x) => x.type === 'tiltak_koblet' || x.type === 'tiltak_frakoblet').map((x) => x.type);
  mem.forEach((type, i) => assert.equal(type, i % 2 === 0 ? 'tiltak_koblet' : 'tiltak_frakoblet', `${label}: medlemskapshistorikk alternerer ikke: ${mem.join(', ')}`));
  const histMember = mem.length ? mem[mem.length - 1] === 'tiltak_koblet' : false;
  assert.equal(histMember, member, `${label}: historikken sier medlem=${histMember}, tilstanden sier medlem=${member}`);
  const spor = new Set();
  for (const x of ev) { if (x.type === 'spor_koblet') spor.add(x.etter); if (x.type === 'spor_frakoblet') spor.delete(x.foer); }
  assert.deepEqual([...spor].sort(), Object.keys(links || {}).sort(), `${label}: spor-historikken og spor-tilstanden er ulike`);
}

const count = (db, sakId, type) => sakEventList(db, sakId).filter((x) => x.type === type).length;

/* ======================================================================
 * A. Mistanker fra gjennomgangen, reprodusert som tester
 * ====================================================================== */

test('F1: en mislykket tilbakerulling fjerner aldri en nyere, gyldig kobling', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  let failures = 3;
  e.db.failWhen = (u) => Object.keys(u).some((p) => p.startsWith('/sakTiltakSpor/')) && failures-- > 0; // A sin skriving feiler 3×
  let tiltakTx = 0;
  const innblanding = [];
  e.db.onTransaction = async (path) => {
    if (path !== `/tiltak/${T}`) return;
    tiltakTx += 1;
    if (tiltakTx === 2) { // A sin tilbakerulling er i ferd med å starte; en annen bruker rekker en full frakobling + ny kobling
      innblanding.push(await outcome(remove(e, B, sakId)));
      innblanding.push(await outcome(set(e, B, sakId, [a])));
    }
  };
  const resA = await outcome(set(e, A, sakId, [a]));
  assert.equal(resA.ok, false, 'A skulle feile');
  assertConsistent(e.db, sakId, T, 'F1');
  if (innblanding[1].ok) assert.equal(e.db.at(`/tiltak/${T}/sakId`), sakId, 'B fikk «ok» på ny kobling, men A sin tilbakerulling rev den bort');
});

test('F2: en samtidig kobling til samme sak kan ikke bygge på en kobling som deretter rulles tilbake', async () => {
  const e = env();
  const { sakId, a, b } = await setupSak(e);
  let failuresA = 3;
  e.db.failWhen = (u) => Object.values(u).some((v) => v && v.actorUid === A) && failuresA-- > 0; // bare A sine skrivinger feiler
  const [ra, rb] = await Promise.all([outcome(set(e, A, sakId, [a])), outcome(set(e, B, sakId, [b]))]);
  assert.equal(ra.ok, false, 'A skulle feile');
  assertConsistent(e.db, sakId, T, 'F2');
  if (rb.ok) assert.equal(e.db.at(`/tiltak/${T}/sakId`), sakId, 'B fikk «ok», men koblingen ble revet bort av A sin tilbakerulling');
});

test('F3: samtidig kobling og frakobling av samme tiltak gir aldri tilstand som motsier historikken', async () => {
  for (const cold of [false, true]) for (const remoteFirst of [false, true]) {
    const e = env({}, { cold });
    const { sakId, a, b } = await setupSak(e);
    await set(e, A, sakId, [b]);
    const ops = [() => outcome(set(e, B, sakId, [a])), () => outcome(remove(e, A, sakId))];
    if (remoteFirst) ops.reverse();
    await Promise.all(ops.map((f) => f()));
    assertConsistent(e.db, sakId, T, `cold=${cold} removeFirst=${remoteFirst}`);
  }
});

test('F4: samtidige frakoblinger gir nøyaktig én frakoblingshistorikk (ingen duplikater)', async () => {
  const e = env();
  const { sakId, a, b } = await setupSak(e);
  await set(e, A, sakId, [a, b]);
  const res = await Promise.all([A, B, A].map((u) => outcome(remove(e, u, sakId))));
  assert.ok(res.some((r) => r.ok), 'minst én frakobling skal lykkes');
  assert.equal(count(e.db, sakId, 'tiltak_frakoblet'), 1);
  assert.equal(count(e.db, sakId, 'spor_frakoblet'), 2);
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), null);
  assertConsistent(e.db, sakId, T, 'F4');
});

test('F5: flere identiske samtidige koblinger gir nøyaktig én tiltak_koblet og ett sett spor-hendelser (idempotent under konkurranse)', async () => {
  for (const cold of [false, true]) {
    const e = env({}, { cold });
    const { sakId, a, b } = await setupSak(e);
    const res = await Promise.all([A, B, A, B, A].map((u) => outcome(set(e, u, sakId, [a, b]))));
    assert.ok(res.some((r) => r.ok), 'minst én kobling skal lykkes');
    for (const r of res.filter((x) => !x.ok)) assert.equal(r.code, 'aborted', 'tapere skal avvises tydelig, ikke feile uforutsett: ' + r.message);
    assert.equal(count(e.db, sakId, 'tiltak_koblet'), 1, 'cold=' + cold);
    assert.equal(count(e.db, sakId, 'spor_koblet'), 2);
    assert.deepEqual(e.db.at(`/sakTiltakSpor/${sakId}/${T}`), { [a]: true, [b]: true });
    assertConsistent(e.db, sakId, T, 'F5 cold=' + cold);
  }
});

test('F6: kobling til sak 2 mens tiltaket frakobles fra sak 1 gir aldri to saker eller foreldreløse koblinger', async () => {
  for (const cold of [false, true]) {
    const e = env({}, { cold });
    const s1 = await setupSak(e, 'Sak en');
    const s2 = await setupSak(e, 'Sak to');
    await set(e, A, s1.sakId, [s1.a]);
    const [r1, r2] = await Promise.all([outcome(remove(e, A, s1.sakId)), outcome(set(e, B, s2.sakId, [s2.b]))]);
    assert.equal(r1.ok, true, 'frakobling skal lykkes: ' + r1.message);
    const owner = e.db.at(`/tiltak/${T}/sakId`);
    assert.ok(owner === null || owner === s2.sakId, 'tiltaket kan aldri stå igjen i sak 1: ' + owner);
    assert.equal(r2.ok, owner === s2.sakId, 'ok-status må stemme med faktisk tilstand');
    assertConsistent(e.db, s1.sakId, T, 'sak 1');
    assertConsistent(e.db, s2.sakId, T, 'sak 2');
  }
});

/* ======================================================================
 * B. Transaksjonscallbacks som kjøres flere ganger (claimed / released)
 * ====================================================================== */

test('callback kjøres på nytt med ferske data: samtidige endringer på tiltaket går ikke tapt, claimed er riktig', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  let runs = 0;
  e.db.beforeCommit = (p) => { if (p === `/tiltak/${T}` && runs < 3) { e.db.data.tiltak[T].nestesteg = 'endret ' + runs; runs += 1; } };
  const res = await set(e, A, sakId, [a]);
  assert.equal(res.tilknyttet, true);
  const lagret = e.db.at(`/tiltak/${T}`);
  assert.equal(lagret.nestesteg, 'endret 2', 'siste samtidige endring bevares (ikke overskrevet av gammel kopi)');
  assert.equal(lagret.sakId, sakId);
  assert.equal(lagret.beskrivelse, 'INTERN');
  assert.equal(count(e.db, sakId, 'tiltak_koblet'), 1);
  assertConsistent(e.db, sakId, T, 'rerun');
});

test('claimed nullstilles per kjøring: rekker en annen forespørsel å koble samme sak mens vi prøver, skriver vi ikke tiltak_koblet', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  let first = true;
  e.db.beforeCommit = (p) => { if (p === `/tiltak/${T}` && first) { first = false; e.db.data.tiltak[T].sakId = sakId; } }; // «noen andre» koblet først
  const res = await set(e, A, sakId, [a]);
  assert.equal(res.tilknyttet, false, 'vi vant ikke kampen om medlemskapet');
  assert.equal(count(e.db, sakId, 'tiltak_koblet'), 0, 'og skal derfor ikke skrive tiltak_koblet');
  assert.deepEqual(e.db.at(`/sakTiltakSpor/${sakId}/${T}`), { [a]: true });
});

test('claimed lekker ikke mellom kjøringer: tapt kamp etter en vellykket første kjøring skriver ingenting', async () => {
  const e = env();
  const s1 = await setupSak(e, 'Sak en');
  const s2 = await setupSak(e, 'Sak to');
  let first = true;
  e.db.beforeCommit = (p) => { if (p === `/tiltak/${T}` && first) { first = false; e.db.data.tiltak[T].sakId = s2.sakId; } };
  const calls = e.db.updateCalls.length;
  const res = await outcome(set(e, A, s1.sakId, [s1.a]));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'aborted');
  assert.equal(e.db.updateCalls.length, calls, 'ingen skriving av spor/hendelser');
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), s2.sakId);
  assert.equal(count(e.db, s1.sakId, 'tiltak_koblet'), 0);
});

test('released nullstilles per kjøring: er tiltaket allerede frakoblet av andre når vi committer, skrives ingen falsk tiltak_frakoblet', async () => {
  // uten gjenværende spor-koblinger: ingenting å rydde, ingen hendelser, endret:false
  const e = env();
  const { sakId } = await setupSak(e);
  await set(e, A, sakId, []);
  let first = true;
  e.db.beforeCommit = (p) => { if (p === `/tiltak/${T}` && first) { first = false; delete e.db.data.tiltak[T].sakId; } }; // «noen andre» frakoblet først
  const frakobletFør = count(e.db, sakId, 'tiltak_frakoblet');
  const res = await remove(e, B, sakId);
  assert.equal(res.endret, false);
  assert.equal(count(e.db, sakId, 'tiltak_frakoblet'), frakobletFør, 'released lekket ikke fra første kjøring');
});

test('frakobling av tiltak som andre allerede har frikoblet, men som har gjenværende koblinger, ryddes og historikken heles', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  await set(e, A, sakId, [a]);
  delete e.db.data.tiltak[T].sakId; // frikoblet utenom Saker-funksjonene (f.eks. konsollen)
  const res = await remove(e, B, sakId);
  assert.equal(res.endret, true);
  assert.equal(e.db.at(`/sakTiltakSpor/${sakId}`), null);
  assert.equal(count(e.db, sakId, 'tiltak_frakoblet'), 1, 'medlemskapets slutt er nå i historikken');
  assertConsistent(e.db, sakId, T, 'opprydding');
  assert.equal((await remove(e, B, sakId)).endret, false, 'og nå er det ryddet');
});

test('kald cache (første kall får null) gir samme resultat som varm cache i alle flyter', async () => {
  for (const cold of [false, true]) {
    const e = env({}, { cold });
    const { sakId, a, b } = await setupSak(e);
    assert.equal((await set(e, A, sakId, [a])).tilknyttet, true);
    assert.equal((await set(e, A, sakId, [a, b])).endret, true);
    assert.equal((await set(e, A, sakId, [a, b])).endret, false);
    assert.equal((await remove(e, A, sakId)).endret, true);
    assert.equal((await remove(e, A, sakId)).endret, false);
    assertConsistent(e.db, sakId, T, 'cold=' + cold);
  }
});

/* ======================================================================
 * C. Per-tiltak-lås (serialiserer set/remove på samme tiltak)
 * ====================================================================== */

test('lås: holdes av en annen operasjon => aborted, ingenting skrives, den andres lås røres ikke', async () => {
  const e = env({}, {});
  const { sakId, a } = await setupSak(e);
  e.db.data.sakLocks = { [T]: { owner: 'annen-operasjon', until: T0 + 30000, uid: B } };
  const calls = e.db.updateCalls.length;
  for (const run of [() => set(e, A, sakId, [a]), () => remove(e, A, sakId)]) {
    const res = await outcome(run());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'aborted');
    assert.match(res.message, /oppdateres akkurat nå/);
  }
  assert.equal(e.db.updateCalls.length, calls);
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), null);
  assert.equal(e.db.at(`/sakLocks/${T}/owner`), 'annen-operasjon');
});

test('lås: utløpt lås overtas, og låsen er borte etter operasjonen', async () => {
  const e = env({}, { frozen: true });
  const { sakId, a } = await setupSak(e);
  e.db.data.sakLocks = { [T]: { owner: 'død-operasjon', until: T0 - 1, uid: B } };
  assert.equal((await set(e, A, sakId, [a])).tilknyttet, true);
  assert.equal(e.db.at(`/sakLocks`), null);
});

test('lås: frigjøres etter suksess, etter vanlig feil og etter at selve tilbakerullingen feiler', async () => {
  // suksess
  let e = env();
  let s = await setupSak(e);
  await set(e, A, s.sakId, [s.a]);
  assert.equal(e.db.at('/sakLocks'), null);
  // skrivefeil + vellykket tilbakerulling
  e = env();
  s = await setupSak(e);
  e.db.failUpdates = 3;
  await outcome(set(e, A, s.sakId, [s.a]));
  assert.equal(e.db.at('/sakLocks'), null);
  // skrivefeil + feilet tilbakerulling
  e = env();
  s = await setupSak(e);
  e.db.failUpdates = 3;
  let n = 0;
  e.db.onTransaction = async (p) => { if (p === `/tiltak/${T}` && ++n >= 2) throw new Error('tx nede'); };
  await outcome(set(e, A, s.sakId, [s.a]));
  assert.equal(e.db.at('/sakLocks'), null);
  // valideringsfeil etter at låsen er tatt (ukjent spor)
  e = env();
  s = await setupSak(e);
  await outcome(set(e, A, s.sakId, ['-OfinnesIkke']));
  assert.equal(e.db.at('/sakLocks'), null);
  // frakobling
  await outcome(remove(e, A, s.sakId));
  assert.equal(e.db.at('/sakLocks'), null);
});

test('lås: frigjøring fjerner aldri en lås som har gått over til en annen operasjon', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  e.db.onBeforeUpdate = async (paths) => {
    if (paths.some((p) => p.startsWith('/sakTiltakSpor/'))) e.db.data.sakLocks[T] = { owner: 'ny-eier', until: T0 + 60000, uid: B }; // vår lås «utløp» og ble overtatt
  };
  await set(e, A, sakId, [a]);
  assert.equal(e.db.at(`/sakLocks/${T}/owner`), 'ny-eier');
});

test('lås: feil ved frigjøring gjør ikke en vellykket operasjon til en feil; låsen utløper og stenger ikke tiltaket for alltid', async () => {
  const e = env();
  const { sakId, a, b } = await setupSak(e);
  e.db.onTransaction = async (p) => { if (p.startsWith('/sakLocks/') && e.db.at(p) && e.db.at(p).owner) { /* lås eksisterer = dette er frigjøringen */ throw new Error('release nede'); } };
  const res = await set(e, A, sakId, [a]);
  assert.equal(res.endret, true, 'operasjonen lyktes og skal meldes som lyktes');
  assert.ok(e.errors.length >= 1, 'feilen ble logget');
  e.db.onTransaction = null;
  const direkte = await outcome(set(e, A, sakId, [a, b]));
  assert.equal(direkte.code, 'aborted', 'låsen står til den utløper');
  e.advance(46000);
  assert.equal((await set(e, A, sakId, [a, b])).endret, true);
  assertConsistent(e.db, sakId, T, 'etter utløp');
});

test('lås: berører bare det aktuelle tiltaket; andre tiltak kan kobles samtidig', async () => {
  const e = env({ tiltak: { [T]: tiltak(), '-Ot2': tiltak() } });
  const { sakId, a } = await setupSak(e);
  const res = await Promise.all([outcome(set(e, A, sakId, [a], T)), outcome(set(e, B, sakId, [a], '-Ot2'))]);
  assert.deepEqual(res.map((r) => r.ok), [true, true]);
});

const overtattLås = (e) => { e.db.data.sakLocks = { [T]: { owner: 'ny-eier', until: T0 + 10 ** 9, uid: B } }; };

test('mister vi låsen mellom fase 1 og fase 2: ingenting mer skrives, ingen tilbakerulling, den nye eierens lås er urørt', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  let tatt = false;
  e.db.onGet = async (p) => { if (!tatt && p.startsWith('/sakTiltakSpor/')) { tatt = true; overtattLås(e); } }; // første lesing etter fase 1
  const res = await outcome(set(e, A, sakId, [a]));
  assert.equal(res.ok, false);
  assert.match(res.message, /delvis/);
  assert.doesNotMatch(res.message, /rullet tilbake/);
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), sakId, 'medlemskapet står (vi kan ikke vite om en annen har tatt over)');
  assert.equal(e.db.at('/sakTiltakSpor'), null, 'og vi skrev ikke fase 2');
  assert.equal(e.db.at(`/sakLocks/${T}/owner`), 'ny-eier');
});

test('mister vi låsen etter at fase 2 har feilet: ingen tilbakerulling (kunne fjernet en annens kobling), og meldingen sier delvis', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  e.db.onBeforeUpdate = async () => { overtattLås(e); throw new Error('skrivefeil'); }; // alle forsøk feiler, og låsen går tapt
  const res = await outcome(set(e, A, sakId, [a]));
  assert.equal(res.ok, false);
  assert.match(res.message, /delvis/);
  assert.doesNotMatch(res.message, /rullet tilbake/);
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), sakId, 'kompensasjonen ble ikke forsøkt uten lås');
  assert.equal(e.db.transactionCalls.filter((c) => c.path === `/tiltak/${T}`).length, 1, 'bare selve kobling-transaksjonen, ingen rollback-transaksjon');
});

test('mister vi låsen etter frikobling og skrivefeil: ingen gjenoppretting av sakId (en annen kan ha tatt tiltaket)', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  await set(e, A, sakId, [a]);
  e.db.onBeforeUpdate = async () => { overtattLås(e); throw new Error('skrivefeil'); };
  const res = await outcome(remove(e, A, sakId));
  assert.equal(res.ok, false);
  assert.match(res.message, /delvis/);
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), null, 'ikke gjenopprettet uten lås');
});

test('gjenoppretting av medlemskap overskriver aldri en annen saks kobling (frakobling feiler, tiltaket tas av en annen)', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  await set(e, A, sakId, [a]);
  e.db.failUpdates = 3;
  let n = 0;
  e.db.onTransaction = async (p) => { if (p === `/tiltak/${T}` && ++n === 2) e.db.data.tiltak[T].sakId = '-AnnenSak'; }; // rett før gjenopprettingen
  const res = await outcome(remove(e, A, sakId));
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.message, /rullet tilbake/);
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), '-AnnenSak', 'den andre sakens kobling er urørt');
});

test('tilbakerulling som ikke faktisk fjerner noe, meldes aldri som «rullet tilbake»', async () => {
  const e = env();
  const { sakId, a } = await setupSak(e);
  e.db.failUpdates = 3;
  let n = 0;
  e.db.onTransaction = async (p) => { // etter vår kobling, før tilbakerullingen: tiltaket flyttes (direkte skriving) til en annen sak
    if (p === `/tiltak/${T}` && ++n === 2) e.db.data.tiltak[T].sakId = '-AnnenSak';
  };
  const res = await outcome(set(e, A, sakId, [a]));
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.message, /rullet tilbake/, 'tilbakerullingen avbrøt (sakId var ikke lenger vår), så den kan ikke meldes som utført');
  assert.equal(e.db.at(`/tiltak/${T}/sakId`), '-AnnenSak', 'og den andres kobling er urørt');
});

/* ======================================================================
 * D. Feilinjeksjon: etter enhver enkeltfeil konverterer en ny kjøring til ønsket tilstand
 * ====================================================================== */

/*
 * Hver feil: inject(e) setter opp feilen. `hang` = prosessen «dør» (operasjonen fullføres aldri, og finally kjører aldri).
 * `orphanMellom` = foreldreløse spor-koblinger kan ligge igjen midlertidig (de ignoreres av lesere og ryddes av neste kjøring).
 */
const FEIL = {
  'skrivefeil 1×': { inject: (e) => { e.db.failUpdates = 1; } },
  'skrivefeil 2×': { inject: (e) => { e.db.failUpdates = 2; } },
  'skrivefeil 3× (kompensasjon)': { inject: (e) => { e.db.failUpdates = 3; } },
  'skrivefeil 3× og kompensasjonen kaster': {
    orphanMellom: true,
    inject: (e) => {
      e.db.failUpdates = 3;
      let n = 0;
      e.db.onTransaction = async (p) => { if (p === `/tiltak/${T}` && ++n >= 2) throw new Error('tx nede'); };
    },
  },
  'medlemskaps-transaksjonen kaster': {
    inject: (e) => {
      let n = 0;
      e.db.onTransaction = async (p) => { if (p === `/tiltak/${T}` && ++n === 1) throw new Error('tx nede'); };
    },
  },
  'lås-frigjøring kaster': {
    inject: (e) => { e.db.onTransaction = async (p) => { if (p.startsWith('/sakLocks/') && e.db.at(p)) throw new Error('release nede'); }; },
  },
  'prosessen dør etter medlemskap (lås står igjen)': {
    hang: true, orphanMellom: true,
    inject: (e) => { e.db.onBeforeUpdate = () => new Promise(() => {}); },
  },
};

const OPERASJONER = {
  'ny kobling med begge spor': {
    start: async () => {},
    kjor: (e, s) => set(e, A, s.sakId, [s.a, s.b]),
    forventSpor: (s) => [s.a, s.b], forventMedlem: true, claimer: true,
  },
  'endre spor-sett': {
    start: async (e, s) => { await set(e, A, s.sakId, [s.a]); },
    kjor: (e, s) => set(e, A, s.sakId, [s.b]),
    forventSpor: (s) => [s.b], forventMedlem: true,
  },
  'frakobling': {
    start: async (e, s) => { await set(e, A, s.sakId, [s.a, s.b]); },
    kjor: (e, s) => remove(e, A, s.sakId),
    forventSpor: () => [], forventMedlem: false,
  },
};

for (const [feilNavn, feil] of Object.entries(FEIL)) {
  for (const [opNavn, op] of Object.entries(OPERASJONER)) {
    test(`feilinjeksjon [${feilNavn}] × [${opNavn}]: aldri korrupt lesetilstand, og én ny kjøring konverterer`, async () => {
      const e = env();
      const s = await setupSak(e);
      await op.start(e, s);
      feil.inject(e);
      let forste;
      if (feil.hang) {
        op.kjor(e, s).catch(() => {}); // blir aldri ferdig
        for (let i = 0; i < 3000; i++) await Promise.resolve();
        forste = { ok: false, code: 'hang' };
      } else {
        forste = await outcome(op.kjor(e, s));
      }
      // Feilen er forbigående: rydd injeksjonene og la en eventuell stående lås utløpe.
      e.db.failUpdates = 0; e.db.failWhen = null; e.db.onTransaction = null; e.db.onBeforeUpdate = null; e.db.beforeCommit = null;
      e.advance(46000);

      // Lesetilstanden etter første forsøk er alltid trygg: foreldreløse koblinger kan finnes bare der det er erklært,
      // og da ignoreres de av getSak (rapporteres som ugyldige, teller ikke).
      const medlemEtter = e.db.at(`/tiltak/${T}/sakId`) === s.sakId;
      const orphan = e.db.at(`/sakTiltakSpor/${s.sakId}/${T}`) !== null;
      if (!medlemEtter && orphan) {
        assert.equal(feil.orphanMellom, true, 'uventet foreldreløse koblinger etter første forsøk');
        const d = await core.getSak(e.deps, A, { sakId: s.sakId });
        assert.deepEqual(d.tiltakIds, []);
        assert.deepEqual(d.tiltakSpor, {}, 'foreldreløse koblinger ignoreres av lesere');
        assert.deepEqual(d.ugyldigeKoblinger, [T]);
      }
      if (forste.ok) assertConsistent(e.db, s.sakId, T, 'etter vellykket første forsøk');

      const andre = await outcome(op.kjor(e, s));
      assert.equal(andre.ok, true, 'andre forsøk uten feil skal lykkes: ' + andre.message);
      assert.equal(e.db.at(`/tiltak/${T}/sakId`) === s.sakId, op.forventMedlem, 'sluttilstand: medlemskap');
      assert.deepEqual(Object.keys(e.db.at(`/sakTiltakSpor/${s.sakId}/${T}`) || {}).sort(), op.forventSpor(s).sort(), 'sluttilstand: spor');
      assert.equal(e.db.at('/sakLocks'), null, 'ingen låser står igjen');

      // Dokumentert gjenværende hull (kun KOBLING): feiler både skriving og kompensasjon, eller dør prosessen etter at
      // medlemskapet er skrevet, står tiltaket i saken uten spor og uten tiltak_koblet i sakEvents. Gjentakelse fullfører
      // sporene, men kan ikke vite at tiltak_koblet mangler. (Endringen er likevel logget i tiltakEvents, uten bruker.)
      const kjentHull = op.claimer && feil.orphanMellom;
      if (kjentHull) {
        assertConsistent(e.db, s.sakId, T, 'kjent hull', { history: false });
        assert.equal(count(e.db, s.sakId, 'tiltak_koblet'), 0, 'dokumentert hull: tiltak_koblet mangler');
      } else {
        assertConsistent(e.db, s.sakId, T, 'sluttilstand'); // inkl. FRAKOBLING: historikken heles av oppryddingsveien
      }
      // Idempotens: en tredje kjøring endrer ingenting.
      const calls = e.db.updateCalls.length;
      const tredje = await op.kjor(e, s);
      assert.equal(tredje.endret, false);
      assert.equal(e.db.updateCalls.length, calls);
    });
  }
}

test('tilfeldig flettede operasjoner (tidsstyrt) etterlater alltid konsistent tilstand', async () => {
  // Deterministisk pseudotilfeldig: 40 forløp med blanding av kobling/frakobling/spor-endring fra to brukere, med og uten kald cache.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let run = 0; run < 40; run++) {
    const e = env({}, { cold: rnd() < 0.5 });
    const s = await setupSak(e);
    const mulige = [
      () => outcome(set(e, rnd() < 0.5 ? A : B, s.sakId, [s.a])),
      () => outcome(set(e, rnd() < 0.5 ? A : B, s.sakId, [s.b])),
      () => outcome(set(e, rnd() < 0.5 ? A : B, s.sakId, [s.a, s.b])),
      () => outcome(set(e, rnd() < 0.5 ? A : B, s.sakId, [])),
      () => outcome(remove(e, rnd() < 0.5 ? A : B, s.sakId)),
    ];
    if (rnd() < 0.5) { let f = 1 + Math.floor(rnd() * 3); e.db.failWhen = (u) => Object.keys(u).some((p) => p.startsWith('/sakTiltakSpor/')) && f-- > 0; }
    const n = 2 + Math.floor(rnd() * 4);
    const res = await Promise.all(Array.from({ length: n }, () => mulige[Math.floor(rnd() * mulige.length)]()));
    for (const r of res.filter((x) => !x.ok)) assert.ok(['aborted', 'failed-precondition', 'internal'].includes(r.code), `uventet feilkode ${r.code}: ${r.message}`);
    assertConsistent(e.db, s.sakId, T, `forløp ${run}`);
    assert.equal(e.db.at('/sakLocks'), null, `forløp ${run}: lås står igjen`);
  }
});
