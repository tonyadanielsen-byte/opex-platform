'use strict';

// Kjør: node --test tests/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Vm = require('../saker/sak-view-model');
const L = require('../saker/sak-logic');

const IDAG = '2026-10-09';
const SAK = '-OsakRib';
const SA = '-OsporA';
const SB = '-OsporB';
const NAVN = { 'uid-a': 'Tony Danielsen', 'uid-b': 'Kenneth Nordbakk' };
const navn = (uid) => NAVN[uid] || '';

const t = (fbKey, over = {}) => ({ fbKey, tittel: 'Tiltak ' + fbKey, sakId: SAK, status: 'Aktiv', frist: '2026-12-01', eier: 'Tony Danielsen', miljo: 'Produksjon', livssyklus: 'Aktiv', systemId: 'KVAL-' + fbKey.slice(-4), ...over });

const ribbefett = () => [
  t('-Or1', { tittel: 'Fast lagergjennomgang hos Constellation', frist: '2026-10-30' }),
  t('-Or2', { tittel: 'Batchstyring', frist: '2026-10-16' }),
  t('-Or3', { tittel: 'Avvik mot Constellation', status: 'Fullført', frist: '2026-10-02', livssyklus: 'Arkivert', arkivert: true }),
  t('-Or4', { tittel: 'Datokontroll Frysa', frist: '2026-10-08', eier: 'Erling Magnussen' }),
  t('-Or5', { tittel: 'Datokontroll Ferdigmat', status: 'Innmeldt', frist: '2026-10-09' }),
  t('-Or6', { tittel: 'Systemvarsel/sperre', status: 'Til godkjenning', frist: '2026-11-15' }),
  t('-Or7', { tittel: 'Avklare tapskategori', frist: '2026-10-20' }),
];

const sak = (over = {}) => ({ sakId: SAK, kode: 'SAK-0001', tittel: 'Ribbefett 2025', problemstilling: 'Problem', eierUid: 'uid-a', status: 'Åpen', omrader: ['Ferdigmat'], opprettetAt: '2026-10-01T08:00:00.000Z', opprettetAv: 'uid-a', ...over });

const detail = (over = {}) => ({
  sak: sak(),
  spor: [{ sporId: SA, kode: 'A', sporsmal: 'Hvorfor oppsto restlageret?', rekkefolge: 1 }, { sporId: SB, kode: 'B', sporsmal: 'Hvorfor endte restlageret som kassasjon?', rekkefolge: 2 }],
  arsaker: [],
  tiltakIds: ['-Or1', '-Or2', '-Or3', '-Or4', '-Or5', '-Or6', '-Or7'],
  tiltakSpor: { '-Or1': [SA], '-Or2': [SA, SB], '-Or3': [SB], '-Or4': [SB], '-Or5': [SB], '-Or6': [SB], '-Or7': [] },
  ugyldigeKoblinger: [],
  tiltakEvents: {},
  sakEvents: {},
  avkortet: { tiltakEvents: [], sakEvents: false },
  hentetAt: '2026-10-09T10:00:00.000Z',
  ...over,
});

const bygg = (d = detail(), tasks = ribbefett()) => Vm.byggSakModell(d, tasks, { idag: IDAG, navn });
const ids = (rader) => rader.map((r) => r.id);

function deepFreeze(v) { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; }

/* ------------------------------------------------------------------ grunnmodell */

test('Ribbefett: nøkkeltall kommer fra sak-logic, og fremdrift vises som hele prosent', () => {
  const m = bygg();
  assert.equal(m.summary.totalt, 7);
  assert.equal(m.summary.gjort, 1);
  assert.equal(m.summary.gjenstar, 6);
  assert.equal(m.summary.forfalt, 1);
  assert.equal(m.prosent, 14);
  assert.equal(m.nesteFristTekst, 'I dag');
  assert.equal(m.sak.eierNavn, 'Tony Danielsen');
  assert.equal(m.sak.statusMeta.tone, 'info');
  assert.equal(m.sak.lukket, false);
});

