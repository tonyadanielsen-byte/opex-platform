'use strict';

// Kjør: node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_PATH = path.join(__dirname, '..', 'saker', 'sak-logic.js');
const L = require(SRC_PATH);

const IDAG = '2026-10-09'; // fredag
const SAK = '-OribbeFett2025';

/* ------------------------------------------------------------------ fixtures */

const tiltak = (fbKey, over = {}) => ({
  fbKey,
  tittel: 'Tiltak ' + fbKey,
  sakId: SAK,
  status: 'Aktiv',
  frist: '2026-12-01',
  eier: 'Tony Danielsen',
  miljo: 'Produksjon',
  livssyklus: 'Aktiv',
  ...over,
});

// Ribbefett 2025 – restlager og kassasjon (dagens tilstand, IDAG = 2026-10-09)
const ribbefett = () => [
  tiltak('-Or1', { tittel: 'Fast lagergjennomgang hos Constellation', status: 'Aktiv', frist: '2026-10-30' }),
  tiltak('-Or2', { tittel: 'Batchstyring ved bestilling fra Constellation', status: 'Aktiv', frist: '2026-10-16' }),
  tiltak('-Or3', { tittel: 'Avvik mot Constellation – utgått vare sendt til Sarpsborg', status: 'Fullført', frist: '2026-10-02', livssyklus: 'Arkivert', arkivert: true }),
  tiltak('-Or4', { tittel: 'Internt avvik – datokontroll ved mottak på Frysa', status: 'Aktiv', frist: '2026-10-08' }),
  tiltak('-Or5', { tittel: 'Internt avvik – datokontroll før pakking i Ferdigmat', status: 'Innmeldt', frist: '2026-10-09' }),
  tiltak('-Or6', { tittel: 'Vurdere systemvarsel/sperre ved mottak av utgått vare', status: 'Til godkjenning', frist: '2026-11-15' }),
  tiltak('-Or7', { tittel: 'Avklare tapskategori og årsak til restlager ribbefett 2025', status: 'Aktiv', frist: '2026-10-20' }),
];

const sum = (tasks, extra = {}) => L.oppsummerSak(tasks, { sakId: SAK, idag: IDAG, ...extra });
const klasse = (over, idag = IDAG) => L.klassifiserTiltak(tiltak('-Ox', over), idag);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/* ---------------------------------------------------------------- [01]–[27] */

test('[01] vanlig aktiv sak: Ribbefett gir riktige tall', () => {
  const s = sum(ribbefett());
  assert.equal(s.totalt, 7);
  assert.equal(s.kobletTotalt, 7);
  assert.equal(s.gjort, 1);
  assert.equal(s.gjenstar, 6);
  assert.equal(s.forfalt, 1);
  assert.equal(s.stanset, 0);
  assert.equal(s.avsluttet, 0);
  assert.equal(s.ekskludert, 0);
  assert.equal(s.fremdrift, 1 / 7);
  assert.deepEqual(s.naermesteFrist, { dato: '2026-10-09', tiltakIds: ['-Or5'], dagerTil: 0 });
  assert.deepEqual(s.eldsteForfaltFrist, { dato: '2026-10-08', tiltakIds: ['-Or4'], dagerSiden: 1 });
  assert.equal(s.sisteAktivitet, null);
  assert.equal(s.idag, IDAG);
});

test('[02] Fullført er gjort, også når tiltaket er arkivert/lagret', () => {
  const p = klasse({ status: 'Fullført', livssyklus: 'Arkivert', arkivert: true, frist: '2026-01-01' });
  assert.equal(p.klasse, 'gjort');
  assert.equal(p.forfalt, false, 'fullført tiltak med gammel frist er ikke forfalt');
  const s = sum([tiltak('-a', { status: 'Fullført', livssyklus: 'Arkivert', arkivert: true })]);
  assert.equal(s.gjort, 1);
  assert.equal(s.fremdrift, 1);
});

test('[03] Innmeldt er gjenstår', () => {
  const p = klasse({ status: 'Innmeldt' });
  assert.equal(p.klasse, 'gjenstar');
  assert.equal(p.status, 'Innmeldt');
  assert.equal(p.ukjentStatus, false);
});

test('[04] Aktiv er gjenstår', () => {
  const p = klasse({ status: 'Aktiv' });
  assert.equal(p.klasse, 'gjenstar');
  assert.equal(p.ukjentStatus, false);
});

test('[05] Til godkjenning er gjenstår', () => {
  const p = klasse({ status: 'Til godkjenning' });
  assert.equal(p.klasse, 'gjenstar');
  assert.equal(p.ukjentStatus, false);
});

test('[06] Forfalt: frist før i dag er forfalt og en delmengde av gjenstår', () => {
  const p = klasse({ status: 'Aktiv', frist: '2026-10-08' });
  assert.equal(p.klasse, 'gjenstar');
  assert.equal(p.forfalt, true);
  const s = sum([tiltak('-a', { frist: '2026-10-08' }), tiltak('-b', { frist: '2026-10-08', status: 'Innmeldt' }), tiltak('-c', { frist: '2026-12-01' })]);
  assert.equal(s.gjenstar, 3, 'forfalte telles også som gjenstår');
  assert.equal(s.forfalt, 2);
  assert.ok(s.forfalt <= s.gjenstar);
  assert.equal(s.totalt, 3, 'forfalt er ikke en egen kategori i totalt');
});

