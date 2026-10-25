// Policy for the offline identity runtime patch: pinned last in the sequence,
// hashed, exercised by a contract probe, and limited to identity data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const lock = JSON.parse(fs.readFileSync(new URL('../runtime-patches.lock.json', import.meta.url), 'utf8'));
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

test('offline identity patch is pinned after the user sign-in work and hashed', () => {
  const entry = lock.patches.find(p => p.file === 'assets/xgameruntime-offline-identity.patch');
  assert.ok(entry, 'lock entry');
  assert.equal(sha(read('../../assets/xgameruntime-offline-identity.patch')), entry.sha256);
  const index = name => lock.patches.findIndex(p => p.file === name);
  assert.ok(index(entry.file) > index('assets/xgameruntime-user-signin.patch'));
  assert.ok(index(entry.file) > index('assets/xgameruntime-shared-foundation.patch'));
  for (const file of ['dlls/xgameruntime/xuser.c', 'dlls/xgameruntime/xnetworking.c', 'dlls/xgameruntime/private.h'])
    assert.match(lock.expectedXgameruntimeSources[file] ?? '', /^[a-f0-9]{64}$/);
});

test('offline identity stores identity only and is used solely when the network is unreachable', () => {
  const patch = read('../../assets/xgameruntime-offline-identity.patch');
  // The cache records what a title may observe about the signed-in user.
  for (const field of ['xuid=', 'gamertag=', 'modernGamertag=', 'ageGroup=', 'savedAt=']) assert.ok(patch.includes(field), field);
  // Never tokens, tickets or keys.
  assert.doesNotMatch(patch, /\+.*(userToken|deviceToken|titleToken|proofKey|Ticket)=/);
  assert.ok(patch.includes('connectivity_failure( hr )'));
  assert.ok(patch.includes('OFFLINE_IDENTITY_MAX_AGE (30ull'));
  assert.ok(patch.includes('XODUS_FORCE_OFFLINE'));
  assert.ok(patch.includes('XNetworkingConnectivityLevelHint_LocalAccess'));
});

test('offline identity is covered by a contract probe wired into the build and the runner', () => {
  const probe = read('./offline-identity-probe.c');
  assert.match(probe, /XODUS_FORCE_OFFLINE/);
  assert.match(probe, /no-cache-fails/);
  assert.match(probe, /stale-cache-fails/);
  assert.match(probe, /cached-sign-in/);
  assert.match(probe, /token-fails-offline/);
  assert.match(probe, /hint-local/);
  assert.match(read('./run-contract-probes.mjs'), /'offline-identity'/);
  assert.match(read('../build-shared-runtime.mjs'), /'offline-identity'/);
  assert.match(read('../assemble-shared-runtime.mjs'), /xuser-offline-identity-v1/);
});
