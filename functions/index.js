const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

const APP_LINK = '/opex-platform/';
const OWNER_UID = Object.freeze({
  'Tony Danielsen': 'TJKI3zlDKSR7jvFXksVFgEgjS432',
  'Kenneth Nordbakk': 'gibm3aDi1KWlNyl7P3jTktQoGsM2',
  'Erling Magnussen': 'lJ7bn7HkbcZnhDoxfaBYQKEFL083',
});
const ADMIN_UID = OWNER_UID['Tony Danielsen'];
const TERMINAL = new Set(['Fullført', 'Stanset', 'Avsluttet']);

function isProductionTask(task) {
  return Boolean(task && task.miljo !== 'Test' && task.tittel && task.eier);
}

function ownerUid(owner) {
  return OWNER_UID[String(owner || '').trim()] || null;
}

function collectTokensForUid(pushTokensRoot, uid) {
  const devices = pushTokensRoot && pushTokensRoot[uid];
  if (!devices || typeof devices !== 'object') return [];
  const tokens = [];
  for (const device of Object.values(devices)) {
    if (device && typeof device.token === 'string' && device.token.trim()) {
      tokens.push(device.token.trim());
    }
  }
  return [...new Set(tokens)].slice(0, 500);
}

async function sendToUid(uid, message) {
  if (!uid) return { skipped: 'no-uid' };
  const snapshot = await getDatabase().ref('/pushTokens').get();
  const tokens = collectTokensForUid(snapshot.val(), uid);
  if (!tokens.length) return { skipped: 'no-token', uid };

  const response = await getMessaging().sendEachForMulticast({
    tokens,
    data: {
      title: String(message.title || 'OpEx Hub'),
      body: String(message.body || 'Du har et nytt varsel.'),
      link: String(message.link || APP_LINK),
      tag: String(message.tag || 'opex-notification'),
      eventType: String(message.eventType || 'opex-event'),
      taskId: String(message.taskId || ''),
      owner: String(message.owner || ''),
    },
    webpush: {
      headers: {
        Urgency: message.urgency || 'high',
        TTL: String(message.ttl || 3600),
      },
    },
  });

  console.log('OpEx push result', {
    eventType: message.eventType,
    taskId: message.taskId,
    uid,
    devices: tokens.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
  });
  return response;
}

async function sendToOwner(task, message) {
  const uid = ownerUid(task.eier);
  if (!uid) {
    console.log('OpEx push: owner has no mapped UID; skipping', { owner: task.eier, taskId: message.taskId });
    return { skipped: 'unknown-owner' };
  }
  return sendToUid(uid, { ...message, owner: task.eier });
}

exports.notifyNewTaskV1B = onValueCreated(
  {
    ref: '/tiltak/{taskId}',
    instance: 'opex-nortura-default-rtdb',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 2,
  },
  async (event) => {
    const task = event.data.val() || {};
    const taskId = event.params.taskId;
    if (!isProductionTask(task) || TERMINAL.has(task.status)) return;

    await sendToOwner(task, {
      title: task.prioritet === 'Kritisk' ? '🚨 Nytt kritisk tiltak' : 'Nytt tiltak tildelt deg',
      body: task.tittel,
      tag: `opex-new-task-${taskId}`,
      eventType: 'new-task',
      taskId,
      ttl: 86400,
    });

    if (task.status === 'Til godkjenning' && ADMIN_UID !== ownerUid(task.eier)) {
      await sendToUid(ADMIN_UID, {
        title: 'Tiltak venter på godkjenning',
        body: `${task.eier}: ${task.tittel}`,
        tag: `opex-approval-${taskId}`,
        eventType: 'approval-needed',
        taskId,
        owner: task.eier,
        ttl: 86400,
      });
    }
  }
);

