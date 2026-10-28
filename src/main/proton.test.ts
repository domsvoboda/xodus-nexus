import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { fexEnvironment, managedUnrealCultureGameIni, prefixUserLocale, prepareProtonRunner, syncPrefixUserLocale, syncUnrealCultureGameIni } from './proton.js';
import { prepareGameWrapper } from './game-wrapper.js';
import { defaultLaunchTools } from '../shared/launch-tools.js';
import { preparedGameWine } from './game-launch.js';

const created: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('fexEnvironment', () => {
  // Runs the runner's FEX block as an arm64 (or x86_64) host would and reports
  // the exported FEX variables and the per-game config it wrote.
  async function evaluate(machine: string, env: Record<string, string>, args: string[] = [], i386XGameRuntime?: string) {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-fex-')); created.push(root);
    const bin = path.join(root, 'bin'), config = path.join(root, 'compat', 'proton-fex-config.json');
    await mkdir(bin); await mkdir(path.dirname(config));
    await writeFile(path.join(bin, 'uname'), `#!/bin/sh\necho ${machine}\n`, { mode: 0o755 });
    const script = [...fexEnvironment(config, i386XGameRuntime), 'echo "APP=${FEX_APP_CONFIG:-}"', 'echo "LOCATION=${FEX_APP_CONFIG_LOCATION:-}"', 'echo "CACHE=${FEX_DISKCACHE:-}"'].join('\n');
    const { stdout } = await execFile('/bin/sh', ['-c', script, 'runner', ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env } });
    const written = await readFile(config, 'utf8').then(text => JSON.parse(text), () => undefined);
    return { stdout, config, written };
  }

  it.skipIf(process.platform === 'win32')('writes an empty per-game config like Proton when Steam sets nothing', async () => {
    const result = await evaluate('aarch64', {});
    expect(result.written).toEqual({ Config: {}, ThunksDB: {} });
    expect(result.stdout).toBe(`APP=${result.config}\nLOCATION=${path.join(path.dirname(result.config), 'fex-emu')}/\nCACHE=1\n`);
  });

  it.skipIf(process.platform === 'win32')('takes each game\'s Steam FEX variables, and the compat override sets both', async () => {
    expect((await evaluate('aarch64', { STEAM_FEX_TSOENABLED: '0' })).written.Config).toEqual({ TSOEnabled: '0' });
    expect((await evaluate('aarch64', { STEAM_FEX_TSOENABLED: '1', STEAM_FEX_MULTIBLOCK: '0' })).written.Config).toEqual({ TSOEnabled: '1', Multiblock: '0' });
    expect((await evaluate('aarch64', { STEAM_FEX_TSOENABLED: '1', STEAM_COMPAT_FEX_CONFIG: 'Multiblock:1' })).written.Config).toEqual({ TSOEnabled: '0', Multiblock: '1' });
    // Only FEX's boolean values reach the JSON file.
    expect((await evaluate('aarch64', { STEAM_FEX_TSOENABLED: '1", "Evil": "x' })).written.Config).toEqual({});
  });

  it.skipIf(process.platform === 'win32')('gives a 32-bit exe vector TSO unless the runtime has FEX-safe atomics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-fex-pe-')); created.push(root);
    const pe = (machine: number) => { const b = Buffer.alloc(0x86); b.write('MZ'); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80, 'latin1'); b.writeUInt16LE(machine, 0x84); return b; };
    const x86 = path.join(root, 'Game.exe'), x64 = path.join(root, 'game64.exe'), unfixed = path.join(root, 'unfixed.dll'), fixed = path.join(root, 'fixed.dll');
    await writeFile(x86, pe(0x14c)); await writeFile(x64, pe(0x8664));
    await writeFile(unfixed, pe(0x14c)); await writeFile(fixed, Buffer.concat([pe(0x14c), Buffer.from('nexus-fex-safe-i386-atomics-v1')]));
    expect((await evaluate('aarch64', {}, [x86], unfixed)).written.Config).toEqual({ VectorTSOEnabled: '1' });
    expect((await evaluate('aarch64', { STEAM_FEX_TSOENABLED: '1' }, ['--flag', 'C:\\missing.exe', x86, x64], path.join(root, 'absent.dll'))).written.Config).toEqual({ TSOEnabled: '1', VectorTSOEnabled: '1' });
    expect((await evaluate('aarch64', {}, [x86], fixed)).written.Config).toEqual({});
    expect((await evaluate('aarch64', {}, [x64, x86], unfixed)).written.Config).toEqual({});
    expect((await evaluate('aarch64', {}, [x86])).written.Config).toEqual({});
  });

  it.skipIf(process.platform === 'win32')('keeps explicit FEX settings and does nothing on x86_64 hosts', async () => {
    const explicit = await evaluate('aarch64', { FEX_APP_CONFIG: '/mine.json', FEX_APP_CONFIG_LOCATION: '/profiles/', FEX_DISKCACHE: '0', STEAM_FEX_TSOENABLED: '0' });
    expect(explicit.written).toBeUndefined();
    expect(explicit.stdout).toBe('APP=/mine.json\nLOCATION=/profiles/\nCACHE=0\n');
    const empty = await evaluate('aarch64', { FEX_APP_CONFIG: '', FEX_APP_CONFIG_LOCATION: '', FEX_DISKCACHE: '' });
    expect(empty.written).toBeUndefined();
    expect(empty.stdout).toBe('APP=\nLOCATION=\nCACHE=\n');
    const x86 = await evaluate('x86_64', { STEAM_FEX_TSOENABLED: '0' });
    expect(x86.written).toBeUndefined();
    expect(x86.stdout).toBe('APP=\nLOCATION=\nCACHE=\n');
  });
});