test('[07] frist i dag er IKKE forfalt', () => {
  const p = klasse({ status: 'Aktiv', frist: IDAG });
  assert.equal(p.forfalt, false);
  const s = sum([tiltak('-a', { frist: IDAG })]);
  assert.equal(s.forfalt, 0);
  assert.equal(s.naermesteFrist.dagerTil, 0);
  assert.equal(s.eldsteForfaltFrist, null);
});

test('[08] Stanset telles separat og er aldri forfalt eller gjenstår', () => {
  const p = klasse({ status: 'Stanset', frist: '2026-01-01', livssyklus: 'Idebank', arkivert: true });
  assert.equal(p.klasse, 'stanset');
  assert.equal(p.forfalt, false);
  const s = sum([tiltak('-a', { status: 'Stanset', frist: '2026-01-01' })]);
  assert.equal(s.stanset, 1);
  assert.equal(s.gjenstar, 0);
  assert.equal(s.forfalt, 0);
});

test('[09] Avsluttet telles separat og er aldri forfalt eller gjenstår', () => {
  const p = klasse({ status: 'Avsluttet', frist: '2026-01-01', livssyklus: 'Avsluttet', arkivert: true });
  assert.equal(p.klasse, 'avsluttet');
  assert.equal(p.forfalt, false);
  const s = sum([tiltak('-a', { status: 'Avsluttet', frist: '2026-01-01' })]);
  assert.equal(s.avsluttet, 1);
  assert.equal(s.gjenstar, 0);
});

test('[10] miljo=Test ekskluderes, uansett status', () => {
  for (const status of ['Aktiv', 'Fullført', 'Stanset', 'Avsluttet', 'Innmeldt']) {
    const p = klasse({ miljo: 'Test', status, frist: '2026-01-01' });
    assert.equal(p.klasse, 'ekskludert', status);
    assert.equal(p.ekskludertArsak, 'test');
    assert.equal(p.forfalt, false);
  }
  const s = sum([tiltak('-a', { miljo: 'Test' }), tiltak('-b', {})]);
  assert.equal(s.ekskludert, 1);
  assert.equal(s.totalt, 1);
  assert.equal(s.kobletTotalt, 2);
});

test('[11] test=true ekskluderes (som isTest i appen)', () => {
  const p = klasse({ test: true, miljo: 'Produksjon' });
  assert.equal(p.klasse, 'ekskludert');
  assert.equal(p.ekskludertArsak, 'test');
  assert.equal(klasse({ test: 'true' }).klasse, 'gjenstar', 'bare boolsk true teller, som i appen');
  assert.equal(klasse({ miljo: undefined }).klasse, 'gjenstar', 'manglende miljo regnes som Produksjon');
  assert.equal(klasse({ miljo: '' }).klasse, 'gjenstar');
});

test('[12] papirkurv ekskluderes (livssyklus eller papirkurv-flagg), og vinner over test', () => {
  assert.equal(klasse({ livssyklus: 'Papirkurv' }).ekskludertArsak, 'papirkurv');
  assert.equal(klasse({ papirkurv: true }).ekskludertArsak, 'papirkurv');
  assert.equal(klasse({ livssyklus: 'Papirkurv', miljo: 'Test' }).ekskludertArsak, 'papirkurv');
  assert.equal(klasse({ livssyklus: 'Papirkurv', status: 'Fullført' }).klasse, 'ekskludert');
  assert.equal(klasse({ papirkurv: false, livssyklus: 'Aktiv' }).klasse, 'gjenstar');
});

test('[13] gammel status Åpen → Innmeldt (gjenstår)', () => {
  const p = klasse({ status: 'Åpen' });
  assert.equal(p.status, 'Innmeldt');
  assert.equal(p.klasse, 'gjenstar');
  assert.equal(p.ukjentStatus, false);
  assert.equal(L.normStatus('Åpen'), 'Innmeldt');
});

test('[14] gammel status Pågår → Aktiv (gjenstår)', () => {
  const p = klasse({ status: 'Pågår' });
  assert.equal(p.status, 'Aktiv');
  assert.equal(p.klasse, 'gjenstar');
  assert.equal(L.normStatus('Pågår'), 'Aktiv');
});

test('[15] gammel status Avvist → Avsluttet (separat, ikke gjenstår)', () => {
  const p = klasse({ status: 'Avvist', frist: '2026-01-01' });
  assert.equal(p.status, 'Avsluttet');
  assert.equal(p.klasse, 'avsluttet');
  assert.equal(p.forfalt, false);
  assert.equal(L.normStatus('Avvist'), 'Avsluttet');
});

test('[16] tom status behandles som Innmeldt (som computedStatus)', () => {
  for (const status of ['', undefined, null]) {
    const p = klasse({ status });
    assert.equal(p.status, 'Innmeldt', String(status));
    assert.equal(p.klasse, 'gjenstar');
    assert.equal(p.ukjentStatus, false);
  }
  assert.equal(klasse({ status: undefined, frist: '2026-10-01' }).forfalt, true);
});

test('[17] ukjent status er gjenstår (som i appen), men flagges i datakvalitet', () => {
  const p = klasse({ status: 'Venter på svar' });
  assert.equal(p.klasse, 'gjenstar');
  assert.equal(p.ukjentStatus, true);
  assert.equal(p.status, 'Venter på svar');
  const s = sum([tiltak('-a', { status: 'Venter på svar' }), tiltak('-b', {})]);
  assert.deepEqual(s.datakvalitet.ukjentStatus, { antall: 1, tiltakIds: ['-a'] });
  // eksakt sammenligning som normStatus i appen: avvikende skrivemåte er ukjent, ikke stille rettet
  assert.equal(klasse({ status: 'aktiv' }).ukjentStatus, true);
  assert.equal(klasse({ status: 'Fullført ' }).klasse, 'gjenstar');
});

