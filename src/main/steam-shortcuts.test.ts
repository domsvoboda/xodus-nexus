import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { addSteamShortcut, ARMADA_LAUNCH_WRAPPER, findSteamLaunch, planSteamShortcut, readSteamShortcuts, STEAM_COMMAND, steamAccounts, steamArgument, steamCommandOptions, type SteamLaunch } from './steam-shortcuts.js';

let root: string;
const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fixture')]);
const launch: SteamLaunch = { title: 'A game', executable: '"/bin/sh"', options: '"/home/me/launch-game" "0123456789abcdef"', directory: '/home/me', identity: 'profile:0123456789abcdef', icon: '/home/me/icon.png' };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-steam-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const config = () => path.join(root, '.local/share/Steam/userdata/123/config');
async function setup(bytes?: Buffer) {
  await fs.mkdir(config(), { recursive: true, mode: 0o700 });
  if (bytes) await fs.writeFile(path.join(config(), 'shortcuts.vdf'), bytes, { mode: 0o600 });
  return config();
}
const stopped = async () => false;

describe('Steam binary shortcut planning', () => {
  it('creates a complete shortcut and appends without changing any original byte', () => {
    const first = planSteamShortcut(undefined, launch);
    const next = planSteamShortcut(first.bytes, { ...launch, title: 'Second', options: 'other', identity: 'other' });
    expect(next.bytes.subarray(0, first.bytes.length - 2)).toEqual(first.bytes.subarray(0, -2));
    expect(next.appid).not.toBe(first.appid);
    expect(first.bytes.toString()).toContain('AllowOverlay');
    expect(first.bytes.toString()).toContain('Xodus Nexus');
  });
  it('is idempotent and preserves user customizations on a matching shortcut', () => {
    const first = planSteamShortcut(undefined, launch);
    const renamed = Buffer.from(first.bytes.toString('binary').replace('A game\0', 'Renamed by user\0'), 'binary');
    const result = planSteamShortcut(renamed, launch);
    expect(result.added).toBe(false);
    expect(result.appid).toBe(first.appid);
    expect(result.bytes).toEqual(renamed);
  });
  it('separates equal titles from different profiles/games', () => {
    const first = planSteamShortcut(undefined, launch);
    const second = planSteamShortcut(first.bytes, { ...launch, options: 'second', identity: 'second-profile' });
    expect(second.appid).not.toBe(first.appid);
  });
  it('upgrades a shortcut without %command% in place, keeping its id and other fields', () => {
    const legacy = planSteamShortcut(undefined, launch);
    const current = { ...launch, options: launch.options + STEAM_COMMAND };
    const upgraded = planSteamShortcut(legacy.bytes, current);
    expect(upgraded.added).toBe(true);
    expect(upgraded.appid).toBe(legacy.appid);
    expect(upgraded.bytes.toString('binary')).toContain(`LaunchOptions\0${current.options}\0`);
    expect(upgraded.bytes.toString('binary')).not.toContain(`LaunchOptions\0${launch.options}\0`);
    expect(upgraded.bytes.length).toBe(legacy.bytes.length + STEAM_COMMAND.length);
    expect(planSteamShortcut(upgraded.bytes, current)).toEqual({ bytes: upgraded.bytes, appid: legacy.appid, added: false });
    expect(findSteamLaunch(legacy.bytes, current)).toBe(legacy.appid);
  });
  it('upgrades a shortcut ArmadaOS wrapped (`<wrapper> %command% <script> <id>`) to the script-first form', () => {
    const current = { ...launch, options: steamCommandOptions(launch.options, true) };
    expect(current.options).toBe(`${launch.options} ${ARMADA_LAUNCH_WRAPPER} %command%`);
    const plain = planSteamShortcut(undefined, launch);
    const wrapped = Buffer.from(plain.bytes.toString('binary').replace(`LaunchOptions\0${launch.options}\0`, `LaunchOptions\0${ARMADA_LAUNCH_WRAPPER} %command% ${launch.options}\0`), 'binary');
    expect(findSteamLaunch(wrapped, current)).toBe(plain.appid);
    const upgraded = planSteamShortcut(wrapped, current);
    expect(upgraded).toMatchObject({ appid: plain.appid, added: true });
    expect(upgraded.bytes.toString('binary')).toContain(`LaunchOptions\0${current.options}\0`);
    // A shortcut first written elsewhere (`<script> <id> %command%`) also moves to the ArmadaOS form.
    const other = planSteamShortcut(undefined, { ...launch, options: steamCommandOptions(launch.options, false) });
    expect(planSteamShortcut(other.bytes, current)).toMatchObject({ appid: other.appid, added: true });
  });
  it('refuses an ID collision without changing the old entry', () => {
    const first = planSteamShortcut(undefined, launch);
    expect(() => planSteamShortcut(first.bytes, { ...launch, options: 'changed' })).toThrow('collision');
  });
  it.each([Buffer.alloc(0), Buffer.from([0]), Buffer.from('\0other\0\x08\x08'), Buffer.from('\0shortcuts\0\x09bad\0\x08\x08'), Buffer.from('\0shortcuts\0\x08\x08junk')])('rejects malformed/unknown format %#', bytes => {
    expect(() => planSteamShortcut(bytes, launch)).toThrow();
  });
  it('rejects oversized input and NUL injection', () => {
    expect(() => planSteamShortcut(Buffer.alloc(32 * 1024 * 1024 + 1), launch)).toThrow('too large');
    expect(() => planSteamShortcut(undefined, { ...launch, title: 'bad\0field' })).toThrow();
  });
  it('keeps a field budget even for compact input', () => {
    const fields = Buffer.from('\x01x\0\0'.repeat(500_001), 'binary');
    const bytes = Buffer.concat([Buffer.from('\0shortcuts\0\x000\0', 'binary'), fields, Buffer.from([8, 8, 8])]);
    expect(() => planSteamShortcut(bytes, launch)).toThrow('Too many');
  });
  it('quotes Steam command arguments without a shell expansion path', () => {
    expect(steamArgument('/home/my "$x`file`\\')).toBe('"/home/my \\"\\$x\\`file\\`\\\\"');
    expect(() => steamArgument('bad\narg')).toThrow();
    expect(() => steamArgument('/home/%command%/test')).toThrow();
  });
});