describe('prepareProtonRunner', () => {
  it('runs an arm64 runtime from its own loader, prefix and ARM64X component checksums', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-arm64-prefix-')); created.push(root);
    const runtime = path.join(root, 'runtime'), compat = path.join(root, 'compat');
    const wine = path.join(runtime, 'files/bin-arm64/wine');
    const system32 = path.join(compat, 'pfx/drive_c/windows/system32');
    const source = path.join(runtime, 'files/lib/wine/aarch64-windows');
    await mkdir(path.dirname(wine), { recursive: true }); await mkdir(source, { recursive: true }); await mkdir(system32, { recursive: true });
    await writeFile(wine, '#!/bin/sh\nprintf "%s|%s" "$PATH" "$WINEDLLOVERRIDES"\n', { mode: 0o700 });
    await writeFile(path.join(runtime, 'files/bin-arm64/wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(path.join(runtime, 'proton'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // An arm64 prefix has no Wine vkd3d DLLs; Proton builds them only for x86.
    for (const name of ['dxgi.dll', 'd3d12.dll']) await writeFile(path.join(system32, name), 'ready');
    await writeFile(path.join(source, 'libnghttp2.dll'), 'arm64x nghttp2');
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const metadata = { features: ['wine-winhttp-http2-v1'], components: { 'libnghttp2.dll': sha('arm64x nghttp2') }, componentsByArch: { 'aarch64-windows': { 'libnghttp2.dll': sha('arm64x nghttp2') } } };
    await writeFile(path.join(runtime, 'XODUS_NEXUS_PATCH.json'), JSON.stringify(metadata));
    // Without the arm64 template prefix the runtime is not a usable Proton.
    expect(await prepareProtonRunner(wine, compat, path.join(root, 'steam'))).toBeUndefined();
    await mkdir(path.join(runtime, 'files/share/default_pfx_arm64'), { recursive: true });
    const runner = (await prepareProtonRunner(wine, compat, path.join(root, 'steam')))!;
    expect(await readFile(path.join(system32, 'libnghttp2.dll'), 'utf8')).toBe('arm64x nghttp2');
    const script = await readFile(runner.command, 'utf8');
    expect(script).toContain(path.join(runtime, 'files/bin-arm64/wineserver'));
    expect(script).not.toContain(path.join(runtime, 'files/bin/wineserver'));
    expect((await execFile(runner.command)).stdout).toMatch(new RegExp(`^${path.join(runtime, 'files/bin-arm64').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*\\|.*libnghttp2=n`));
    // An arm64 PE directory is never checked against x86_64 checksums.
    await writeFile(path.join(runtime, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ ...metadata, componentsByArch: undefined }));
    await expect(prepareProtonRunner(wine, compat, path.join(root, 'steam'))).rejects.toThrow('libnghttp2.dll checksum');
  });

  it('provisions every verified shared DXVK module, without modifying prior runtime symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-dxvk-prefix-')); created.push(root);
    const runtime = path.join(root, 'runtime'), compat = path.join(root, 'compat');
    const wine = path.join(runtime, 'files/bin/wine');
    const system32 = path.join(compat, 'pfx/drive_c/windows/system32');
    const modules = ['d3d8.dll', 'd3d9.dll', 'd3d10core.dll', 'd3d11.dll', 'dxgi.dll'];
    const source = path.join(runtime, 'files/lib/wine/dxvk/x86_64-windows');
    await mkdir(path.dirname(wine), { recursive: true }); await mkdir(source, { recursive: true });
    await mkdir(path.join(runtime, 'files/share/default_pfx'), { recursive: true }); await mkdir(system32, { recursive: true });
    await writeFile(wine, '#!/bin/sh\nprintf "%s" "$WINEDLLOVERRIDES"\n', { mode: 0o700 });
    await writeFile(path.join(runtime, 'proton'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    for (const name of ['libvkd3d-utils-1.dll', 'd3d12.dll']) await writeFile(path.join(system32, name), 'ready');
    const components: Record<string, string> = {};
    const previous = path.join(root, 'previous-dxvk.dll'); await writeFile(previous, 'unchanged');
    for (const name of modules) {
      await writeFile(path.join(source, name), `new ${name}`);
      await symlink(previous, path.join(system32, name));
      components[name] = createHash('sha256').update(`new ${name}`).digest('hex');
    }
    await writeFile(path.join(runtime, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features: ['dxvk-constant-compare-v1'], components }));
    const runner = (await prepareProtonRunner(wine, compat, path.join(root, 'steam')))!;
    for (const name of modules) expect(await readFile(path.join(system32, name), 'utf8')).toBe(`new ${name}`);
    expect(await readFile(previous, 'utf8')).toBe('unchanged');
    expect((await execFile(runner.command)).stdout).toContain('d3d8=n');
    for (const name of modules) await writeFile(path.join(system32, name), `previous ${name}`);
    await writeFile(path.join(source, 'dxgi.dll'), 'corrupt');
    await expect(prepareProtonRunner(wine, compat, path.join(root, 'steam'))).rejects.toThrow('dxgi.dll checksum');
    for (const name of modules) expect(await readFile(path.join(system32, name), 'utf8')).toBe(`previous ${name}`);
  });
  it.each([false, true])('keeps the prefix and applies game tools only to Play (tools enabled: %s)', async (withTools) => {
    const root=await mkdtemp(path.join(tmpdir(),'nexus-proton-game-tools-')); created.push(root);
    const runtime=path.join(root,"runtime's directory"), wine=path.join(runtime,'files/bin/wine'), compat=path.join(root,'compat');
    await mkdir(path.dirname(wine),{recursive:true}); await mkdir(path.join(runtime,'files/share/default_pfx'),{recursive:true});
    const system32=path.join(compat,'pfx/drive_c/windows/system32'); await mkdir(system32,{recursive:true});
    for(const name of ['libvkd3d-utils-1.dll','dxgi.dll','d3d12.dll']) await writeFile(path.join(system32,name),'ready');
    await writeFile(path.join(system32,'wined3d.dll'),'unmanaged shader module');
    await writeFile(path.join(runtime,'proton'),'#!/bin/sh\nexit 0\n'); await chmod(path.join(runtime,'proton'),0o700);
    await writeFile(wine,'#!/bin/sh\nprintf "%s\\n" "$WINEDLLOVERRIDES" "$DXVK_HUD" "$WINEPREFIX" "$ESPEAK_DATA_PATH"; printf "<%s>\\n" "$@"; printf "<controller:%s:%s>\\n" "$PROTON_DISABLE_HIDRAW" "$SteamGameId"\n'); await chmod(wine,0o700);
    await writeFile(path.join(runtime,'files/bin/wineserver'),'#!/bin/sh\nexit 0\n'); await chmod(path.join(runtime,'files/bin/wineserver'),0o700);
    const wrapper=await prepareGameWrapper(wine,withTools ? {...defaultLaunchTools,launchOptions:'WINEDLLOVERRIDES="dxgi=n,b;winhttp=b" DXVK_HUD=fps %command% --launcher-skip'} : undefined,path.join(root,'wrappers'));
    const runner=(await prepareProtonRunner(wine,compat,path.join(root,'steam'),wrapper.command))!;
    expect(await readFile(path.join(system32,'wined3d.dll'),'utf8')).toBe('unmanaged shader module');
    const setup=await execFile(runner.command,['setup']);
    expect(setup.stdout).not.toContain('fps'); expect(setup.stdout).not.toContain('--launcher-skip');
    expect(setup.stdout.split('\n')).toContain(path.join(runtime,'files/share'));
    const game=await execFile(preparedGameWine(runner, wrapper.command),['actual game.exe'], { env: { ...process.env, WINEPREFIX: '', ESPEAK_DATA_PATH: '/wrong/host/data', PROTON_DISABLE_HIDRAW: '0x054c/0x0ce6', SteamGameId: '16968485195965530112' } });
    expect(game.stdout).toContain(path.join(compat,'pfx'));
    expect(game.stdout.split('\n')).toContain(path.join(runtime,'files/share'));
    expect(game.stdout).not.toContain('/wrong/host/data');
    expect(game.stdout).toContain('<controller:0x054c/0x0ce6:16968485195965530112>');
    if (withTools) {
      expect(game.stdout).toContain(`dxgi=n,b;winhttp=b\nfps\n${path.join(compat,'pfx')}`);
      expect(game.stdout).toContain('<actual game.exe>\n<--launcher-skip>');
    } else {
      expect(runner.launchCommand).toBeUndefined();
      expect(game.stdout).toContain('<actual game.exe>');
      expect(game.stdout).not.toContain('fps');
    }
    expect(runner.stopPrefix.command).toBe(runner.command);
    await execFile(runner.stopPrefix.command,runner.stopPrefix.args);
  });
  it.each([false, true])('provisions shared HTTP/2 dependencies safely (old symlink: %s)', async (oldSymlink) => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-h2-prefix-'));
    created.push(root);
    const runtime = path.join(root, 'runtime');
    const wine = path.join(runtime, 'files/bin/wine');
    const compat = path.join(root, 'compat');
    const system32 = path.join(compat, 'pfx/drive_c/windows/system32');
    const dll = Buffer.from('new shared nghttp2 fixture');
    const jsonDll = Buffer.from('new shared WinRT JSON fixture');
    const shaderDll = Buffer.from('new shared shader parser fixture');
    const appStateDll = Buffer.from('new shared app-state registration fixture');
    const original = path.join(root, 'previous-nghttp2.dll');
    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(runtime, 'files/share/default_pfx'), { recursive: true });
    await mkdir(path.join(runtime, 'files/lib/wine/x86_64-windows'), { recursive: true });
    await mkdir(path.join(runtime, 'files/lib/vkd3d/x86_64-windows'), { recursive: true });
    await mkdir(system32, { recursive: true });
    await writeFile(wine, '#!/bin/sh\nprintf \'%s\\n\' "$WINEDLLOVERRIDES"\n');
    await chmod(wine, 0o700);
    await writeFile(path.join(runtime, 'proton'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(runtime, 'proton'), 0o700);
    for (const name of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await writeFile(path.join(system32, name), 'ready');
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/libnghttp2.dll'), dll);
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/windows.web.dll'), jsonDll);
    await writeFile(path.join(runtime, 'files/lib/vkd3d/x86_64-windows/libvkd3d-shader-1.dll'), shaderDll);
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/twinapi.appcore.dll'), appStateDll);
    await writeFile(path.join(runtime, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features: ['wine-winhttp-http2-v1', 'winrt-json-v1', 'hlsl-state-keywords-v1', 'appstate-registration-v1'], components: { 'libnghttp2.dll': createHash('sha256').update(dll).digest('hex'), 'windows.web.dll': createHash('sha256').update(jsonDll).digest('hex'), 'libvkd3d-shader-1.dll': createHash('sha256').update(shaderDll).digest('hex'), 'twinapi.appcore.dll': createHash('sha256').update(appStateDll).digest('hex') } }));
    if (oldSymlink) {
      await writeFile(original, 'old runtime');
      await symlink(original, path.join(system32, 'libnghttp2.dll'));
      await symlink(original, path.join(system32, 'windows.web.dll'));
      await symlink(original, path.join(system32, 'libvkd3d-shader-1.dll'));
      await symlink(original, path.join(system32, 'twinapi.appcore.dll'));
    } else await writeFile(path.join(system32, 'libvkd3d-shader-1.dll'), 'previous copied shader module');
    const runner = await prepareProtonRunner(wine, compat, path.join(root, 'steam'));
    expect(await readFile(path.join(system32, 'libnghttp2.dll'))).toEqual(dll);
    expect(await readFile(path.join(system32, 'windows.web.dll'))).toEqual(jsonDll);
    expect(await readFile(path.join(system32, 'libvkd3d-shader-1.dll'))).toEqual(shaderDll);
    expect(await readFile(path.join(system32, 'twinapi.appcore.dll'))).toEqual(appStateDll);
    if (oldSymlink) expect(await readFile(original, 'utf8')).toBe('old runtime');
    const { stdout } = await execFile(runner!.command);
    expect(stdout).toContain('winhttp=b;libnghttp2=n');
    await prepareProtonRunner(wine, compat, path.join(root, 'steam'));
    expect(await readFile(path.join(system32, 'libnghttp2.dll'))).toEqual(dll);
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/windows.web.dll'), 'corrupt');
    await expect(prepareProtonRunner(wine, compat, path.join(root, 'steam'))).rejects.toThrow('windows.web.dll checksum');
    expect(await readFile(path.join(system32, 'windows.web.dll'))).toEqual(jsonDll);
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/windows.web.dll'), jsonDll);
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/libnghttp2.dll'), 'corrupt');
    await expect(prepareProtonRunner(wine, compat, path.join(root, 'steam'))).rejects.toThrow('checksum');
    expect(await readFile(path.join(system32, 'libnghttp2.dll'))).toEqual(dll);
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/libnghttp2.dll'), dll);
    await writeFile(path.join(runtime, 'files/lib/vkd3d/x86_64-windows/libvkd3d-shader-1.dll'), 'corrupt');
    await expect(prepareProtonRunner(wine, compat, path.join(root, 'steam'))).rejects.toThrow('libvkd3d-shader-1.dll checksum');
    expect(await readFile(path.join(system32, 'libvkd3d-shader-1.dll'))).toEqual(shaderDll);
    await writeFile(path.join(runtime, 'files/lib/vkd3d/x86_64-windows/libvkd3d-shader-1.dll'), shaderDll);
    await writeFile(path.join(runtime, 'files/lib/wine/x86_64-windows/twinapi.appcore.dll'), 'corrupt');
    await expect(prepareProtonRunner(wine, compat, path.join(root, 'steam'))).rejects.toThrow('twinapi.appcore.dll checksum');
    expect(await readFile(path.join(system32, 'twinapi.appcore.dll'))).toEqual(appStateDll);
    // This capability must fail closed even without the older capabilities.
    await writeFile(path.join(runtime, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features: ['appstate-registration-v1'], components: { 'twinapi.appcore.dll': createHash('sha256').update(appStateDll).digest('hex') } }));
    await expect(prepareProtonRunner(wine, compat, path.join(root, 'steam'))).rejects.toThrow('twinapi.appcore.dll checksum');
    expect(await readFile(path.join(system32, 'twinapi.appcore.dll'))).toEqual(appStateDll);
  });
  it('initializes Proton, then executes Wine directly with the Proton environment', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-proton-'));
    created.push(root);
    const wine = path.join(root, 'runtime', 'files', 'bin', 'wine');
    const proton = path.join(root, 'runtime', 'proton');
    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(root, 'runtime', 'files', 'share', 'default_pfx'), { recursive: true });
    await writeFile(wine, '#!/bin/sh\nprintf \'%s\\n\' "$WINEPREFIX" "$WINEDLLPATH" "$WINEDLLOVERRIDES" "$1"\n');
    await chmod(wine, 0o700);
    await writeFile(proton, '#!/bin/sh\nroot="$STEAM_COMPAT_DATA_PATH/pfx/drive_c/windows/system32"\nmkdir -p "$root"\ntouch "$root/libvkd3d-utils-1.dll" "$root/dxgi.dll" "$root/d3d12.dll"\n');
    await chmod(proton, 0o700);

    const compat = path.join(root, "compat game's data");
    const steam = path.join(root, "steam user's root");
    const result = await prepareProtonRunner(wine, compat, steam);
    expect(result?.command).toBe(path.join(compat, 'xodus-proton-wine'));
    const { stdout } = await execFile(result!.command, ['target path']);
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe(path.join(compat, 'pfx'));
    expect(lines[1]).toContain('/files/lib/vkd3d:');
    expect(lines[2]).toContain('dxgi=n');
    expect(lines[3]).toBe('target path');
  });

  it('falls back when the selected Wine is not part of a Proton distribution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-wine-'));
    created.push(root);
    expect(await prepareProtonRunner(path.join(root, 'bin', 'wine'), path.join(root, 'compat'), path.join(root, 'steam'))).toBeUndefined();
  });

  it.each(['', '/explicit/eac'])('discovers the installed EAC bridge without overriding configuration (%s)', async (explicit) => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-eac-runner-'));
    created.push(root);
    const files = path.join(root, 'runtime/files');
    const wine = path.join(files, 'bin/wine');
    const steam = path.join(root, "Steam's library");
    const eac = path.join(steam, 'steamapps/common/Proton EasyAntiCheat Runtime');
    const compat = path.join(root, 'compat');
    const system32 = path.join(compat, 'pfx/drive_c/windows/system32');
    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(files, 'share/default_pfx'), { recursive: true });
    await mkdir(system32, { recursive: true });
    for (const dll of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await writeFile(path.join(system32, dll), 'ready');
    await writeFile(wine, '#!/bin/sh\nprintf \'%s\\n\' "$PROTON_EAC_RUNTIME"\n');
    await chmod(wine, 0o700);
    await writeFile(path.join(files, '../proton'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(files, '../proton'), 0o700);
    await mkdir(path.join(eac, 'v2/lib64'), { recursive: true });
    for (const name of ['easyanticheat_x64.dll', 'easyanticheat_x64.so']) await writeFile(path.join(eac, 'v2/lib64', name), 'fixture');
    const runner = await prepareProtonRunner(wine, compat, steam);
    const { stdout } = await execFile(runner!.command, [], { env: { ...process.env, PROTON_EAC_RUNTIME: explicit } });
    expect(stdout.trim()).toBe(explicit || eac);
  });

  it("keeps each game's shader caches beside its prefix without overriding configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-shader-cache-'));
    created.push(root);
    const files = path.join(root, 'runtime/files');
    const wine = path.join(files, 'bin/wine');
    const compat = path.join(root, "compat game's data");
    const system32 = path.join(compat, 'pfx/drive_c/windows/system32');
    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(files, 'share/default_pfx'), { recursive: true });
    await mkdir(system32, { recursive: true });
    for (const dll of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await writeFile(path.join(system32, dll), 'ready');
    await writeFile(wine, '#!/bin/sh\nprintf \'%s\\n\' "$VKD3D_SHADER_CACHE_PATH" "$__GL_SHADER_DISK_CACHE_PATH" "$__GL_SHADER_DISK_CACHE" "$__GL_SHADER_DISK_CACHE_SKIP_CLEANUP" "$MESA_SHADER_CACHE_DIR" "$MESA_SHADER_CACHE_MAX_SIZE" "$__GL_SHADER_DISK_CACHE_SIZE"\n');
    await chmod(wine, 0o700);
    await writeFile(path.join(files, '../proton'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(files, '../proton'), 0o700);
    const runner = await prepareProtonRunner(wine, compat, path.join(root, 'steam'));
    const cache = path.join(compat, 'shadercache');
    for (const name of ['vkd3d-proton', 'nvidia', 'mesa']) expect((await stat(path.join(cache, name))).isDirectory()).toBe(true);
    const clean = { ...process.env };
    for (const name of ['VKD3D_SHADER_CACHE_PATH', '__GL_SHADER_DISK_CACHE_PATH', '__GL_SHADER_DISK_CACHE', '__GL_SHADER_DISK_CACHE_SKIP_CLEANUP', '__GL_SHADER_DISK_CACHE_SIZE', 'MESA_SHADER_CACHE_DIR', 'MESA_SHADER_CACHE_MAX_SIZE']) delete clean[name];
    const defaults = await execFile(runner!.command, [], { env: clean });
    expect(defaults.stdout.trim().split('\n')).toEqual([
      path.join(cache, 'vkd3d-proton'), path.join(cache, 'nvidia'), '1', '', path.join(cache, 'mesa'), '4G', '4294967296',
    ]);
    const explicit = await execFile(runner!.command, [], { env: { ...clean, VKD3D_SHADER_CACHE_PATH: '/mine/vkd3d', __GL_SHADER_DISK_CACHE_PATH: '/mine/nv', MESA_SHADER_CACHE_DIR: '/mine/mesa' } });
    expect(explicit.stdout.trim().split('\n').filter((line, index) => index === 0 || index === 1 || index === 4)).toEqual(['/mine/vkd3d', '/mine/nv', '/mine/mesa']);
  });

  it.each([0, 23])('waits for launcher descendants and preserves launcher exit %s', async (launcherExit) => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-proton-descendants-'));
    created.push(root);
    const files = path.join(root, "runtime's directory", 'files');
    const wine = path.join(files, 'bin', 'wine');
    const server = path.join(files, 'bin', 'wineserver');
    const compat = path.join(root, 'compat');
    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(files, 'share', 'default_pfx'), { recursive: true });
    const system32 = path.join(compat, 'pfx', 'drive_c', 'windows', 'system32');
    await mkdir(system32, { recursive: true });
    for (const dll of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await writeFile(path.join(system32, dll), 'ready');
    await writeFile(path.join(files, '..', 'proton'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(files, '..', 'proton'), 0o700);
    await writeFile(wine, `#!/bin/sh\nprintf 'launcher exited\\n' >> "$RECORD"\nexit ${launcherExit}\n`);
    await writeFile(server, '#!/bin/sh\n[ "$1" = "-w" ] || exit 91\n[ "$WINEPREFIX" = "$EXPECTED_PREFIX" ] || exit 92\nprintf \'descendant still running\\n\' >> "$RECORD"\nsleep 0.1\nprintf \'descendant finished\\n\' >> "$RECORD"\n');
    await chmod(wine, 0o700);
    await chmod(server, 0o700);
    const record = path.join(root, 'lifecycle');
    const runner = await prepareProtonRunner(wine, compat, path.join(root, 'steam'));
    let code = 0;
    try {
      await execFile(runner!.command, ['launcher.exe'], { env: { ...process.env, RECORD: record, EXPECTED_PREFIX: path.join(compat, 'pfx') } });
    } catch (error) { code = (error as { code: number }).code; }
    expect(code).toBe(launcherExit);
    expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual(['launcher exited', 'descendant still running', 'descendant finished']);
  });

  it.each([false, true])('keeps media libraries coherent (host SDK: %s) without inheriting editor libraries', async (hostLibraries) => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-proton-media-'));
    created.push(root);
    const runtime = path.join(root, "runtime's files");
    const files = path.join(runtime, 'files');
    const wine = path.join(files, 'bin', 'wine');
    const compat = path.join(root, 'compat');
    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(files, 'share', 'default_pfx'), { recursive: true });
    const system32 = path.join(compat, 'pfx', 'drive_c', 'windows', 'system32');
    await mkdir(system32, { recursive: true });
    for (const dll of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await writeFile(path.join(system32, dll), 'ready');
    await writeFile(wine, '#!/bin/sh\nprintf \'%s\\n\' "$LD_LIBRARY_PATH" "$GST_PLUGIN_SYSTEM_PATH_1_0" "$GST_PLUGIN_PATH_1_0" "$WINE_GST_REGISTRY_DIR" "$MEDIACONV_BLANK_VIDEO_FILE" "$MEDIACONV_BLANK_AUDIO_FILE"\n');
    await chmod(wine, 0o700);
    await writeFile(path.join(runtime, 'proton'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(runtime, 'proton'), 0o700);
    if (hostLibraries) await writeFile(path.join(runtime, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features: ['wine-host-libraries-v1'] }));
    const runner = await prepareProtonRunner(wine, compat, path.join(root, 'steam'));
    const { stdout } = await execFile(runner!.command, [], { env: { ...process.env, LD_LIBRARY_PATH: '/editor/foreign-libraries', GST_PLUGIN_PATH_1_0: '/editor/foreign-plugins' } });
    const values = stdout.split('\n');
    expect(values[0]).not.toContain('/editor');
    expect(values[0].startsWith('/usr/lib:')).toBe(hostLibraries);
    expect(values[1]).toBe(hostLibraries ? '/usr/lib/gstreamer-1.0' : ['x86_64-linux-gnu', 'aarch64-linux-gnu', 'i386-linux-gnu'].map((arch) => path.join(files, 'lib', arch, 'gstreamer-1.0')).join(':'));
    expect(values[2]).toBe('');
    expect(values[3]).toBe(path.join(compat, 'gstreamer-1.0'));
    expect(values[4]).toBe(path.join(files, 'share', 'media', 'blank.mkv'));
    expect(values[5]).toBe(path.join(files, 'share', 'media', 'blank.ptna'));
  });

  it('rebases existing prefix symlinks when the selected Proton runtime changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-proton-rebase-'));
    created.push(root);
    const previousRuntime = path.join(root, 'releases', 'previous');
    const currentRuntime = path.join(root, 'releases', 'current');
    const wine = path.join(currentRuntime, 'files', 'bin', 'wine');
    const proton = path.join(currentRuntime, 'proton');
    const previousDll = path.join(previousRuntime, 'files', 'lib', 'wine', 'x86_64-windows', 'xgameruntime.dll');
    const currentDll = path.join(currentRuntime, 'files', 'lib', 'wine', 'x86_64-windows', 'xgameruntime.dll');
    const compat = path.join(root, 'compat');
    const system32 = path.join(compat, 'pfx', 'drive_c', 'windows', 'system32');
    const prefixDll = path.join(system32, 'xgameruntime.dll');

    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(currentRuntime, 'files', 'share', 'default_pfx'), { recursive: true });
    await mkdir(path.dirname(previousDll), { recursive: true });
    await mkdir(path.dirname(currentDll), { recursive: true });
    await mkdir(system32, { recursive: true });
    await writeFile(wine, '#!/bin/sh\nexit 0\n');
    await chmod(wine, 0o700);
    await writeFile(proton, '#!/bin/sh\nexit 0\n');
    await chmod(proton, 0o700);
    await writeFile(previousDll, 'old');
    await writeFile(currentDll, 'new');
    await symlink(previousDll, prefixDll);
    for (const dll of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) {
      await writeFile(path.join(system32, dll), 'ready');
    }

    await prepareProtonRunner(wine, compat, path.join(root, 'steam'));
    expect(await readlink(prefixDll)).toBe(currentDll);
  });
});