test('[18] ugyldig frist ignoreres for forfalt og nærmeste frist, og flagges', () => {
  const ugyldige = ['2026-13-45', '09.10.2026', '2026-10-9', ' 2026-10-09', '2026-10-09T00:00:00', '2026-02-30', 'snart', 20261009, true, {}];
  for (const frist of ugyldige) {
    const p = klasse({ frist });
    assert.equal(p.fristStatus, 'ugyldig', JSON.stringify(frist));
    assert.equal(p.forfalt, false);
    assert.equal(p.frist, null);
  }
  const s = sum([
    tiltak('-a', { frist: 'snart' }),
    tiltak('-b', { frist: '' }),
    tiltak('-c', { frist: undefined }),
    tiltak('-d', { frist: '2026-10-12' }),
  ]);
  assert.equal(s.forfalt, 0);
  assert.deepEqual(s.naermesteFrist, { dato: '2026-10-12', tiltakIds: ['-d'], dagerTil: 3 });
  assert.deepEqual(s.datakvalitet.ugyldigFrist, { antall: 1, tiltakIds: ['-a'] });
  assert.deepEqual(s.datakvalitet.utenFrist, { antall: 2, tiltakIds: ['-b', '-c'] });
});

test('[19] ingen tiltak gir nuller og null (aldri NaN)', () => {
  for (const tasks of [[], undefined, null, [tiltak('-x', { sakId: '-annenSak' })], [tiltak('-y', { sakId: undefined })]]) {
    const s = sum(tasks);
    assert.equal(s.totalt, 0);
    assert.equal(s.kobletTotalt, 0);
    assert.equal(s.gjort, 0);
    assert.equal(s.gjenstar, 0);
    assert.equal(s.forfalt, 0);
    assert.equal(s.stanset, 0);
    assert.equal(s.avsluttet, 0);
    assert.equal(s.ekskludert, 0);
    assert.equal(s.fremdrift, null);
    assert.equal(s.naermesteFrist, null);
    assert.equal(s.eldsteForfaltFrist, null);
    assert.equal(s.sisteAktivitet, null);
    assert.deepEqual(s.tiltak, []);
  }
});

test('[20] bare Stanset/Avsluttet: fremdrift er null, ikke 0 og ikke NaN', () => {
  const s = sum([tiltak('-a', { status: 'Stanset' }), tiltak('-b', { status: 'Avsluttet' }), tiltak('-c', { status: 'Avvist' })]);
  assert.equal(s.totalt, 3);
  assert.equal(s.stanset, 1);
  assert.equal(s.avsluttet, 2);
  assert.equal(s.gjort + s.gjenstar, 0);
  assert.equal(s.fremdrift, null);
  assert.equal(s.naermesteFrist, null);
});

test('[21] fremdrift = gjort / (gjort + gjenstår); stanset og avsluttet inngår ikke i nevneren', () => {
  assert.equal(sum([tiltak('-a', { status: 'Aktiv' })]).fremdrift, 0, 'ingen gjort = 0, ikke null');
  assert.equal(sum([tiltak('-a', { status: 'Fullført' })]).fremdrift, 1);
  assert.equal(sum([tiltak('-a', { status: 'Fullført' }), tiltak('-b', { status: 'Aktiv' }), tiltak('-c', { status: 'Innmeldt' })]).fremdrift, 1 / 3);
  const medSeparate = sum([
    tiltak('-a', { status: 'Fullført' }), tiltak('-b', { status: 'Aktiv' }),
    tiltak('-c', { status: 'Stanset' }), tiltak('-d', { status: 'Avsluttet' }), tiltak('-e', { status: 'Stanset' }),
  ]);
  assert.equal(medSeparate.fremdrift, 0.5, 'stanset/avsluttet påvirker ikke fremdriften');
  const medTest = sum([tiltak('-a', { status: 'Fullført' }), tiltak('-b', { status: 'Aktiv', miljo: 'Test' })]);
  assert.equal(medTest.fremdrift, 1, 'ekskluderte påvirker ikke fremdriften');
});

test('[22] nærmeste frist: kun gjenstående, tidligste fra i dag og fremover, med lik-dato-liste', () => {
  const s = sum([
    tiltak('-a', { frist: '2026-10-20' }),
    tiltak('-b', { frist: '2026-10-14' }),
    tiltak('-c', { frist: '2026-10-14', status: 'Innmeldt' }),
    tiltak('-d', { status: 'Fullført', frist: '2026-10-10' }), // gjort: ignoreres
    tiltak('-e', { status: 'Stanset', frist: '2026-10-10' }), // separat: ignoreres
    tiltak('-f', { status: 'Avsluttet', frist: '2026-10-10' }), // separat: ignoreres
    tiltak('-g', { miljo: 'Test', frist: '2026-10-10' }), // ekskludert: ignoreres
    tiltak('-h', { livssyklus: 'Papirkurv', frist: '2026-10-10' }), // ekskludert: ignoreres
    tiltak('-i', { frist: '2026-10-01' }), // forfalt: er ikke «kommende»
  ]);
  assert.deepEqual(s.naermesteFrist, { dato: '2026-10-14', tiltakIds: ['-b', '-c'], dagerTil: 5 });
  assert.deepEqual(s.eldsteForfaltFrist, { dato: '2026-10-01', tiltakIds: ['-i'], dagerSiden: 8 });

  const bareForfalt = sum([tiltak('-a', { frist: '2026-09-01' })]);
  assert.equal(bareForfalt.naermesteFrist, null);
  assert.equal(bareForfalt.forfalt, 1);

  assert.equal(sum([tiltak('-a', { frist: IDAG }), tiltak('-b', { frist: '2026-10-10' })]).naermesteFrist.dato, IDAG);
});

