import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ComponentUpdateAdmission } from './component-update-admission.js';
import { LauncherUpdater, launcherCandidate } from './launcher-update.js';
import { APPIMAGE_ARCH_SUFFIX, ELF_MACHINE, currentArch, type NexusArch } from './arch.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function image(marker: number, arch: NexusArch = currentArch()): Buffer {
  const bytes = Buffer.alloc(100, marker); Buffer.from('7f454c46', 'hex').copy(bytes);
  bytes[4] = 2; bytes[5] = 1; Buffer.from('414902', 'hex').copy(bytes, 8); bytes.writeUInt16LE(ELF_MACHINE[arch], 18); return bytes;
}
function release(version = '0.2.3', arch: NexusArch = currentArch(), repo='domsvoboda/xodus-nexus',family='Xodus-Nexus') {
  const name = `${family}-${version}-${APPIMAGE_ARCH_SUFFIX[arch]}.AppImage`;
  return { tag_name: `v${version}`, assets: [
    { name, size: 100, browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}` },
    { name: `${name}.sha512sum`, size: 200, browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}.sha512sum` },
  ] };
}
async function fixture(bad = '', arch: NexusArch = currentArch(),repo='domsvoboda/xodus-nexus',family='Xodus-Nexus') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-update-test-')); roots.push(root);
  const target = path.join(root, 'Launcher.AppImage'); await fs.writeFile(target, image(1,arch), { mode: 0o700 });
  const next = bad === 'format' ? Buffer.alloc(100) : image(2,bad==='architecture'?(arch==='x64'?'arm64':'x64'):arch);
  const r = release('0.2.3',arch,repo,family);
  const fetcher = (async (url: string | URL | Request) => {
    const text = String(url);
    if (text.includes('api.github')) return new Response(JSON.stringify([r]));
    if (text.endsWith('.sha512sum')) return new Response(`${bad === 'checksum' ? '0'.repeat(128) : createHash('sha512').update(next).digest('hex')}  ${r.assets[0].name}\n`);
    if (bad === 'network') throw new Error('Network interrupted');
    return new Response(next);
  }) as typeof fetch;
  const updater = new LauncherUpdater('0.2.2', target, root, () => {}, fetcher, arch);
  await updater.initialize(); await updater.check(); return { root, target, updater, fetcher };
}
describe('AppImage updater', () => {
  it('releases admission and lock when initial notification throws', async () => {
    const {root,target,fetcher}=await fixture();let fail=false;
    const updater=new LauncherUpdater('0.2.2',target,root,()=>{if(fail)throw Error('notify');},fetcher);await updater.initialize();await updater.check();fail=true;
    await expect(updater.install()).rejects.toMatchObject({committed:false});expect(updater.state.updating).toBe(false);expect(await fs.readFile(target)).toEqual(image(1));
    expect((await fs.readdir(root)).some(name=>name.endsWith('.nexus-update.lock'))).toBe(false);fail=false;await updater.install();
  });
  it('clears busy state after postcommit cleanup failure and reports actual replacement', async () => {
    const {root,target,updater}=await fixture();const original=fs.rm;let injected=false;
    vi.spyOn(fs,'rm').mockImplementation(async(p,options)=>{if(!injected&&String(p).includes('.nexus-update-')){injected=true;throw Error('cleanup failed');}return original(p,options);});
    await expect(updater.install()).rejects.toMatchObject({committed:true});expect(updater.state.updating).toBe(false);expect(await fs.readFile(target)).toEqual(image(2));expect(updater.state.restartRequired).toBe(true);
    expect((await fs.readdir(root)).some(name=>name.endsWith('.nexus-update.lock'))).toBe(false);
  });
  it('preserves backup and reports attention if rollback fails after replacement', async () => {
    const {root,target,updater}=await fixture();const write=fs.writeFile,rename=fs.rename;
    vi.spyOn(fs,'writeFile').mockImplementation(async(p,data,options)=>{if(String(p).includes('launcher-update.json.'))throw Error('journal failed');return write(p,data,options);});
    vi.spyOn(fs,'rename').mockImplementation(async(a,b)=>{if(String(a).includes('.nexus-backup-'))throw Error('restore failed');return rename(a,b);});
    await expect(updater.install()).rejects.toMatchObject({committed:true,retryable:false});expect(await fs.readFile(target)).toEqual(image(2));expect(updater.state.updating).toBe(false);
    const backups=(await fs.readdir(root)).filter(name=>name.includes('.nexus-backup-'));expect(backups).toHaveLength(1);expect(await fs.readFile(path.join(root,backups[0]))).toEqual(image(1));
  });
  it('does not remove a consumed journal temporary path after publication', async () => {
    const {updater}=await fixture();const rm=vi.spyOn(fs,'rm');await updater.install();expect(rm.mock.calls.some(([p])=>String(p).includes('launcher-update.json.'))).toBe(false);
  });
  it('rejects concurrent installation before awaited image validation', async () => {
    const {updater}=await fixture();let release!:()=>void;const hold=new Promise<void>(r=>release=r);
    const internal=updater as unknown as {writableImage():Promise<string>};const original=internal.writableImage.bind(updater);vi.spyOn(internal,'writableImage').mockImplementation(async()=>{await hold;return original();});
    const pending=updater.install();const admission=new ComponentUpdateAdmission(()=>{if(updater.busy)throw Error('launcher busy');});expect(()=>admission.reserve()).toThrow('busy');await expect(updater.install()).rejects.toThrow('pending');await expect(updater.rollback()).rejects.toThrow('pending');release();await pending;
  });
  it('reserves rollback before awaited image validation and excludes installation', async () => {
    const {updater}=await fixture();await updater.install();let release!:()=>void;const hold=new Promise<void>(r=>release=r);
    const internal=updater as unknown as {writableImage():Promise<string>};const original=internal.writableImage.bind(updater);vi.spyOn(internal,'writableImage').mockImplementation(async()=>{await hold;return original();});
    const pending=updater.rollback();const admission=new ComponentUpdateAdmission(()=>{if(updater.busy)throw Error('launcher busy');});expect(()=>admission.reserve()).toThrow('busy');await expect(updater.rollback()).rejects.toThrow('pending');await expect(updater.install()).rejects.toThrow('pending');release();await pending;
  });
  it.each(['changed','deleted'])('rejects %s activated bytes during targeted reconciliation',async change=>{
    const {root,target,fetcher}=await fixture();let updater!:LauncherUpdater;
    updater=new LauncherUpdater('0.2.2',target,root,()=>{if(updater.state.restartRequired)throw Error('notify after commit');},fetcher);await updater.initialize();const plan=await updater.prepareComponentUpdate();
    await expect(plan.apply({identity:Symbol()})).rejects.toMatchObject({committed:true});
    if(change==='changed')await fs.writeFile(target,image(7));else await fs.rm(target);
    await expect(plan.reconcile!({identity:Symbol()})).rejects.toMatchObject({retryable:false});
  });
  it('rejects a checksum changed after plan approval without replacing installed bytes',async()=>{
    const {root,target,fetcher}=await fixture();let tamper=false;
    const guarded=(async(input:URL|RequestInfo,options?:RequestInit)=>tamper&&String(input).endsWith('.sha512sum')?new Response('0'.repeat(128)+'  '+release().assets[0].name+'\n'):fetcher(input,options)) as typeof fetch;
    const updater=new LauncherUpdater('0.2.2',target,root,()=>{},guarded);await updater.initialize();const plan=await updater.prepareComponentUpdate();tamper=true;
    await expect(plan.apply({identity:Symbol()})).rejects.toMatchObject({committed:false});expect(await fs.readFile(target)).toEqual(image(1));expect(updater.busy).toBe(false);
  });
  it('rejects a changed installed image from an approved component plan', async () => {
    const {updater,target}=await fixture();const plan=await updater.prepareComponentUpdate();expect(plan.item.state).toBe('ready');await fs.writeFile(target,image(7));expect(await plan.isCurrent()).toBe(false);await expect(plan.apply({identity:Symbol()})).rejects.toThrow('changed');expect(await fs.readFile(target)).toEqual(image(7));
  });
  it('ignores backend/runtime tags and prereleases; uses newest complete stable launcher', () => {
    expect(launcherCandidate([{ ...release('9.0.0'), tag_name: 'backend-v9.0.0' }, { ...release('8.0.0'), prerelease: true }, release('0.2.3'), release('0.2.4')], '0.2.2')?.version).toBe('0.2.4');
    expect(launcherCandidate([release()], '0.2.3')).toBeUndefined();
    const unsafe = release(); unsafe.assets[0].browser_download_url = 'https://evil.example/update';
    expect(launcherCandidate([unsafe], '0.2.2')).toBeUndefined();
  });
  it.each(['x64','arm64'] as const)('atomically installs exact %s bytes and restores the previous launcher without touching settings', async arch => {
    const { root, target, updater, fetcher } = await fixture('',arch);
    await fs.writeFile(path.join(root, 'settings.json'), 'KEEP');
    await updater.install(); expect(await fs.readFile(target)).toEqual(image(2,arch));
    expect(updater.state.restartRequired).toBe(true); expect(updater.state.canRollback).toBe(true);
    const restarted = new LauncherUpdater('0.2.3', target, root, () => {}, fetcher, arch); await restarted.initialize();
    expect(restarted.state.canRollback).toBe(true); await restarted.rollback();
    expect(await fs.readFile(target)).toEqual(image(1,arch)); expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).toBe('KEEP');
  });
  it.each(['checksum', 'network', 'format', 'architecture'])('preserves the installed image on %s failure and removes staging/lock', async bad => {
    const { root, target, updater } = await fixture(bad);
    await expect(updater.install()).rejects.toThrow(); expect(await fs.readFile(target)).toEqual(image(1));
    expect((await fs.readdir(root)).some(name => name.includes('nexus-update') || name.includes('nexus-backup'))).toBe(false);
    expect(updater.state.updating).toBe(false);
  });
  it('selects each native AppImage without a newer release hiding the last matching build',()=>{
    const releases=[release('9.9.9','x64'),release('9.8.0','arm64')];
    expect(launcherCandidate(releases,'0.4.0','arm64')?.version).toBe('9.8.0');
    expect(launcherCandidate(releases,'0.4.0','x64')?.version).toBe('9.9.9');
    expect(launcherCandidate([release('9.9.9','x64')],'0.4.0','arm64')).toBeUndefined();
  });
  it('rejects shared-writable images and keeps manual release download available for development builds', async () => {
    const { root, target, fetcher } = await fixture(); await fs.chmod(target, 0o777);
    const updater = new LauncherUpdater('0.2.2', target, root, () => {}, fetcher); await updater.initialize(); await updater.check();
    expect(updater.state.canInstall).toBe(false); expect(updater.state.releaseUrl).toContain('/releases/tag/v0.2.3');
    await expect(updater.install()).rejects.toThrow('owned');
    const dev = new LauncherUpdater('0.2.2', undefined, root, () => {}, fetcher); await dev.initialize(); expect(dev.state.canInstall).toBe(false);
  });
});