describe('syncPrefixUserLocale', () => {
  it('reads the pinned prefix locale and deletes the registry key when it differs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-locale-'));
    created.push(root);
    const prefix = path.join(root, 'pfx');
    await mkdir(prefix, { recursive: true });
    await writeFile(path.join(prefix, 'user.reg'), 'WINE REGISTRY Version 2\n\n[Control Panel\\\\International] 1\n"LocaleName"="en-US"\n');
    const wine = path.join(root, 'wine');
    const record = path.join(root, 'reg-calls');
    await writeFile(wine, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$RECORD"\nexit 0\n');
    await chmod(wine, 0o700);

    expect(await prefixUserLocale(prefix)).toBe('en-US');
    const lines: string[] = [];
    await syncPrefixUserLocale(wine, prefix, 'cs-CZ', { RECORD: record }, (line) => lines.push(line));
    const calls = (await readFile(record, 'utf8')).trim().split('\n');
    expect(calls).toEqual(['reg', 'delete', 'HKCU\\Control Panel\\International', '/f']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('en-US');
    expect(lines[0]).toContain('cs-CZ');
  });

  it('keeps a matching locale, including equivalent bare-language selections', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-locale-skip-'));
    created.push(root);
    const prefix = path.join(root, 'pfx');
    await mkdir(prefix, { recursive: true });
    await writeFile(path.join(prefix, 'user.reg'), 'WINE REGISTRY Version 2\n\n[Control Panel\\\\International] 1\n"LocaleName"="cs-CZ"\n');
    const wine = path.join(root, 'wine');
    const record = path.join(root, 'reg-calls');
    await writeFile(wine, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$RECORD"\nexit 0\n');
    await chmod(wine, 0o700);

    const lines: string[] = [];
    await syncPrefixUserLocale(wine, prefix, 'cs-CZ', { RECORD: record }, (line) => lines.push(line));
    await syncPrefixUserLocale(wine, prefix, 'cs', { RECORD: record }, (line) => lines.push(line));
    await expect(readFile(record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(lines).toHaveLength(0);
  });

  it('applies a bare language and resets only the locale it managed on System default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-locale-reset-')); created.push(root);
    const prefix = path.join(root, 'pfx'); await mkdir(prefix);
    const registry = path.join(prefix, 'user.reg');
    const reg = (locale: string) => `WINE REGISTRY Version 2\n\n[Unrelated] 1\n"LocaleName"="ignore-me"\n\n[Control Panel\\\\International] 1\n"LocaleName"="${locale}"\n`;
    await writeFile(registry, reg('en-US'));
    const wine = path.join(root, 'wine'), record = path.join(root, 'calls');
    await writeFile(wine, '#!/bin/sh\nprintf "%s\\n" "$WINEUSERLOCALE" >> "$RECORD"\n', { mode: 0o700 });
    const lines: string[] = [], env = { RECORD: record, LANG: 'en_US.UTF-8' };
    await syncPrefixUserLocale(wine, prefix, 'de', env, line => lines.push(line));
    expect(await readFile(record, 'utf8')).toBe('de-DE\n');
    expect(JSON.parse(await readFile(path.join(prefix, '.nexus-user-locale.json'), 'utf8'))).toEqual({ schema: 1, applied: 'de-DE' });
    // Simulate the registry regenerated by Wine at the next game process.
    await writeFile(registry, reg('de-DE'));
    await syncPrefixUserLocale(wine, prefix, undefined, env, line => lines.push(line));
    expect(await readFile(record, 'utf8')).toBe('de-DE\nen-US\n');
    await expect(readFile(path.join(prefix, '.nexus-user-locale.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await syncPrefixUserLocale(wine, prefix, undefined, env, line => lines.push(line));
    expect(await readFile(record, 'utf8')).toBe('de-DE\nen-US\n');
  });

  it('does not reset a manually configured prefix or follow a linked ownership marker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-locale-manual-')); created.push(root);
    const prefix = path.join(root, 'pfx'); await mkdir(prefix);
    const registry = path.join(prefix, 'user.reg');
    await writeFile(registry, 'WINE REGISTRY Version 2\n\n[Control Panel\\\\International] 1\n"LocaleName"="fr-FR"\n');
    const wine = path.join(root, 'must-never-run');
    await syncPrefixUserLocale(wine, prefix, undefined, { LANG: 'en_US.UTF-8' }, () => {});
    const marker = path.join(prefix, '.nexus-user-locale.json');
    await writeFile(marker, JSON.stringify({ schema: 1, applied: 'de-DE' }));
    await syncPrefixUserLocale(wine, prefix, undefined, { LANG: 'en_US.UTF-8' }, () => {});
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const external = path.join(root, 'external'); await writeFile(external, 'unchanged'); await symlink(external, marker);
    const lines: string[] = [];
    await syncPrefixUserLocale(wine, prefix, 'de', {}, line => lines.push(line));
    expect(lines.join()).toContain('unchanged');
    expect(await readFile(external, 'utf8')).toBe('unchanged');
    expect(await prefixUserLocale(prefix)).toBe('fr-FR');
  });

  it('retains reset ownership after a failed Wine command so it can retry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-locale-retry-')); created.push(root);
    const prefix = path.join(root, 'pfx'); await mkdir(prefix);
    await writeFile(path.join(prefix, 'user.reg'), 'WINE REGISTRY Version 2\n\n[Control Panel\\\\International] 1\n"LocaleName"="de-DE"\n');
    const marker = path.join(prefix, '.nexus-user-locale.json'), data = JSON.stringify({ schema: 1, applied: 'de-DE' });
    await writeFile(marker, data);
    const wine = path.join(root, 'wine'); await writeFile(wine, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const lines: string[] = [];
    await syncPrefixUserLocale(wine, prefix, undefined, { LANG: 'en_US.UTF-8' }, line => lines.push(line));
    expect(lines.join()).toContain('could not be updated');
    expect(await readFile(marker, 'utf8')).toBe(data);
  });

  it('does not block Play if the Wine locale tool fails to spawn', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-locale-missing-tool-')); created.push(root);
    const prefix = path.join(root, 'pfx'); await mkdir(prefix);
    const lines: string[] = [];
    await expect(syncPrefixUserLocale(path.join(root, 'missing-wine'), prefix, 'pl', {}, line => lines.push(line))).resolves.toBeUndefined();
    expect(lines.join()).toContain('could not be synchronized');
    expect(lines.join()).not.toContain(root);
    await expect(readFile(path.join(prefix, '.nexus-user-locale.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites or removes a preexisting temporary locale record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-locale-collision-')); created.push(root);
    const prefix = path.join(root, 'pfx'); await mkdir(prefix);
    const temporary = path.join(prefix, `.nexus-user-locale.json.${process.pid}.tmp`);
    await writeFile(temporary, 'preexisting user data');
    const wine = path.join(root, 'wine'); await writeFile(wine, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const lines: string[] = [];
    await syncPrefixUserLocale(wine, prefix, 'pl', {}, line => lines.push(line));
    expect(await readFile(temporary, 'utf8')).toBe('preexisting user data');
    expect(lines.join()).toContain('could not be synchronized');
  });

  it('reports a failed registry update without throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'xodus-nexus-locale-fail-'));
    created.push(root);
    const prefix = path.join(root, 'pfx');
    await mkdir(prefix, { recursive: true });
    await writeFile(path.join(prefix, 'user.reg'), 'WINE REGISTRY Version 2\n\n[Control Panel\\\\International] 1\n"LocaleName"="en-US"\n');
    const wine = path.join(root, 'wine');
    await writeFile(wine, '#!/bin/sh\nexit 1\n');
    await chmod(wine, 0o700);

    const lines: string[] = [];
    await syncPrefixUserLocale(wine, prefix, 'cs-CZ', {}, (line) => lines.push(line));
    expect(lines.some((line) => line.includes('could not be updated'))).toBe(true);
  });
});

