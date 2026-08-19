'use strict';

const { onValueCreated } = require('firebase-functions/v2/database');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

const APP_URL = 'https://tonyadanielsen-byte.github.io/opex-platform/';
const OWNER_UID = Object.freeze({
  'Tony Danielsen': 'TJKI3zlDKSR7jvFXksVFgEgjS432',
  'Kenneth Nordbakk': 'gibm3aDi1KWlNyl7P3jTktQoGsM2',
  'Erling Magnussen': 'lJ7bn7HkbcZnhDoxfaBYQKEFL083',
});
const ADMIN_UID = OWNER_UID['Tony Danielsen'];

function clean(value) { return String(value ?? '').trim(); }
function ownerUid(owner) { return OWNER_UID[clean(owner)] || null; }
function taskLink(taskId) { return `${APP_URL}?openTask=${encodeURIComponent(clean(taskId))}`; }

function collectTokensForUid(root, uid) {
  const devices = root && root[uid];
  if (!devices || typeof devices !== 'object') return [];
  return [...new Set(Object.values(devices).map(device => clean(device?.token)).filter(Boolean))].slice(0, 500);
}

async function recordActivity(uid, message) {
  const ref = getDatabase().ref(`/activityInbox/${uid}`).push();
  await ref.set({
    title: clean(message.title) || 'OpEx Hub',
    body: clean(message.body) || 'Du har en ny oppdatering.',
    link: clean(message.link) || taskLink(message.taskId),
    eventType: 'task-comment-participant',
    taskId: clean(message.taskId),
    owner: clean(message.owner),
    createdAt: new Date().toISOString(),
    seenAt: null,
  });
}

async function sendParticipantNotification(uid, message, tokenRoot) {
  await recordActivity(uid, message);

  const tokens = collectTokensForUid(tokenRoot, uid);
  if (!tokens.length) {
    console.log('OpEx participant comment: in-app only', { uid, taskId: message.taskId });
    return;
  }

  const title = clean(message.title) || '💬 Ny kommentar i en samtale du følger';
  const body = clean(message.body) || 'Et tiltak du har kommentert på har fått en ny kommentar.';
  const link = taskLink(message.taskId);
  const tag = `opex-comment-participant-${message.taskId}-${message.commentId}`;

  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: {
      title,
      body,
      link,
      tag,
      eventType: 'task-comment-participant',
      taskId: clean(message.taskId),
      owner: clean(message.owner),
    },
    webpush: {
      headers: { Urgency: 'high', TTL: '86400' },
      notification: {
        title,
        body,
        icon: `${APP_URL}icons/opex-icon-192.png`,
        badge: `${APP_URL}icons/opex-status-badge-v2.png?v=2`,
        tag,
        renotify: false,
        data: { link, taskId: clean(message.taskId) },
      },
      fcmOptions: { link },
    },
  });

  console.log('OpEx participant comment result', {
    uid,
    taskId: message.taskId,
    devices: tokens.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
  });
}

exports.notifyCommentParticipantsV1 = onValueCreated({
  ref: '/taskComments/{taskId}/{commentId}',
  instance: 'opex-nortura-default-rtdb',
  region: 'europe-west1',
  memory: '256MiB',
  timeoutSeconds: 60,
  maxInstances: 2,
}, async event => {
  const comment = event.data.val() || {};
  const taskId = clean(event.params.taskId);
  const commentId = clean(event.params.commentId);
  const actor = clean(event?.authId || event?.auth?.uid || comment.authorUid);
  if (!taskId || !actor || !clean(comment.text)) return;

  const db = getDatabase();
  const [taskSnap, commentsSnap, tokenSnap] = await Promise.all([
    db.ref(`/tiltak/${taskId}`).get(),
    db.ref(`/taskComments/${taskId}`).get(),
    db.ref('/pushTokens').get(),
  ]);

  if (!taskSnap.exists()) return;
  const task = taskSnap.val() || {};
  if (task.miljo === 'Test' || !clean(task.tittel)) return;

  const currentOwnerUid = ownerUid(task.eier);
  const comments = commentsSnap.val() || {};

  // Alle som tidligere har deltatt i kommentarfeltet følger samtalen automatisk.
  // Ekskluder den som nettopp kommenterte, tiltakseier og admin fordi eksisterende
  // notifyTaskCommentV1 allerede håndterer eier/admin. Dermed unngår vi dobbeltvarsel.
  const participantUids = new Set();
  for (const [id, row] of Object.entries(comments)) {
    if (id === commentId) continue;
    const uid = clean(row?.authorUid);
    if (!uid || uid === actor || uid === currentOwnerUid || uid === ADMIN_UID) continue;
    participantUids.add(uid);
  }

  if (!participantUids.size) return;

  const authorName = clean(comment.authorName) || 'En bruker';
  const body = `${task.tittel} · ${clean(comment.text).slice(0, 120)}`;
  const message = {
    title: `💬 ${authorName} svarte i en samtale du følger`,
    body,
    taskId,
    commentId,
    owner: task.eier,
  };

  const tokenRoot = tokenSnap.val() || {};
  await Promise.all(
    [...participantUids].map(uid => sendParticipantNotification(uid, message, tokenRoot))
  );
});