it.each(['domsvoboda/xodus-nexus','domsvoboda/nexus-launcher'])('accepts coherent old/new artifact families only under the exact %s release',repo=>{
 for(const family of ['Xodus-Nexus','Nexus-Launcher'])for(const arch of ['x64','arm64'] as const){
  const r=release('0.5.0',arch,repo,family),candidate=launcherCandidate([r],'0.4.2',arch);
  expect(candidate?.image.name).toBe(`${family}-0.5.0-${APPIMAGE_ARCH_SUFFIX[arch]}.AppImage`);expect(candidate?.releaseUrl).toBe(`https://github.com/${repo}/releases/tag/v0.5.0`);
 }
});
it('rejects cross-repository/tag/family/checksum links, traversal and downgraded releases',()=>{
 for(const url of ['https://evil.example/update','https://github.com/attacker/nexus-launcher/releases/download/v0.5.0/Xodus-Nexus-0.5.0-x86_64.AppImage','https://github.com/domsvoboda/nexus-launcher/releases/download/v0.5.0/Xodus-Nexus-0.5.0-x86_64.AppImage','https://github.com/domsvoboda/xodus-nexus/releases/download/v0.5.0/../Xodus-Nexus-0.5.0-x86_64.AppImage']){
  const r=release('0.5.0','x64');r.assets[0].browser_download_url=url;expect(launcherCandidate([r],'0.4.2','x64')).toBeUndefined();
 }
 for(const change of ['tag','family','duplicate']){
  const r=release('0.5.0','x64');
  if(change==='tag')r.assets[1].browser_download_url=r.assets[1].browser_download_url.replace('v0.5.0','v0.5.1');
  if(change==='family')r.assets[1].name=r.assets[1].name.replace('Xodus-Nexus','Nexus-Launcher');
  if(change==='duplicate')r.assets.push({...r.assets[1]});
  expect(launcherCandidate([r],'0.4.2','x64')).toBeUndefined();
 }
 expect(launcherCandidate([release('0.4.1')],'0.4.2')).toBeUndefined();
});
it('installs verified renamed-repository bytes in the existing AppImage path without moving state',async()=>{
 const {root,target,updater}=await fixture('',currentArch(),'domsvoboda/nexus-launcher','Nexus-Launcher');
 await fs.writeFile(root+'/launcher-state.json','old state');await updater.install();expect(await fs.readFile(target)).toEqual(image(2));expect(await fs.readFile(root+'/launcher-state.json','utf8')).toBe('old state');
});
