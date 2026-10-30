import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  clearLaunchViews, forwardedSteamCommand, forwardedWrappers, LAUNCH_VIEW_MARGIN, LAUNCH_VIEW_SPACE_MESSAGE, launchViewDirectory, launchViewFailure, launchViewNeed,
  requireLaunchViewSpace, steamProtonLimits, steamShaderCacheEnvironment, writeSteamPrefixStop, OVERLAY_COMPONENTS, overlayRuntime, parseSteamCommand, prefixArchitecture, prepareSteamOverlay, requireSupportedGameExecutable,
  steamCompatData, steamCompatMounts, steamLaunchCommand, steamProtonCommand, steamProtonLayout, wrapperPrefix, writeSteamLauncher, writeWrappedLauncher,
} from './steam-compat.js';

const linux = process.platform === 'linux';
const proton = '/home/deck/.steam/root/compatibilitytools.d/GE-Proton10/proton';
const chain = ['/steam/reaper', 'SteamLaunch', 'AppId=3000000000', '--', '/steam/SteamLinuxRuntime_sniper/_v2-entry-point', '--verb=waitforexitandrun', '--', proton, 'waitforexitandrun', '/bin/sh'];

describe('Steam launch command', () => {
  it('keeps Steam\'s command up to the Proton verb and drops the placeholder executable', () => {
    expect(steamProtonCommand(chain)).toEqual({ prefix: chain.slice(0, -1), protonRoot: path.dirname(proton) });
  });
  it('treats a shortcut without a compatibility tool as a Nexus runtime launch', () => {
    expect(steamProtonCommand(undefined)).toBeUndefined();
    expect(steamProtonCommand(['/bin/sh'])).toBeUndefined();
    expect(steamProtonCommand(['/steam/reaper', 'SteamLaunch', 'AppId=1', '--', '/bin/sh'])).toBeUndefined();
    expect(steamProtonCommand(['/opt/proton', 'unknownverb', '/bin/sh'])).toBeUndefined();
  });
  it('rejects relative Proton paths, control characters and oversized commands', () => {
    expect(() => steamProtonCommand(['proton', 'waitforexitandrun', '/bin/sh'])).toThrow('relative');
    expect(() => steamProtonCommand([proton, 'waitforexitandrun', 'a\nb'])).toThrow();
    expect(() => steamProtonCommand(Array(65).fill('x'))).toThrow();
  });
  it('keeps the wrappers and the tool part of Steam\'s command for the launch', () => {
    expect(steamLaunchCommand(undefined)).toBeUndefined();
    expect(steamLaunchCommand([])).toBeUndefined();
    // Nothing but Steam's tracking and the placeholder: a plain Nexus launch.
    expect(steamLaunchCommand([...tracking, '/bin/sh'])).toBeUndefined();
    expect(steamLaunchCommand([armada, ...tracking, '/bin/sh'])).toEqual([armada]);
    expect(steamLaunchCommand([armada, ...tracking, ...tool, '/bin/sh'])).toEqual([armada, ...tool]);
    expect(steamLaunchCommand(chain)).toEqual(chain.slice(4, -1));
    expect(() => steamLaunchCommand(['a\nb'])).toThrow();
  });
  it('adds mounts after any Steam already set', () => {
    expect(steamCompatMounts({}, ['/games/a', '/run/user/1000/v'])).toBe('/games/a:/run/user/1000/v');
    expect(steamCompatMounts({ STEAM_COMPAT_MOUNTS: '/mnt/x' }, ['/games/a'])).toBe('/mnt/x:/games/a');
  });
});

// Captured on ArmadaOS: launch options `"<launch-game>" "<id>" /usr/libexec/armada/armada-game-launch %command%`.
const armada = '/usr/libexec/armada/armada-game-launch';
const tracking = ['/home/deck/.local/share/Steam/linuxarm64/pw-audio-namespace', '--', '/home/deck/.local/share/Steam/steamrtarm64/reaper', 'SteamLaunch', 'AppId=3715325483', '--'];
const tool = ['/home/deck/.local/share/Steam/steamapps/common/SteamLinuxRuntime_4-arm64/_v2-entry-point', '--verb=waitforexitandrun', '--', proton, 'waitforexitandrun'];

