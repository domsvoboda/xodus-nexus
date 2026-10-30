import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { GameShortcuts, shortcutLauncherPath, desktopArgument, shortcutArguments, shortcutInstanceData, shortcutInstanceRequest, shortcutTitleStem } from './game-shortcuts.js';
import { ShortcutLaunch } from './shortcut-launch.js';

const execute = promisify(execFile);
const id = '0123456789abcdef';
const game = { id, title: 'A game\nExec=unwanted', installState: 'ready' as const };

it('matches game windows to a hidden profile-specific entry and preserves it when creating a shortcut', async () => {
  const f = await fixture();
  try {
    await f.shortcuts.initialize();
    const png = Buffer.from('89504e470d0a1a0a00010203', 'hex');
    const identity = await f.shortcuts.windowIdentity(game, png);
    expect(identity).toMatch(/^xodus-nexus-game-[a-f0-9]{12}-0123456789abcdef$/);
    const target = path.join(f.locations.applications, identity + '.desktop');
    const body = await fs.readFile(target, 'utf8');
    expect(body).toContain('NoDisplay=true\n');
    expect(body).toContain(`StartupWMClass=${identity}\n`);
    expect(body.match(/^Exec=/gm)).toHaveLength(1);
    const icon = path.join(f.locations.userData, 'shortcuts/icons', id + '.png');
    expect(body).toContain(`Icon=${icon}\n`);
    expect(await fs.readFile(icon)).toEqual(png);
    await f.shortcuts.create(game, 'applications');
    expect(await fs.readFile(target, 'utf8')).toBe(body);
    expect(await f.shortcuts.windowIdentity(game)).toBe(identity);
    await fs.writeFile(target, 'unrelated');
    await expect(f.shortcuts.windowIdentity(game)).rejects.toThrow('unrelated');
    expect(await fs.readFile(target, 'utf8')).toBe('unrelated');
    await expect(f.shortcuts.windowIdentity({ ...game, id: '../bad' })).rejects.toThrow('identity');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

it('writes safe persistent desktop descriptors for live Steam imports without touching user application menus', async () => {
  const f = await fixture();
  try {
    await f.shortcuts.initialize();
    const prepared = await f.shortcuts.steamDesktop(game);
    const body = await fs.readFile(prepared.file, 'utf8');
    expect(prepared.file).toBe(path.join(f.locations.userData, 'shortcuts/steam', id + '.desktop'));
    expect(body.match(/^Exec=/gm)).toHaveLength(1);
    expect(body).toContain('Name=A game Exec=unwanted\n');
    expect(body).toContain(desktopArgument(path.join(f.locations.userData, 'shortcuts/launch-game')));
    expect(body).toContain(desktopArgument(id));
    expect((await fs.stat(prepared.file)).mode & 0o777).toBe(0o600);
    await expect(fs.access(f.locations.applications)).rejects.toThrow();
    const nexus = await f.shortcuts.steamDesktop();
    expect(await fs.readFile(nexus.file, 'utf8')).toContain('Name=Xodus Nexus\n');
    await fs.writeFile(prepared.file, 'unrelated user file');
    await expect(f.shortcuts.steamDesktop(game)).rejects.toThrow('unrelated');
    expect(await fs.readFile(prepared.file, 'utf8')).toBe('unrelated user file');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

it('creates Steam launch descriptions without unwanted desktop/menu entries and preserves profile arguments', async () => {
  const f = await fixture();
  try {
    await f.shortcuts.initialize();
    const steam = await f.shortcuts.steamLaunch({ ...game, title: 'A game' });
    expect(steam.executable).toBe('"/bin/sh"');
    expect(steam.options).toContain('"' + id + '"');
    expect((await execute('/bin/sh', [path.join(f.locations.userData, 'shortcuts/launch-game'), id])).stdout.trim())
      .toBe(`--nexus-profile ${f.locations.userData} --launch-game ${id}`);
    const nexus = await f.shortcuts.steamLaunch();
    expect(nexus.title).toBe('Xodus Nexus');
    expect(nexus.identity).not.toBe(steam.identity);
    expect((await execute('/bin/sh', [path.join(f.locations.userData, 'shortcuts/launch-nexus')])).stdout.trim())
      .toBe(`--nexus-profile ${f.locations.userData}`);
    await expect(fs.access(f.locations.desktop)).rejects.toThrow();
    await expect(fs.access(f.locations.applications)).rejects.toThrow();
    await expect(f.shortcuts.steamLaunch({ ...game, installState: 'imported' })).rejects.toThrow('ready');
    await expect(f.shortcuts.steamLaunch({ ...game, id: '../bad' })).rejects.toThrow('ready');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-shortcuts-'));
  const launcher = path.join(root, 'Launcher $`%\' name.AppImage');
  await fs.copyFile('/bin/echo', launcher); await fs.chmod(launcher, 0o700);
  const icon = path.join(root, 'icon.png'); await fs.writeFile(icon, 'fixture icon');
  const locations = { userData: path.join(root, 'profile'), desktop: path.join(root, 'Desktop'),
    applications: path.join(root, 'applications'), launcher, icon };
  return { root, locations, shortcuts: new GameShortcuts(locations) };
}

it('creates profile-scoped desktop/menu entries and starts the launcher, not the game', async () => {
  const f = await fixture();
  try {
    await f.shortcuts.initialize();
    const target = await f.shortcuts.create(game, 'desktop');
    const menu = await f.shortcuts.create(game, 'applications');
    expect(await fs.readFile(target, 'utf8')).toContain('Name=A game Exec=unwanted\n');
    expect((await fs.readFile(target, 'utf8')).match(/^Exec=/gm)).toHaveLength(1);
    expect(await fs.readFile(target, 'utf8')).toContain('Exec=/bin/sh ');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(menu)).mode & 0o777).toBe(0o644);
    const entry = path.join(f.locations.userData, 'shortcuts/launch-game');
    const result = await execute(entry, [id]);
    expect(result.stdout.trim()).toBe(`--nexus-profile ${f.locations.userData} --launch-game ${id}`);
    const before = await fs.readFile(target, 'utf8');
    // AppImage update replaces the file at the same path; shortcut stays valid.
    await fs.rename(f.locations.launcher, `${f.locations.launcher}.old`);
    await fs.copyFile(`${f.locations.launcher}.old`, f.locations.launcher);
    expect((await execute(entry, [id])).stdout).toBe(result.stdout);
    // Opening a manually moved launcher refreshes only the stable entry point.
    const moved = path.join(f.root, 'Moved launcher.AppImage');
    await fs.rename(f.locations.launcher, moved);
    await new GameShortcuts({ ...f.locations, launcher: moved }).initialize();
    expect((await execute(entry, [id])).stdout).toBe(result.stdout);
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    expect(await fs.readFile(entry, 'utf8')).not.toContain(f.locations.launcher);
    await f.shortcuts.remove(id);
    await expect(fs.stat(target)).rejects.toThrow(); await expect(fs.stat(menu)).rejects.toThrow();
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

it('rejects invalid IDs, unsupported installs, unsafe directories and unrelated output files', async () => {
  const f = await fixture();
  try {
    const unsupported = new GameShortcuts({ ...f.locations, launcher: undefined });
    await unsupported.initialize(); expect(unsupported.available).toBe(false);
    await expect(unsupported.create(game, 'desktop')).rejects.toThrow('installed Linux launcher');
    await f.shortcuts.initialize();
    await expect(f.shortcuts.create({ ...game, id: '../bad' }, 'desktop')).rejects.toThrow('Invalid game');
    await expect(f.shortcuts.create({ ...game, installState: 'imported' }, 'desktop')).rejects.toThrow('ready');
    await expect(f.shortcuts.create(game, '../elsewhere' as 'desktop')).rejects.toThrow('destination');
    const target = await f.shortcuts.create(game, 'desktop');
    await fs.writeFile(target, 'unrelated user file');
    const collision = await f.shortcuts.create(game, 'desktop');
    expect(collision).not.toBe(target);
    expect(await fs.readFile(target, 'utf8')).toBe('unrelated user file');
    await f.shortcuts.remove(id);
    expect(await fs.readFile(target, 'utf8')).toBe('unrelated user file');
    await fs.unlink(target); await fs.symlink(f.locations.icon, target);
    expect(await f.shortcuts.create(game, 'desktop')).not.toBe(target);
    expect(await fs.readFile(f.locations.icon, 'utf8')).toBe('fixture icon');
    await fs.chmod(f.locations.applications, 0o777).catch(() => {});
    await fs.mkdir(f.locations.applications, { recursive: true }); await fs.chmod(f.locations.applications, 0o777);
    await expect(f.shortcuts.create(game, 'applications')).rejects.toThrow('directory');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

it('names files by game title and safely separates games and profiles with identical titles', async () => {
  const f=await fixture();
  try {
    await f.shortcuts.initialize();
    const named={...game,title:'Shift At Midnight'};
    const first=await f.shortcuts.create(named,'desktop');
    expect(path.basename(first)).toBe('Shift At Midnight.desktop');
    expect(await f.shortcuts.create(named,'desktop')).toBe(first);
    const second=await f.shortcuts.create({...named,id:'fedcba9876543210'},'desktop');
    expect(path.basename(second)).toBe('Shift At Midnight (fedcba98).desktop');
    expect(await fs.readFile(first,'utf8')).toContain(`X-Xodus-Nexus-Game=${id}\n`);
    const other=new GameShortcuts({...f.locations,userData:path.join(f.root,'other-profile')});
    await other.initialize();
    const third=await other.create(named,'desktop');
    expect(third).not.toBe(first); expect(third).not.toBe(second);
    await f.shortcuts.remove(id);
    await expect(fs.stat(first)).rejects.toThrow();
    expect((await fs.stat(second)).isFile()).toBe(true);
    expect((await fs.stat(third)).isFile()).toBe(true);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

it('migrates a legacy hash entry and removes only its own old title after explicit recreation', async () => {
  const f=await fixture();
  try {
    await f.shortcuts.initialize();
    const named={...game,title:'Old title'};
    const first=await f.shortcuts.create(named,'desktop');
    const profile=createHash('sha256').update(path.resolve(f.locations.userData)).digest('hex').slice(0,12);
    const legacy=path.join(f.locations.desktop,`xodus-nexus-${profile}-${id}.desktop`);
    await fs.rename(first,legacy);
    await fs.writeFile(legacy,(await fs.readFile(legacy,'utf8')).replace(`X-Xodus-Nexus-Game=${id}\n`,''));
    const renamed=await f.shortcuts.create({...named,title:'Shift At Midnight'},'desktop');
    expect(path.basename(renamed)).toBe('Shift At Midnight.desktop');
    await expect(fs.stat(legacy)).rejects.toThrow();
    const newer=await f.shortcuts.create({...named,title:'New title'},'desktop');
    await expect(fs.stat(renamed)).rejects.toThrow();
    await f.shortcuts.remove(id); await expect(fs.stat(newer)).rejects.toThrow();
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

it('sanitizes path separators, controls and reserved punctuation and bounds UTF8 filenames', () => {
  expect(shortcutTitleStem('Shift At Midnight')).toBe('Shift At Midnight');
  expect(shortcutTitleStem('../../Game: A/B\\C?\n')).toBe('Game A B C');
  expect(shortcutTitleStem('../\0')).toBe('Xodus Nexus game');
  expect(shortcutTitleStem('Příliš žluťoučký kůň')).toBe('Příliš žluťoučký kůň');
  for(const title of ['A'.repeat(1000),'猫'.repeat(1000),'é'.repeat(1000)]) {
    const stem=shortcutTitleStem(title);
    expect(Buffer.byteLength(stem)).toBeLessThanOrEqual(120);
    expect(stem).not.toContain('\ufffd');
  }
});

it('atomically creates colliding titles without overwriting either entry', async () => {
  const f=await fixture();
  try {
    await f.shortcuts.initialize();
    const paths=await Promise.all([game,{...game,id:'fedcba9876543210'}].map(entry=>f.shortcuts.create({...entry,title:'Same title'},'desktop')));
    expect(new Set(paths).size).toBe(2);
    const bodies=await Promise.all(paths.map(file=>fs.readFile(file,'utf8')));
    expect(bodies[0]).toContain(`X-Xodus-Nexus-Game=${id}`);
    expect(bodies[1]).toContain('X-Xodus-Nexus-Game=fedcba9876543210');
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

it('parses only validated shortcut requests and escapes desktop Exec separately from shell quoting', () => {
  expect(shortcutArguments(['launcher', '--nexus-profile', '/a profile', '--launch-game', id])).toEqual({ profile: '/a profile', gameId: id });
  expect(shortcutArguments(['launcher', '--unrelated'])).toEqual({});
  for (const argv of [['--launch-game'], ['--launch-game', '../game'], ['--launch-game', id, '--launch-game', id],
    ['--nexus-profile', 'relative'], ['--nexus-profile', '/x\nExec=evil']]) expect(() => shortcutArguments(argv)).toThrow();
  expect(desktopArgument('/a b/100%/"$`\\')).toBe('"/a b/100%%/\\\\"\\\\$\\\\`\\\\\\\\"');
});

it('hands off the original request independently of Chromium switch reordering', () => {
  const profile = '/tmp/a profile/žluťoučký';
  const original = shortcutArguments(['--nexus-profile', profile, '--launch-game', id]);
  // This is the order observed from the actual second-instance event on Linux.
  expect(() => shortcutArguments(['--nexus-profile', '--launch-game', '--ozone-platform=wayland', profile, id])).toThrow('Invalid Nexus profile');
  const data = JSON.parse(JSON.stringify(shortcutInstanceData(original)));
  expect(shortcutInstanceRequest(data, profile)).toEqual(original);
  expect(shortcutInstanceRequest(shortcutInstanceData({}), profile)).toEqual({});
  expect(shortcutInstanceRequest(shortcutInstanceData({ gameId: id }), profile)).toEqual({ gameId: id });
  expect(() => shortcutInstanceRequest(data, '/tmp/another-profile')).toThrow('different Nexus profile');
});

it('rejects malformed or failed handoffs instead of converting them into a normal launch', () => {
  const profile = '/tmp/profile';
  for (const data of [undefined, null, [], {}, { nexusShortcut: null },
    { nexusShortcut: { schema: 2, request: {} } }, { nexusShortcut: { schema: 1, request: [] } },
    shortcutInstanceData({}, true), shortcutInstanceData({ gameId: '../game' }),
    shortcutInstanceData({ profile: 'relative' }), shortcutInstanceData({ profile: '/tmp/bad\npath' }),
    { nexusShortcut: { schema: 1, request: { gameId: 42 } } },
    { nexusShortcut: { schema: 1, request: { profile: null } } },
    { nexusShortcut: { schema: 1, request: { extra: 'unexpected' } } },
  ]) expect(() => shortcutInstanceRequest(data, profile)).toThrow();
});

it('writes a persistent per-game PNG, reuses it offline and keeps Nexus as the fallback', async () => {
  const f = await fixture();
  try {
    await f.shortcuts.initialize();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
    const target = await f.shortcuts.create(game, 'desktop', png);
    const icon = path.join(f.locations.userData, 'shortcuts/icons', `${id}.png`);
    expect(await fs.readFile(target, 'utf8')).toContain(`Icon=${icon}\n`);
    expect(await fs.readFile(icon)).toEqual(png);
    expect((await fs.stat(icon)).mode & 0o777).toBe(0o600);
    const menu = await f.shortcuts.create(game, 'applications');
    expect(await fs.readFile(menu, 'utf8')).toContain(`Icon=${icon}\n`);
    const other = await f.shortcuts.create({ ...game, id: 'fedcba9876543210' }, 'desktop', Buffer.from('not an image'));
    expect(await fs.readFile(other, 'utf8')).toContain(`Icon=${path.join(f.locations.userData, 'shortcuts/nexus.png')}\n`);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

it('coalesces duplicate requests, refuses concurrent games, and recovers after startup failure', async () => {
  let finish!: () => void;
  let active: string | undefined;
  const calls: string[] = [];
  const router = new ShortcutLaunch(() => active, async value => {
    calls.push(value); await new Promise<void>(resolve => { finish = resolve; });
    active = value;
  });
  const pending = router.request(id);
  await router.request(id);
  await expect(router.request('fedcba9876543210')).rejects.toThrow('Another game');
  expect(calls).toEqual([id]); finish(); await pending;
  await router.request(id); expect(calls).toEqual([id]);
  await expect(router.request('fedcba9876543210')).rejects.toThrow('Another game');
  const failure = new ShortcutLaunch(() => undefined, async () => { throw Error('missing runtime'); });
  await expect(failure.request(id)).rejects.toThrow('missing runtime');
  expect(failure.preparing).toBe(false);
});

it('follows the stable launcher symlink after an update instead of pinning its resolved version',async()=>{
  const f=await fixture();
  try{
    const stable=path.join(f.root,'Xodus-Nexus.AppImage');await fs.symlink(f.locations.launcher,stable);
    expect(await shortcutLauncherPath(f.locations.launcher)).toBe(stable);
    const shortcuts=new GameShortcuts({...f.locations,launcher:stable});await shortcuts.initialize();
    const helper=path.join(f.locations.userData,'shortcuts/launch-game');
    expect((await execute('/bin/sh',[helper,id])).stdout).toContain('--launch-game '+id);
    const updated=path.join(f.root,'updated');await fs.writeFile(updated,'#!/bin/sh\nprintf updated\n',{mode:0o700});
    await fs.unlink(stable);await fs.symlink(updated,stable);
    expect((await execute('/bin/sh',[helper,id])).stdout).toBe('updated');
    expect(await shortcutLauncherPath(f.locations.launcher,updated)).toBe(f.locations.launcher);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