test('tiltak grupperes etter spor; ett tiltak kan stå i flere spor; ikke-koblede for seg', () => {
  const m = bygg();
  assert.deepEqual(ids(m.spor[0].tiltak), ['-Or2', '-Or1'], 'spor A: etter frist');
  assert.deepEqual(new Set(ids(m.spor[1].tiltak)), new Set(['-Or2', '-Or3', '-Or4', '-Or5', '-Or6']));
  assert.deepEqual(ids(m.ikkeKoblet), ['-Or7']);
  assert.deepEqual(m.spor[1].tiltak.find((r) => r.id === '-Or2').sporIds.slice().sort(), [SA, SB].sort(), 'tiltaket vet at det står i begge spor');
});

test('tiltak sorteres: forfalt først, så gjenstående etter frist, fullførte til slutt', () => {
  const m = bygg();
  assert.deepEqual(ids(m.spor[1].tiltak), ['-Or4', '-Or5', '-Or2', '-Or6', '-Or3']);
  assert.deepEqual(ids(m.alleTiltak), ['-Or4', '-Or5', '-Or2', '-Or7', '-Or1', '-Or6', '-Or3']);
});

test('tiltaksrader har statusmerke, frist-tekst og systemId; forfalt overstyrer status', () => {
  const m = bygg();
  const r4 = m.alleTiltak.find((r) => r.id === '-Or4');
  assert.deepEqual([r4.statusMeta.label, r4.statusMeta.tone], ['Forfalt', 'danger']);
  assert.equal(r4.fristTekst, '1 dag over frist');
  assert.equal(r4.eier, 'Erling Magnussen');
  const r5 = m.alleTiltak.find((r) => r.id === '-Or5');
  assert.deepEqual([r5.statusMeta.label, r5.fristTekst], ['Innmeldt', 'I dag']);
  const r3 = m.alleTiltak.find((r) => r.id === '-Or3');
  assert.equal(r3.statusMeta.label, 'Fullført');
  assert.equal(r3.systemId, 'KVAL--Or3');
});

test('stanset, avsluttet og ekskluderte tiltak telles/vises riktig og tas ikke med i spor-gruppene', () => {
  const tasks = [...ribbefett(), t('-Os1', { status: 'Stanset' }), t('-Os2', { status: 'Avsluttet' }), t('-Ot', { miljo: 'Test' })];
  const d = detail({ tiltakIds: [...detail().tiltakIds, '-Os1', '-Os2', '-Ot'], tiltakSpor: { ...detail().tiltakSpor, '-Os1': [SA], '-Os2': [], '-Ot': [SA] } });
  const m = bygg(d, tasks);
  assert.equal(m.summary.stanset, 1);
  assert.equal(m.summary.avsluttet, 1);
  assert.equal(m.summary.ekskludert, 1);
  assert.deepEqual(ids(m.separate.stanset), ['-Os1']);
  assert.deepEqual(ids(m.separate.avsluttet), ['-Os2']);
  assert.equal(m.spor[0].tiltak.some((r) => r.id === '-Os1' || r.id === '-Ot'), false);
  assert.equal(m.ikkeKoblet.some((r) => r.id === '-Os2'), false, 'avsluttet tiltak er ikke «mangler spor»');
});

