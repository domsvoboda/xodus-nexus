import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildCompatibility } from './build.mjs';
import { fileURLToPath } from 'node:url';
let root, components, loader, sdk;
const source = path.dirname(fileURLToPath(import.meta.url));
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-pgs-test-'));
  components = path.join(root, 'components');
  await buildCompatibility(components);
  const files = path.join(root, 'files');
  await fs.mkdir(path.join(files, 'bin'), { recursive: true });
  await fs.mkdir(path.join(files, 'share/xodus-nexus/compat'), { recursive: true });
  loader = path.join(files, 'bin/wine');
  await fs.copyFile(path.join(components, 'wine-launcher'), loader);
  await fs.copyFile(path.join(components, 'PlayFabGameSave.dll'), path.join(files, 'share/xodus-nexus/compat/PlayFabGameSave.dll'));
  await fs.copyFile(path.join(components, 'gaming-services-version.exe'), path.join(files, 'share/xodus-nexus/compat/gaming-services-version.exe'));
  await fs.writeFile(path.join(files, 'bin/wine.nexus-original'),
    '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$WINE_DLL_FILE_MAP" "$WINE_EXE_FILE_MAP" "$WINEDLLOVERRIDES"\nexit 23\n', { mode: 0o755 });
  const definition = await fs.readFile(path.join(source, 'playfab-save-folder.def'), 'utf8');
  const fakeDef = definition.replace(/^(PF\w+)(?:=\S+)? @(\d+)$/gm,
    (_, name, ordinal) => `${name}${name === 'PFGameSaveFilesInitialize' ? '' : '=probe_stub'} @${ordinal}`);
  await fs.writeFile(path.join(root, 'fixture.def'), fakeDef);
  sdk = path.join(root, 'owner-sdk.dll');
  execFileSync('x86_64-w64-mingw32-gcc', ['-shared', '-O2', '-DPROBE_SDK',
    path.join(source, '../runtime-tests/playfab-folder-probe.c'), path.join(root, 'fixture.def'), '-o', sdk],
    { env: { ...process.env, LD_LIBRARY_PATH: '', LD_PRELOAD: '' }, stdio: 'pipe' });
});
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const view = await fs.mkdtemp(path.join(root, '.xodus-chain-'));
  const exe = path.join(view, 'Entry.exe');
  await fs.writeFile(exe, 'materialized test executable');
  await fs.symlink(sdk, path.join(view, 'PlayFabGameSave.dll'));
  const nt = file => `\\??\\Z:${file.replaceAll('/', '\\')}`;
  const other = '42:unrelated.dll';
  const env = { ...process.env, LD_LIBRARY_PATH: '', LD_PRELOAD: '',
    NEXUS_GAMING_SERVICES_VERSION_OVERRIDE: '0',
    WINE_DLL_FILE_MAP: `${other}|3:${nt(path.join(view, 'PlayFabGameSave.dll'))}`,
    WINE_EXE_FILE_MAP: `42:unrelated.exe|3:${path.join(view, 'PlayFabGameSave.dll')}`,
    WINEDLLOVERRIDES: 'winhttp=b' };
  const run = (changes = {}, args = [exe]) => spawnSync(loader, args,
    { env: { ...env, ...changes }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', awaitFd.fd] });
  const awaitFd = await fs.open(sdk, 'r');
  return { view, exe, env, run, close: () => awaitFd.close() };
}
test('stages exact SDK, preserves owner bytes, filters only replaced FD, preserves exit code', async () => {
  const f = await fixture();
  try {
    const beforeBytes = await fs.readFile(sdk);
    const result = f.run();
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), ['42:unrelated.dll', '42:unrelated.exe', 'winhttp=b;playfabgamesave=n;nexus_pgs_native=n']);
    assert.deepEqual(await fs.readFile(sdk), beforeBytes);
    assert.deepEqual(await fs.readFile(path.join(f.view, 'nexus_pgs_native.dll')), beforeBytes);
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), false);
    assert.equal(f.run().status, 23, 'repeated staging is idempotent');
  } finally { await f.close(); }
});
test('ordinary Wine arguments and opt-out do not change any files or maps', async () => {
  const f = await fixture();
  try {
    assert.equal(f.run({}, ['--version']).status, 23);
    assert.equal(f.run({ NEXUS_PLAYFAB_ADAPTER: '0' }).status, 23);
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), true);
    await assert.rejects(fs.access(path.join(f.view, 'nexus_pgs_native.dll')));
  } finally { await f.close(); }
});
test('other-user-writable or symlinked views are never modified', async () => {
  const f = await fixture();
  try {
    await fs.chmod(f.view, 0o775);
    assert.equal(f.run().status, 23);
    await fs.chmod(f.view, 0o700);
    const alias = path.join(root, '.xodus-chain-alias');
    await fs.symlink(f.view, alias);
    assert.equal(f.run({}, [path.join(alias, 'Entry.exe')]).status, 23);
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), true);
  } finally { await f.close(); }
});
test('malformed or different SDKs are left unchanged; existing alias is not overwritten', async () => {
  const f = await fixture();
  try {
    const unknown = path.join(root, 'unknown.dll');
    await fs.writeFile(unknown, 'not an SDK');
    const fd = await fs.open(unknown, 'r');
    try {
      const result = spawnSync(loader, [f.exe], { env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd.fd] });
      assert.equal(result.status, 23);
      assert.match(result.stderr, /unsupported PlayFab/);
      assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), true);
    } finally { await fd.close(); }
    await fs.writeFile(path.join(f.view, 'nexus_pgs_native.dll'), 'owner collision');
    assert.equal(f.run().status, 70);
    assert.equal(await fs.readFile(path.join(f.view, 'nexus_pgs_native.dll'), 'utf8'), 'owner collision');
  } finally { await f.close(); }
});
test('version override requires explicit prefix and fails closed if bootstrap fails', async () => {
  const f = await fixture();
  try {
    assert.equal(f.run({ NEXUS_GAMING_SERVICES_VERSION_OVERRIDE: '1', WINEPREFIX: '' }).status, 70);
    const result = f.run({ NEXUS_GAMING_SERVICES_VERSION_OVERRIDE: '1', WINEPREFIX: f.view });
    assert.equal(result.status, 70, 'failed bootstrap must not start the game');
    assert.deepEqual(result.stdout.trimEnd().split('\n'), ['', '', 'winhttp=b'], 'bootstrap never inherits game maps');
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), true);
    assert.equal(f.run({ NEXUS_GAMING_SERVICES_VERSION_OVERRIDE: '1', WINEPREFIX: '' }, ['--version']).status, 23);
  } finally { await f.close(); }
});
test('version bootstrap is on by default, independent of SDK adapter, and preserves game maps', async () => {
  const f = await fixture();
  const original = path.join(path.dirname(loader), 'wine.nexus-original');
  const bytes = await fs.readFile(original);
  try {
    await fs.writeFile(original, '#!/bin/sh\nif [ "$2" = "apply" ]; then\n  test -z "$WINE_DLL_FILE_MAP" && test -z "$WINE_EXE_FILE_MAP" || exit 72\n  printf "bootstrap-ok\\n"\n  exit 0\nfi\nprintf "%s\\n%s\\n" "$WINE_DLL_FILE_MAP" "$WINE_EXE_FILE_MAP"\nexit 23\n');
    const result = f.run({ NEXUS_GAMING_SERVICES_VERSION_OVERRIDE: undefined, WINEPREFIX: f.view, NEXUS_PLAYFAB_ADAPTER: '0' });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), ['bootstrap-ok', f.env.WINE_DLL_FILE_MAP, f.env.WINE_EXE_FILE_MAP]);
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), true);
    const disabled = f.run({ NEXUS_GAMING_SERVICES_VERSION_OVERRIDE: '0', WINEPREFIX: '', NEXUS_PLAYFAB_ADAPTER: '0' });
    assert.equal(disabled.status, 23);
    assert.deepEqual(disabled.stdout.trimEnd().split('\n'), [f.env.WINE_DLL_FILE_MAP, f.env.WINE_EXE_FILE_MAP]);
  } finally { await fs.writeFile(original, bytes); await f.close(); }
});
test('backend default 0755 view is sealed before SDK staging', async () => {
  const f = await fixture();
  try {
    await fs.chmod(f.view, 0o755);
    const result = f.run({ NEXUS_BOOTSTRAP_DIAGNOSTICS: '1' });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stderr, /NEXUS_BOOTSTRAP sdk=1 appLocal=0/);
    assert.equal((await fs.stat(f.view)).mode & 0o777, 0o700);
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), false);
  } finally { await f.close(); }
});


