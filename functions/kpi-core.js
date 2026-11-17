'use strict';

/*
 * KPI (per avdeling: renhold, senere ferdigmat) — serverlogikk (ren, testbar mot simulert database). Bindes til callables i kpi-api.js.
 *
 * Datamodell (leses/skrives KUN her, via admin SDK — klienter har ingen direkte tilgang):
 *   /kpi/{enhet}/config/{aar}             { naerMaalProsent, kpier: { kpiId: { navn, omrade, enhet, retning, aggregat, maaltype,
 *                                             maal, fjorResultat, naerMaalProsent, sortering, aktiv } }, oppdatertAv, oppdatertAt }
  *   /kpi/{enhet}/verdier/{aar}/{mm}/{kpiId}  tall (i visningsenhet: prosent som 94.8)
  *   /kpi/{enhet}/registrert/{aar}/{mm}      { av, at }   siste registrering for måneden
  *   /kpi/{enhet}/logg/{aar}/{nøkkel}        { mnd, kpiId, foer, etter, av, at }   append-only endringslogg
  *   /kpi/{enhet}/registratorer/{uid}        true          (ekstra registratorer uten ny deploy)
 *
 * Avdelingene (enhet) og standard registratorer står i kpi-enheter.js. Alle kall tar { enhet }.
 * Tilgang: lese = innlogget bruker i /authorizedUsers. Skrive = registrator (standard for avdelingen, eller flagget i databasen).
 * KPI-tiltak skrives til den felles tiltakslista /tiltak med kobling (kilde: 'kpi', kpiEnhet, kpiId, kpiAar), slik at eksisterende
 * tiltaksvarsler (opprettet, endret, frist) gjelder automatisk.
 */

class KpiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KpiError';
    this.code = code;
  }
}
function fail(code, message) { throw new KpiError(code, message); }

const E = require('./kpi-enheter');

const KJENTE_NAVN = Object.freeze({
  TJKI3zlDKSR7jvFXksVFgEgjS432: 'Tony Danielsen',
  gibm3aDi1KWlNyl7P3jTktQoGsM2: 'Kenneth Nordbakk',
  lJ7bn7HkbcZnhDoxfaBYQKEFL083: 'Erling Magnussen',
});

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const KPI_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MND = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const ENHETER = ['Antall', '%', 'Kr', 'Score'];
const MAKS_KPIER = 40;
const MAKS_VERDI = 1e12;
const KATEGORIER = ['HMS', 'Kvalitet', 'KF', 'GPP', 'LOR', 'Annet'];
const PRIORITETER = ['Lav', 'Middels', 'Høy', 'Kritisk'];
const KATEGORI_FOR_OMRADE = { HMS: 'HMS', KF: 'KF', Renholdsresultater: 'Kvalitet' };

function clean(v) { return String(v ?? '').trim(); }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function erTall(v) { return typeof v === 'number' && Number.isFinite(v); }

/* ---------------------------------------------------------------- tilgang */

async function requireAuthorized(deps, uid) {
  const id = clean(uid);
  if (!id) fail('unauthenticated', 'Du må være logget inn.');
  if (!SAFE_ID.test(id)) fail('permission-denied', 'Brukeren har ikke tilgang til OpEx.');
  const snap = await deps.db.ref(`/authorizedUsers/${id}`).get();
  if (snap.val() !== true) fail('permission-denied', 'Brukeren har ikke tilgang til OpEx.');
  return id;
}

async function erRegistrator(deps, uid, enhet) {
  if (E.hent(enhet).registratorer.includes(uid)) return true;
  return (await deps.db.ref(`/kpi/${enhet}/registratorer/${uid}`).get()).val() === true;
}

/** Gyldig avdeling (enhet) fra kallet. Sjekkes etter innlogging, så uinnloggede kall avvises først. */
function lesEnhet(v) {
  const id = clean(v);
  if (!E.hent(id)) fail('invalid-argument', 'Ukjent KPI-avdeling.');
  return id;
}

/** Innlogget + gyldig avdeling. Returnerer { id, enhet, B } der B er databasestien for avdelingen. */
async function tilgang(deps, uid, input) {
  const id = await requireAuthorized(deps, uid);
  const enhet = lesEnhet(input.enhet);
  return { id, enhet, B: `/kpi/${enhet}` };
}

async function requireRegistrator(deps, uid, input) {
  const t = await tilgang(deps, uid, input);
  if (!(await erRegistrator(deps, t.id, t.enhet))) fail('permission-denied', 'Bare de som registrerer KPI-er kan gjøre endringer her.');
  return t;
}

function navnFor(uid) { return KJENTE_NAVN[uid] || ''; }

/* ---------------------------------------------------------------- validering */

function lesAar(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 2020 || n > 2100) fail('invalid-argument', 'Ugyldig år.');
  return n;
}

