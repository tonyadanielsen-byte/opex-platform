'use strict';

/*
 * KPI — varsler for alle avdelinger: Firebase-binding. Logikken ligger i kpi-varsler-core.js.
 * Sender som de øvrige OpEx-varslene: aktivitetsinnboks (/activityInbox/{uid}) + push til OpEx-enheter (/pushTokens/{uid}).
 * Et klikk på varselet åpner KPI-appen.
 */

const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const core = require('./kpi-varsler-core');

if (!getApps().length) initializeApp();

const ICON = 'https://tonyadanielsen-byte.github.io/opex-platform/icons/opex-icon-192.png';
const BADGE = 'https://tonyadanielsen-byte.github.io/opex-platform/icons/opex-notification-badge-96.png';

function clean(v) { return String(v ?? '').trim(); }

async function send(uid, m) {
  const db = getDatabase();
  await db.ref(`/activityInbox/${uid}`).push().set({
    title: clean(m.title), body: clean(m.body), link: clean(m.link), eventType: clean(m.eventType),
    taskId: '', owner: '', createdAt: new Date().toISOString(), seenAt: null,
  });
  const devices = (await db.ref(`/pushTokens/${uid}`).get()).val() || {};
  const tokens = [...new Set(Object.values(devices).map((d) => clean(d && d.token)).filter(Boolean))].slice(0, 500);
  if (!tokens.length) return { skipped: 'no-token' };
  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title: m.title, body: m.body },
    data: { title: m.title, body: m.body, link: m.link, tag: m.tag, eventType: m.eventType },
    webpush: {
      headers: { Urgency: 'normal', TTL: '86400' },
      notification: { title: m.title, body: m.body, icon: ICON, badge: BADGE, tag: m.tag, renotify: false, data: { link: m.link, eventType: m.eventType } },
      fcmOptions: { link: m.link },
    },
  });
  const ugyldige = [];
  response.responses.forEach((r, i) => {
    const code = (r && r.error && r.error.code) || '';
    if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) ugyldige.push(tokens[i]);
  });
  if (ugyldige.length) {
    const updates = {};
    Object.entries(devices).forEach(([key, d]) => { if (ugyldige.includes(clean(d && d.token))) updates[key] = null; });
    if (Object.keys(updates).length) await db.ref(`/pushTokens/${uid}`).update(updates);
  }
  return response;
}

function deps() {
  return { get db() { return getDatabase(); }, now: () => new Date(), send, log: console };
}

exports.notifyKpiPaaminnelseV1 = onSchedule({
  schedule: '10 8 * * *', timeZone: 'Europe/Oslo', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 120, maxInstances: 1, retryCount: 1,
}, async () => {
  const res = await core.paaminnelse(deps());
  console.log('kpi påminnelse', res);
});

exports.notifyKpiEndringV1 = onValueWritten({
  ref: '/kpi/{enhet}/verdier/{aar}/{mm}', instance: 'opex-nortura-default-rtdb', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 60, maxInstances: 2,
}, async (event) => {
  const res = await core.vedEndring(deps(), { enhet: event.params.enhet, aar: event.params.aar, mm: event.params.mm, foer: event.data.before.val() });
  if (res.sendt.length) console.log('kpi varsler', { enhet: event.params.enhet, aar: event.params.aar, mm: event.params.mm, sendt: res.sendt });
});