test('årsaker grupperes per spor med menneskelig vurdering (hvem/når); fjernede holdes adskilt', () => {
  const d = detail({
    arsaker: [
      { arsakId: '-Oa1', sporId: SA, tekst: 'Manglende fast rutine', status: 'støttet', grunnlag: 'Intervju', vurdertAv: 'uid-b', vurdertAt: '2026-10-08T22:30:00.000Z', opprettetAv: 'uid-a', opprettetAt: '2026-10-07T08:00:00.000Z', fjernet: false },
      { arsakId: '-Oa2', sporId: SA, tekst: 'Gammel ordlyd', status: 'hypotese', grunnlag: '', vurdertAv: 'uid-a', vurdertAt: '2026-10-06T08:00:00.000Z', opprettetAv: 'uid-a', opprettetAt: '2026-10-06T08:00:00.000Z', fjernet: true },
      { arsakId: '-Oa3', sporId: SB, tekst: 'Utgått batch', status: 'bekreftet', grunnlag: 'Batchlogg', vurdertAv: 'uid-ukjent', vurdertAt: '2026-10-09T08:00:00.000Z', opprettetAv: 'uid-a', opprettetAt: '2026-10-09T08:00:00.000Z', fjernet: false },
    ],
  });
  const m = bygg(d);
  assert.deepEqual(m.spor[0].arsaker.map((a) => a.arsakId), ['-Oa1']);
  assert.deepEqual(m.spor[0].fjernede.map((a) => a.arsakId), ['-Oa2']);
  assert.equal(m.spor[0].arsaker[0].vurdertAvNavn, 'Kenneth Nordbakk');
  assert.equal(m.spor[0].arsaker[0].vurdertDato, '2026-10-09', '22:30Z er allerede 9. oktober i Oslo');
  assert.deepEqual([m.spor[0].arsaker[0].meta.label, m.spor[0].arsaker[0].meta.tone], ['Støttet', 'info']);
  assert.equal(m.spor[1].arsaker[0].vurdertAvNavn, 'Ukjent bruker', 'ukjent uid vises ikke som tom tekst');
  assert.equal(m.spor[1].arsaker[0].meta.label, 'Bekreftet');
});

/* ------------------------------------------------------------------ krever handling */

test('Krever handling: forfalt og uten spor, sortert kritisk → advarsel → info, med handling', () => {
  const m = bygg();
  const k = m.kreverHandling;
  assert.equal(k[0].nivaa, 'kritisk');
  assert.equal(k[0].id, 'forfalt:-Or4');
  assert.deepEqual(k[0].handling, { type: 'apneTiltak', tiltakId: '-Or4', label: 'Åpne tiltak' });
  assert.match(k[0].tekst, /Datokontroll Frysa.*1 dag over frist/);
  const uten = k.find((x) => x.id === 'uten-spor');
  assert.equal(uten.nivaa, 'advarsel');
  assert.equal(uten.handling.tiltakId, '-Or7');
  const nivaaer = k.map((x) => x.nivaa);
  const rang = { kritisk: 0, advarsel: 1, info: 2 };
  assert.deepEqual(nivaaer.map((n) => rang[n]), nivaaer.map((n) => rang[n]).sort((a, b) => a - b));
  assert.ok(k.find((x) => x.id === 'godkjenning:-Or6'), 'tiltak som venter på godkjenning er en oppfølging');
  assert.ok(k.find((x) => x.id === 'spor-uten-arsak:' + SA), 'spor uten årsaker flagges');
});

test('Krever handling: hypoteser som venter på vurdering telles, men en vurdert årsak gjør det ikke', () => {
  const mk = (status) => detail({ arsaker: [{ arsakId: '-Oa1', sporId: SA, tekst: 'X', status, grunnlag: 'g', vurdertAv: 'uid-a', vurdertAt: '2026-10-09T08:00:00.000Z', opprettetAv: 'uid-a', opprettetAt: '2026-10-09T08:00:00.000Z', fjernet: false }] });
  assert.ok(bygg(mk('hypotese')).kreverHandling.find((x) => x.id === 'hypoteser'));
  assert.equal(bygg(mk('bekreftet')).kreverHandling.find((x) => x.id === 'hypoteser'), undefined);
});