function lesMaaned(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 12) fail('invalid-argument', 'Ugyldig måned.');
  return MND[n - 1];
}

function lesVerdi(v, hvor) {
  if (v === null || v === undefined || v === '') return null;
  if (!erTall(v) || Math.abs(v) > MAKS_VERDI) fail('invalid-argument', `Ugyldig tall for ${hvor}.`);
  return Math.round(v * 1e6) / 1e6;
}

function tekst(v, felt, maks, paakrevd) {
  const t = clean(v);
  if (paakrevd && !t) fail('invalid-argument', `${felt} må fylles ut.`);
  if (t.length > maks) fail('invalid-argument', `${felt} kan ha maks ${maks} tegn.`);
  return t;
}

function valg(v, lovlige, felt) {
  const t = clean(v);
  if (!lovlige.includes(t)) fail('invalid-argument', `Ugyldig ${felt}: «${t}».`);
  return t;
}

function lesGrense(v, felt) {
  if (v === null || v === undefined || v === '') return null;
  if (!erTall(v) || v < 0 || v > 100) fail('invalid-argument', `${felt} må være mellom 0 og 100 %.`);
  return v;
}

/** Validerer og normaliserer en hel årskonfigurasjon. */
function lesConfig(input) {
  if (!isObject(input)) fail('invalid-argument', 'Mangler KPI-oppsett.');
  const naer = lesGrense(input.naerMaalProsent, 'Grensen for «nær mål»');
  if (!isObject(input.kpier)) fail('invalid-argument', 'Oppsettet må ha minst én KPI.');
  const ider = Object.keys(input.kpier);
  if (!ider.length) fail('invalid-argument', 'Oppsettet må ha minst én KPI.');
  if (ider.length > MAKS_KPIER) fail('invalid-argument', `Maks ${MAKS_KPIER} KPI-er per år.`);
  const kpier = {};
  const navnBrukt = new Set();
  ider.forEach((id, i) => {
    if (!KPI_ID.test(id)) fail('invalid-argument', `Ugyldig KPI-id «${id}».`);
    const d = input.kpier[id];
    if (!isObject(d)) fail('invalid-argument', `Ugyldig KPI «${id}».`);
    const navn = tekst(d.navn, 'KPI-navn', 80, true);
    const nokkel = navn.toLowerCase();
    if (navnBrukt.has(nokkel)) fail('invalid-argument', `KPI-navnet «${navn}» er brukt to ganger.`);
    navnBrukt.add(nokkel);
    kpier[id] = {
      navn,
      omrade: tekst(d.omrade, 'Område', 40, true),
      enhet: valg(d.enhet, ENHETER, 'enhet'),
      retning: valg(d.retning, ['Opp', 'Ned'], 'retning'),
      aggregat: valg(d.aggregat, ['Sum', 'Snitt'], 'aggregat'),
      maaltype: valg(d.maaltype, ['HIA', 'Fast'], 'måltype'),
      maal: lesVerdi(d.maal, `mål for ${navn}`),
      fjorResultat: lesVerdi(d.fjorResultat, `fjorårets resultat for ${navn}`),
      naerMaalProsent: lesGrense(d.naerMaalProsent, `Grensen for «nær mål» på ${navn}`),
      sortering: Number.isInteger(d.sortering) ? d.sortering : (i + 1) * 10,
      aktiv: d.aktiv !== false,
    };
  });
  return { naerMaalProsent: naer === null ? 20 : naer, kpier };
}

/** Validerer verdier for ett år: { '01': { kpiId: tall } } mot gyldige KPI-id-er. */
function lesAarsverdier(input, kpiIder, label) {
  if (input === undefined || input === null) return {};
  if (!isObject(input)) fail('invalid-argument', `Ugyldige verdier for ${label}.`);
  const ut = {};
  Object.keys(input).forEach((m) => {
    if (!MND.includes(m)) fail('invalid-argument', `Ugyldig måned «${m}» i ${label}.`);
    if (!isObject(input[m])) fail('invalid-argument', `Ugyldige verdier for måned ${m} i ${label}.`);
    Object.keys(input[m]).forEach((id) => {
      if (!kpiIder.has(id)) fail('invalid-argument', `Ukjent KPI «${id}» i ${label}.`);
      const v = lesVerdi(input[m][id], `${id} (${m}) i ${label}`);
      if (v !== null) { ut[m] = ut[m] || {}; ut[m][id] = v; }
    });
  });
  return ut;
}

/* ---------------------------------------------------------------- skrivehjelpere */

async function commit(deps, updates, melding) {
  let last;
  for (let forsok = 1; forsok <= 3; forsok++) {
    try { await deps.db.ref().update(updates); return; } catch (error) { last = error; if (forsok < 3) await deps.sleep(150 * forsok); }
  }
  deps.log.error('kpi: update feilet', { error: String(last?.message || last), paths: Object.keys(updates).length });
  fail('internal', melding);
}

