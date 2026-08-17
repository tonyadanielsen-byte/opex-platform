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
const UID_NAME = Object.freeze(Object.fromEntries(Object.entries(OWNER_UID).map(([name, uid]) => [uid, name])));
const ADMIN_UID = OWNER_UID['Tony Danielsen'];
const LEADER_REPORT_UIDS = new Set([OWNER_UID['Kenneth Nordbakk'], OWNER_UID['Erling Magnussen']]);
const TERMINAL = new Set(['Fullført', 'Stanset', 'Avsluttet']);

function clean(value) { return String(value ?? '').trim(); }
function changed(before, after, field) { return clean(before?.[field]) !== clean(after?.[field]); }
function isProductionTask(task) { return Boolean(task && task.miljo !== 'Test' && clean(task.tittel) && clean(task.eier)); }
function ownerUid(owner) { return OWNER_UID[clean(owner)] || null; }
function actorUid(event) { return clean(event?.authId || event?.auth?.uid) || null; }
function actorName(uid) { return UID_NAME[clean(uid)] || 'En bruker'; }
function taskLink(taskId) { return `${APP_URL}?openTask=${encodeURIComponent(clean(taskId))}`; }
function collectTokensForUid(root, uid) {
  const devices = root && root[uid];
  if (!devices || typeof devices !== 'object') return [];
  return [...new Set(Object.values(devices).map(d => d?.token?.trim()).filter(Boolean))].slice(0, 500);
}

async function sendToUid(uid, message, excludeUid = null) {
  if (!uid) return { skipped: 'no-uid' };
  if (excludeUid && uid === excludeUid) {
    console.log('OpEx push skipped', { reason: 'self-action', uid, eventType: message.eventType, taskId: message.taskId });
    return { skipped: 'self-action', uid };
  }
  const snapshot = await getDatabase().ref('/pushTokens').get();
  const tokens = collectTokensForUid(snapshot.val(), uid);
  if (!tokens.length) {
    console.log('OpEx push skipped', { reason: 'no-token', uid, eventType: message.eventType, taskId: message.taskId });
    return { skipped: 'no-token', uid };
  }

  const title = clean(message.title) || 'OpEx Hub';
  const body = clean(message.body) || 'Du har et nytt varsel.';
  const link = clean(message.link) || (message.taskId ? taskLink(message.taskId) : APP_URL);
  const tag = clean(message.tag) || 'opex-notification';
  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { title, body, link, tag, eventType: clean(message.eventType) || 'opex-event', taskId: clean(message.taskId), owner: clean(message.owner) },
    webpush: {
      headers: { Urgency: message.urgency || 'high', TTL: String(message.ttl || 3600) },
      notification: {
        title, body,
        icon: `${APP_URL}icons/opex-icon-192.png`,
        badge: `${APP_URL}icons/opex-status-badge-v2.png?v=2`,
        tag, renotify: false,
        data: { link, taskId: clean(message.taskId) },
      },
      fcmOptions: { link },
    },
  });
  console.log('OpEx push result', { eventType: message.eventType, taskId: message.taskId, uid, devices: tokens.length, successCount: response.successCount, failureCount: response.failureCount });
  return response;
}

async function sendToOwner(task, message, excludeUid = null) {
  const uid = ownerUid(task.eier);
  if (!uid) {
    console.log('OpEx push skipped', { reason: 'unknown-owner', owner: task.eier, taskId: message.taskId, eventType: message.eventType });
    return { skipped: 'unknown-owner' };
  }
  return sendToUid(uid, { ...message, owner: task.eier }, excludeUid);
}

exports.notifyNewTaskV1C = onValueCreated({ ref: '/tiltak/{taskId}', instance: 'opex-nortura-default-rtdb', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 60, maxInstances: 2 }, async event => {
  const task = event.data.val() || {};
  const taskId = event.params.taskId;
  const actor = actorUid(event);
  if (!isProductionTask(task) || TERMINAL.has(task.status)) return;

  await sendToOwner(task, {
    title: task.prioritet === 'Kritisk' ? '🚨 Nytt kritisk tiltak' : 'Nytt tiltak tildelt deg', body: task.tittel,
    tag: `opex-new-task-${taskId}`, eventType: 'new-task', taskId, ttl: 86400,
  }, actor);

  if (task.status === 'Til godkjenning' && ADMIN_UID !== ownerUid(task.eier)) {
    await sendToUid(ADMIN_UID, { title: 'Tiltak venter på godkjenning', body: `${task.eier}: ${task.tittel}`, tag: `opex-approval-${taskId}`, eventType: 'approval-needed', taskId, owner: task.eier, ttl: 86400 }, actor);
  }
});

