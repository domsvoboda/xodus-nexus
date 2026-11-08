import { execFile as callback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareProtonRunner } from './proton.js';
import { prepareGameWrapper } from './game-wrapper.js';
import { defaultLaunchTools } from '../shared/launch-tools.js';
import { prepareShaderCache } from './shader-cache.js';

const execFile = promisify(callback), roots: string[] = [];
const keys = ['VKD3D_SHADER_CACHE_PATH', '__GL_SHADER_DISK_CACHE_PATH', '__GL_SHADER_DISK_CACHE',
  '__GL_SHADER_DISK_CACHE_SKIP_CLEANUP', '__GL_SHADER_DISK_CACHE_SIZE', 'MESA_SHADER_CACHE_DIR',
  'MESA_SHADER_CACHE_MAX_SIZE', 'MESA_SHADER_CACHE_DISABLE', 'DXVK_STATE_CACHE_PATH'];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }; for (const key of keys) delete env[key]; return { ...env, ...extra };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-shader-cache-')); roots.push(root);
  const wine = path.join(root, "runtime's path/files/bin/wine"), compat = path.join(root, "game's prefix");
  const system = path.join(compat, 'pfx/drive_c/windows/system32');
  await fs.mkdir(path.dirname(wine), { recursive: true }); await fs.mkdir(system, { recursive: true });
  await fs.mkdir(path.join(path.dirname(wine), '../share/default_pfx'), { recursive: true });
  for (const name of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await fs.writeFile(path.join(system, name), 'fixture');
  // The runtime's Proton session is the Play route. Forward its `run` arguments
  // to the exact fixture Wine so the Play environment can be observed.
  await fs.writeFile(path.join(path.dirname(wine), '../../proton'),
    `#!${process.execPath}\nconst {spawnSync}=require('child_process');const args=process.argv.slice(2);if(args[0]==='run')args.shift();const result=spawnSync(${JSON.stringify(wine)},args,{stdio:'inherit'});process.exit(result.status??1);\n`, { mode: 0o700 });
  await fs.writeFile(wine, `#!${process.execPath}\nconst fs=require('fs'),path=require('path');
if(process.env.NEXUS_CACHE_TEST==='persist') {
 const file=path.join(process.env.VKD3D_SHADER_CACHE_PATH,'synthetic-cache');
 const hit=fs.existsSync(file);if(!hit)fs.writeFileSync(file,'synthetic only');console.log(hit?'hit':'miss');
}else console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null]))));\n`, { mode: 0o700 });
  return { root, wine, compat, steam: path.join(root, 'steam'), cache: path.join(compat, 'shadercache') };
}