exports.notifyTaskChangesV1B = onValueUpdated(
  {
    ref: '/tiltak/{taskId}',
    instance: 'opex-nortura-default-rtdb',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 2,
  },
  async (event) => {
    const before = event.data.before.val() || {};
    const after = event.data.after.val() || {};
    const taskId = event.params.taskId;
    if (!isProductionTask(after)) return;

    if (before.eier !== after.eier) {
      await sendToOwner(after, {
        title: 'Tiltak er tildelt deg',
        body: after.tittel,
        tag: `opex-reassigned-${taskId}`,
        eventType: 'task-reassigned',
        taskId,
        ttl: 86400,
      });
    }

    if (before.frist !== after.frist && after.frist && !TERMINAL.has(after.status)) {
      await sendToOwner(after, {
        title: 'Frist er endret',
        body: `${after.tittel} · ny frist ${after.frist}`,
        tag: `opex-deadline-change-${taskId}`,
        eventType: 'deadline-changed',
        taskId,
        ttl: 86400,
      });
    }

    if (before.prioritet !== after.prioritet && after.prioritet === 'Kritisk' && !TERMINAL.has(after.status)) {
      await sendToOwner(after, {
        title: '🚨 Tiltak satt til Kritisk',
        body: after.tittel,
        tag: `opex-critical-${taskId}`,
        eventType: 'priority-critical',
        taskId,
        ttl: 86400,
      });
    }

    if (before.status !== after.status) {
      if (after.status === 'Til godkjenning') {
        await sendToUid(ADMIN_UID, {
          title: 'Tiltak venter på godkjenning',
          body: `${after.eier}: ${after.tittel}`,
          tag: `opex-approval-${taskId}`,
          eventType: 'approval-needed',
          taskId,
          owner: after.eier,
          ttl: 86400,
        });
      } else if (TERMINAL.has(after.status)) {
        const labels = {
          'Fullført': '✅ Tiltak fullført',
          'Stanset': '💡 Tiltak flyttet til Idébank',
          'Avsluttet': '⏹ Tiltak avsluttet',
        };
        await sendToOwner(after, {
          title: labels[after.status],
          body: after.tittel,
          tag: `opex-status-${taskId}`,
          eventType: `status-${after.status.toLowerCase()}`,
          taskId,
          ttl: 86400,
        });
      }
    }
  }
);

function osloToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateDiffDays(date, today) {
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

function reminderFor(daysLeft) {
  if (daysLeft === 3) return { key: 'due-3', title: 'Frist om 3 dager', bodyPrefix: '' };
  if (daysLeft === 0) return { key: 'due-today', title: '⏰ Frist i dag', bodyPrefix: '' };
  if (daysLeft === -1) return { key: 'overdue-1', title: '⚠️ Tiltak er forfalt', bodyPrefix: '' };
  if (daysLeft < -1 && (Math.abs(daysLeft) - 1) % 7 === 0) {
    return { key: `overdue-${Math.abs(daysLeft)}`, title: '⚠️ Tiltak er fortsatt forfalt', bodyPrefix: '' };
  }
  return null;
}

exports.notifyDeadlinesV1B = onSchedule(
  {
    schedule: '0 8 * * *',
    timeZone: 'Europe/Oslo',
    region: 'europe-west1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
    retryCount: 1,
  },
  async () => {
    const db = getDatabase();
    const today = osloToday();
    const tasksSnapshot = await db.ref('/tiltak').get();
    const tasks = tasksSnapshot.val() || {};

    for (const [taskId, task] of Object.entries(tasks)) {
      if (!isProductionTask(task) || TERMINAL.has(task.status) || !task.frist) continue;
      if (task.livssyklus === 'Papirkurv' || task.papirkurv === true) continue;
      const daysLeft = dateDiffDays(task.frist, today);
      const reminder = reminderFor(daysLeft);
      if (!reminder) continue;

      const logRef = db.ref(`/pushNotificationLog/${reminder.key}/${taskId}/${today}`);
      const alreadySent = await logRef.get();
      if (alreadySent.exists()) continue;

      const result = await sendToOwner(task, {
        title: reminder.title,
        body: `${task.tittel} · frist ${task.frist}`,
        tag: `opex-${reminder.key}-${taskId}`,
        eventType: reminder.key,
        taskId,
        ttl: 43200,
      });

      if (!result?.skipped) {
        await logRef.set({ sentAt: new Date().toISOString(), owner: task.eier });
      }
    }
  }
);