test('[23] siste aktivitet fra tiltakEvents (rå RTDB-form og array), kun for saksens tiltak', () => {
  const tiltakEvents = {
    '-Or1': {
      k1: { type: 'endret', felt: 'status', createdAt: '2026-10-07T10:00:00.000Z' },
      k2: { type: 'kommentar', createdAt: '2026-10-08T12:30:00.000Z' },
    },
    '-Or4': { k3: { type: 'endret', felt: 'frist', createdAt: '2026-10-09T05:00:00.000Z' } },
    '-Ox1': { k4: { type: 'endret', createdAt: '2026-10-09T06:00:00.000Z' } }, // annen sak
    '-Os4': { k5: { type: 'endret', createdAt: '2026-10-09T07:00:00.000Z' } }, // testtiltak i saken
    '-Or2': { bad1: { type: 'endret', createdAt: 'ikke en dato' }, bad2: { type: 'endret' }, bad3: 'tekst' },
  };
  const tasks = [...ribbefett(), tiltak('-Os4', { miljo: 'Test' })];
  const s = sum(tasks, { tiltakEvents });
  assert.deepEqual(s.sisteAktivitet, {
    createdAt: '2026-10-09T05:00:00.000Z', dato: '2026-10-09', dagerSiden: 0,
    kilde: 'tiltak', type: 'endret', tiltakId: '-Or4', felt: 'frist',
  });

  const arr = Object.entries(tiltakEvents).flatMap(([tiltakId, m]) => Object.values(m).filter(e => e && typeof e === 'object').map(e => ({ ...e, tiltakId })));
  assert.deepEqual(sum(tasks, { tiltakEvents: arr }).sisteAktivitet, s.sisteAktivitet);

  const bareKommentar = sum(tasks, { tiltakEvents: { '-Or1': { k2: tiltakEvents['-Or1'].k2 } } });
  assert.equal(bareKommentar.sisteAktivitet.type, 'kommentar', 'kommentaraktivitet teller som aktivitet');
  assert.equal(bareKommentar.sisteAktivitet.dagerSiden, 1);
});

test('[24] siste aktivitet fra sakEvents (rå form og array), og sak vinner ved lik tid', () => {
  const sakEvents = {
    e1: { type: 'sak_opprettet', createdAt: '2026-10-01T08:00:00.000Z', actorUid: 'u1' },
    e2: { type: 'tiltak_koblet', createdAt: '2026-10-09T08:00:00.000Z', actorUid: 'u1', entityId: '-Or1' },
    e3: { type: 'sak_endret', createdAt: '2026-10-05T08:00:00.000Z', actorUid: 'u1' },
  };
  const s = sum(ribbefett(), { sakEvents });
  assert.equal(s.sisteAktivitet.kilde, 'sak');
  assert.equal(s.sisteAktivitet.type, 'tiltak_koblet');
  assert.equal(s.sisteAktivitet.createdAt, '2026-10-09T08:00:00.000Z');
  assert.equal(s.sisteAktivitet.tiltakId, null);
  assert.deepEqual(sum(ribbefett(), { sakEvents: Object.values(sakEvents) }).sisteAktivitet, s.sisteAktivitet);

  // nyere tiltakshendelse slår eldre sakshendelse
  const nyereTiltak = sum(ribbefett(), { sakEvents, tiltakEvents: { '-Or2': { x: { type: 'endret', felt: 'eier', createdAt: '2026-10-09T09:00:00.000Z' } } } });
  assert.equal(nyereTiltak.sisteAktivitet.kilde, 'tiltak');
  assert.equal(nyereTiltak.sisteAktivitet.tiltakId, '-Or2');

  // lik tid: sak vinner, uavhengig av rekkefølge
  const lik = { type: 'endret', felt: 'status', createdAt: '2026-10-09T08:00:00.000Z' };
  const tie = sum(ribbefett(), { sakEvents: { s: { type: 'sak_endret', createdAt: lik.createdAt } }, tiltakEvents: { '-Or1': { t: lik } } });
  assert.equal(tie.sisteAktivitet.kilde, 'sak');

  // tidspunkt med offset normaliseres til UTC
  const offset = sum(ribbefett(), { sakEvents: [{ type: 'sak_endret', createdAt: '2026-10-09T10:00:00+02:00' }] });
  assert.equal(offset.sisteAktivitet.createdAt, '2026-10-09T08:00:00.000Z');
});

test('[25] ingen aktivitet gir null', () => {
  for (const extra of [{}, { tiltakEvents: {}, sakEvents: {} }, { tiltakEvents: [], sakEvents: [] }, { tiltakEvents: null, sakEvents: undefined },
    { sakEvents: { a: { createdAt: 'rot' }, b: { type: 'x' }, c: null } },
    { tiltakEvents: { '-Ox9': { a: { createdAt: '2026-10-09T05:00:00.000Z' } } } }]) {
    assert.equal(sum(ribbefett(), extra).sisteAktivitet, null, JSON.stringify(extra));
  }
  assert.equal(L.sisteAktivitet({ idag: IDAG }), null);
  assert.equal(L.sisteAktivitet(), null);
});

