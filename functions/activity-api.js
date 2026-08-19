'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');

function clean(value) {
  return String(value ?? '').trim();
}

async function assertAuthorized(request) {
  const uid = clean(request?.auth?.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Du må være logget inn.');
  const allowed = await getDatabase().ref(`/authorizedUsers/${uid}`).get();
  if (allowed.val() !== true) throw new HttpsError('permission-denied', 'Brukeren har ikke tilgang til OpEx.');
  return uid;
}

exports.getActivityInboxV1 = onCall({
  region: 'europe-west1',
  memory: '256MiB',
  timeoutSeconds: 30,
  maxInstances: 2,
}, async request => {
  const uid = await assertAuthorized(request);
  const snapshot = await getDatabase().ref(`/activityInbox/${uid}`).limitToLast(100).get();
  const value = snapshot.val() || {};
  const items = Object.entries(value)
    .map(([id, item]) => ({ id, ...(item || {}) }))
    .sort((a, b) => clean(b.createdAt).localeCompare(clean(a.createdAt)));
  return { items };
});

exports.markActivitySeenV1 = onCall({
  region: 'europe-west1',
  memory: '256MiB',
  timeoutSeconds: 30,
  maxInstances: 2,
}, async request => {
  const uid = await assertAuthorized(request);
  const ids = Array.isArray(request.data?.ids)
    ? request.data.ids.map(clean).filter(Boolean).slice(0, 100)
    : [];
  if (!ids.length) return { updated: 0 };

  const seenAt = new Date().toISOString();
  const updates = {};
  for (const id of ids) updates[`/activityInbox/${uid}/${id}/seenAt`] = seenAt;
  await getDatabase().ref().update(updates);
  return { updated: ids.length, seenAt };
});