test('manual adapter and linked original are materialized only inside the private view', async () => {
  const f = await fixture();
  try {
    const originalBytes = await fs.readFile(sdk);
    await fs.unlink(path.join(f.view, 'PlayFabGameSave.dll'));
    await fs.symlink(path.join(components, 'PlayFabGameSave.dll'), path.join(f.view, 'PlayFabGameSave.dll'));
    await fs.symlink(sdk, path.join(f.view, 'nexus_pgs_native.dll'));
    const result = f.run({ WINE_DLL_FILE_MAP: '42:unrelated.dll', NEXUS_BOOTSTRAP_DIAGNOSTICS: '1' });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stderr, /NEXUS_BOOTSTRAP sdk=1 appLocal=0/);
    assert.deepEqual(await fs.readFile(path.join(f.view, 'nexus_pgs_native.dll')), originalBytes);
    assert.equal((await fs.lstat(path.join(f.view, 'nexus_pgs_native.dll'))).isSymbolicLink(), false);
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), false);
    assert.deepEqual(await fs.readFile(sdk), originalBytes);
    assert.equal(f.run({ WINE_DLL_FILE_MAP: '42:unrelated.dll' }).status, 23);
  } finally { await f.close(); }
});
test('adapter without the original SDK fails before loader instead of aliasing itself', async () => {
  const f = await fixture();
  try {
    await fs.unlink(path.join(f.view, 'PlayFabGameSave.dll'));
    await fs.symlink(path.join(components, 'PlayFabGameSave.dll'), path.join(f.view, 'PlayFabGameSave.dll'));
    const result = f.run({ WINE_DLL_FILE_MAP: '42:unrelated.dll' });
    assert.equal(result.status, 70, result.stderr);
    assert.equal(result.stdout, '', 'target loader was never started');
    assert.match(result.stderr, /original PlayFab SDK/);
    await assert.rejects(fs.access(path.join(f.view, 'nexus_pgs_native.dll')));
    assert.equal((await fs.lstat(path.join(f.view, 'PlayFabGameSave.dll'))).isSymbolicLink(), true);
  } finally { await f.close(); }
});
test('an adapter can never be accepted as its own original SDK', async () => {
  const f = await fixture();
  try {
    await fs.unlink(path.join(f.view, 'PlayFabGameSave.dll'));
    const proxy = path.join(components, 'PlayFabGameSave.dll');
    await fs.copyFile(proxy, path.join(f.view, 'PlayFabGameSave.dll'));
    await fs.copyFile(proxy, path.join(f.view, 'nexus_pgs_native.dll'));
    const result = f.run({ WINE_DLL_FILE_MAP: '42:unrelated.dll' });
    assert.equal(result.status, 70, result.stderr);
    assert.equal(result.stdout, '');
  } finally { await f.close(); }
});


