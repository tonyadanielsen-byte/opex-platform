'use strict';

/*
 * Server-skrevet hendelseslogg for Saker MVP-0 (fase 1a).
 *
 * Bevisst SEPARAT fra notifyTaskChangesV1C: varsling og logging skal ikke kunne påvirke hverandre.
 * Logikken ligger i events-core.js (ren, testet). Denne filen er bare tynn Firebase-binding.
 *
 * Skriver til:
 *   /tiltakEvents/{tiltakId}/{eventId}   (aldri fra klient; ingen klientregler/lesing i MVP-0)
 *
 * NB: RTDB-hendelser i firebase-functions v2 har ikke auth-kontekst. actorUid/actorType settes
 * derfor bare hvis plattformen leverer authId/authType, ellers utelates de.
 */

const { onValueWritten, onValueCreated } = require('firebase-functions/v2/database');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const core = require('./events-core');

if (!getApps().length) initializeApp();

const TRIGGER_OPTIONS = {
  instance: 'opex-nortura-default-rtdb',
  region: 'europe-west1',
  memory: '256MiB',
  timeoutSeconds: 60,
  maxInstances: 2,
  // Trygt: hendelsesnøklene er deterministiske, så gjentatt levering overskriver samme noder.
  retry: true,
};

exports.logTiltakEventsV1 = onValueWritten({ ref: '/tiltak/{taskId}', ...TRIGGER_OPTIONS }, async event => {
  const before = event.data.before.exists() ? event.data.before.val() : null;
  const after = event.data.after.exists() ? event.data.after.val() : null;
  await core.processTiltakWrite({
    taskId: event.params.taskId,
    before,
    after,
    eventId: event.id,
    eventTimeIso: event.time,
    authId: event.authId,
    authType: event.authType,
  }, getDatabase());
});

exports.logTaskCommentEventV1 = onValueCreated({ ref: '/taskComments/{taskId}/{commentId}', ...TRIGGER_OPTIONS }, async event => {
  await core.processCommentCreated({
    taskId: event.params.taskId,
    commentId: event.params.commentId,
    comment: event.data.val(),
    eventId: event.id,
    eventTimeIso: event.time,
  }, getDatabase());
});