describe('Steam filesystem integration', () => {
  it('adds to 12,000 imported entries over 8 MiB, preserving every unknown field and byte', async () => {
    const template = planSteamShortcut(undefined, { ...launch, title: 'Imported game', options: 'imported', identity: 'imported' }).bytes;
    const entry = template.subarray('\0shortcuts\0'.length, -2);
    const unknown = Buffer.concat([Buffer.from('\x01custom-provider\0', 'binary'), Buffer.from('x'.repeat(600) + '\0')]);
    const blocks = Array.from({ length: 12_000 }, (_, i) => Buffer.concat([
      Buffer.from('\0' + i + '\0'), entry.subarray(3, -1), unknown, Buffer.from([8]),
    ]));
    const original = Buffer.concat([template.subarray(0, '\0shortcuts\0'.length), ...blocks, Buffer.from([8, 8])]);
    expect(original.length).toBeGreaterThan(8 * 1024 * 1024);
    const directory = await setup(original);
    await addSteamShortcut(directory, launch, {}, stopped);
    const updated = (await readSteamShortcuts(path.join(directory, 'shortcuts.vdf')))!;
    expect(updated.subarray(0, original.length - 2).equals(original.subarray(0, -2))).toBe(true);
    const planned = planSteamShortcut(updated, launch);
    expect(planned.added).toBe(false);
    expect(findSteamLaunch(updated, launch)).toBe(planned.appid);
    const backup = (await fs.readdir(directory)).find(name => name.startsWith('shortcuts.vdf.nexus-backup-'))!;
    expect((await fs.readFile(path.join(directory, backup))).equals(original)).toBe(true);
  });

  it('refuses oversized files before reading or changing them', async () => {
    const directory = await setup(), file = path.join(directory, 'shortcuts.vdf');
    const handle = await fs.open(file, 'wx', 0o600);
    await handle.truncate(32 * 1024 * 1024 + 1); await handle.close();
    await expect(readSteamShortcuts(file)).rejects.toThrow('Unsafe');
    expect((await fs.stat(file)).size).toBe(32 * 1024 * 1024 + 1);
  });
  it('discovers existing native and Flatpak profiles, deduplicating Steam symlinks', async () => {
    await setup();
    await fs.mkdir(path.join(root, '.steam'), { mode: 0o700 });
    await fs.symlink(path.join(root, '.local/share/Steam'), path.join(root, '.steam/steam'));
    const flatpak = path.join(root, '.var/app/com.valvesoftware.Steam/.local/share/Steam/userdata/456/config');
    await fs.mkdir(flatpak, { recursive: true, mode: 0o700 });
    expect(await steamAccounts(root)).toEqual([config(), flatpak]);
  });
  it('backs up exact old bytes, preserves entries and writes artwork by actual appID', async () => {
    const old = planSteamShortcut(undefined, { ...launch, title: 'Unrelated', options: 'unrelated', identity: 'unrelated' }).bytes;
    const directory = await setup(old);
    const uri = await addSteamShortcut(directory, launch, { cover: image, wide: image }, stopped);
    const result = planSteamShortcut(await fs.readFile(path.join(directory, 'shortcuts.vdf')), launch);
    expect(uri).toBe(`steam://rungameid/${(BigInt(result.appid) << 32n) | 0x02000000n}`);
    const backup = (await fs.readdir(directory)).find(name => name.startsWith('shortcuts.vdf.nexus-backup-'))!;
    expect(await fs.readFile(path.join(directory, backup))).toEqual(old);
    expect(await fs.readFile(path.join(directory, 'grid', `${result.appid}p.png`))).toEqual(image);
    expect(result.bytes.subarray(0, old.length - 2)).toEqual(old.subarray(0, -2));
  });
  it('does not duplicate entries or overwrite user artwork', async () => {
    const directory = await setup();
    await addSteamShortcut(directory, launch, { cover: image }, stopped);
    const bytes = await fs.readFile(path.join(directory, 'shortcuts.vdf'));
    const appid = planSteamShortcut(bytes, launch).appid;
    const art = path.join(directory, 'grid', `${appid}p.png`);
    await fs.writeFile(art, 'custom art');
    await addSteamShortcut(directory, launch, { cover: image }, stopped);
    expect(await fs.readFile(path.join(directory, 'shortcuts.vdf'))).toEqual(bytes);
    expect(await fs.readFile(art, 'utf8')).toBe('custom art');
  });
  it('refuses running Steam without creating files', async () => {
    const directory = await setup();
    await expect(addSteamShortcut(directory, launch, {}, async () => true)).rejects.toThrow('Close Steam');
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('aborts if Steam starts before the VDF transaction commits', async () => {
    const directory = await setup(); let checks = 0;
    await expect(addSteamShortcut(directory, launch, {}, async () => ++checks >= 3)).rejects.toThrow('Close Steam');
    await expect(fs.access(path.join(directory, 'shortcuts.vdf'))).rejects.toThrow();
    expect((await fs.readdir(directory)).some(name => name.includes('.lock') || name.startsWith('shortcuts.vdf.nexus-'))).toBe(false);
  });
  it('aborts a concurrent external edit without overwriting it', async () => {
    const directory = await setup(); const file = path.join(directory, 'shortcuts.vdf');
    let checks = 0;
    await expect(addSteamShortcut(directory, launch, {}, async () => {
      if (++checks === 2) await fs.writeFile(file, 'external edit', { mode: 0o600 });
      return false;
    })).rejects.toThrow('changed concurrently');
    expect(await fs.readFile(file, 'utf8')).toBe('external edit');
  });
  it.each(['file-symlink', 'hardlink', 'directory-symlink', 'lock', 'malformed'])('leaves unsafe files untouched: %s', async scenario => {
    const directory = await setup(); const file = path.join(directory, 'shortcuts.vdf');
    const target = path.join(root, 'untouched'); await fs.writeFile(target, 'untouched');
    if (scenario === 'file-symlink') await fs.symlink(target, file);
    if (scenario === 'hardlink') await fs.link(target, file);
    if (scenario === 'lock') await fs.writeFile(path.join(directory, '.xodus-nexus-shortcuts.lock'), 'other operation');
    if (scenario === 'malformed') await fs.writeFile(file, 'not VDF');
    let selected = directory;
    if (scenario === 'directory-symlink') { selected = path.join(root, 'alias'); await fs.symlink(directory, selected); }
    await expect(addSteamShortcut(selected, launch, {}, stopped)).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('untouched');
  });
  it('does not publish malformed artwork', async () => {
    const directory = await setup();
    await addSteamShortcut(directory, launch, { cover: Buffer.from('not PNG') }, stopped);
    expect(await fs.readdir(path.join(directory, 'grid'))).toEqual([]);
  });
});