describe('persistent shader cache', () => {
  it.each([
    ['VKD3D_SHADER_CACHE_PATH', "/custom/path with space's"], ['VKD3D_SHADER_CACHE_PATH', '0'], ['VKD3D_SHADER_CACHE_PATH', ''],
    ['__GL_SHADER_DISK_CACHE_PATH', '/custom/nvidia'], ['__GL_SHADER_DISK_CACHE_PATH', ''],
    ['__GL_SHADER_DISK_CACHE', '0'], ['__GL_SHADER_DISK_CACHE', ''],
    ['__GL_SHADER_DISK_CACHE_SKIP_CLEANUP', '0'], ['__GL_SHADER_DISK_CACHE_SKIP_CLEANUP', '1'],
    ['__GL_SHADER_DISK_CACHE_SIZE', '123456'], ['MESA_SHADER_CACHE_DIR', '/custom/mesa'], ['MESA_SHADER_CACHE_DIR', ''],
    ['MESA_SHADER_CACHE_MAX_SIZE', '512M'], ['MESA_SHADER_CACHE_MAX_SIZE', ''], ['MESA_SHADER_CACHE_DISABLE', 'true'],
    ['DXVK_STATE_CACHE_PATH', '/user/legacy-dxvk'],
  ])('preserves each explicit setting independently: %s=%j', async (key, value) => {
    const f = await fixture(), runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    const result = await execFile(runner.command, [], { env: environment({ [key]: value }) });
    expect(JSON.parse(result.stdout)[key]).toBe(value);
  });

  it('has finite driver cache defaults without forcing cleanup off', async () => {
    const f = await fixture(), runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    const result = JSON.parse((await execFile(runner.command, [], { env: environment() })).stdout);
    expect(result).toMatchObject({ VKD3D_SHADER_CACHE_PATH: path.join(f.cache, 'vkd3d-proton'),
      __GL_SHADER_DISK_CACHE_PATH: path.join(f.cache, 'nvidia'), __GL_SHADER_DISK_CACHE: '1',
      __GL_SHADER_DISK_CACHE_SKIP_CLEANUP: null, __GL_SHADER_DISK_CACHE_SIZE: '4294967296',
      MESA_SHADER_CACHE_DIR: path.join(f.cache, 'mesa'), MESA_SHADER_CACHE_MAX_SIZE: '4G' });
  });

  it.each([[0.25,'268435456','256M'],[2.5,'2684354560','2560M'],[8,'8589934592','8G']])('applies the chosen %s GiB limit to real driver environments',async(gib,bytes,mesa)=>{
    const f=await fixture(),runner=(await prepareProtonRunner(f.wine,f.compat,f.steam,Number(gib)))!;
    const result=JSON.parse((await execFile(runner.command,[],{env:environment()})).stdout);
    expect(result.__GL_SHADER_DISK_CACHE_SIZE).toBe(bytes);expect(result.MESA_SHADER_CACHE_MAX_SIZE).toBe(mesa);
    const override=JSON.parse((await execFile(runner.command,[],{env:environment({__GL_SHADER_DISK_CACHE_SIZE:'123',MESA_SHADER_CACHE_MAX_SIZE:'512M'})})).stdout);
    expect(override.__GL_SHADER_DISK_CACHE_SIZE).toBe('123');expect(override.MESA_SHADER_CACHE_MAX_SIZE).toBe('512M');
  });

  it('does not impose managed enable/size defaults on custom driver directories', async () => {
    const f = await fixture(), runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    const result = JSON.parse((await execFile(runner.command, [], { env: environment({ __GL_SHADER_DISK_CACHE_PATH: '/external/nvidia', MESA_SHADER_CACHE_DIR: '/external/mesa' }) })).stdout);
    expect(result).toMatchObject({ __GL_SHADER_DISK_CACHE: null, __GL_SHADER_DISK_CACHE_SIZE: null,
      __GL_SHADER_DISK_CACHE_SKIP_CLEANUP: null, MESA_SHADER_CACHE_MAX_SIZE: null });
  });

  it.each(['shadercache', 'shadercache/vkd3d-proton', 'shadercache/nvidia', 'shadercache/mesa', 'shadercache/steamapp'])('refuses a managed cache symlink: %s', async relative => {
    const f = await fixture(), outside = path.join(f.root, 'outside');
    await fs.mkdir(outside, { mode: 0o755 }); await fs.writeFile(path.join(outside, 'keep'), 'unchanged');
    const link = path.join(f.compat, relative); await fs.mkdir(path.dirname(link), { recursive: true }); await fs.symlink(outside, link);
    await expect(prepareProtonRunner(f.wine, f.compat, f.steam)).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual(['keep']);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('unchanged');
  });

  it.each(['shadercache', 'shadercache/mesa'])('fails clearly for a non-directory cache without replacing files: %s', async relative => {
    const f = await fixture(), file = path.join(f.compat, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'keep');
    await expect(prepareProtonRunner(f.wine, f.compat, f.steam)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('keep');
  });

  it('repairs only owned directory permissions, preserving cached bytes and file modes', async () => {
    const f = await fixture();
    for (const name of ['', 'vkd3d-proton', 'nvidia', 'mesa', 'steamapp']) { const dir = path.join(f.cache, name); await fs.mkdir(dir, { recursive: true }); await fs.chmod(dir, 0o777); }
    const cached = path.join(f.cache, 'mesa/cache'); await fs.writeFile(cached, 'warm', { mode: 0o640 });
    await prepareProtonRunner(f.wine, f.compat, f.steam);
    for (const name of ['', 'vkd3d-proton', 'nvidia', 'mesa', 'steamapp']) expect((await fs.stat(path.join(f.cache, name))).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(cached, 'utf8')).toBe('warm'); expect((await fs.stat(cached)).mode & 0o777).toBe(0o640);
  });

  it('does not change the process umask and supports concurrent cache preparation', async () => {
    const f = await fixture(), mask = process.umask();
    const results = await Promise.all([prepareShaderCache(f.compat), prepareShaderCache(f.compat)]);
    expect(results[0]).toEqual(results[1]); expect(process.umask()).toBe(mask);
    for (const directory of Object.values(results[0])) expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('refuses a different owner before creating cache entries', async () => {
    const f = await fixture();
    vi.spyOn(process, 'geteuid').mockReturnValue(process.geteuid!() + 1);
    await expect(prepareShaderCache(f.compat)).rejects.toThrow('owned by the current user');
    await expect(fs.access(f.cache)).rejects.toThrow();
  });

  it('rejects a relative prefix without creating directories', async () => {
    await expect(prepareShaderCache('relative-prefix')).rejects.toThrow('absolute');
  });

  it('rejects a prefix symlink without changing its target', async () => {
    const f = await fixture(), link = path.join(f.root, 'prefix-link'); await fs.symlink(f.compat, link);
    await expect(prepareShaderCache(link)).rejects.toThrow();
    await expect(fs.access(f.cache)).rejects.toThrow();
  });

  it.each(['prefix', 'cache'])('does not follow a parent replaced during directory creation: %s', async replaced => {
    const f = await fixture(), outside = path.join(f.root, 'outside'); await fs.mkdir(outside, { mode: 0o755 });
    const mkdir = fs.mkdir.bind(fs); let swapped = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (directory, options) => {
      const target = String(directory);
      if (!swapped && target.startsWith('/proc/self/fd/') && target.endsWith(replaced === 'prefix' ? '/shadercache' : '/vkd3d-proton')) {
        swapped = true;
        const current = replaced === 'prefix' ? f.compat : f.cache;
        await fs.rename(current, current + '-preserved'); await fs.symlink(outside, current);
      }
      return mkdir(directory, options as { recursive: true });
    });
    await expect(prepareShaderCache(f.compat)).rejects.toThrow('changed');
    expect(swapped).toBe(true); expect(await fs.readdir(outside)).toEqual([]);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
  });

  it('propagates cache IO errors instead of silently using an ephemeral directory', async () => {
    const f = await fixture();
    vi.spyOn(fs, 'mkdir').mockRejectedValue(Object.assign(Error('read-only cache'), { code: 'EROFS' }));
    await expect(prepareShaderCache(f.compat)).rejects.toThrow('read-only cache');
    await expect(fs.access(f.cache)).rejects.toThrow();
  });

  it('quotes cache paths containing shell metacharacters and newlines literally', async () => {
    const f = await fixture(), special = path.join(f.root, 'prefix "quoted"; $(false)\nnext');
    await fs.rename(f.compat, special); f.compat = special;
    const runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    const result = JSON.parse((await execFile(runner.command, [], { env: environment() })).stdout);
    expect(result.VKD3D_SHADER_CACHE_PATH).toBe(path.join(special, 'shadercache/vkd3d-proton'));
  });

  it('reuses the same cache after a temporary launch view is deleted and keeps games separate', async () => {
    const f = await fixture(), a = path.join(f.root, 'temporary-view-a'), b = path.join(f.root, 'temporary-view-b');
    await fs.mkdir(a); await fs.mkdir(b);
    const first = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    expect((await execFile(first.command, [], { cwd: a, env: environment({ NEXUS_CACHE_TEST: 'persist' }) })).stdout.trim()).toBe('miss');
    await fs.rm(a, { recursive: true });
    const second = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    expect((await execFile(second.command, [], { cwd: b, env: environment({ NEXUS_CACHE_TEST: 'persist' }) })).stdout.trim()).toBe('hit');
    const other = await fixture(), otherRunner = (await prepareProtonRunner(other.wine, other.compat, other.steam))!;
    expect((await execFile(otherRunner.command, [], { cwd: b, env: environment({ NEXUS_CACHE_TEST: 'persist' }) })).stdout.trim()).toBe('miss');
    expect(await fs.readdir(b)).toEqual([]);
  });

  it('preserves per-game wrapper overrides without applying them to setup or Stop', async () => {
    const f = await fixture();
    const runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    const tools = await prepareGameWrapper(runner.launchCommand, { ...defaultLaunchTools,
      launchOptions: 'VKD3D_SHADER_CACHE_PATH="/user/cache with spaces" __GL_SHADER_DISK_CACHE=0 MESA_SHADER_CACHE_MAX_SIZE=512M %command%' }, path.join(f.root, 'wrappers'), environment());
    const setup = JSON.parse((await execFile(runner.command, [], { env: environment() })).stdout);
    expect(setup.VKD3D_SHADER_CACHE_PATH).toBe(path.join(f.cache, 'vkd3d-proton'));
    const game = JSON.parse((await execFile(tools.command, [], { env: environment() })).stdout);
    expect(game).toMatchObject({ VKD3D_SHADER_CACHE_PATH: '/user/cache with spaces', __GL_SHADER_DISK_CACHE: '0', MESA_SHADER_CACHE_MAX_SIZE: '512M' });
    const server = path.join(path.dirname(f.wine), 'wineserver'); await fs.writeFile(server, '#!/bin/sh\n[ "$1" = -k ]\n', { mode: 0o700 });
    await execFile(runner.command, ['--nexus-stop-prefix'], { env: environment({ NEXUS_CACHE_TEST: 'persist' }) });
    await expect(fs.access(path.join(f.cache, 'vkd3d-proton/synthetic-cache'))).rejects.toThrow(); await tools.cleanup();
  });
});

// PROTON_LOCAL_SHADER_CACHE is Proton's own per-game shader cache switch. The
// runtime only reaches it through STEAM_COMPAT_SHADER_PATH, so this fixture
// implements the documented upstream rule: on the `run` verb the session creates
// the per-game cache directories and exports their variables with setdefault.
// Any driver cache Nexus already exported therefore keeps its value.
describe('Proton local shader cache through the Play command', () => {
  const localKeys = ['STEAM_COMPAT_SHADER_PATH', 'DXVK_STATE_CACHE_PATH', 'AMD_VK_PIPELINE_CACHE_PATH',
    'VKD3D_SHADER_CACHE_PATH', 'MESA_SHADER_CACHE_DIR', 'MESA_SHADER_CACHE_MAX_SIZE',
    '__GL_SHADER_DISK_CACHE_PATH', '__GL_SHADER_DISK_CACHE_SIZE'];
  async function localFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-proton-local-cache-')); roots.push(root);
    const files = path.join(root, "runtime's files", 'files');
    const wine = path.join(files, 'bin/wine'), proton = path.join(files, '..', 'proton');
    const compat = path.join(root, 'compat'), system = path.join(compat, 'pfx/drive_c/windows/system32');
    await fs.mkdir(path.dirname(wine), { recursive: true });
    await fs.mkdir(path.join(files, 'share/default_pfx'), { recursive: true });
    await fs.mkdir(system, { recursive: true });
    for (const name of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await fs.writeFile(path.join(system, name), 'fixture');
    await fs.writeFile(proton, `#!${process.execPath}
const {spawnSync}=require('child_process');const fs=require('fs');
const args=process.argv.slice(2);
const nonzero=value=>value!==undefined&&value.length>0&&value!=='0';
if(args[0]==='run'){
 args.shift();
 if(nonzero(process.env.PROTON_LOCAL_SHADER_CACHE)&&process.env.STEAM_COMPAT_SHADER_PATH){
  const base=process.env.STEAM_COMPAT_SHADER_PATH;
  const vars={__GL_SHADER_DISK_CACHE_APP_NAME:'steamapp_shader_cache',__GL_SHADER_DISK_CACHE_PATH:base+'/nvidiav1',
   __GL_SHADER_DISK_CACHE_SIZE:'10737418240',MESA_SHADER_CACHE_DIR:base,MESA_SHADER_CACHE_MAX_SIZE:'10G',
   AMD_VK_PIPELINE_CACHE_PATH:base+'/AMDv1',DXVK_STATE_CACHE_PATH:base+'/DXVK_state_cache',
   VKD3D_SHADER_CACHE_PATH:base+'/VKD3D_shader_cache'};
  for(const name of ['__GL_SHADER_DISK_CACHE_PATH','MESA_SHADER_CACHE_DIR','AMD_VK_PIPELINE_CACHE_PATH','DXVK_STATE_CACHE_PATH','VKD3D_SHADER_CACHE_PATH'])fs.mkdirSync(vars[name],{recursive:true});
  for(const [name,value] of Object.entries(vars))if(!(name in process.env))process.env[name]=value;
 }
}
const result=spawnSync(${JSON.stringify(wine)},args,{stdio:'inherit'});process.exit(result.status??1);
`, { mode: 0o700 });
    await fs.writeFile(wine, `#!${process.execPath}
console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(localKeys)}.map(k=>[k,process.env[k]??null]))));
`, { mode: 0o700 });
    return { root, wine, compat, steam: path.join(root, 'steam'), cache: path.join(compat, 'shadercache') };
  }
  function localEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env = environment();
    delete env.STEAM_COMPAT_SHADER_PATH; delete env.PROTON_LOCAL_SHADER_CACHE;
    return { ...env, ...extra };
  }

  it('maps PROTON_LOCAL_SHADER_CACHE to the managed per-prefix cache and keeps the driver caches', async () => {
    const f = await localFixture(), runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    const launchScript = await fs.readFile(runner.launchCommand, 'utf8');
    expect(launchScript).toContain(`export STEAM_COMPAT_SHADER_PATH='${path.join(f.cache, 'steamapp')}'`);
    // Internal prefix work and Stop never enter the Proton session.
    expect(await fs.readFile(runner.command, 'utf8')).not.toContain('STEAM_COMPAT_SHADER_PATH');
    // The variable is inert until the game requests the local cache.
    const off = JSON.parse((await execFile(runner.launchCommand, [], { env: localEnvironment() })).stdout);
    expect(off.STEAM_COMPAT_SHADER_PATH).toBe(path.join(f.cache, 'steamapp'));
    expect(off.DXVK_STATE_CACHE_PATH).toBeNull();
    expect(off.AMD_VK_PIPELINE_CACHE_PATH).toBeNull();
    await expect(fs.access(path.join(f.cache, 'steamapp/DXVK_state_cache'))).rejects.toThrow();
    const setup = JSON.parse((await execFile(runner.command, [], { env: localEnvironment() })).stdout);
    expect(setup.STEAM_COMPAT_SHADER_PATH).toBeNull();
    await expect(fs.access(path.join(f.cache, 'steamapp/AMDv1'))).rejects.toThrow();
    // The real user path: the request arrives through the game's launch options.
    const tools = await prepareGameWrapper(runner.launchCommand, { ...defaultLaunchTools,
      launchOptions: 'PROTON_LOCAL_SHADER_CACHE=1 %command%' }, path.join(f.root, 'wrappers'), localEnvironment());
    const on = JSON.parse((await execFile(tools.command, ['game.exe'], { env: localEnvironment() })).stdout);
    expect(on.DXVK_STATE_CACHE_PATH).toBe(path.join(f.cache, 'steamapp/DXVK_state_cache'));
    expect(on.AMD_VK_PIPELINE_CACHE_PATH).toBe(path.join(f.cache, 'steamapp/AMDv1'));
    for (const name of ['nvidiav1', 'AMDv1', 'DXVK_state_cache', 'VKD3D_shader_cache']) expect((await fs.stat(path.join(f.cache, 'steamapp', name))).isDirectory()).toBe(true);
    // Proton only setdefaults these, so the managed caches of the prefix win.
    expect(on.__GL_SHADER_DISK_CACHE_PATH).toBe(path.join(f.cache, 'nvidia'));
    expect(on.__GL_SHADER_DISK_CACHE_SIZE).toBe('4294967296');
    expect(on.VKD3D_SHADER_CACHE_PATH).toBe(path.join(f.cache, 'vkd3d-proton'));
    expect(on.MESA_SHADER_CACHE_DIR).toBe(path.join(f.cache, 'mesa'));
    expect(on.MESA_SHADER_CACHE_MAX_SIZE).toBe('4G');
    await tools.cleanup();
  });

  it('keeps an explicit disabled request from enabling the local cache', async () => {
    const f = await localFixture(), runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    for (const value of ['0', '']) {
      const result = JSON.parse((await execFile(runner.launchCommand, [], { env: localEnvironment({ PROTON_LOCAL_SHADER_CACHE: value }) })).stdout);
      expect(result.DXVK_STATE_CACHE_PATH).toBeNull();
      expect(result.AMD_VK_PIPELINE_CACHE_PATH).toBeNull();
    }
    await expect(fs.access(path.join(f.cache, 'steamapp/DXVK_state_cache'))).rejects.toThrow();
  });
});

// Deep optional check: the pinned protonfixes source itself consumes the
// environment the Play command exports. It needs no Wine or Proton binary and is
// skipped unless the module checkout is provided. Environment contract:
//   XODUS_PROTONFIXES_SOURCE=/path/to/the/protonfixes/module
//                      (the directory that directly contains utilities.py)
// Only the `setup_local_shader_cache` function is extracted and executed, so the
// package is never imported (no __init__, protonfixes helpers, upscalers or
// network), and nothing is written into the checkout.
const protonfixesSource = process.env.XODUS_PROTONFIXES_SOURCE;
describe.skipIf(!protonfixesSource)('pinned protonfixes local shader cache', () => {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const keys = ['STEAM_COMPAT_SHADER_PATH', 'DXVK_STATE_CACHE_PATH', 'AMD_VK_PIPELINE_CACHE_PATH',
    'VKD3D_SHADER_CACHE_PATH', 'MESA_SHADER_CACHE_DIR', 'MESA_SHADER_CACHE_MAX_SIZE',
    '__GL_SHADER_DISK_CACHE_PATH', '__GL_SHADER_DISK_CACHE_SIZE'];
  async function pinnedFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-protonfixes-source-')); roots.push(root);
    const files = path.join(root, 'runtime', 'files');
    const wine = path.join(files, 'bin/wine'), proton = path.join(root, 'runtime', 'proton');
    const compat = path.join(root, 'compat'), system = path.join(compat, 'pfx/drive_c/windows/system32');
    const probe = path.join(root, 'probe.py'), envOut = path.join(root, 'environment.json');
    await fs.mkdir(path.dirname(wine), { recursive: true });
    await fs.mkdir(path.join(files, 'share/default_pfx'), { recursive: true });
    await fs.mkdir(system, { recursive: true });
    for (const name of ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll']) await fs.writeFile(path.join(system, name), 'fixture');
    // Only the pinned function is compiled and run. The package (and its
    // __init__, helpers and upscalers) is never imported, so no import side
    // effect or bytecode write can occur in the checkout.
    await fs.writeFile(probe, `import ast, json, os, subprocess, sys
source = os.path.join(${JSON.stringify(protonfixesSource)}, 'utilities.py')
with open(source, encoding='utf-8') as handle:
    tree = ast.parse(handle.read(), filename=source)
found = [node for node in tree.body
         if isinstance(node, ast.FunctionDef) and node.name == 'setup_local_shader_cache']
if len(found) != 1:
    raise SystemExit(f'expected exactly one setup_local_shader_cache, found {len(found)}')
namespace = {'os': os}
exec(compile(ast.Module(body=[found[0]], type_ignores=[]), source, 'exec'), namespace)
# Mirrors the pinned session for the run verb: check_environment() records the
# compat option, then the utility receives the process environment.
config = set()
value = os.environ.get("PROTON_LOCAL_SHADER_CACHE", "")
if len(value) > 0 and value != "0":
    config.add("localshadercache")
namespace['setup_local_shader_cache'](config, os.environ)
sys.exit(subprocess.call([sys.argv[1]] + sys.argv[2:], env=os.environ))
`);
    await fs.writeFile(proton, `#!/bin/sh\n[ "$1" = run ] || exec ${quote(wine)} "$@"\nshift\nexec python3 ${quote(probe)} ${quote(wine)} "$@"\n`, { mode: 0o700 });
    await fs.writeFile(wine, `#!${process.execPath}
const fs=require('fs');
fs.writeFileSync(process.env.ENV_OUT,JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null]))));
`, { mode: 0o700 });
    return { root, wine, compat, steam: path.join(root, 'steam'), cache: path.join(compat, 'shadercache'), envOut };
  }
  function pinnedEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of [...keys, 'PROTON_LOCAL_SHADER_CACHE', 'DXVK_HUD', 'MESA_SHADER_CACHE_DISABLE']) delete env[key];
    return { ...env, ...extra };
  }

  it('uses the exported shader path for its per-game caches and keeps the managed driver caches', async () => {
    const f = await pinnedFixture(), runner = (await prepareProtonRunner(f.wine, f.compat, f.steam))!;
    await execFile(runner.launchCommand, ['game.exe'],
      { env: pinnedEnvironment({ PROTON_LOCAL_SHADER_CACHE: '1', ENV_OUT: f.envOut, PYTHONDONTWRITEBYTECODE: '1' }) });
    const on = JSON.parse(await fs.readFile(f.envOut, 'utf8'));
    expect(on.DXVK_STATE_CACHE_PATH).toBe(path.join(f.cache, 'steamapp/DXVK_state_cache'));
    expect(on.AMD_VK_PIPELINE_CACHE_PATH).toBe(path.join(f.cache, 'steamapp/AMDv1'));
    // The upstream helper only setdefaults these, so the managed values win.
    expect(on.__GL_SHADER_DISK_CACHE_PATH).toBe(path.join(f.cache, 'nvidia'));
    expect(on.__GL_SHADER_DISK_CACHE_SIZE).toBe('4294967296');
    expect(on.VKD3D_SHADER_CACHE_PATH).toBe(path.join(f.cache, 'vkd3d-proton'));
    expect(on.MESA_SHADER_CACHE_DIR).toBe(path.join(f.cache, 'mesa'));
    expect(on.MESA_SHADER_CACHE_MAX_SIZE).toBe('4G');
    for (const name of ['nvidiav1', 'AMDv1', 'DXVK_state_cache', 'VKD3D_shader_cache']) expect((await fs.stat(path.join(f.cache, 'steamapp', name))).isDirectory()).toBe(true);
    // An unrequested local cache keeps the prefix free of Proton-owned state.
    await fs.rm(path.join(f.cache, 'steamapp'), { recursive: true, force: true });
    await fs.mkdir(path.join(f.cache, 'steamapp'), { mode: 0o700 });
    await execFile(runner.launchCommand, ['game.exe'], { env: pinnedEnvironment({ ENV_OUT: f.envOut, PYTHONDONTWRITEBYTECODE: '1' }) });
    const off = JSON.parse(await fs.readFile(f.envOut, 'utf8'));
    expect(off.STEAM_COMPAT_SHADER_PATH).toBe(path.join(f.cache, 'steamapp'));
    expect(off.DXVK_STATE_CACHE_PATH).toBeNull();
    expect(off.AMD_VK_PIPELINE_CACHE_PATH).toBeNull();
    expect(await fs.readdir(path.join(f.cache, 'steamapp'))).toEqual([]);
  });
});