exports.notifyTaskChangesV1C = onValueWritten({ ref: '/tiltak/{taskId}', instance: 'opex-nortura-default-rtdb', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 60, maxInstances: 2 }, async event => {
  if (!event.data.before.exists() || !event.data.after.exists()) return;
  const before = event.data.before.val() || {};
  const after = event.data.after.val() || {};
  const taskId = event.params.taskId;
  const actor = actorUid(event);
  if (!isProductionTask(after)) return;

  const changes = { eier: changed(before, after, 'eier'), frist: changed(before, after, 'frist'), prioritet: changed(before, after, 'prioritet'), status: changed(before, after, 'status'), nestesteg: changed(before, after, 'nestesteg') };
  console.log('OpEx task change detected', { taskId, actor, changes, before: { eier: before.eier, frist: before.frist, prioritet: before.prioritet, status: before.status, nestesteg: before.nestesteg }, after: { eier: after.eier, frist: after.frist, prioritet: after.prioritet, status: after.status, nestesteg: after.nestesteg } });

  if (changes.eier) await sendToOwner(after, { title: 'Tiltak er tildelt deg', body: after.tittel, tag: `opex-reassigned-${taskId}-${Date.now()}`, eventType: 'task-reassigned', taskId, ttl: 86400 }, actor);
  if (changes.frist && after.frist && !TERMINAL.has(after.status)) await sendToOwner(after, { title: 'Frist er endret', body: `${after.tittel} · ny frist ${after.frist}`, tag: `opex-deadline-change-${taskId}-${Date.now()}`, eventType: 'deadline-changed', taskId, ttl: 86400 }, actor);
  if (changes.prioritet && !TERMINAL.has(after.status)) {
    const critical = clean(after.prioritet) === 'Kritisk';
    await sendToOwner(after, { title: critical ? '🚨 Tiltak satt til Kritisk' : 'Prioritet er endret', body: `${after.tittel} · ${clean(after.prioritet) || 'ingen prioritet'}`, tag: `opex-priority-${taskId}-${Date.now()}`, eventType: critical ? 'priority-critical' : 'priority-changed', taskId, ttl: 86400 }, actor);
  }
  if (changes.nestesteg && clean(after.nestesteg) && !TERMINAL.has(after.status)) await sendToOwner(after, { title: 'Neste steg er oppdatert', body: `${after.tittel} · ${clean(after.nestesteg).slice(0, 120)}`, tag: `opex-next-step-${taskId}-${Date.now()}`, eventType: 'next-step-changed', taskId, ttl: 86400 }, actor);

  if (changes.status) {
    const status = clean(after.status);
    const ownerIsAdmin = ownerUid(after.eier) === ADMIN_UID;
    if (status === 'Til godkjenning') {
      await sendToUid(ADMIN_UID, { title: 'Tiltak venter på godkjenning', body: `${after.eier}: ${after.tittel}`, tag: `opex-approval-${taskId}-${Date.now()}`, eventType: 'approval-needed', taskId, owner: after.eier, ttl: 86400 }, actor);
      if (!ownerIsAdmin) await sendToOwner(after, { title: 'Status er endret', body: `${after.tittel} · Til godkjenning`, tag: `opex-status-owner-${taskId}-${Date.now()}`, eventType: 'status-changed', taskId, ttl: 86400 }, actor);
    } else if (TERMINAL.has(status)) {
      const titles = { 'Fullført': '🎉 Tiltak fullført!', 'Stanset': '💡 Tiltak flyttet til Idébank', 'Avsluttet': '⏹ Tiltak avsluttet' };
      const body = status === 'Fullført' ? `${after.tittel} er i mål. Sterkt jobbet! 💪` : after.tittel;
      await sendToOwner(after, { title: titles[status], body, tag: `opex-status-${taskId}-${Date.now()}`, eventType: `status-${status.toLowerCase()}`, taskId, ttl: 86400 }, actor);

      if (actor && LEADER_REPORT_UIDS.has(actor)) {
        await sendToUid(ADMIN_UID, {
          title: status === 'Fullført' ? `🎉 ${actorName(actor)} fullførte et tiltak` : `${actorName(actor)} satte tiltak til ${status}`,
          body: after.tittel,
          tag: `opex-leader-${status.toLowerCase()}-${taskId}-${Date.now()}`,
          eventType: `leader-status-${status.toLowerCase()}`,
          taskId, owner: after.eier, ttl: 86400,
        }, actor);
      }
    } else {
      await sendToOwner(after, { title: 'Status er endret', body: `${after.tittel} · ${status || 'ukjent status'}`, tag: `opex-status-${taskId}-${Date.now()}`, eventType: 'status-changed', taskId, ttl: 86400 }, actor);
    }
  }
});