describe('Steam command parts', () => {
  it('splits wrappers, Steam tracking and the placeholder of a native shortcut', () => {
    expect(parseSteamCommand([armada, ...tracking, '/bin/sh'])).toEqual({ wrappers: [armada], tracking, tool: [] });
    expect(parseSteamCommand(['/bin/sh'])).toEqual({ wrappers: [], tracking: [], tool: [] });
    expect(parseSteamCommand(['gamemoderun', '/bin/sh'])).toEqual({ wrappers: ['gamemoderun'], tracking: [], tool: [] });
  });
  it('splits the compatibility tool part of a Proton shortcut', () => {
    const parts = parseSteamCommand(['DXVK_HUD=fps', armada, ...tracking, ...tool, '/bin/sh']);
    expect(parts).toEqual({ wrappers: ['DXVK_HUD=fps', armada], tracking, tool });
    // The launch gets the wrappers and the tool part; Steam's tracking is dropped.
    const forwarded = forwardedSteamCommand(parts);
    expect(forwarded).toEqual(['DXVK_HUD=fps', armada, ...tool]);
    expect(forwardedWrappers(forwarded)).toEqual(['DXVK_HUD=fps', armada]);
    expect(steamProtonCommand(forwarded)?.prefix).toEqual(forwarded);
    expect(forwardedWrappers([armada])).toEqual([armada]);
  });
  it('runs leading VAR=value wrappers through env', () => {
    expect(wrapperPrefix(['DXVK_HUD=fps', armada])).toEqual(['/usr/bin/env', 'DXVK_HUD=fps', armada]);
    expect(wrapperPrefix([armada, 'X=1'])).toEqual([armada, 'X=1']);
    expect(wrapperPrefix([])).toEqual([]);
  });
});

