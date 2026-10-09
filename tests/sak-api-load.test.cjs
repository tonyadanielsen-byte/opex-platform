'use strict';

// Verifiserer at callable-bindingen laster, at alle 9 sak-funksjonene registreres riktig, og at ingen
// eksisterende funksjon forsvinner. Krever `npm install` i functions/ (hoppes over ellers). Ingen Firebase-kall.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fnDir = path.join(__dirname, '..', 'functions');
const hasDeps = fs.existsSync(path.join(fnDir, 'node_modules', 'firebase-functions'));
const skip = !hasDeps && 'functions/node_modules mangler';

const NYE = ['createSakV1', 'getSakerV1', 'getSakV1', 'updateSakV1', 'setTiltakSakV1', 'removeTiltakSakV1', 'createArsakV1', 'updateArsakV1', 'createSporV1'];
const FRA_1A = ['logTiltakEventsV1', 'logTaskCommentEventV1'];
const EKSISTERENDE = [
  'notifyNewTaskV1C', 'notifyTaskChangesV1C', 'notifyTaskCommentV1', 'notifyDeadlinesV1C',
  'getTaskCommentsV1', 'addTaskCommentV1', 'deleteTaskCommentV1',
  'getActivityInboxV1', 'markActivitySeenV1', 'notifyCommentParticipantsV1',
  'notifyLorPlanChangeV1', 'notifyLorWeekStartV1', 'notifyLorFridayReminderV1',
];

test('alle 9 sak-funksjoner er callables i europe-west1 med lav maxInstances', { skip }, () => {
  const entry = require(path.join(fnDir, 'entry.js'));
  for (const name of NYE) {
    const ep = entry[name] && entry[name].__endpoint;
    assert.ok(ep, `${name} mangler eller er ikke en Cloud Function`);
    assert.ok(ep.callableTrigger, `${name} er ikke en callable`);
    assert.deepEqual(ep.region, ['europe-west1'], name);
    assert.equal(ep.maxInstances, 2, name);
    assert.equal(ep.timeoutSeconds, 30, name);
  }
});

test('entry.js eksporterer nøyaktig: 13 eksisterende + 2 fra 1a + 9 nye = 24 funksjoner', { skip }, () => {
  const entry = require(path.join(fnDir, 'entry.js'));
  for (const name of [...EKSISTERENDE, ...FRA_1A, ...NYE]) assert.equal(typeof entry[name], 'function', `${name} mangler`);
  assert.deepEqual(Object.keys(entry).sort(), [...EKSISTERENDE, ...FRA_1A, ...NYE].sort());
});

test('eksisterende funksjoner og 1a-funksjoner er uendret (samme triggere)', { skip }, () => {
  const entry = require(path.join(fnDir, 'entry.js'));
  assert.equal(entry.notifyTaskChangesV1C.__endpoint.eventTrigger.eventFilterPathPatterns.ref, 'tiltak/{taskId}');
  assert.equal(entry.logTiltakEventsV1.__endpoint.eventTrigger.eventFilterPathPatterns.ref, 'tiltak/{taskId}');
  assert.equal(entry.logTiltakEventsV1.__endpoint.eventTrigger.retry, true);
  assert.ok(entry.getTaskCommentsV1.__endpoint.callableTrigger);
});

test('callable-bindingen oversetter SakError til HttpsError og skjuler uventede feil', { skip }, async () => {
  // Kjører mot en tom, ikke-initialisert database: authorizedUsers-oppslaget feiler da uventet (uten legitimasjon),
  // og klienten skal bare få en generisk «internal»-feil, aldri interne detaljer.
  const entry = require(path.join(fnDir, 'entry.js'));
  const request = { data: { tittel: 'Test' }, auth: { uid: 'uid-test' }, rawRequest: {} };
  await assert.rejects(entry.createSakV1.run(request), (err) => {
    assert.equal(err.code, 'internal');
    assert.equal(err.message, 'Uventet feil. Prøv igjen.');
    return true;
  });
  // uten innlogging: SakError('unauthenticated') -> HttpsError('unauthenticated'), før noe databasekall
  await assert.rejects(entry.createSakV1.run({ data: { tittel: 'Test' }, rawRequest: {} }), (err) => {
    assert.equal(err.code, 'unauthenticated');
    assert.equal(err.message, 'Du må være logget inn.');
    return true;
  });
});
