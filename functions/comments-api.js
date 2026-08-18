'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');

const UID_NAME = Object.freeze({
  'TJKI3zlDKSR7jvFXksVFgEgjS432': 'Tony Danielsen',
  'gibm3aDi1KWlNyl7P3jTktQoGsM2': 'Kenneth Nordbakk',
  'lJ7bn7HkbcZnhDoxfaBYQKEFL083': 'Erling Magnussen',
});

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

async function assertTaskExists(taskId) {
  if (!taskId) throw new HttpsError('invalid-argument', 'Tiltak mangler.');
  const task = await getDatabase().ref(`/tiltak/${taskId}`).get();
  if (!task.exists()) throw new HttpsError('not-found', 'Tiltaket finnes ikke.');
}

exports.getTaskCommentsV1 = onCall({
  region: 'europe-west1',
  memory: '256MiB',
  timeoutSeconds: 30,
  maxInstances: 2,
}, async request => {
  await assertAuthorized(request);
  const taskId = clean(request.data?.taskId);
  await assertTaskExists(taskId);

  const snapshot = await getDatabase().ref(`/taskComments/${taskId}`).get();
  const value = snapshot.val() || {};
  const comments = Object.entries(value)
    .map(([id, comment]) => ({ id, ...(comment || {}) }))
    .sort((a, b) => clean(a.createdAt).localeCompare(clean(b.createdAt)));

  return { comments };
});

exports.addTaskCommentV1 = onCall({
  region: 'europe-west1',
  memory: '256MiB',
  timeoutSeconds: 30,
  maxInstances: 2,
}, async request => {
  const uid = await assertAuthorized(request);
  const taskId = clean(request.data?.taskId);
  const text = clean(request.data?.text);

  await assertTaskExists(taskId);
  if (!text) throw new HttpsError('invalid-argument', 'Kommentaren er tom.');
  if (text.length > 1200) throw new HttpsError('invalid-argument', 'Kommentaren kan være maks 1200 tegn.');

  const comment = {
    text,
    authorUid: uid,
    authorName: UID_NAME[uid] || clean(request.auth?.token?.name) || clean(request.auth?.token?.email) || 'Bruker',
    createdAt: new Date().toISOString(),
  };

  const ref = getDatabase().ref(`/taskComments/${taskId}`).push();
  await ref.set(comment);
  return { id: ref.key, comment };
});