test('Krever handling: tom sak foreslår å koble tiltak, og ingen spor gir ikke «uten spor»-varsel', () => {
  const tom = bygg(detail({ tiltakIds: [], tiltakSpor: {}, spor: [] }), []);
  const k = tom.kreverHandling;
  assert.ok(k.find((x) => x.id === 'ingen-tiltak' && x.handling.type === 'kobleTiltak'));
  assert.equal(k.find((x) => x.id === 'uten-spor'), undefined);
  assert.equal(tom.flagg.ingenTiltak, true);
  assert.equal(tom.flagg.ingenSpor, true);
  assert.equal(tom.prosent, null, 'ingen fremdrift å vise');
  assert.equal(tom.summary.fremdrift, null);
});

test('Krever handling: alle fullført foreslår «Løst», men endrer aldri status selv', () => {
  const tasks = [t('-Or1', { status: 'Fullført' }), t('-Or2', { status: 'Fullført' })];
  const d = detail({ tiltakIds: ['-Or1', '-Or2'], tiltakSpor: { '-Or1': [SA], '-Or2': [SB] } });
  const m = bygg(d, tasks);
  const f = m.kreverHandling.find((x) => x.id === 'alle-ferdig');
  assert.ok(f);
  assert.equal(f.handling.type, 'status');
  assert.match(f.detalj, /manuelt/);
  assert.equal(m.sak.status, 'Åpen', 'modellen endrer ikke status');
  assert.equal(bygg(detail({ ...d, sak: sak({ status: 'Løst' }) }), tasks).kreverHandling.find((x) => x.id === 'alle-ferdig'), undefined, 'ikke når saken allerede er løst');
});

test('Krever handling: datakvalitet (ukjent status, ugyldig frist, arkivert uten å være ferdig)', () => {
  const tasks = [t('-Or1', { status: 'Venter' }), t('-Or2', { frist: 'snart' }), t('-Or3', { arkivert: true }), t('-Or4', { frist: '' })];
  const d = detail({ tiltakIds: ['-Or1', '-Or2', '-Or3', '-Or4'], tiltakSpor: { '-Or1': [SA], '-Or2': [SA], '-Or3': [SA], '-Or4': [SA] } });
  const k = bygg(d, tasks).kreverHandling.map((x) => x.id);
  for (const id of ['dq-status', 'dq-frist', 'dq-arkiv', 'dq-uten-frist']) assert.ok(k.includes(id), id);
});

test('Krever handling: inaktivitet etter 14 dager vises for åpen sak, men ikke for løst/lukket eller uten hendelser', () => {
  const ev = { a: { type: 'sak_endret', felt: 'status', foer: 'Åpen', etter: 'Under oppfølging', createdAt: '2026-09-20T08:00:00.000Z', actorUid: 'uid-a' } };
  assert.ok(bygg(detail({ sakEvents: ev })).kreverHandling.find((x) => x.id === 'inaktiv'));
  assert.equal(bygg(detail({ sakEvents: {} })).kreverHandling.find((x) => x.id === 'inaktiv'), undefined, 'ingen hendelser er ikke «inaktiv» (historikk starter sent)');
  assert.equal(bygg(detail({ sak: sak({ status: 'Løst' }), sakEvents: ev })).kreverHandling.find((x) => x.id === 'inaktiv'), undefined);
  const nylig = { a: { ...ev.a, createdAt: '2026-10-05T08:00:00.000Z' } };
  assert.equal(bygg(detail({ sakEvents: nylig })).kreverHandling.find((x) => x.id === 'inaktiv'), undefined);
});

test('lukket sak: ingenting krever handling (saken er låst)', () => {
  const m = bygg(detail({ sak: sak({ status: 'Lukket' }) }));
  assert.deepEqual(m.kreverHandling, []);
  assert.equal(m.sak.lukket, true);
});

test('foreldreløse sporkoblinger nevnes, men teller ikke', () => {
  const m = bygg(detail({ ugyldigeKoblinger: ['-Oborte'] }));
  assert.ok(m.kreverHandling.find((x) => x.id === 'foreldreløse'));
  assert.equal(m.summary.totalt, 7);
});

