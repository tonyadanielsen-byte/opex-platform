const { onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

const APP_URL = 'https://tonyadanielsen-byte.github.io/opex-platform/';
const OWNER_UID = Object.freeze({
  'Tony Danielsen': 'TJKI3zlDKSR7jvFXksVFgEgjS432',
  'Kenneth Nordbakk': 'gibm3aDi1KWlNyl7P3jTktQoGsM2',
  'Erling Magnussen': 'lJ7bn7HkbcZnhDoxfaBYQKEFL083',
});
const ADMIN_UID = OWNER_UID['Tony Danielsen'];
const TERMINAL = new Set(['Fullført', 'Stanset', 'Avsluttet']);

function isProductionTask(task) { return Boolean(task && task.miljo !== 'Test' && task.tittel && task.eier); }
function ownerUid(owner) { return OWNER_UID[String(owner || '').trim()] || null; }
function taskLink(taskId) { return `${APP_URL}?openTask=${encodeURIComponent(String(taskId || ''))}`; }
function collectTokensForUid(root, uid) {
  const devices = root && root[uid];
  if (!devices || typeof devices !== 'object') return [];
  return [...new Set(Object.values(devices).map(d => d?.token?.trim()).filter(Boolean))].slice(0, 500);
}

async function sendToUid(uid, message) {
  if (!uid) return { skipped: 'no-uid' };
  const snapshot = await getDatabase().ref('/pushTokens').get();
  const tokens = collectTokensForUid(snapshot.val(), uid);
  if (!tokens.length) return { skipped: 'no-token', uid };
  const title = String(message.title || 'OpEx Hub');
  const body = String(message.body || 'Du har et nytt varsel.');
  const link = String(message.link || (message.taskId ? taskLink(message.taskId) : APP_URL));
  const tag = String(message.tag || 'opex-notification');
  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { title, body, link, tag, eventType: String(message.eventType || 'opex-event'), taskId: String(message.taskId || ''), owner: String(message.owner || '') },
    webpush: {
      headers: { Urgency: message.urgency || 'high', TTL: String(message.ttl || 3600) },
      notification: {
        title, body,
        icon: `${APP_URL}icons/opex-icon-192.png`,
        badge: `${APP_URL}icons/opex-notification-badge.svg`,
        tag, renotify: false,
        data: { link, taskId: String(message.taskId || '') }
      },
      fcmOptions: { link }
    }
  });
  console.log('OpEx push result', { eventType: message.eventType, taskId: message.taskId, uid, devices: tokens.length, successCount: response.successCount, failureCount: response.failureCount });
  return response;
}

async function sendToOwner(task, message) {
  const uid = ownerUid(task.eier);
  if (!uid) return { skipped: 'unknown-owner' };
  return sendToUid(uid, { ...message, owner: task.eier });
}

exports.notifyNewTaskV1B = onValueCreated({ ref: '/tiltak/{taskId}', instance: 'opex-nortura-default-rtdb', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 60, maxInstances: 2 }, async event => {
  const task = event.data.val() || {}; const taskId = event.params.taskId;
  if (!isProductionTask(task) || TERMINAL.has(task.status)) return;
  await sendToOwner(task, { title: task.prioritet === 'Kritisk' ? '🚨 Nytt kritisk tiltak' : 'Nytt tiltak tildelt deg', body: task.tittel, tag: `opex-new-task-${taskId}`, eventType: 'new-task', taskId, ttl: 86400 });
  if (task.status === 'Til godkjenning' && ADMIN_UID !== ownerUid(task.eier)) await sendToUid(ADMIN_UID, { title: 'Tiltak venter på godkjenning', body: `${task.eier}: ${task.tittel}`, tag: `opex-approval-${taskId}`, eventType: 'approval-needed', taskId, owner: task.eier, ttl: 86400 });
});