test('a previous adapter build is refreshed from the preserved original without a file map', async () => {
  const f = await fixture();
  try {
    const old = path.join(f.view, 'previous-adapter.dll');
    const proxyBytes = await fs.readFile(path.join(components, 'PlayFabGameSave.dll'));
    await fs.writeFile(old, Buffer.concat([proxyBytes, Buffer.from('previous build fixture')]));
    await fs.unlink(path.join(f.view, 'PlayFabGameSave.dll'));
    await fs.symlink(old, path.join(f.view, 'PlayFabGameSave.dll'));
    await fs.symlink(sdk, path.join(f.view, 'nexus_pgs_native.dll'));
    const result = f.run({ WINE_DLL_FILE_MAP: '42:unrelated.dll' });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(await fs.readFile(path.join(f.view, 'PlayFabGameSave.dll')), proxyBytes);
    assert.deepEqual(await fs.readFile(old), Buffer.concat([proxyBytes, Buffer.from('previous build fixture')]));
  } finally { await f.close(); }
});
test('a conflicting original SDK alias is retained and never selected over a different mapped SDK', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.view, 'nexus_pgs_native.dll');
    const conflicting = Buffer.concat([await fs.readFile(sdk), Buffer.from('different SDK fixture')]);
    await fs.writeFile(alias, conflicting);
    await fs.unlink(path.join(f.view, 'PlayFabGameSave.dll'));
    await fs.copyFile(path.join(components, 'PlayFabGameSave.dll'), path.join(f.view, 'PlayFabGameSave.dll'));
    const result = f.run();
    assert.equal(result.status, 70, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(await fs.readFile(alias), conflicting);
  } finally { await f.close(); }
});
