'use strict';

// Verifiserer at funksjonsbindingen laster og at ingen eksisterende eksport forsvinner.
// Krever `npm install` i functions/ (hoppes over ellers). Ingen kall mot Firebase.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fnDir = path.join(__dirname, '..', 'functions');
const hasDeps = fs.existsSync(path.join(fnDir, 'node_modules', 'firebase-functions'));

const EXISTING = [
  'notifyNewTaskV1C', 'notifyTaskChangesV1C', 'notifyTaskCommentV1', 'notifyDeadlinesV1C',
  'getTaskCommentsV1', 'addTaskCommentV1', 'deleteTaskCommentV1',
  'getActivityInboxV1', 'markActivitySeenV1', 'notifyCommentParticipantsV1',
  'notifyLorPlanChangeV1', 'notifyLorWeekStartV1', 'notifyLorFridayReminderV1',
];

test('entry.js eksporterer alle eksisterende funksjoner pluss de nye', { skip: !hasDeps && 'functions/node_modules mangler' }, () => {
  const entry = require(path.join(fnDir, 'entry.js'));
  for (const name of EXISTING) assert.equal(typeof entry[name], 'function', `${name} mangler`);
  assert.equal(typeof entry.logTiltakEventsV1, 'function');
  assert.equal(typeof entry.logTaskCommentEventV1, 'function');
});

test('logTiltakEventsV1 er en skrive-trigger på /tiltak/{taskId} med retry', { skip: !hasDeps && 'functions/node_modules mangler' }, () => {
  const { logTiltakEventsV1 } = require(path.join(fnDir, 'tiltak-events.js'));
  const ep = logTiltakEventsV1.__endpoint;
  assert.ok(ep, 'mangler __endpoint');
  assert.equal(ep.eventTrigger.eventType, 'google.firebase.database.ref.v1.written');
  assert.equal(ep.eventTrigger.eventFilterPathPatterns.ref, 'tiltak/{taskId}');
  assert.equal(ep.eventTrigger.retry, true);
  assert.deepEqual(ep.region, ['europe-west1']);
});

test('logTaskCommentEventV1 er en opprettet-trigger på /taskComments/{taskId}/{commentId}', { skip: !hasDeps && 'functions/node_modules mangler' }, () => {
  const { logTaskCommentEventV1 } = require(path.join(fnDir, 'tiltak-events.js'));
  const ep = logTaskCommentEventV1.__endpoint;
  assert.equal(ep.eventTrigger.eventType, 'google.firebase.database.ref.v1.created');
  assert.equal(ep.eventTrigger.eventFilterPathPatterns.ref, 'taskComments/{taskId}/{commentId}');
});

test('notifyTaskChangesV1C er uendret og skiller seg fra den nye triggeren', { skip: !hasDeps && 'functions/node_modules mangler' }, () => {
  const entry = require(path.join(fnDir, 'entry.js'));
  assert.notEqual(entry.notifyTaskChangesV1C, entry.logTiltakEventsV1);
  assert.equal(entry.notifyTaskChangesV1C.__endpoint.eventTrigger.eventFilterPathPatterns.ref, 'tiltak/{taskId}');
});