/* ---------- [26] Oslo-dato rundt midnatt og sommertid ---------- */

test('[26a] Oslo-dato: sommertid (UTC+2) rundt midnatt', () => {
  assert.equal(L.osloDato('2026-10-08T21:59:59Z'), '2026-10-08');
  assert.equal(L.osloDato('2026-10-08T22:00:00Z'), '2026-10-09'); // 00:00 Oslo; UTC-datoen er fortsatt 8.
  assert.equal(L.osloDato('2026-10-08T22:30:00Z'), '2026-10-09');
  assert.equal(L.osloDato('2026-10-08T23:59:59Z'), '2026-10-09');
  assert.equal(L.osloDato('2026-10-09T00:00:00Z'), '2026-10-09');
});

test('[26b] Oslo-dato: vintertid (UTC+1) rundt midnatt og nyttår', () => {
  assert.equal(L.osloDato('2026-12-31T22:59:59Z'), '2026-12-31');
  assert.equal(L.osloDato('2026-12-31T23:00:00Z'), '2027-01-01');
  assert.equal(L.osloDato('2027-01-15T23:30:00Z'), '2027-01-16');
});

test('[26c] Oslo-dato: overgangene til og fra sommertid i 2026 (29. mars og 25. oktober)', () => {
  assert.equal(L.osloDato('2026-03-28T22:59:59Z'), '2026-03-28'); // 23:59:59 CET
  assert.equal(L.osloDato('2026-03-28T23:00:00Z'), '2026-03-29'); // 00:00 CET
  assert.equal(L.osloDato('2026-03-29T00:59:59Z'), '2026-03-29'); // 01:59:59 CET
  assert.equal(L.osloDato('2026-03-29T01:00:00Z'), '2026-03-29'); // 03:00 CEST
  assert.equal(L.osloDato('2026-03-29T21:59:59Z'), '2026-03-29'); // 23:59:59 CEST
  assert.equal(L.osloDato('2026-03-29T22:00:00Z'), '2026-03-30'); // 00:00 CEST

  assert.equal(L.osloDato('2026-10-24T21:59:59Z'), '2026-10-24'); // 23:59:59 CEST
  assert.equal(L.osloDato('2026-10-24T22:00:00Z'), '2026-10-25'); // 00:00 CEST
  assert.equal(L.osloDato('2026-10-25T00:59:59Z'), '2026-10-25'); // 02:59:59 CEST
  assert.equal(L.osloDato('2026-10-25T01:00:00Z'), '2026-10-25'); // 02:00 CET (klokka satt tilbake)
  assert.equal(L.osloDato('2026-10-25T22:59:59Z'), '2026-10-25'); // 23:59:59 CET
  assert.equal(L.osloDato('2026-10-25T23:00:00Z'), '2026-10-26'); // 00:00 CET
});

test('[26d] Oslo-dato stemmer med uavhengig sommertidsberegning for alle tidspunkt 2025–2030', () => {
  const sisteSondag = (year, month) => {
    const d = new Date(Date.UTC(year, month + 1, 0));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return Date.UTC(year, month, d.getUTCDate(), 1, 0, 0); // 01:00 UTC
  };
  const referanse = (ms) => {
    const y = new Date(ms).getUTCFullYear();
    const sommer = ms >= sisteSondag(y, 2) && ms < sisteSondag(y, 9);
    return new Date(ms + (sommer ? 2 : 1) * 3600000).toISOString().slice(0, 10);
  };
  const fra = Date.UTC(2025, 0, 1);
  const til = Date.UTC(2031, 0, 1);
  let n = 0;
  for (let ms = fra; ms < til; ms += 17 * 60000) { // 17 min: treffer alle klokkeslett over tid
    assert.equal(L.osloDato(ms), referanse(ms), new Date(ms).toISOString());
    n++;
  }
  for (let y = 2025; y <= 2030; y++) {
    for (const m of [2, 9]) {
      const grense = sisteSondag(y, m);
      for (const delta of [-3600000, -1000, 0, 1000, 3600000]) assert.equal(L.osloDato(grense + delta), referanse(grense + delta));
    }
  }
  assert.ok(n > 150000);
});

test('[26e] forfalt rundt norsk midnatt: samme tidspunkt gir forskjellig svar enn dagens UTC-logikk', () => {
  const t = [tiltak('-a', { frist: '2026-10-08' })];
  const natt = '2026-10-08T22:30:00Z'; // 00:30 fredag 9. oktober i Oslo
  const utcDato = natt.slice(0, 10);
  assert.equal(utcDato, '2026-10-08', 'dagens app ville sett «i dag» = 8. oktober (feil)');
  const rett = L.oppsummerSak(t, { sakId: SAK, now: natt });
  assert.equal(rett.idag, '2026-10-09');
  assert.equal(rett.forfalt, 1, '8. oktober er forfalt klokka 00:30 den 9.');

  const kvelden = L.oppsummerSak(t, { sakId: SAK, now: '2026-10-08T21:59:59Z' }); // 23:59:59 den 8.
  assert.equal(kvelden.idag, '2026-10-08');
  assert.equal(kvelden.forfalt, 0, 'frist i dag er ikke forfalt');

  const vinter = L.oppsummerSak([tiltak('-a', { frist: '2026-12-31' })], { sakId: SAK, now: '2026-12-31T23:30:00Z' });
  assert.equal(vinter.idag, '2027-01-01');
  assert.equal(vinter.forfalt, 1);

  assert.equal(L.oppsummerSak(t, { sakId: SAK, now: new Date('2026-10-08T22:30:00Z') }).idag, '2026-10-09');
  assert.equal(L.oppsummerSak(t, { sakId: SAK, now: Date.parse(natt) }).idag, '2026-10-09');
});

