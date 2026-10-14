'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8')).rules;
const authorized = "auth != null && root.child('authorizedUsers').child(auth.uid).val() === true";

test('RTDB: root defaults to deny for read and write', () => {
  assert.equal(rules['.read'], false);
  assert.equal(rules['.write'], false);
});
test('RTDB: measures and LOR require authorized accounts for both operations', () => {
  for (const section of ['tiltak', 'lor']) {
    assert.equal(rules[section]['.read'], authorized);
    assert.equal(rules[section]['.write'], authorized);
  }
});
test('RTDB: authorizedUsers is readable only by own uid and not writable from client', () => {
  assert.equal(rules.authorizedUsers.$uid['.read'], 'auth != null && auth.uid === $uid');
  assert.equal(rules.authorizedUsers.$uid['.write'], false);
});
test('RTDB: push tokens are per user and restricted to authorized user for writes', () => {
  assert.equal(rules.pushTokens.$uid['.read'], 'auth != null && auth.uid === $uid');
  assert.equal(rules.pushTokens.$uid['.write'], "auth != null && auth.uid === $uid && root.child('authorizedUsers').child(auth.uid).val() === true");
});
test('RTDB: new case nodes stay default-denied to direct clients', () => {
  for (const node of ['saker', 'sakSpor', 'sakArsaker', 'sakTiltakSpor', 'sakEvents', 'tiltakEvents', 'sakAdmins', 'counters']) {
    assert.equal(Object.hasOwn(rules, node), false, node + ' must not have broad direct-client permissions');
  }
});
