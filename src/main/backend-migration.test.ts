import {describe,it,expect,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BACKEND_REPOSITORY as fork,LEGACY_BACKEND_REPOSITORY as legacy,backendPackageName,minimumBackendVersion} from './backend-package.js';
import {discoverBackend,installBackend} from './backend-releases.js';
import {currentArch} from './arch.js';
const sha='a'.repeat(128);
const assetUrl=(repo:string,version:string,suffix:string)=>`https://github.com/${repo}/releases/download/backend-v${version}/${backendPackageName(version)}${suffix}`;
const release=(repo:string,version:string)=>({tag_name:`backend-v${version}`,assets:['.tar.xz','.manifest.json','.sha512sum','-source.tar.xz','-source.sha512sum']
  .map(suffix=>({name:backendPackageName(version)+suffix,browser_download_url:assetUrl(repo,version,suffix)}))});
const manifest=(repo:string,version:string)=>({schema:repo===fork?2:1,...(repo===fork?{sourceRepository:fork}:{}),authUi:'electron',version,
  commit:'b'.repeat(40),recipeSha256:'c'.repeat(64),compatibility:'linux-run-v25',platform:'linux',arch:currentArch(),
  archive:backendPackageName(version)+'.tar.xz',archiveSha512:sha,files:Object.fromEntries(['LICENSE','xodus-cli','xodus-service'].map(name=>[name,'d'.repeat(64)]))});
function fixture(forkVersion:string|number|null,legacyVersion:string|null,override:Record<string,unknown>={}) {
  return vi.fn(async(input:URL|RequestInfo)=>{
    const url=String(input);
    const repo=url.includes(fork)?fork:legacy;
    const version=repo===fork?forkVersion:legacyVersion;
    if(url.includes('/releases?')) return typeof version==='number'?new Response('',{status:version}):new Response(JSON.stringify(version?[release(repo,version)]:[]));
    if(typeof version!=='string')throw Error('unexpected fixture download');
    if(url.endsWith('.manifest.json'))return new Response(JSON.stringify({...manifest(repo,version),...override}));
    if(url.endsWith('.sha512sum'))return new Response(`${sha}  ${backendPackageName(version)}.tar.xz\n`);
    throw Error('unexpected fixture request');
  }) as unknown as typeof fetch;
}
describe('backend repository migration',()=>{
  it.each([null,404])('keeps 0.2.14 installable while the new repository is empty or absent (%s)',async state=>{
    expect(minimumBackendVersion).toBe('0.2.14');
    const artifact=await discoverBackend(fixture(state,'0.2.14'));
    expect(artifact.repository).toBe(legacy);expect(artifact.manifest.version).toBe('0.2.14');
  });
  it.each([['0.2.15','0.2.14',fork],['0.2.15','0.2.15',fork],['0.2.15','0.2.16',legacy]] as const)
    ('selects the highest version across trusted repositories (%s/%s)',async(a,b,winner)=>{
      const artifact=await discoverBackend(fixture(a,b));expect(artifact.repository).toBe(winner);
    });
  it('does not mask rate limits or server errors as an empty fork',async()=>{
    await expect(discoverBackend(fixture(403,'0.2.14'))).rejects.toThrow('HTTP 403');
    await expect(discoverBackend(fixture(503,'0.2.14'))).rejects.toThrow('HTTP 503');
  });
  it.each([{schema:1},{sourceRepository:legacy},{sourceRepository:'attacker/backend'},{archiveSha512:'invalid'}])
    ('does not fall back after a selected fork manifest fails validation: %j',async override=>{
      await expect(discoverBackend(fixture('0.2.15','0.2.14',override))).rejects.toThrow('not a valid compatible release');
    });
  it('rejects cross-repository asset links even when both repositories are trusted',async()=>{
    const fetcher=(async()=>new Response(JSON.stringify([release(legacy,'0.2.15')]))) as typeof fetch;
    await expect(discoverBackend(fetcher)).rejects.toThrow('Unexpected backend release asset URL');
  });
  it('revalidates archive origin before downloading or replacing an installed backend',async()=>{
    const artifact=await discoverBackend(fixture('0.2.15',null));
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'backend-migration-'));
    const fetcher=vi.fn();
    try {
      await fs.writeFile(path.join(root,'current.json'),'previous backend');
      await expect(installBackend(root,{...artifact,archiveUrl:'https://attacker.example/backend.tar.xz'},fetcher,async()=>{},async()=>{},()=>{})).rejects.toThrow('Unexpected');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root,'current.json'),'utf8')).toBe('previous backend');
      expect(await fs.readdir(root)).toEqual(['current.json']);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
});