describe('syncUnrealCultureGameIni', () => {
  async function makePrefix(name: string, options: { unreal?: boolean } = {}): Promise<{ prefix: string; configDirectory: string; install: string }> {
    const root = await mkdtemp(path.join(tmpdir(), `xodus-nexus-gameini-${name}-`));
    created.push(root);
    const configDirectory = path.join(root, 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Microsoft', 'Gears of War E-Day', 'WinGDK', '6BE41AB5', 'Saved', 'Config', 'WinGDK');
    await mkdir(configDirectory, { recursive: true });
    const install = path.join(root, 'install');
    await mkdir(install, { recursive: true });
    if (options.unreal !== false) await mkdir(path.join(install, 'Engine'), { recursive: true });
    return { prefix: path.join(root, 'pfx'), configDirectory, install };
  }

  it('pins the culture with an ownership marker in a read-only Game.ini and preserves unrelated sections', async () => {
    const { prefix, configDirectory, install } = await makePrefix('write');
    const gameIni = path.join(configDirectory, 'Game.ini');
    await writeFile(gameIni, '[/Script/AkAudio.AkSettings]\r\nUnrealCultureToWwiseCulture=(("en","English(US)"))\r\n');
    const lines: string[] = [];
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', 'cs-CZ', (line) => lines.push(line));
    const content = await readFile(gameIni, 'utf8');
    expect(content).toContain('Culture=cs-CZ');
    expect(content).toContain('[Internationalization]');
    expect(content).toContain('UnrealCultureToWwiseCulture');
    expect((await stat(gameIni)).mode & 0o222).toBe(0);
    expect(lines.join('\n')).toContain('Pinned the Unreal text language');
  });

  it('keeps an already pinned culture and replaces a stale one, then removes the pin when no language is selected', async () => {
    const { prefix, configDirectory, install } = await makePrefix('update');
    const gameIni = path.join(configDirectory, 'Game.ini');
    const lines: string[] = [];
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', 'cs-CZ', (line) => lines.push(line));
    const pinned = await readFile(gameIni, 'utf8');
    expect(pinned).toContain('Culture=cs-CZ');

    lines.length = 0;
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', 'cs-CZ', (line) => lines.push(line));
    expect(lines).toHaveLength(0);
    expect(await readFile(gameIni, 'utf8')).toBe(pinned);

    lines.length = 0;
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', 'de-DE', (line) => lines.push(line));
    const replaced = await readFile(gameIni, 'utf8');
    expect(replaced).toContain('Culture=de-DE');
    expect(replaced).not.toContain('cs-CZ');

    lines.length = 0;
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', undefined, (line) => lines.push(line));
    const removed = await readFile(gameIni, 'utf8');
    expect(removed).not.toContain('Culture=');
    expect(removed).not.toContain('[Internationalization]');
    expect(lines.join('\n')).toContain('Removed the pinned Unreal text language');
    expect((await stat(gameIni)).mode & 0o777).toBe(0o644);
    await writeFile(gameIni, '[Internationalization]\nCulture=fr-FR\n');
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', undefined, () => {});
    expect(await readFile(gameIni, 'utf8')).toBe('[Internationalization]\nCulture=fr-FR\n');
    expect((await stat(gameIni)).mode & 0o777).toBe(0o644);
  });

  it('never touches a manually authored culture line', async () => {
    const { prefix, configDirectory, install } = await makePrefix('manual');
    const gameIni = path.join(configDirectory, 'Game.ini');
    const manual = '[Internationalization]\r\nCulture=fr-FR\r\n';
    await writeFile(gameIni, manual);
    await chmod(gameIni, 0o644);
    const lines: string[] = [];
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', 'cs-CZ', (line) => lines.push(line));
    expect(await readFile(gameIni, 'utf8')).toBe(manual);
    expect((await stat(gameIni)).mode & 0o222).not.toBe(0);
    expect(lines.join('\n')).toContain('manually configured');
  });

  it('releases only its managed pin and preserves other settings on System default', async () => {
    const { prefix, configDirectory, install } = await makePrefix('reset');
    const gameIni = path.join(configDirectory, 'Game.ini');
    await writeFile(gameIni, '[Other]\nValue=1\n');
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', 'en', () => {});
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', undefined, () => {});
    expect(await readFile(gameIni, 'utf8')).toContain('[Other]\nValue=1');
    expect(await readFile(gameIni, 'utf8')).not.toContain('Culture=');
    expect((await stat(gameIni)).mode & 0o222).not.toBe(0);
  });

  it('does nothing without a title id, for non-Unreal installs, or without a config directory', async () => {
    const { prefix, install } = await makePrefix('skip', { unreal: false });
    const lines: string[] = [];
    await syncUnrealCultureGameIni(prefix, install, undefined, 'cs-CZ', (line) => lines.push(line));
    await syncUnrealCultureGameIni(prefix, install, '6BE41AB5', 'cs-CZ', (line) => lines.push(line));
    await syncUnrealCultureGameIni(prefix, path.join(prefix, 'missing'), '6BE41AB5', 'cs-CZ', (line) => lines.push(line));
    expect(lines).toHaveLength(0);
  });
});

describe('managedUnrealCultureGameIni', () => {
  it('appends a marker-owned section and removes only the owned lines', () => {
    const created = managedUnrealCultureGameIni('', 'cs-CZ');
    expect(created.content).toBe('[Internationalization]\r\n; Xodus Nexus game language\r\nCulture=cs-CZ\r\n');
    expect(created.managed).toBe(true);

    const removed = managedUnrealCultureGameIni(created.content!, undefined);
    expect(removed.content).not.toBeNull();
    expect(removed.content).not.toContain('Culture');
    expect(removed.content).not.toContain('Xodus Nexus');

    const untouched = managedUnrealCultureGameIni('[Internationalization]\r\nCulture=en\r\n', 'cs-CZ');
    expect(untouched.content).toBeNull();
    expect(untouched.manual).toBe(true);
  });
});