describe.skipIf(!linux)('Steam prefix and overlay', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-steam-compat-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  async function compatData(appid = '3000000000') {
    const directory = path.join(root, 'Steam/steamapps/compatdata', appid);
    await fs.mkdir(path.join(directory, 'pfx/drive_c/windows/system32'), { recursive: true, mode: 0o755 });
    return directory;
  }

  async function runtime(peArch = 'x86_64-windows', corrupt?: string) {
    const nexus = path.join(root, 'nexus-runtime');
    const directory = path.join(nexus, 'files/lib/wine', peArch);
    await fs.mkdir(directory, { recursive: true });
    const components: Record<string, string> = {};
    for (const name of OVERLAY_COMPONENTS) {
      const bytes = Buffer.from(`component ${name}`);
      await fs.writeFile(path.join(directory, name), name === corrupt ? Buffer.from('tampered') : bytes);
      components[name] = createHash('sha256').update(bytes).digest('hex');
    }
    await fs.writeFile(path.join(nexus, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ componentsByArch: { [peArch]: components } }));
    return nexus;
  }

  async function steamProton(compat: string, script = 'exit 0') {
    const protonRoot = path.join(root, 'GE-Proton');
    await fs.mkdir(path.join(protonRoot, 'files/bin'), { recursive: true });
    await fs.writeFile(path.join(protonRoot, 'files/bin/wine'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array(10).fill(0), 0x3e, 0]));
    // compatdata/version holds the script's CURRENT_PREFIX_VERSION, not the version file.
    await fs.writeFile(path.join(protonRoot, 'version'), '1792526967 ge-proton10\n');
    await fs.writeFile(path.join(protonRoot, 'proton'), `#!/bin/sh\n#CURRENT_PREFIX_VERSION is read by Nexus\nCURRENT_PREFIX_VERSION="GE-Proton10"\n${script}\n`, { mode: 0o755 });
    await fs.writeFile(path.join(compat, 'version'), 'GE-Proton10\n');
    return { prefix: [path.join(protonRoot, 'proton'), 'waitforexitandrun'], protonRoot };
  }

  it('accepts only a steamapps/compatdata/<appid> directory of this user', async () => {
    const compat = await compatData();
    expect(await steamCompatData({ STEAM_COMPAT_DATA_PATH: compat })).toEqual({ compatData: compat, prefix: path.join(compat, 'pfx') });
    await expect(steamCompatData({})).rejects.toThrow('compatibility data path');
    await expect(steamCompatData({ STEAM_COMPAT_DATA_PATH: path.join(root, 'Steam') })).rejects.toThrow('Unexpected');
    await fs.chmod(compat, 0o777);
    await expect(steamCompatData({ STEAM_COMPAT_DATA_PATH: compat })).rejects.toThrow('Unsafe');
  });

  it('writes the checked overlay into system32 and sets native overrides', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const lines: string[] = [];
    const overlay = await prepareSteamOverlay(command, await runtime(), { STEAM_COMPAT_DATA_PATH: compat, WINEDLLOVERRIDES: 'dinput8=n,b' }, line => lines.push(line));
    for (const name of OVERLAY_COMPONENTS) expect(await fs.readFile(path.join(compat, 'pfx/drive_c/windows/system32', name), 'utf8')).toBe(`component ${name}`);
    expect(overlay.layout.peArch).toBe('x86_64-windows');
    expect(overlay.environment.WINEDLLOVERRIDES).toMatch(/^dinput8=n,b;xgameruntime,.*=n,b;libnghttp2=n$/);
    expect(lines.join('\n')).toContain('Applied the Nexus runtime overlay');
  });

  it('installs Wine-built components without the builtin marker so Proton\'s own builtin is not swapped in', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const nexus = await runtime();
    const built = Buffer.alloc(0x80);
    built.write('MZ', 0, 'latin1');
    built.write('Wine builtin DLL', 0x40, 'latin1');
    await fs.writeFile(path.join(nexus, 'files/lib/wine/x86_64-windows/winhttp.dll'), built);
    const metadata = JSON.parse(await fs.readFile(path.join(nexus, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
    metadata.componentsByArch['x86_64-windows']['winhttp.dll'] = createHash('sha256').update(built).digest('hex');
    await fs.writeFile(path.join(nexus, 'XODUS_NEXUS_PATCH.json'), JSON.stringify(metadata));
    const overlay = await prepareSteamOverlay(command, nexus, { STEAM_COMPAT_DATA_PATH: compat }, () => {});
    const installed = await fs.readFile(path.join(compat, 'pfx/drive_c/windows/system32/winhttp.dll'));
    expect(installed.subarray(0x40, 0x50)).toEqual(Buffer.alloc(16));
    expect(Buffer.concat([installed.subarray(0, 0x40), installed.subarray(0x50)])).toEqual(Buffer.concat([built.subarray(0, 0x40), built.subarray(0x50)]));
    // Proton's Mono only works with its own mscoree.
    expect(OVERLAY_COMPONENTS).not.toContain('mscoree.dll');
    expect(overlay.environment.WINEDLLOVERRIDES).not.toContain('mscoree');
  });

  it('runs Proton\'s setup only when the prefix version differs from its CURRENT_PREFIX_VERSION', async () => {
    const compat = await compatData();
    const marker = path.join(root, 'setup-ran');
    const command = await steamProton(compat, `: > '${marker}'; printf 'GE-Proton10\\n' > "$STEAM_COMPAT_DATA_PATH/version"`);
    await prepareSteamOverlay(command, await runtime(), { STEAM_COMPAT_DATA_PATH: compat }, () => {});
    await expect(fs.access(marker)).rejects.toThrow();
    await fs.writeFile(path.join(compat, 'version'), 'GE-Proton9\n');
    await fs.rm(path.join(root, 'nexus-runtime'), { recursive: true });
    await prepareSteamOverlay(command, await runtime(), { STEAM_COMPAT_DATA_PATH: compat }, () => {});
    await fs.access(marker);
  });

  it('changes nothing when a component checksum or the architecture does not match', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const env = { STEAM_COMPAT_DATA_PATH: compat };
    await expect(prepareSteamOverlay(command, await runtime('x86_64-windows', 'winhttp.dll'), env, () => {})).rejects.toThrow('winhttp.dll checksum');
    await fs.rm(path.join(root, 'nexus-runtime'), { recursive: true });
    await expect(prepareSteamOverlay(command, await runtime('aarch64-windows'), env, () => {})).rejects.toThrow('x86_64-windows components');
    expect(await fs.readdir(path.join(compat, 'pfx/drive_c/windows/system32'))).toEqual([]);
  });

  async function pe(file: string, machine: number) {
    const image = Buffer.alloc(0x100);
    image.write('MZ', 0, 'latin1');
    image.writeUInt32LE(0x80, 0x3c);
    image.write('PE\0\0', 0x80, 'latin1');
    image.writeUInt16LE(machine, 0x84);
    await fs.writeFile(file, image);
  }

  it('follows PROTON_USE_ARM64=0 to the x86_64 loader of an arm64 Proton', async () => {
    const protonRoot = path.join(root, 'cachyos');
    const arm = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array(10).fill(0), 0xb7, 0]);
    const x86 = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array(10).fill(0), 0x3e, 0]);
    await fs.mkdir(path.join(protonRoot, 'files/bin-arm64'), { recursive: true });
    await fs.mkdir(path.join(protonRoot, 'files/bin'), { recursive: true });
    await fs.writeFile(path.join(protonRoot, 'files/bin-arm64/wine'), arm, { mode: 0o755 });
    await fs.writeFile(path.join(protonRoot, 'files/bin/wine'), x86);
    expect((await steamProtonLayout(protonRoot, { PROTON_USE_ARM64: '0' })).peArch).toBe('x86_64-windows');
    // Without an x86_64 loader the arm64 one runs regardless.
    await fs.rm(path.join(protonRoot, 'files/bin'), { recursive: true });
    if (process.arch === 'arm64') expect((await steamProtonLayout(protonRoot, { PROTON_USE_ARM64: '0' })).peArch).toBe('aarch64-windows');
  });

  it('reads a prefix architecture from its kernel32 and refuses to mix architectures', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const kernel32 = path.join(compat, 'pfx/drive_c/windows/system32/kernel32.dll');
    await pe(kernel32, 0xaa64);
    expect(await prefixArchitecture(path.join(compat, 'pfx'))).toBe('aarch64-windows');
    await expect(prepareSteamOverlay(command, await runtime(), { STEAM_COMPAT_DATA_PATH: compat }, () => {})).rejects.toThrow('set up for aarch64-windows');
    expect((await fs.readdir(path.dirname(kernel32))).sort()).toEqual(['kernel32.dll']);
    await pe(kernel32, 0x8664);
    expect(await prefixArchitecture(path.join(compat, 'pfx'))).toBe('x86_64-windows');
    await prepareSteamOverlay(command, await runtime(), { STEAM_COMPAT_DATA_PATH: compat }, () => {});
  });

  it('takes the components from another installed runtime of the right architecture', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const releases = path.join(root, 'releases');
    await fs.mkdir(releases);
    const x86 = await runtime();
    await fs.rename(x86, path.join(releases, 'runtime-x86_64'));
    await runtime('aarch64-windows');
    await fs.rename(path.join(root, 'nexus-runtime'), path.join(releases, 'runtime-aarch64'));
    expect((await overlayRuntime(path.join(releases, 'runtime-aarch64'), 'x86_64-windows'))?.root).toBe(path.join(releases, 'runtime-x86_64'));
    const lines: string[] = [];
    await prepareSteamOverlay(command, path.join(releases, 'runtime-aarch64'), { STEAM_COMPAT_DATA_PATH: compat }, line => lines.push(line));
    expect(lines.join('\n')).toContain('runtime-x86_64');
    expect(await overlayRuntime(path.join(releases, 'runtime-x86_64'), 'aarch64-windows')).toMatchObject({ root: path.join(releases, 'runtime-aarch64') });
  });

  it('never takes an arm64 runtime\'s components for an x86_64 Proton', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const nexus = await runtime('aarch64-windows');
    // Real arm64 assemblies also keep their arm64 checksums in `components`.
    const metadata = JSON.parse(await fs.readFile(path.join(nexus, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
    metadata.components = metadata.componentsByArch['aarch64-windows'];
    await fs.writeFile(path.join(nexus, 'XODUS_NEXUS_PATCH.json'), JSON.stringify(metadata));
    await expect(prepareSteamOverlay(command, nexus, { STEAM_COMPAT_DATA_PATH: compat }, () => {})).rejects.toThrow('No installed Nexus runtime has x86_64-windows components');
  });

  it('leaves graphics components to the player\'s Proton even when the runtime carries them', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const nexus = await runtime();
    const bytes = Buffer.from('nexus d3dcompiler');
    await fs.writeFile(path.join(nexus, 'files/lib/wine/x86_64-windows/d3dcompiler_47.dll'), bytes);
    const metadata = JSON.parse(await fs.readFile(path.join(nexus, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
    metadata.componentsByArch['x86_64-windows']['d3dcompiler_47.dll'] = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(nexus, 'XODUS_NEXUS_PATCH.json'), JSON.stringify(metadata));
    const lines: string[] = [];
    const overlay = await prepareSteamOverlay(command, nexus, { STEAM_COMPAT_DATA_PATH: compat }, line => lines.push(line));
    await expect(fs.access(path.join(compat, 'pfx/drive_c/windows/system32/d3dcompiler_47.dll'))).rejects.toThrow();
    expect(overlay.environment.WINEDLLOVERRIDES).not.toContain('d3dcompiler');
    expect(lines.join('\n')).toContain('Steam Proton graphics: DXVK unknown, vkd3d unknown.');
  });

  it('refuses a symlinked system32 in the Steam prefix', async () => {
    const compat = await compatData();
    const command = await steamProton(compat);
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.rm(path.join(compat, 'pfx/drive_c/windows/system32'), { recursive: true });
    await fs.symlink(elsewhere, path.join(compat, 'pfx/drive_c/windows/system32'));
    await expect(prepareSteamOverlay(command, await runtime(), { STEAM_COMPAT_DATA_PATH: compat }, () => {})).rejects.toThrow();
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it('creates an owner-only launch view directory under the runtime directory', async () => {
    const runtimeDir = path.join(root, 'run');
    await fs.mkdir(runtimeDir, { mode: 0o700 });
    const directory = await launchViewDirectory({ XDG_RUNTIME_DIR: runtimeDir }, 'abc123def456');
    expect(directory).toBe(path.join(runtimeDir, 'xodus-nexus/views/abc123def456'));
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    await expect(launchViewDirectory({}, 'abc123def456')).rejects.toThrow('XDG_RUNTIME_DIR');
    // Views a force-stopped backend left behind go before the next launch; nothing else does.
    await fs.mkdir(path.join(directory, '.xodus-chain-stale/Bin'), { recursive: true });
    await fs.writeFile(path.join(directory, '.xodus-chain-stale/Bin/Code.dll'), 'decrypted');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'x');
    await fs.symlink(outside, path.join(directory, '.xodus-chain-stale/link'));
    await fs.writeFile(path.join(directory, 'other'), 'x');
    await launchViewDirectory({ XDG_RUNTIME_DIR: runtimeDir }, 'abc123def456');
    expect(await fs.readdir(directory)).toEqual(['other']);
    expect(await fs.readdir(outside)).toEqual(['keep']);
  });

  it('writes a launcher that runs Steam\'s command with the view entry appended', async () => {
    const file = await writeSteamLauncher(path.join(root, 'wrappers'), { prefix: ["LABEL=it's", '/steam/proton', 'waitforexitandrun'], protonRoot: '/steam' });
    expect(await fs.readFile(file, 'utf8')).toBe(`#!/bin/sh\nexec '/usr/bin/env' 'LABEL=it'"'"'s' '/steam/proton' 'waitforexitandrun' "$@"\n`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o700);
  });

  it('never runs Steam\'s tracking again', async () => {
    const file = await writeSteamLauncher(path.join(root, 'wrappers'), { prefix: [armada, ...tracking, ...tool], protonRoot: path.dirname(proton) });
    expect(await fs.readFile(file, 'utf8')).not.toContain('reaper');
  });

  it('stops only Steam\'s prefix, with that Proton\'s own wineserver', async () => {
    const stop = await writeSteamPrefixStop(path.join(root, 'wrappers'), '/steam/GE-Proton10', { bin: 'bin', defaultPrefix: 'default_pfx', peArch: 'x86_64-windows' }, "/steam/compatdata/1/it's pfx");
    expect(stop.args).toEqual([]);
    expect(await fs.readFile(stop.command, 'utf8')).toBe(`#!/bin/sh\nexport WINEPREFIX='/steam/compatdata/1/it'"'"'s pfx'\nexec '/steam/GE-Proton10/files/bin/wineserver' -k\n`);
    expect((await fs.stat(stop.command)).mode & 0o777).toBe(0o700);
  });

  it('wraps the Nexus runtime launcher in the shortcut\'s wrappers', async () => {
    const file = await writeWrappedLauncher(path.join(root, 'wrappers'), [armada], '/data/compatdata/x/xodus-proton-wine');
    expect(await fs.readFile(file, 'utf8')).toBe(`#!/bin/sh\nexec '${armada}' '/data/compatdata/x/xodus-proton-wine' "$@"\n`);
  });
});

describe('Steam Proton launch view and limits', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-steam-view-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('counts only executables and DLLs that are still encrypted', async () => {
    await fs.mkdir(path.join(root, 'Bin'));
    await fs.writeFile(path.join(root, 'Game.exe'), Buffer.alloc(3000, 0xa5));
    await fs.writeFile(path.join(root, 'Bin/Code.DLL'), Buffer.alloc(500, 0x11));
    await fs.writeFile(path.join(root, 'Bin/plain.dll'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(8000)]));
    await fs.writeFile(path.join(root, 'Bin/data.pak'), Buffer.alloc(9000, 0xa5));
    await fs.writeFile(path.join(root, 'empty.exe'), '');
    expect(await launchViewNeed(root)).toBe(3500);
  });

  it('refuses a view that would take more than half of the free space', async () => {
    const statfs = (free: number) => async () => ({ bavail: free / 4096, bsize: 4096 });
    const gib = 1024 ** 3;
    expect(await requireLaunchViewSpace(root, 2 * 1024 ** 2, statfs(1.5 * gib))).toEqual({ need: 2 * 1024 ** 2, free: 1.5 * gib });
    await expect(requireLaunchViewSpace(root, 0.75 * gib, statfs(1.5 * gib))).rejects.toThrow(LAUNCH_VIEW_SPACE_MESSAGE);
    await expect(requireLaunchViewSpace(root, 0, statfs(LAUNCH_VIEW_MARGIN))).rejects.toThrow('clear the compatibility tool');
  });

  it('reports a launch view that ran out of space, and nothing else', () => {
    expect(launchViewFailure('could not create launch view /run/user/1000/x: No space left on device (os error 28)')).toBe(LAUNCH_VIEW_SPACE_MESSAGE);
    expect(launchViewFailure('game.exe: No space left on device')).toBeUndefined();
    expect(launchViewFailure('created a temporary launch view with 2 decrypted files')).toBeUndefined();
  });

  it('removes only the backend\'s views', async () => {
    await fs.mkdir(path.join(root, '.xodus-chain-a/Bin'), { recursive: true });
    await fs.writeFile(path.join(root, '.xodus-chain-a/Bin/Code.dll'), 'decrypted');
    await fs.writeFile(path.join(root, '.xodus-chain-file'), 'x');
    await fs.mkdir(path.join(root, 'other'));
    await clearLaunchViews(root);
    expect((await fs.readdir(root)).sort()).toEqual(['.xodus-chain-file', 'other']);
  });

  it('names what a Steam Proton launch does not get from the Nexus runtime', () => {
    const lines = steamProtonLimits('/steam/compatdata/1/pfx');
    expect(lines[0]).toContain('Package identity and ApplicationData');
    expect(lines[1]).toContain("Steam's prefix (/steam/compatdata/1/pfx)");
  });

  it('applies the managed shader caches only where Steam or the player set none', () => {
    const caches = { vkd3d: '/c/vkd3d-proton', nvidia: '/c/nvidia', mesa: '/c/mesa' };
    const limits = { bytes: String(4 * 1024 ** 3), mesa: '4G' };
    expect(steamShaderCacheEnvironment({}, caches, limits)).toEqual({
      VKD3D_SHADER_CACHE_PATH: caches.vkd3d, __GL_SHADER_DISK_CACHE_PATH: caches.nvidia, __GL_SHADER_DISK_CACHE: '1',
      __GL_SHADER_DISK_CACHE_SIZE: limits.bytes, MESA_SHADER_CACHE_DIR: caches.mesa, MESA_SHADER_CACHE_MAX_SIZE: '4G',
    });
    // Steam's own cache directories (and an explicit empty value) win, and so do their limits.
    expect(steamShaderCacheEnvironment({ __GL_SHADER_DISK_CACHE_PATH: '/steam/shadercache/1/nvidiav1', MESA_SHADER_CACHE_DIR: '', VKD3D_SHADER_CACHE_PATH: '/v' }, caches, limits)).toEqual({});
    expect(steamShaderCacheEnvironment({ MESA_SHADER_CACHE_MAX_SIZE: '1G', __GL_SHADER_DISK_CACHE: '0' }, caches, limits)).toMatchObject({
      MESA_SHADER_CACHE_DIR: caches.mesa, __GL_SHADER_DISK_CACHE_PATH: caches.nvidia });
    expect(steamShaderCacheEnvironment({ MESA_SHADER_CACHE_MAX_SIZE: '1G', __GL_SHADER_DISK_CACHE: '0' }, caches, limits)).not.toHaveProperty('MESA_SHADER_CACHE_MAX_SIZE');
    expect(steamShaderCacheEnvironment({ MESA_SHADER_CACHE_MAX_SIZE: '1G', __GL_SHADER_DISK_CACHE: '0' }, caches, limits)).not.toHaveProperty('__GL_SHADER_DISK_CACHE');
  });
});

describe('Steam Proton game executable', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-steam-exe-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  async function exe(name: string, machine: number) {
    const image = Buffer.alloc(0x100);
    image.write('MZ', 0, 'latin1');
    image.writeUInt32LE(0x80, 0x3c);
    image.write('PE\0\0', 0x80, 'latin1');
    image.writeUInt16LE(machine, 0x84);
    const file = path.join(root, name);
    await fs.writeFile(file, image);
    return file;
  }

  it('refuses a 32-bit executable and accepts 64-bit, ARM64 and unreadable (encrypted) ones', async () => {
    await expect(requireSupportedGameExecutable(await exe('x86.exe', 0x14c))).rejects.toThrow('32-bit (x86)');
    await requireSupportedGameExecutable(await exe('x64.exe', 0x8664));
    await requireSupportedGameExecutable(await exe('arm64.exe', 0xaa64));
    const encrypted = path.join(root, 'encrypted.exe');
    await fs.writeFile(encrypted, Buffer.alloc(0x100, 0xa5));
    await requireSupportedGameExecutable(encrypted);
    await requireSupportedGameExecutable(path.join(root, 'missing.exe'));
  });
});