/* ------------------------------------------------------------------ aktivitet */

test('aktivitet slår sammen sak- og tiltakshendelser, nyeste først, med lesbare tekster og aktør', () => {
  const d = detail({
    arsaker: [{ arsakId: '-Oa1', sporId: SA, tekst: 'Manglende fast rutine for restlager', status: 'hypotese', grunnlag: '', vurdertAv: 'uid-a', vurdertAt: '2026-10-09T08:00:00.000Z', opprettetAv: 'uid-a', opprettetAt: '2026-10-09T08:00:00.000Z', fjernet: false }],
    sakEvents: {
      s1: { type: 'sak_opprettet', createdAt: '2026-10-01T08:00:00.000Z', actorUid: 'uid-a', entityId: SAK, felt: 'kode', etter: 'SAK-0001' },
      s2: { type: 'tiltak_koblet', createdAt: '2026-10-01T08:05:00.000Z', actorUid: 'uid-a', entityId: '-Or1', felt: 'sakId', etter: SAK },
      s3: { type: 'spor_koblet', createdAt: '2026-10-01T08:05:01.000Z', actorUid: 'uid-a', entityId: '-Or1', felt: 'sporId', etter: SA },
      s4: { type: 'sak_endret', createdAt: '2026-10-08T09:00:00.000Z', actorUid: 'uid-b', entityId: SAK, felt: 'status', foer: 'Åpen', etter: 'Under oppfølging' },
      s5: { type: 'arsak_opprettet', createdAt: '2026-10-09T08:00:00.000Z', actorUid: 'uid-a', entityId: '-Oa1', felt: 'status', etter: 'hypotese' },
      s6: { type: 'arsak_endret', createdAt: '2026-10-09T09:00:00.000Z', actorUid: 'uid-b', entityId: '-Oa1', felt: 'status', foer: 'hypotese', etter: 'støttet' },
    },
    tiltakEvents: {
      '-Or4': { e1: { type: 'endret', felt: 'status', foer: 'Innmeldt', etter: 'Aktiv', createdAt: '2026-10-07T07:00:00.000Z' }, e2: { type: 'kommentar', kommentarId: 'c1', forfatterUid: 'uid-b', createdAt: '2026-10-09T09:30:00.000Z' } },
      '-Oannet': { x: { type: 'endret', createdAt: '2026-10-09T09:59:00.000Z' } },
    },
  });
  const m = bygg(d);
  const tekster = m.aktivitet.map((a) => a.tekst);
  assert.equal(tekster[0], 'Ny kommentar på «Datokontroll Frysa»', 'nyeste først');
  assert.deepEqual(m.aktivitet.map((a) => a.createdAt), m.aktivitet.map((a) => a.createdAt).slice().sort().reverse());
  assert.ok(tekster.includes('Årsaksstatus «Manglende fast rutine for restlager»: hypotese → støttet'));
  assert.ok(tekster.includes('Status endret: Åpen → Under oppfølging'));
  assert.ok(tekster.includes('«Fast lagergjennomgang hos Constellation» ble koblet til Spor A'));
  assert.ok(tekster.includes('Saken ble opprettet'));
  assert.ok(tekster.includes('«Datokontroll Frysa»: status Innmeldt → Aktiv'));
  assert.equal(tekster.some((x) => x.includes('annet')), false, 'hendelser for tiltak utenfor saken vises ikke');
  const kom = m.aktivitet[0];
  assert.equal(kom.aktor, 'Kenneth Nordbakk');
  assert.equal(kom.ikon, 'message');
  assert.equal(m.aktivitetTom, false);
  assert.equal(m.aktivitetAvkortet, false);
});

