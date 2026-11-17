'use strict';

/*
 * KPI Renhold — varsler (ren logikk, testbar mot simulert database). Bindes i renhold-kpi-varsler.js.
 *
 *  a) Påminnelse om registrering: den 3. i måneden for forrige måned, med purring den 7., 10. og 14. hvis noe mangler.
 *  b) Varsel når en KPI faller til «Ikke på mål» (sammenlignet med før lagringen; for en ny måned: med forrige måned).
 *  d) Månedsoppsummering når alle verdiene for måneden er registrert.
 *  (c — tiltak — dekkes av de eksisterende tiltaksvarslene, siden KPI-tiltak ligger i den felles tiltakslista.)
 *
 * Mottakere: registratorene (Tony, Kenneth) + /renholdKpi/varselMottakere/{uid} === true (f.eks. Besim).
 * Hvert varsel får en fast nøkkel i /renholdKpi/varslet, så det aldri sendes to ganger (retry, ny lagring av samme verdi).
 * Import fra Excel gir ingen varsler.
 */

const L = require('./renhold-kpi-logic');
const { REGISTRATORER } = require('./renhold-kpi-core');

const APP_URL = 'https://tonyadanielsen-byte.github.io/opex-platform/renhold-kpi/#kpi';
const PURREDAGER = [7, 10, 14];

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function osloDeler(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { aar: p.year, maaned: p.month, dag: p.day };
}

async function mottakere(deps) {
  const ekstra = (await deps.db.ref('/renholdKpi/varselMottakere').get()).val() || {};
  return [...new Set([...Object.keys(REGISTRATORER), ...Object.keys(ekstra).filter((uid) => ekstra[uid] === true)])];
}

/** Sender til alle mottakere én gang per nøkkel. Returnerer true hvis sendt. */
async function sendEnGang(deps, nokkel, melding) {
  const ref = deps.db.ref(`/renholdKpi/varslet/${nokkel}`);
  if ((await ref.get()).exists()) return false;
  // Merk som sendt først: en ny kjøring (retry) skal heller miste et varsel enn å sende det to ganger.
  await ref.set(deps.now().toISOString());
  const uids = await mottakere(deps);
  for (const uid of uids) {
    try { await deps.send(uid, { ...melding, link: APP_URL, tag: `renhold-kpi-${nokkel}` }); } catch (e) { deps.log.error('renhold-kpi varsel feilet', { uid, nokkel, error: String(e?.message || e) }); }
  }
  return true;
}

function liste(navn, maks) {
  const n = maks || 3;
  return navn.length <= n ? navn.join(', ') : navn.slice(0, n).join(', ') + ` og ${navn.length - n} til`;
}

/* ---------------------------------------------------------------- a) påminnelse og purring */

/** Kjøres hver morgen. Gjelder forrige måned. */
async function paaminnelse(deps) {
  const idag = osloDeler(deps.now());
  const erPaaminnelse = idag.dag === 3, erPurring = PURREDAGER.includes(idag.dag);
  if (!erPaaminnelse && !erPurring) return { sendt: false, grunn: 'ikke en varseldag' };
  const aar = idag.maaned === 1 ? idag.aar - 1 : idag.aar;
  const n = idag.maaned === 1 ? 12 : idag.maaned - 1;
  const mm = L.mndKey(n);
  const config = (await deps.db.ref(`/renholdKpi/config/${aar}`).get()).val();
  if (!isObject(config)) return { sendt: false, grunn: 'intet oppsett' };
  const verdier = (await deps.db.ref(`/renholdKpi/verdier/${aar}`).get()).val() || {};
  const mangler = L.manglerVerdi(config, verdier, n);
  if (!mangler.length) return { sendt: false, grunn: 'alt registrert' };
  const totalt = L.aktiveKpier(config).length;
  const mnd = L.mndNavn(n).toLowerCase();
  const ingen = mangler.length === totalt;
  const melding = erPaaminnelse ? {
    title: 'Tid for KPI-registrering',
    body: ingen ? `Registrer renholdstallene for ${mnd} (${totalt} KPI-er).` : `${L.mndNavn(n)} mangler ${mangler.length} av ${totalt} verdier: ${liste(mangler.map((k) => k.navn))}.`,
    eventType: 'renhold-kpi-paaminnelse',
  } : {
    title: `Påminnelse: KPI for ${mnd} mangler`,
    body: `${mangler.length} av ${totalt} verdier er ikke registrert: ${liste(mangler.map((k) => k.navn))}.`,
    eventType: 'renhold-kpi-purring',
  };
  const sendt = await sendEnGang(deps, `paaminnelse-${aar}-${mm}-d${idag.dag}`, melding);
  return { sendt, aar, maaned: n, mangler: mangler.length };
}