test('[26f] siste aktivitet bruker Oslo-dato for «dato» og «dagerSiden»', () => {
  const s = L.oppsummerSak(ribbefett(), {
    sakId: SAK, now: '2026-10-09T10:00:00Z',
    sakEvents: [{ type: 'sak_endret', createdAt: '2026-10-08T22:30:00.000Z' }],
  });
  assert.equal(s.sisteAktivitet.dato, '2026-10-09', '22:30Z = 00:30 Oslo neste dag');
  assert.equal(s.sisteAktivitet.dagerSiden, 0);
});

test('[27] blanding av alle kategorier: tellerne går opp og ingenting telles to ganger', () => {
  const tasks = [
    ...ribbefett(),
    tiltak('-Os1', { status: 'Stanset', frist: '2026-09-01' }),
    tiltak('-Os2', { status: 'Avsluttet' }),
    tiltak('-Os3', { status: 'Avvist' }),
    tiltak('-Os4', { miljo: 'Test', frist: '2026-01-01' }),
    tiltak('-Os5', { test: true }),
    tiltak('-Os6', { livssyklus: 'Papirkurv' }),
    tiltak('-Os7', { status: 'Åpen', frist: '2026-10-05' }),
    tiltak('-Os8', { status: 'Pågår', frist: '2026-10-12' }),
    tiltak('-Os9', { status: '', frist: '' }),
    tiltak('-Os10', { status: 'Venter', frist: '2026-10-10' }),
    tiltak('-Os11', { status: 'Aktiv', frist: 'snart' }),
    tiltak('-Ox1', { sakId: '-annenSak', status: 'Fullført' }),
    tiltak('-Ox2', { sakId: undefined }),
  ];
  const s = sum(tasks);
  assert.equal(s.gjort, 1);
  assert.equal(s.gjenstar, 11);
  assert.equal(s.forfalt, 2);
  assert.equal(s.stanset, 1);
  assert.equal(s.avsluttet, 2);
  assert.equal(s.ekskludert, 3);
  assert.equal(s.totalt, 15);
  assert.equal(s.kobletTotalt, 18);
  assert.equal(s.totalt, s.gjort + s.gjenstar + s.stanset + s.avsluttet);
  assert.equal(s.kobletTotalt, s.totalt + s.ekskludert);
  assert.ok(s.forfalt <= s.gjenstar);
  assert.equal(s.fremdrift, 1 / 12);
  assert.deepEqual(s.naermesteFrist, { dato: '2026-10-09', tiltakIds: ['-Or5'], dagerTil: 0 });
  assert.deepEqual(s.eldsteForfaltFrist, { dato: '2026-10-05', tiltakIds: ['-Os7'], dagerSiden: 4 });
  assert.deepEqual(s.datakvalitet.ukjentStatus, { antall: 1, tiltakIds: ['-Os10'] });
  assert.deepEqual(s.datakvalitet.ugyldigFrist, { antall: 1, tiltakIds: ['-Os11'] });
  assert.deepEqual(s.datakvalitet.utenFrist, { antall: 1, tiltakIds: ['-Os9'] });
  assert.equal(s.tiltak.length, 18);
  assert.deepEqual(s.tiltak.map(p => p.klasse).filter(k => k === 'ekskludert').length, 3);
});

/* --------------------------------------------- arkiverte tiltak (avklaring før 1c) */

test('[28] Fullført + arkivert/lagret teller som gjort, uansett hvilken arkivmarkering som brukes', () => {
  for (const arkiv of [{ livssyklus: 'Arkivert', arkivert: true }, { livssyklus: 'Arkivert' }, { arkivert: true }]) {
    const p = klasse({ status: 'Fullført', frist: '2026-01-01', ...arkiv });
    assert.equal(p.klasse, 'gjort', JSON.stringify(arkiv));
    assert.equal(p.forfalt, false);
    assert.equal(p.arkivertIkkeFerdig, false, 'fullført + arkivert er forventet tilstand, ikke et avvik');
  }
  const s = sum([tiltak('-a', { status: 'Fullført', livssyklus: 'Arkivert', arkivert: true }), tiltak('-b', {})]);
  assert.equal(s.gjort, 1);
  assert.equal(s.datakvalitet.arkivertIkkeFerdig.antall, 0);
});

