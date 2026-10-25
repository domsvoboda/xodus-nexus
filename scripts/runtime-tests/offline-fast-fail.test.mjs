// Policy for the fail-fast network patch: pinned after the offline identity it
// completes, hashed, bounded timeouts only, no retries on an unreachable
// network, and the contract probe times both offline sign-in paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const lock = JSON.parse(fs.readFileSync(new URL('../runtime-patches.lock.json', import.meta.url), 'utf8'));
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

test('fail-fast patch is pinned after the offline identity and hashed with its sources', () => {
  const entry = lock.patches.find(p => p.file === 'assets/xgameruntime-offline-fast-fail.patch');
  assert.ok(entry, 'lock entry');
  assert.equal(sha(read('../../assets/xgameruntime-offline-fast-fail.patch')), entry.sha256);
  const index = name => lock.patches.findIndex(p => p.file === name);
  assert.ok(index(entry.file) > index('assets/xgameruntime-offline-identity.patch'));
  assert.ok(index(entry.file) > index('assets/xgameruntime-shared-foundation.patch'));
  for (const file of ['dlls/xgameruntime/util.c', 'dlls/xgameruntime/util.h', 'dlls/xgameruntime/xuser.c'])
    assert.match(lock.expectedXgameruntimeSources[file] ?? '', /^[a-f0-9]{64}$/);
  const files = [...read('../../assets/xgameruntime-offline-fast-fail.patch').matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
  assert.deepEqual(files.sort(), ['dlls/xgameruntime/util.c', 'dlls/xgameruntime/util.h', 'dlls/xgameruntime/xuser.c']);
});

test('requests bound resolution and connect, keep transfer timeouts, and stop retrying an unreachable network', () => {
  const patch = read('../../assets/xgameruntime-offline-fast-fail.patch');
  // Both HTTP helpers get the same bounded session timeouts; send/receive stay at Wine's defaults.
  assert.equal((patch.match(/^\+\s*WinHttpSetTimeouts\( session, 5000, 5000, 30000, 30000 \);/gm) ?? []).length, 2);
  assert.doesNotMatch(patch, /^\+.*WinHttpSetTimeouts\( (?!session, 5000, 5000, 30000, 30000)/m);
  // One shared classifier for the four unreachable-network errors.
  assert.match(patch, /^\+BOOL http_connectivity_failure\( HRESULT hr \)/m);
  for (const error of ['ERROR_WINHTTP_TIMEOUT', 'ERROR_WINHTTP_NAME_NOT_RESOLVED', 'ERROR_WINHTTP_CANNOT_CONNECT', 'ERROR_WINHTTP_CONNECTION_ERROR'])
    assert.ok(patch.includes(error), error);
  assert.match(patch, /^\+\s*if \(hr == E_FAIL \|\| http_connectivity_failure\( hr \)\) break;/m);
  assert.match(patch, /^\+\s*if \(FAILED\(hr\) && http_connectivity_failure\( hr \)\) break;/m);
  // The sign-in thread no longer makes a delayed second attempt against an unreachable network.
  assert.match(patch, /^-\s*if \(connectivity_failure\( hr \) && attempt >= 1\) break;/m);
  assert.match(patch, /^\+\s*if \(connectivity_failure\( hr \)\) break;/m);
  // Server-error retries and the start-race retries are untouched.
  assert.doesNotMatch(patch, /^[-+].*attempt < 3/m);
  assert.doesNotMatch(patch, /^[-+].*Sleep\( 3000 \)/m);
});

test('the offline identity probe times both forced-offline sign-in paths', () => {
  const probe = read('./offline-identity-probe.c');
  assert.match(probe, /no-cache-fails-fast/);
  assert.match(probe, /cached-sign-in-fast/);
  assert.equal((probe.match(/GetTickCount64\(\) - started < 2000/g) ?? []).length, 2);
});