/* ---------------------------------------------------------------- b) og d) ved lagring */

/**
 * Kalles når /renholdKpi/verdier/{aar}/{mm} er skrevet. foer = månedens verdier før skrivingen.
 * Databasen har allerede tilstanden etter skrivingen.
 */
async function vedEndring(deps, { aar, mm, foer }) {
  const n = L.MND_KEYS.indexOf(mm) + 1;
  if (!n) return { sendt: [] };
  const [config, verdier, fjor, reg] = await Promise.all([
    deps.db.ref(`/renholdKpi/config/${aar}`).get().then((s) => s.val()),
    deps.db.ref(`/renholdKpi/verdier/${aar}`).get().then((s) => s.val() || {}),
    deps.db.ref(`/renholdKpi/verdier/${Number(aar) - 1}`).get().then((s) => s.val() || {}),
    deps.db.ref(`/renholdKpi/registrert/${aar}/${mm}`).get().then((s) => s.val()),
  ]);
  if (!isObject(config)) return { sendt: [] };
  if (reg && reg.import) return { sendt: [], grunn: 'import' };
  // Bare den nyeste måneden med data gir varsler: retting av en gammel måned skal ikke alarmere.
  if (L.sisteMaanedMedData(verdier) !== n) return { sendt: [], grunn: 'eldre måned' };

  const foerMnd = isObject(foer) ? foer : {};
  const verdierFoer = { ...verdier, [mm]: foerMnd };
  const kpier = L.aktiveKpier(config);
  const sendt = [];
  const mnd = L.mndNavn(n).toLowerCase();

  // b) falt til «Ikke på mål»
  const falt = [];
  kpier.forEach((def) => {
    const etter = L.vurderKpi(def, config, verdier, fjor, n);
    if (etter.status !== L.STATUS.IKKE) return;
    const haddeVerdi = L.erTall(foerMnd[def.id]);
    const foerStatus = haddeVerdi ? L.vurderKpi(def, config, verdierFoer, fjor, n).status
      : (n > 1 ? L.vurderKpi(def, config, verdierFoer, fjor, n - 1).status : L.STATUS.INGEN);
    if (foerStatus === L.STATUS.IKKE) return;
    falt.push(etter);
  });
  for (const r of falt) {
    const ok = await sendEnGang(deps, `ikke-paa-maal-${aar}-${mm}-${r.id}`, {
      title: `${r.def.navn} er ikke på mål`,
      body: `${L.fmtVerdi(r.faktisk, r.def.enhet)} hittil i år mot mål ${L.fmtVerdi(r.maal, r.def.enhet, { brok: true })} (t.o.m. ${mnd}). Vurder et tiltak.`,
      eventType: 'renhold-kpi-ikke-paa-maal',
    });
    if (ok) sendt.push(`ikke-paa-maal:${r.id}`);
  }

  // d) månedsoppsummering når måneden er komplett
  const kompletEtter = L.manglerVerdi(config, verdier, n).length === 0;
  const kompletFoer = L.manglerVerdi(config, verdierFoer, n).length === 0;
  if (kompletEtter && !kompletFoer) {
    const v = L.vurderAar(config, verdier, fjor, n);
    const fokus = v.fokus.map((r) => r.def.navn);
    const ok = await sendEnGang(deps, `oppsummering-${aar}-${mm}`, {
      title: `KPI Renhold: ${mnd} er registrert`,
      body: `${v.tell.paa} på mål · ${v.tell.naer} nær mål · ${v.tell.ikke} ikke på mål.` + (fokus.length ? ` Fokus: ${liste(fokus)}.` : ' Alle KPI-er er på eller nær mål.'),
      eventType: 'renhold-kpi-oppsummering',
    });
    if (ok) sendt.push('oppsummering');
  }
  return { sendt };
}

module.exports = { paaminnelse, vedEndring, APP_URL, _intern: { osloDeler, mottakere } };