// onValueWritten is deliberately used here instead of onValueUpdated. We guard
// create/delete events ourselves, making the trigger resilient to RTDB update/set styles.
exports.notifyTaskChangesV1B = onValueWritten({ ref: '/tiltak/{taskId}', instance: 'opex-nortura-default-rtdb', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 60, maxInstances: 2 }, async event => {
  if (!event.data.before.exists() || !event.data.after.exists()) return;
  const before = event.data.before.val() || {}; const after = event.data.after.val() || {}; const taskId = event.params.taskId;
  console.log('OpEx task change detected', { taskId, frist: [before.frist, after.frist], prioritet: [before.prioritet, after.prioritet], status: [before.status, after.status], eier: [before.eier, after.eier] });
  if (!isProductionTask(after)) return;
  if (before.eier !== after.eier) await sendToOwner(after, { title: 'Tiltak er tildelt deg', body: after.tittel, tag: `opex-reassigned-${taskId}`, eventType: 'task-reassigned', taskId, ttl: 86400 });
  if (before.frist !== after.frist && after.frist && !TERMINAL.has(after.status)) await sendToOwner(after, { title: 'Frist er endret', body: `${after.tittel} · ny frist ${after.frist}`, tag: `opex-deadline-change-${taskId}`, eventType: 'deadline-changed', taskId, ttl: 86400 });
  if (before.prioritet !== after.prioritet && after.prioritet === 'Kritisk' && !TERMINAL.has(after.status)) await sendToOwner(after, { title: '🚨 Tiltak satt til Kritisk', body: after.tittel, tag: `opex-critical-${taskId}`, eventType: 'priority-critical', taskId, ttl: 86400 });
  if (before.status !== after.status) {
    if (after.status === 'Til godkjenning') await sendToUid(ADMIN_UID, { title: 'Tiltak venter på godkjenning', body: `${after.eier}: ${after.tittel}`, tag: `opex-approval-${taskId}`, eventType: 'approval-needed', taskId, owner: after.eier, ttl: 86400 });
    else if (TERMINAL.has(after.status)) {
      const labels = { 'Fullført': '✅ Tiltak fullført', 'Stanset': '💡 Tiltak flyttet til Idébank', 'Avsluttet': '⏹ Tiltak avsluttet' };
      await sendToOwner(after, { title: labels[after.status], body: after.tittel, tag: `opex-status-${taskId}`, eventType: `status-${after.status.toLowerCase()}`, taskId, ttl: 86400 });
    }
  }
});

function osloToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((a,p) => { if (p.type !== 'literal') a[p.type]=p.value; return a; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dateDiffDays(date,today) { const a=Date.parse(`${date}T00:00:00Z`), b=Date.parse(`${today}T00:00:00Z`); return Number.isFinite(a)&&Number.isFinite(b)?Math.round((a-b)/86400000):null; }
function reminderFor(daysLeft) {
  if (daysLeft===3) return {key:'due-3',title:'Frist om 3 dager'};
  if (daysLeft===0) return {key:'due-today',title:'⏰ Frist i dag'};
  if (daysLeft===-1) return {key:'overdue-1',title:'⚠️ Tiltak er forfalt'};
  if (daysLeft < -1 && (Math.abs(daysLeft)-1)%7===0) return {key:`overdue-${Math.abs(daysLeft)}`,title:'⚠️ Tiltak er fortsatt forfalt'};
  return null;
}

exports.notifyDeadlinesV1B = onSchedule({ schedule:'0 8 * * *', timeZone:'Europe/Oslo', region:'europe-west1', memory:'256MiB', timeoutSeconds:120, maxInstances:1, retryCount:1 }, async () => {
  const db=getDatabase(), today=osloToday(), snap=await db.ref('/tiltak').get(), tasks=snap.val()||{};
  for (const [taskId,task] of Object.entries(tasks)) {
    if (!isProductionTask(task)||TERMINAL.has(task.status)||!task.frist||task.livssyklus==='Papirkurv'||task.papirkurv===true) continue;
    const reminder=reminderFor(dateDiffDays(task.frist,today)); if(!reminder) continue;
    const logRef=db.ref(`/pushNotificationLog/${reminder.key}/${taskId}/${today}`); if((await logRef.get()).exists()) continue;
    const result=await sendToOwner(task,{title:reminder.title,body:`${task.tittel} · frist ${task.frist}`,tag:`opex-${reminder.key}-${taskId}`,eventType:reminder.key,taskId,ttl:43200});
    if(!result?.skipped) await logRef.set({sentAt:new Date().toISOString(),owner:task.eier});
  }
});