test('aktivitet: sakId-endring på tiltaket vises ikke dobbelt når saken har egen koblingshendelse', () => {
  const d = detail({
    sakEvents: { s2: { type: 'tiltak_koblet', createdAt: '2026-10-01T08:05:00.000Z', actorUid: 'uid-a', entityId: '-Or1', felt: 'sakId', etter: SAK } },
    tiltakEvents: { '-Or1': { e1: { type: 'endret', felt: 'sakId', etter: SAK, createdAt: '2026-10-01T08:05:01.000Z' } } },
  });
  const m = bygg(d);
  assert.equal(m.aktivitet.length, 1);
  assert.equal(m.aktivitet[0].kilde, 'sak');
  // uten sakshendelse (dobbeltfeil-hull) vises tiltakets egen hendelse så koblingen ikke forsvinner fra historikken
  const m2 = bygg(detail({ tiltakEvents: d.tiltakEvents }));
  assert.equal(m2.aktivitet.length, 1);
  assert.equal(m2.aktivitet[0].kilde, 'tiltak');
});

test('aktivitet: tom historikk og avkortet historikk signaliseres', () => {
  assert.equal(bygg().aktivitetTom, true);
  const ev = { a: { type: 'sak_endret', felt: 'tittel', createdAt: '2026-10-09T08:00:00.000Z', actorUid: 'uid-a' } };
  assert.equal(bygg(detail({ sakEvents: ev, avkortet: { tiltakEvents: [], sakEvents: true } })).aktivitetAvkortet, true);
  assert.equal(bygg(detail({ sakEvents: ev, avkortet: { tiltakEvents: ['-Or4'], sakEvents: false } })).aktivitetAvkortet, true);
  assert.equal(bygg(detail({ sakEvents: ev })).aktivitetAvkortet, false);
  assert.equal(bygg(detail({ sakEvents: ev, avkortet: undefined })).aktivitetAvkortet, false, 'eldre svar uten avkortet-felt');
});

test('aktivitet: ugyldige hendelser ignoreres, og dato/dager-siden bruker Oslo-dato', () => {
  const d = detail({ sakEvents: { bad: { type: 'sak_endret', createdAt: 'rot' }, nul: null, ok: { type: 'sak_endret', felt: 'status', foer: 'a', etter: 'b', createdAt: '2026-10-08T22:30:00.000Z', actorUid: 'uid-a' } } });
  const m = bygg(d);
  assert.equal(m.aktivitet.length, 1);
  assert.equal(m.aktivitet[0].dato, '2026-10-09');
  assert.equal(m.aktivitet[0].dagerSiden, 0);
});

test('aktivitet: ukjent aktør vises som «Ukjent bruker», manglende aktør som tom', () => {
  const d = detail({ sakEvents: { a: { type: 'sak_endret', felt: 'tittel', createdAt: '2026-10-09T08:00:00.000Z', actorUid: 'uid-fremmed' } }, tiltakEvents: { '-Or1': { b: { type: 'endret', felt: 'status', foer: 'A', etter: 'B', createdAt: '2026-10-09T07:00:00.000Z' } } } });
  const m = bygg(d);
  assert.equal(m.aktivitet.find((x) => x.kilde === 'sak').aktor, 'Ukjent bruker');
  assert.equal(m.aktivitet.find((x) => x.kilde === 'tiltak').aktor, '');
});

/* ------------------------------------------------------------------ oversikten */

const liste = (saker, detaljer = {}, tasks = ribbefett()) => Vm.byggListeModell(saker, detaljer, tasks, { idag: IDAG, navn });

