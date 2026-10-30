import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../uninstall.sh', import.meta.url));
async function fixture(t, custom = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-uninstall-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = custom ? path.join(root, 'prefix with spaces $literal') : path.join(root, '.local');
  const data = custom ? path.join(root, 'data with spaces') : path.join(root, '.local/share');
  const app = path.join(prefix, 'opt/xodus-nexus');
  const image = path.join(app, 'Xodus-Nexus.AppImage');
  const command = path.join(prefix, 'bin/xodus-nexus');
  const desktop = path.join(data, 'applications/xodus-nexus.desktop');
  for (const dir of [app, path.dirname(command), path.dirname(desktop), path.join(root, 'tools')]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(image, 'installed AppImage');
  await fs.writeFile(path.join(app, 'icon.png'), 'installed icon');
  await fs.symlink(image, command);
  await fs.writeFile(desktop, `[Desktop Entry]\nName=Xodus Nexus\nExec=${command} %U\nIcon=${app}/icon.png\n`);
  const preserved = [path.join(data, 'xodus-nexus/runtimes/runtime'), path.join(root, '.config/xodus-nexus/settings'), path.join(root, 'games/saves/save.dat')];
  for (const file of preserved) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'keep'); }
  await fs.writeFile(path.join(root, 'tools/update-desktop-database'), '#!/bin/sh\nprintf updated > "$XDG_DATA_HOME/database-updated"\n', { mode: 0o755 });
  const env = { ...process.env, HOME: root, XDG_DATA_HOME: data, PATH: `${root}/tools:/usr/bin:/bin` };
  delete env.XODUS_NEXUS_PREFIX;
  if (custom) env.XODUS_NEXUS_PREFIX = prefix;
  const run = (...args) => {
    assert.ok(prefix.startsWith(root + path.sep) && data.startsWith(root + path.sep));
    return spawnSync('/bin/bash', [script, ...args], { env, encoding: 'utf8' });
  };
  const kept = async () => { for (const file of preserved) assert.equal(await fs.readFile(file, 'utf8'), 'keep'); };
  return { root, prefix, data, app, image, command, desktop, run, kept };
}
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }

test('uninstall removes only the default installer files and is idempotent', async t => {
  const f = await fixture(t);
  const backup = `${f.image}.nexus-backup-01234567-89ab-cdef-0123-456789abcdef`;
  await fs.writeFile(backup, 'old AppImage');
  await fs.writeFile(`${f.image}.part`, 'partial download');
  assert.equal(f.run().status, 0);
  for (const file of [f.image, f.command, f.desktop, f.app, backup]) await absent(file);
  await f.kept();
  const second = f.run(); assert.equal(second.status, 0); assert.match(second.stdout, /No installer-managed/);
});

test('dry-run preserves every file and custom paths are handled literally', async t => {
  const f = await fixture(t, true);
  const preview = f.run('--dry-run'); assert.equal(preview.status, 0); assert.match(preview.stdout, /Would remove:/);
  assert.equal(await fs.readFile(f.image, 'utf8'), 'installed AppImage');
  await fs.lstat(f.command); await fs.lstat(f.desktop); await absent(path.join(f.data, 'database-updated'));
  assert.equal(f.run().status, 0); await absent(f.image); await absent(f.command); await absent(f.desktop); await f.kept();
});

test('uninstall preserves unrelated files, command replacements and desktop entries', async t => {
  const f = await fixture(t);
  await fs.unlink(f.command); await fs.writeFile(f.command, 'my unrelated command');
  await fs.writeFile(f.desktop, '[Desktop Entry]\nName=Another application\n');
  const extra = path.join(f.app, 'game-save.dat'); await fs.writeFile(extra, 'keep extra');
  const lookalike = `${f.image}.nexus-backup-not-an-updater-uuid`; await fs.writeFile(lookalike, 'keep lookalike');
  assert.equal(f.run().status, 0);
  assert.equal(await fs.readFile(f.command, 'utf8'), 'my unrelated command');
  assert.match(await fs.readFile(f.desktop, 'utf8'), /Another application/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'keep extra');
  assert.equal(await fs.readFile(lookalike, 'utf8'), 'keep lookalike'); await f.kept();
});

test('uninstall refuses a redirected application directory', async t => {
  const f = await fixture(t);
  const actual = path.join(f.root, 'redirected'); await fs.rename(f.app, actual); await fs.symlink(actual, f.app);
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /directory is a symlink/);
  assert.equal(await fs.readFile(path.join(actual, 'Xodus-Nexus.AppImage'), 'utf8'), 'installed AppImage'); await f.kept();
});

test('file symlinks are unlinked without deleting their targets', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'keep.AppImage'); await fs.writeFile(target, 'external file');
  await fs.unlink(f.image); await fs.symlink(target, f.image);
  assert.equal(f.run().status, 0); await absent(f.image);
  assert.equal(await fs.readFile(target, 'utf8'), 'external file'); await f.kept();
});

test('active updates and invalid options cannot delete an installation', async t => {
  const f = await fixture(t);
  await fs.writeFile(`${f.image}.nexus-update.lock`, String(process.pid));
  const active = f.run(); assert.equal(active.status, 1); assert.match(active.stderr, /update is active/);
  assert.equal(f.run('--purge').status, 1);
  assert.equal(await fs.readFile(f.image, 'utf8'), 'installed AppImage'); await f.kept();
  await fs.writeFile(`${f.image}.nexus-update.lock`, '-1'); assert.equal(f.run().status, 1);
  await fs.writeFile(`${f.image}.nexus-update.lock`, '999999999'); assert.equal(f.run().status, 0);
});