function loggNokkel(now, i) {
  return `${String(now.getTime()).padStart(13, '0')}-${Math.random().toString(36).slice(2, 8)}-${i}`;
}

function osloDato(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* ---------------------------------------------------------------- operasjoner */

/** Henter alt klienten trenger for ett år: oppsett, årets og fjorårets verdier, registreringer og tilgang. */
async function getKpi(deps, uid, data) {
  const input = isObject(data) ? data : {};
  const { id, enhet, B } = await tilgang(deps, uid, input);
  const [configs, registrator] = await Promise.all([
    deps.db.ref(`${B}/config`).get().then((s) => s.val() || {}),
    erRegistrator(deps, id, enhet),
  ]);
  const aarListe = Object.keys(configs).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const aar = input.aar !== undefined && input.aar !== null ? lesAar(input.aar) : (aarListe.length ? aarListe[aarListe.length - 1] : new Date().getFullYear());
  const [verdier, fjorVerdier, registrert] = await Promise.all([
    deps.db.ref(`${B}/verdier/${aar}`).get().then((s) => s.val() || {}),
    deps.db.ref(`${B}/verdier/${aar - 1}`).get().then((s) => s.val() || {}),
    deps.db.ref(`${B}/registrert/${aar}`).get().then((s) => s.val() || {}),
  ]);
  return { enhet, aar, aarListe, config: configs[aar] || null, verdier, fjorVerdier, registrert, kanRegistrere: registrator };
}

/** Lagrer verdiene for én måned. Bare endrede verdier skrives; tom verdi (null) sletter. Alt logges. */
async function saveKpiMaaned(deps, uid, data) {
  const input = isObject(data) ? data : {};
  const { id, B } = await requireRegistrator(deps, uid, input);
  const aar = lesAar(input.aar);
  const mm = lesMaaned(input.maaned);
  if (!isObject(input.verdier)) fail('invalid-argument', 'Mangler verdier.');
  const config = (await deps.db.ref(`${B}/config/${aar}`).get()).val();
  if (!isObject(config) || !isObject(config.kpier)) fail('failed-precondition', `Det finnes ikke noe KPI-oppsett for ${aar}. Lag oppsettet først.`);
  const naa = (await deps.db.ref(`${B}/verdier/${aar}/${mm}`).get()).val() || {};
  const now = deps.now();
  const at = now.toISOString();
  const updates = {};
  let i = 0;
  Object.keys(input.verdier).forEach((kpiId) => {
    if (!config.kpier[kpiId]) fail('invalid-argument', `Ukjent KPI «${kpiId}».`);
    const ny = lesVerdi(input.verdier[kpiId], config.kpier[kpiId].navn);
    const gammel = erTall(naa[kpiId]) ? naa[kpiId] : null;
    if (ny === gammel) return;
    updates[`${B}/verdier/${aar}/${mm}/${kpiId}`] = ny;
    const logg = { mnd: mm, kpiId, av: id, at };
    if (gammel !== null) logg.foer = gammel;
    if (ny !== null) logg.etter = ny;
    updates[`${B}/logg/${aar}/${loggNokkel(now, i++)}`] = logg;
  });
  if (!i) return { aar, maaned: Number(mm), endret: 0 };
  updates[`${B}/registrert/${aar}/${mm}`] = { av: id, at };
  await commit(deps, updates, 'Kunne ikke lagre verdiene. Prøv igjen.');
  return { aar, maaned: Number(mm), endret: i };
}

/** Lagrer (oppretter eller erstatter) KPI-oppsettet for ett år. */
async function saveKpiConfig(deps, uid, data) {
  const input = isObject(data) ? data : {};
  const { id, B } = await requireRegistrator(deps, uid, input);
  const aar = lesAar(input.aar);
  const config = lesConfig(input.config);
  // En KPI med registrerte verdier kan ikke fjernes (bare settes inaktiv), ellers mister vi historikk.
  const [gammel, verdier] = await Promise.all([
    deps.db.ref(`${B}/config/${aar}`).get().then((s) => s.val()),
    deps.db.ref(`${B}/verdier/${aar}`).get().then((s) => s.val() || {}),
  ]);
  const brukte = new Set();
  Object.values(verdier).forEach((m) => Object.keys(m || {}).forEach((k) => brukte.add(k)));
  brukte.forEach((k) => {
    if (!config.kpier[k]) {
      const navn = (gammel && gammel.kpier && gammel.kpier[k] && gammel.kpier[k].navn) || k;
      fail('failed-precondition', `«${navn}» har registrerte verdier og kan ikke slettes. Sett den som inaktiv i stedet.`);
    }
  });
  await commit(deps, {
    [`${B}/config/${aar}`]: { ...config, oppdatertAv: id, oppdatertAt: deps.now().toISOString() },
  }, 'Kunne ikke lagre oppsettet. Prøv igjen.');
  return { aar };
}

/**
 * Import fra Excel (klienten leser arket og sender strukturerte data): oppsett for året, årets verdier og fjorårets
 * verdier i én atomisk skriving. Overskriver bare hvis overskriv=true.
 */
async function importKpi(deps, uid, data) {
  const input = isObject(data) ? data : {};
  const { id, B } = await requireRegistrator(deps, uid, input);
  const aar = lesAar(input.aar);
  const config = lesConfig(input.config);
  const ider = new Set(Object.keys(config.kpier));
  const verdier = lesAarsverdier(input.verdier, ider, String(aar));
  const fjor = lesAarsverdier(input.fjorVerdier, ider, String(aar - 1));
  const [finnes, fjorFinnes] = await Promise.all([
    deps.db.ref(`${B}/config/${aar}`).get().then((s) => s.exists()),
    deps.db.ref(`${B}/verdier/${aar - 1}`).get().then((s) => s.exists()),
  ]);
  if ((finnes || fjorFinnes) && input.overskriv !== true) {
    fail('already-exists', `Det finnes allerede data for ${finnes ? aar : aar - 1}. Bekreft at du vil overskrive.`);
  }
  const now = deps.now();
  const at = now.toISOString();
  const updates = {
    [`${B}/config/${aar}`]: { ...config, oppdatertAv: id, oppdatertAt: at },
    [`${B}/verdier/${aar}`]: Object.keys(verdier).length ? verdier : null,
    [`${B}/verdier/${aar - 1}`]: Object.keys(fjor).length ? fjor : null,
    [`${B}/logg/${aar}/${loggNokkel(now, 0)}`]: { import: true, av: id, at },
  };
  const registrert = {};
  Object.keys(verdier).forEach((m) => { registrert[m] = { av: id, at, import: true }; });
  updates[`${B}/registrert/${aar}`] = Object.keys(registrert).length ? registrert : null;
  await commit(deps, updates, 'Importen feilet. Ingenting ble lagret.');
  const antall = (o) => Object.values(o).reduce((s, m) => s + Object.keys(m).length, 0);
  return { aar, kpier: ider.size, verdier: antall(verdier), fjorVerdier: antall(fjor) };
}

/** Oppretter et tiltak i den felles tiltakslista, koblet til en KPI. */
async function createKpiTiltak(deps, uid, data) {
  const input = isObject(data) ? data : {};
  const { id, enhet, B } = await tilgang(deps, uid, input);
  const aar = lesAar(input.aar);
  const kpiId = clean(input.kpiId);
  if (!KPI_ID.test(kpiId)) fail('invalid-argument', 'Ugyldig KPI.');
  const def = (await deps.db.ref(`${B}/config/${aar}/kpier/${kpiId}`).get()).val();
  if (!isObject(def)) fail('not-found', 'KPI-en finnes ikke.');
  const frist = clean(input.frist);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(frist) || Number.isNaN(Date.parse(frist))) fail('invalid-argument', 'Velg en gyldig frist.');
  const kategori = input.kategori ? valg(input.kategori, KATEGORIER, 'kategori') : (KATEGORI_FOR_OMRADE[def.omrade] || 'Annet');
  const aktor = navnFor(id) || tekst(input.opprettetAv, 'Opprettet av', 80, false) || 'Ukjent';
  const tiltak = {
    tittel: tekst(input.tittel, 'Tittel', 160, true),
    kategori,
    omrade: E.hent(enhet).tiltakOmrade,
    prioritet: input.prioritet ? valg(input.prioritet, PRIORITETER, 'prioritet') : 'Middels',
    status: 'Aktiv',
    frist,
    eier: tekst(input.eier, 'Eier', 80, true),
    beskrivelse: tekst(input.beskrivelse, 'Beskrivelse', 2000, false),
    nestesteg: tekst(input.nestesteg, 'Neste steg', 500, false),
    miljo: 'Produksjon',
    forslagsstiller: aktor,
    opprettetAv: aktor,
    dato: osloDato(deps.now()),
    livssyklus: 'Aktiv',
    kilde: 'kpi',
    kpiEnhet: enhet,
    kpiId,
    kpiAar: aar,
    kpiNavn: def.navn,
  };
  const key = deps.newKey('/tiltak');
  await commit(deps, { [`/tiltak/${key}`]: tiltak }, 'Kunne ikke opprette tiltaket. Prøv igjen.');
  return { tiltakId: key };
}

module.exports = {
  KpiError, KJENTE_NAVN, getKpi, saveKpiMaaned, saveKpiConfig, importKpi, createKpiTiltak,
  _intern: { lesConfig, lesAarsverdier },
};