exports.notifyTaskCommentV1 = onValueCreated({ ref: '/taskComments/{taskId}/{commentId}', instance: 'opex-nortura-default-rtdb', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 60, maxInstances: 2 }, async event => {
  const comment = event.data.val() || {};
  const taskId = event.params.taskId;
  const actor = actorUid(event) || clean(comment.authorUid);
  const taskSnap = await getDatabase().ref(`/tiltak/${taskId}`).get();
  if (!taskSnap.exists()) return;
  const task = taskSnap.val() || {};
  if (!isProductionTask(task) || !clean(comment.text)) return;

  const name = clean(comment.authorName) || actorName(actor);
  const body = `${task.tittel} · ${clean(comment.text).slice(0, 120)}`;
  await sendToOwner(task, { title: `💬 Ny kommentar fra ${name}`, body, tag: `opex-comment-owner-${taskId}-${event.params.commentId}`, eventType: 'task-comment', taskId, ttl: 86400 }, actor);
  if (ADMIN_UID !== ownerUid(task.eier)) await sendToUid(ADMIN_UID, { title: `💬 Ny kommentar fra ${name}`, body, tag: `opex-comment-leader-${taskId}-${event.params.commentId}`, eventType: 'task-comment-leader', taskId, owner: task.eier, ttl: 86400 }, actor);
});

function osloToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dateDiffDays(date, today) { const a = Date.parse(`${date}T00:00:00Z`); const b = Date.parse(`${today}T00:00:00Z`); return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86400000) : null; }
function reminderFor(daysLeft) {
  if (daysLeft === 3) return { key: 'due-3', title: 'Frist om 3 dager' };
  if (daysLeft === 0) return { key: 'due-today', title: '⏰ Frist i dag' };
  if (daysLeft === -1) return { key: 'overdue-1', title: '⚠️ Tiltak er forfalt' };
  if (daysLeft < -1 && (Math.abs(daysLeft) - 1) % 7 === 0) return { key: `overdue-${Math.abs(daysLeft)}`, title: '⚠️ Tiltak er fortsatt forfalt' };
  return null;
}

exports.notifyDeadlinesV1C = onSchedule({ schedule: '0 8 * * *', timeZone: 'Europe/Oslo', region: 'europe-west1', memory: '256MiB', timeoutSeconds: 120, maxInstances: 1, retryCount: 1 }, async () => {
  const db = getDatabase(); const today = osloToday(); const snap = await db.ref('/tiltak').get(); const tasks = snap.val() || {};
  for (const [taskId, task] of Object.entries(tasks)) {
    if (!isProductionTask(task) || TERMINAL.has(task.status) || !task.frist || task.livssyklus === 'Papirkurv' || task.papirkurv === true) continue;
    const reminder = reminderFor(dateDiffDays(task.frist, today)); if (!reminder) continue;
    const logRef = db.ref(`/pushNotificationLog/${reminder.key}/${taskId}/${today}`); if ((await logRef.get()).exists()) continue;
    const result = await sendToOwner(task, { title: reminder.title, body: `${task.tittel} · frist ${task.frist}`, tag: `opex-${reminder.key}-${taskId}`, eventType: reminder.key, taskId, ttl: 43200 });
    if (!result?.skipped) await logRef.set({ sentAt: new Date().toISOString(), owner: task.eier });
  }
});
