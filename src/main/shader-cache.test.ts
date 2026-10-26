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
  await fs.writeFile(path.join(path.dirname(wine), '../../proton'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
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
    const f=await fixture(),runner=(await prepareProtonRunner(f.wine,f.compat,f.steam,f.wine,Number(gib)))!;
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

  it.each(['shadercache', 'shadercache/vkd3d-proton', 'shadercache/nvidia', 'shadercache/mesa'])('refuses a managed cache symlink: %s', async relative => {
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
    for (const name of ['', 'vkd3d-proton', 'nvidia', 'mesa']) { const dir = path.join(f.cache, name); await fs.mkdir(dir, { recursive: true }); await fs.chmod(dir, 0o777); }
    const cached = path.join(f.cache, 'mesa/cache'); await fs.writeFile(cached, 'warm', { mode: 0o640 });
    await prepareProtonRunner(f.wine, f.compat, f.steam);
    for (const name of ['', 'vkd3d-proton', 'nvidia', 'mesa']) expect((await fs.stat(path.join(f.cache, name))).mode & 0o777).toBe(0o700);
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
    const tools = await prepareGameWrapper(f.wine, { ...defaultLaunchTools,
      launchOptions: 'VKD3D_SHADER_CACHE_PATH="/user/cache with spaces" __GL_SHADER_DISK_CACHE=0 MESA_SHADER_CACHE_MAX_SIZE=512M %command%' }, path.join(f.root, 'wrappers'), environment());
    const runner = (await prepareProtonRunner(f.wine, f.compat, f.steam, tools.command))!;
    const setup = JSON.parse((await execFile(runner.command, [], { env: environment() })).stdout);
    expect(setup.VKD3D_SHADER_CACHE_PATH).toBe(path.join(f.cache, 'vkd3d-proton'));
    const game = JSON.parse((await execFile(runner.launchCommand!, [], { env: environment() })).stdout);
    expect(game).toMatchObject({ VKD3D_SHADER_CACHE_PATH: '/user/cache with spaces', __GL_SHADER_DISK_CACHE: '0', MESA_SHADER_CACHE_MAX_SIZE: '512M' });
    const server = path.join(path.dirname(f.wine), 'wineserver'); await fs.writeFile(server, '#!/bin/sh\n[ "$1" = -k ]\n', { mode: 0o700 });
    await execFile(runner.command, ['--nexus-stop-prefix'], { env: environment({ NEXUS_CACHE_TEST: 'persist' }) });
    await expect(fs.access(path.join(f.cache, 'vkd3d-proton/synthetic-cache'))).rejects.toThrow(); await tools.cleanup();
  });
});