test('[29] arkivert tiltak med ikke-ferdig status: gjenstår, IKKE forfalt, og flagges som datakvalitetsavvik', () => {
  const arkivmarkeringer = [
    { arkivert: true }, { livssyklus: 'Arkivert' }, { livssyklus: 'Idebank' }, { livssyklus: 'Idébank' }, { livssyklus: 'Avsluttet' },
  ];
  for (const arkiv of arkivmarkeringer) {
    for (const status of ['Aktiv', 'Innmeldt', 'Til godkjenning', 'Åpen', 'Pågår', '', 'Venter']) {
      const p = klasse({ status, frist: '2026-10-08', ...arkiv }); // gammel frist
      assert.equal(p.klasse, 'gjenstar', JSON.stringify([status, arkiv]));
      assert.equal(p.forfalt, false, 'arkivert skal aldri regnes som forfalt: ' + JSON.stringify([status, arkiv]));
      assert.equal(p.arkivertIkkeFerdig, true);
    }
  }
  const s = sum([
    tiltak('-a', { status: 'Aktiv', frist: '2026-10-01', livssyklus: 'Arkivert', arkivert: true }),
    tiltak('-b', { status: 'Innmeldt', frist: '2026-10-03', arkivert: true }),
    tiltak('-c', { status: 'Aktiv', frist: '2026-10-01' }), // vanlig forfalt tiltak
    tiltak('-d', { status: 'Aktiv', frist: '2026-10-20' }),
  ]);
  assert.equal(s.gjenstar, 4, 'arkiverte ikke-ferdige regnes fortsatt som gjenstår');
  assert.equal(s.forfalt, 1, 'bare det vanlige tiltaket er forfalt');
  assert.deepEqual(s.datakvalitet.arkivertIkkeFerdig, { antall: 2, tiltakIds: ['-a', '-b'] });
  assert.deepEqual(s.eldsteForfaltFrist, { dato: '2026-10-01', tiltakIds: ['-c'], dagerSiden: 8 });
});

test('[30] arkivert ikke-ferdig tiltak med gammel frist forurenser ikke «nærmeste frist» eller «eldste forfalte»', () => {
  const s = sum([tiltak('-a', { status: 'Aktiv', frist: '2026-01-01', arkivert: true })]);
  assert.equal(s.gjenstar, 1);
  assert.equal(s.forfalt, 0);
  assert.equal(s.naermesteFrist, null, 'en passert frist er ikke «kommende»');
  assert.equal(s.eldsteForfaltFrist, null);
  // arkivert ikke-ferdig med framtidig frist er fortsatt en kommende frist (og flagges)
  const framtid = sum([tiltak('-a', { status: 'Aktiv', frist: '2026-10-20', arkivert: true })]);
  assert.equal(framtid.naermesteFrist.dato, '2026-10-20');
  assert.equal(framtid.datakvalitet.arkivertIkkeFerdig.antall, 1);
});

test('[31] arkivert + Stanset/Avsluttet er forventet (ikke avvik); ekskluderte flagges ikke', () => {
  for (const status of ['Stanset', 'Avsluttet', 'Avvist']) {
    const p = klasse({ status, livssyklus: 'Idebank', arkivert: true });
    assert.equal(p.arkivertIkkeFerdig, false, status);
  }
  const s = sum([
    tiltak('-a', { status: 'Stanset', livssyklus: 'Idebank', arkivert: true }),
    tiltak('-b', { status: 'Aktiv', arkivert: true, miljo: 'Test' }),
    tiltak('-c', { status: 'Aktiv', arkivert: true, livssyklus: 'Papirkurv' }),
  ]);
  assert.equal(s.datakvalitet.arkivertIkkeFerdig.antall, 0);
  assert.equal(s.ekskludert, 2);
});

test('[32] erArkivert har samme regler som isArchived i appen', () => {
  assert.equal(L.erArkivert({ arkivert: true }), true);
  for (const l of ['Arkivert', 'Idebank', 'Idébank', 'Avsluttet']) assert.equal(L.erArkivert({ livssyklus: l }), true, l);
  for (const l of ['Aktiv', 'Papirkurv', undefined, '']) assert.equal(L.erArkivert({ livssyklus: l }), false, String(l));
  assert.equal(L.erArkivert({ arkivert: false }), false);
  assert.equal(L.erArkivert({ arkivert: 'true' }), false);
  assert.equal(L.erArkivert(null), false);
});

/* ------------------------------------------------- øvrig kontrakt og robusthet */

test('medlemskap bestemmes bare av tiltak.sakId (tiltak i andre saker og uten sak ignoreres)', () => {
  const tasks = [tiltak('-a'), tiltak('-b', { sakId: '-annen' }), tiltak('-c', { sakId: undefined }), tiltak('-d', { sakId: '' }), tiltak('-e', { sakId: ` ${SAK} ` })];
  assert.deepEqual(L.tiltakForSak(tasks, SAK).map(t => t.fbKey), ['-a', '-e']);
  assert.deepEqual(L.tiltakForSak(tasks, ''), []);
  assert.deepEqual(L.tiltakForSak(tasks, undefined), []);
  assert.deepEqual(L.tiltakForSak('ikke en liste', SAK), []);
});

test('tiltak-id hentes fra fbKey (appen), ellers id', () => {
  const s = sum([{ sakId: SAK, id: '-viaId', status: 'Aktiv' }, tiltak('-viaKey')]);
  assert.deepEqual(s.tiltak.map(p => p.id), ['-viaId', '-viaKey']);
});

test('modulen muterer ikke inndata', () => {
  const tasks = deepFreeze(ribbefett());
  const events = deepFreeze({ '-Or1': { k: { type: 'endret', createdAt: '2026-10-09T05:00:00.000Z' } } });
  const sakEvents = deepFreeze([{ type: 'sak_endret', createdAt: '2026-10-08T05:00:00.000Z' }]);
  assert.doesNotThrow(() => sum(tasks, { tiltakEvents: events, sakEvents }));
  assert.doesNotThrow(() => L.oppsummerSaker(tasks, [SAK], { idag: IDAG, tiltakEvents: events, sakEvents: { [SAK]: sakEvents } }));
});