test('oversikten: saker som trenger oppmerksomhet først, løste/lukkede for seg', () => {
  const tasks = [...ribbefett(), t('-Ob1', { sakId: '-Osak2', status: 'Aktiv', frist: '2026-12-01' }), t('-Oc1', { sakId: '-Osak3', status: 'Fullført' })];
  const saker = [
    sak({ sakId: '-Osak2', kode: 'SAK-0002', tittel: 'Rolig sak' }),
    sak({ sakId: SAK, kode: 'SAK-0001' }),
    sak({ sakId: '-Osak3', kode: 'SAK-0003', tittel: 'Ferdig sak', status: 'Lukket' }),
    sak({ sakId: '-Osak4', kode: 'SAK-0004', tittel: 'Tom sak' }),
  ];
  const l = liste(saker, {}, tasks);
  assert.deepEqual(l.aktive.map((k) => k.kode), ['SAK-0001', 'SAK-0004', 'SAK-0002']);
  assert.deepEqual(l.aktive.map((k) => k.nivaa), ['kritisk', 'advarsel', 'rolig']);
  assert.deepEqual(l.lukkede.map((k) => k.kode), ['SAK-0003']);
  assert.equal(l.kreverOppmerksomhet, 2);
  assert.equal(l.totalt, 4);
  assert.equal(l.aktive[0].nivaaArsak, '1 forfalt tiltak');
  assert.equal(l.aktive[1].nivaaArsak, 'Ingen tiltak koblet');
});

test('oversiktskort: tall, eier, fremdrift og «siste aktivitet» (lastet/ikke lastet)', () => {
  const k0 = liste([sak()]).aktive[0];
  assert.equal(k0.summary.totalt, 7);
  assert.equal(k0.prosent, 14);
  assert.equal(k0.eierNavn, 'Tony Danielsen');
  assert.equal(k0.aktivitetLastet, false);
  assert.equal(k0.nesteFristTekst, 'I dag');
  const k1 = liste([sak()], { [SAK]: detail({ sakEvents: { a: { type: 'sak_endret', felt: 'tittel', createdAt: '2026-10-08T08:00:00.000Z', actorUid: 'uid-a' } } }) }).aktive[0];
  assert.equal(k1.aktivitetLastet, true);
  assert.equal(k1.sisteAktivitetTekst, 'i går');
  const k2 = liste([sak()], { [SAK]: detail() }).aktive[0];
  assert.equal(k2.aktivitetLastet, true);
  assert.equal(k2.sisteAktivitetTekst, '', 'lastet, men ingen hendelser');
});

test('oversikten: alle fullført flagges som advarsel (vurder å løse), lukket sak aldri', () => {
  const tasks = [t('-Or1', { status: 'Fullført' })];
  assert.equal(liste([sak()], {}, tasks).aktive[0].nivaa, 'advarsel');
  assert.equal(liste([sak({ status: 'Lukket' })], {}, [t('-Or1', { status: 'Aktiv', frist: '2020-01-01' })]).aktive.length, 0);
  assert.equal(liste([sak({ status: 'Lukket' })], {}, [t('-Or1', { status: 'Aktiv', frist: '2020-01-01' })]).lukkede[0].nivaa, 'rolig');
});

test('oversikten: tom liste og ugyldig inndata gir tomme lister, ikke feil', () => {
  for (const x of [[], undefined, null]) {
    const l = liste(x);
    assert.deepEqual([l.aktive, l.lukkede, l.totalt, l.kreverOppmerksomhet], [[], [], 0, 0]);
  }
});

/* ------------------------------------------------------------------ koble-kandidater */

test('kobleKandidater: bare ledige tiltak; test/papirkurv ute; andre saker vises som utilgjengelige med saksnummer', () => {
  const tasks = [
    t('-A', { sakId: undefined, tittel: 'Ledig en' }),
    t('-B', { sakId: undefined, tittel: 'Ledig to', status: 'Fullført' }),
    t('-C', { sakId: undefined, miljo: 'Test' }),
    t('-D', { sakId: undefined, livssyklus: 'Papirkurv' }),
    t('-E', { sakId: '-Osak2', tittel: 'I annen sak' }),
    t('-F', { sakId: '-Oukjent', tittel: 'I ukjent sak' }),
    t('-G', { sakId: '', tittel: 'Tom sakId er ledig' }),
  ];
  const r = Vm.kobleKandidater(tasks, [{ sakId: '-Osak2', kode: 'SAK-0002' }], '');
  assert.deepEqual(r.ledige.map((x) => x.id).sort(), ['-A', '-B', '-G']);
  assert.deepEqual(r.andreSaker.map((x) => [x.id, x.sakKode]).sort(), [['-E', 'SAK-0002'], ['-F', 'en annen sak']]);
  assert.deepEqual(Vm.kobleKandidater(tasks, [], 'ledig to').ledige.map((x) => x.id), ['-B']);
  assert.deepEqual(Vm.kobleKandidater(tasks, [], 'KVAL-').ledige.length, 3, 'søk på systemId');
  assert.deepEqual(Vm.kobleKandidater(undefined, undefined), { ledige: [], andreSaker: [] });
});

/* ------------------------------------------------------------------ tekst, rene funksjoner */

test('fristTekst og dagerSidenTekst', () => {
  assert.deepEqual([0, 1, 5, -1, -4, null, undefined].map(Vm.fristTekst), ['I dag', 'I morgen', 'Om 5 dager', '1 dag over frist', '4 dager over frist', 'Ingen frist', 'Ingen frist']);
  assert.deepEqual([0, -1, 1, 3, undefined].map(Vm.dagerSidenTekst), ['i dag', 'i dag', 'i går', '3 dager siden', '']);
  assert.equal(Vm.prosent(0.14285), 14);
  assert.equal(Vm.prosent(null), null);
  assert.equal(Vm.kutt('a'.repeat(100), 10), 'aaaaaaaaa…');
});

test('statusmetadata: alle statuser har merkelapp, tone og ikon (aldri bare farge)', () => {
  for (const s of Vm.SAK_STATUSER) { const m = Vm.SAK_STATUS_META[s]; assert.ok(m.tone && m.icon && m.beskrivelse, s); }
  for (const s of Vm.ARSAK_STATUSER) { const m = Vm.ARSAK_STATUS_META[s]; assert.ok(m.label && m.tone && m.icon && m.beskrivelse, s); }
  for (const s of ['Innmeldt', 'Til godkjenning', 'Aktiv', 'Fullført', 'Stanset', 'Avsluttet', 'Noe annet', '']) { const m = Vm.tiltakStatusMeta(s, false); assert.ok(m.label && m.tone && m.icon, s); }
  assert.equal(Vm.tiltakStatusMeta('Aktiv', true).label, 'Forfalt');
});

test('modellen muterer ikke inndata og er ren (ingen DOM/Firebase/nettverk)', () => {
  assert.doesNotThrow(() => Vm.byggSakModell(deepFreeze(detail({ sakEvents: { a: { type: 'sak_endret', felt: 'tittel', createdAt: '2026-10-09T08:00:00.000Z' } } })), deepFreeze(ribbefett()), { idag: IDAG, navn }));
  assert.doesNotThrow(() => Vm.byggListeModell(deepFreeze([sak()]), deepFreeze({}), deepFreeze(ribbefett()), { idag: IDAG, navn }));
  const src = fs.readFileSync(path.join(__dirname, '..', 'saker', 'sak-view-model.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/\b(window|document|navigator|localStorage|fetch|XMLHttpRequest|firebase|innerHTML|console|setTimeout)\b/.test(src), false);
});

test('visningsmodellen tåler ufullstendig serverdata (eldre svar, manglende felt)', () => {
  const minimal = { sak: { sakId: SAK, kode: 'SAK-0001', tittel: 'x', status: 'Åpen', eierUid: '' } };
  const m = Vm.byggSakModell(minimal, [], { idag: IDAG });
  assert.equal(m.spor.length, 0);
  assert.equal(m.summary.totalt, 0);
  assert.equal(m.sak.eierNavn, '');
  assert.deepEqual(m.aktivitet, []);
  assert.ok(Array.isArray(m.kreverHandling));
});