test('ugyldig idag/now/tidspunkt gir tydelig feil i stedet for stille feil svar', () => {
  assert.throws(() => L.oppsummerSak([], { sakId: SAK, idag: '2026-02-30' }), /idag/);
  assert.throws(() => L.oppsummerSak([], { sakId: SAK, idag: '9.10.2026' }), /idag/);
  assert.throws(() => L.oppsummerSak([], { sakId: SAK, now: 'ikke en dato' }), /Ugyldig tidspunkt/);
  assert.throws(() => L.osloDato('2026-10-09'), /ren dato/);
  assert.throws(() => L.osloDato(NaN), /Ugyldig tidspunkt/);
  assert.throws(() => L.osloDato(null), /Date, millisekunder eller ISO/);
  assert.throws(() => L.klassifiserTiltak({}, 'i dag'), /idag/);
  assert.throws(() => L.dagerMellom('2026-10-09', 'x'), /gyldige/);
});

test('gyldigDato og dagerMellom: ekte kalenderdatoer, skuddår og sommertid gir hele dager', () => {
  assert.equal(L.gyldigDato('2026-10-09'), true);
  assert.equal(L.gyldigDato('2028-02-29'), true);
  assert.equal(L.gyldigDato('2026-02-29'), false);
  assert.equal(L.gyldigDato('2026-00-10'), false);
  assert.equal(L.gyldigDato('2026-10-32'), false);
  assert.equal(L.gyldigDato(''), false);
  assert.equal(L.gyldigDato(undefined), false);
  assert.equal(L.dagerMellom('2026-10-09', '2026-10-09'), 0);
  assert.equal(L.dagerMellom('2026-10-09', '2026-10-16'), 7);
  assert.equal(L.dagerMellom('2026-10-16', '2026-10-09'), -7);
  assert.equal(L.dagerMellom('2028-02-28', '2028-03-01'), 2);
  assert.equal(L.dagerMellom('2026-03-28', '2026-03-30'), 2, 'sommertidsovergang gir fortsatt hele dager');
  assert.equal(L.dagerMellom('2026-10-24', '2026-10-26'), 2);
  assert.equal(L.dagerMellom('2026-12-31', '2027-01-01'), 1);
});

test('oppsummerSaker beregner flere saker med samme datagrunnlag og sakEvents per sak', () => {
  const tasks = [...ribbefett(), tiltak('-b1', { sakId: '-sakB', status: 'Fullført' }), tiltak('-b2', { sakId: '-sakB', status: 'Aktiv', frist: '2026-10-01' })];
  const r = L.oppsummerSaker(tasks, [SAK, '-sakB', '-tom'], {
    idag: IDAG,
    sakEvents: { '-sakB': [{ type: 'sak_endret', createdAt: '2026-10-08T10:00:00.000Z' }] },
  });
  assert.deepEqual(Object.keys(r), [SAK, '-sakB', '-tom']);
  assert.equal(r[SAK].totalt, 7);
  assert.equal(r[SAK].sisteAktivitet, null, 'sakEvents for en annen sak telles ikke');
  assert.equal(r['-sakB'].totalt, 2);
  assert.equal(r['-sakB'].forfalt, 1);
  assert.equal(r['-sakB'].fremdrift, 0.5);
  assert.equal(r['-sakB'].sisteAktivitet.createdAt, '2026-10-08T10:00:00.000Z');
  assert.equal(r['-tom'].totalt, 0);
  assert.deepEqual(L.oppsummerSaker(tasks, undefined, {}), {});
});

test('resultatet kan serialiseres (JSON) uten tap, klart for UI og AI-grunnlag', () => {
  const s = sum(ribbefett(), { sakEvents: [{ type: 'sak_endret', createdAt: '2026-10-08T05:00:00.000Z' }] });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

/* -------------------------------------------- uavhengighet: DOM, Firebase, globals */

test('API-et er stabilt og frosset', () => {
  assert.deepEqual(Object.keys(L).sort(), [
    'dagerMellom', 'erArkivert', 'erPapirkurv', 'erTest', 'gyldigDato', 'klassifiserTiltak',
    'normStatus', 'oppsummerSak', 'oppsummerSaker', 'osloDato', 'sisteAktivitet', 'tiltakForSak',
  ].sort());
  assert.equal(Object.isFrozen(L), true);
});

test('kildekoden bruker ingen DOM, Firebase, nettverk, lagring eller Node-globaler', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const kode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const forbudt = /\b(window|document|navigator|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|firebase|Firebase|require|process|Buffer|setTimeout|setInterval|console|alert|confirm|prompt|location|__dirname)\b/;
  const treff = kode.match(forbudt);
  assert.equal(treff, null, 'forbudt referanse i sak-logic.js: ' + (treff && treff[0]));
});

test('modulen virker i et tomt JS-miljø uten require/module/window (som et klassisk <script>)', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC_PATH, 'utf8'), sandbox);
  const lib = sandbox.OpExSakLogic;
  assert.ok(lib, 'OpExSakLogic ble ikke satt som global');
  assert.deepEqual(Object.keys(lib).sort(), Object.keys(L).sort());
  assert.deepEqual(Object.keys(sandbox), ['OpExSakLogic'], 'modulen skal ikke lage andre globaler');
  const fraSandbox = JSON.parse(JSON.stringify(lib.oppsummerSak(ribbefett(), { sakId: SAK, idag: IDAG })));
  const fraNode = JSON.parse(JSON.stringify(sum(ribbefett())));
  assert.deepEqual(fraSandbox, fraNode, 'samme resultat i nettleser-modus som i Node');
  assert.equal(lib.osloDato(new Date('2026-10-08T22:30:00Z')), '2026-10-09', 'Date fra annen realm fungerer');
});
