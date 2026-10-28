import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BackendManager } from './backend.js';
import { backendLock, backendRecipeSha256, backendPackageName, validateBackendManifest, validateBackendArchive } from './backend-package.js';
import { discoverBackend } from './backend-releases.js';
import { BACKEND_ARCH_SUFFIX, ELF_MACHINE, currentArch } from './arch.js';
import { run } from './process.js';

vi.mock('./process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./process.js')>();
  return { ...actual, run: vi.fn(async (cmd: string, args: string[], options: object) => {
    if (cmd.endsWith('/xodus-cli')) {
      const marker = (await fs.readFile(cmd))[63];
      if (marker === 7) return {code:127,output:'/private/path/xodus-cli: error while loading shared libraries: libdbus-1.so.3: cannot open shared object file: No such file or directory\n'};
      // 8: an earlier offline backend that cannot revoke stored licenses; 9: the current one.
      if ([8, 9].includes(marker) && args[0] === 'run') return { code: 0, output: '--materialize-chain\n--license-cache <LICENSE_CACHE>\n--offline\n' };
      if ([8, 9].includes(marker) && args[0] === 'offline-pc') return { code: 0, output: marker === 9 ? '--set <SET>\n--confirm\n--license-cache <LICENSE_CACHE>\n' : '--set <SET>\n--confirm\n' };
      if (args[0] === 'resolve-package') return { code:0,output: marker === 6 ? '--include-dlc\n' : '--json\n--market\n' };
      return { code: 0, output: args[0] === 'streaming' ? '--selected-content-id\n' + ([3,5].includes(marker) ? '--progress-json\n--control-stdin\n' : '') + (marker === 3 ? '--download-limit-kib\n' : '') + (marker === 8 ? 'Nexus capabilities: update-recovery-v1\n' : '') : args[0] === 'run' ? (marker === 2 ? '--unsupported' : '--materialize-chain') :
        (marker === 1 ? 'xodus-cli 0.1.0\n  login    Login\n  streaming    Streaming\n' :
        'xodus-cli 0.1.0\n  account    Account\n  login    Login\n  logout    Logout\n  download    Download\n  streaming    Streaming\n  run    Run\n  resolve-package    Resolve packages\n' + ([8, 9].includes(marker) ? '  offline-pc    Offline PC\n' : '') + (marker === 4 ? '' : '\nOptions:\n  --external-webview-stdio  External UI\n')) };
    }
    if (cmd.endsWith('/xodus-service')) throw new Error('Service must never be started by installer tests');
    if (['git', 'cargo', 'rustc', 'protoc'].includes(cmd)) return { code: 1, output: 'Build tool intentionally absent' };
    if (cmd === 'ps') return { code: 0, output: '' };
    return actual.run(cmd, args, options);
  }) };
});
const sha = (data: Buffer, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const tag = `backend-v${backendLock.version}`;
const url = (name: string) => `https://github.com/domsvoboda/xodus-nexus/releases/download/${tag}/${name}`;
const elf = () => { const bytes = Buffer.alloc(64); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(ELF_MACHINE[currentArch()], 18); return bytes; };

describe('prebuilt backend', () => {
  it.each([false, true])('requires the real update-recovery capability rather than progress support: %s', async supported => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-update-caps-'));
    try {
      const cli = path.join(root, 'target/release/xodus-cli'); await fs.mkdir(path.dirname(cli), { recursive: true });
      const bytes = elf(); bytes[63] = supported ? 8 : 3; await fs.writeFile(cli, bytes, { mode: 0o755 });
      const status = await new BackendManager(root, root, () => {}, () => false).refresh();
      expect(status.capabilities.streamingUpdateRecovery).toBe(supported);
      if (!supported) expect(status.capabilities.streamingControls).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('reports a missing loader dependency instead of hiding it behind offline status (#328)',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-backend-loader-'));
    try{
      const cli=path.join(root,'broken','xodus-cli');await fs.mkdir(path.dirname(cli),{recursive:true});
      const bytes=elf();bytes[63]=7;await fs.writeFile(cli,bytes,{mode:0o755});
      await fs.mkdir(path.join(root,'xodus-backends'));
      const pointer=JSON.stringify({binaryPath:cli});await fs.writeFile(path.join(root,'xodus-backends/current.json'),pointer);
      const name=backendPackageName(backendLock.version),archive=name+'.tar.xz';
      const manifest={schema:1,authUi:'electron',version:backendLock.version,commit:backendLock.commit,
        recipeSha256:backendRecipeSha256,compatibility:backendLock.compatibility,platform:'linux',arch:currentArch(),archive,
        archiveSha512:'a'.repeat(128),files:{LICENSE:'b'.repeat(64),'xodus-cli':'c'.repeat(64),'xodus-service':'d'.repeat(64)}};
      const fetcher=vi.fn(async(input:URL|RequestInfo)=>{
        const target=String(input);
        if(target.includes('/releases?'))return new Response(JSON.stringify([{tag_name:tag,assets:[archive,name+'.manifest.json',name+'.sha512sum',name+'-source.tar.xz',name+'-source.sha512sum'].map(asset=>({name:asset,browser_download_url:url(asset)}))}]));
        if(target.endsWith('.manifest.json'))return new Response(JSON.stringify(manifest));
        if(target.endsWith('.sha512sum'))return new Response(manifest.archiveSha512+'  '+archive+'\n');
        throw Error('Unexpected download during release check');
      }) as unknown as typeof fetch;
      const manager=new BackendManager(root,'',()=>{},()=>false,fetcher);
      const status=await manager.refresh();expect(status.available).toBe(false);
      expect(status.blockReason).toContain('D-Bus runtime library is missing');
      expect(status.blockReason).not.toContain('/private');expect(status.capabilities.login).toBe(false);
      expect(await fs.readFile(path.join(root,'xodus-backends/current.json'),'utf8')).toBe(pointer);
      // A successful release check must not erase why the installed backend
      // cannot start. It also must not activate or download anything by itself.
      const checked=await manager.checkUpdate();expect(checked.available).toBe(false);expect(checked.releaseAvailable).toBe(true);
      expect(checked.blockReason).toContain('D-Bus runtime library is missing');
      bytes[63]=0;await fs.writeFile(cli,bytes);
      const recovered=await manager.refresh();expect(recovered.available).toBe(true);expect(recovered.blockReason).toBeUndefined();
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
  it.each([false,true])('only enables Durable selection when the real subcommand advertises it: %s',async supported=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-content-cap-'));
    try{const cli=path.join(root,'target/release/xodus-cli');await fs.mkdir(path.dirname(cli),{recursive:true});
      const bytes=elf();if(supported)bytes[63]=6;await fs.writeFile(cli,bytes,{mode:0o755});
      const status=await new BackendManager(root,root,()=>{},()=>false).refresh();
      expect(status.capabilities.contentPackageSelection).toBe(supported);
      expect(status.capabilities.packageSelection).toBe(true);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
  it.each([[8, false], [9, true]])('keeps offline licenses only with a backend that also revokes them (marker %s)', async (marker, supported) => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-license-cache-cap-'));
    try{const cli=path.join(root,'target/release/xodus-cli');await fs.mkdir(path.dirname(cli),{recursive:true});
      const bytes=elf();bytes[63]=marker;await fs.writeFile(cli,bytes,{mode:0o755});
      const status=await new BackendManager(root,root,()=>{},()=>false).refresh();
      expect(status.capabilities.offlinePc).toBe(true);
      expect(status.capabilities.licenseCache).toBe(supported);
      expect(status.capabilities.offlineLaunch).toBe(supported);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
  it.each([false, true])('detects structured progress and controls from actual subcommand help: %s', async supported => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-progress-caps-'));
    try {
      const cli = path.join(root, 'target', 'release', 'xodus-cli');
      await fs.mkdir(path.dirname(cli), { recursive: true });
      const bytes = elf(); if (supported) bytes[63] = 3;
      await fs.writeFile(cli, bytes, { mode: 0o755 });
      const manager = new BackendManager(root, root, () => {}, () => false);
      const status = await manager.refresh();
      expect(status.capabilities.streamingProgressJson).toBe(supported);
      expect(status.capabilities.streamingControls).toBe(supported);
      expect(status.capabilities.streamingBandwidthLimit).toBe(supported);
      expect(status.capabilities.packageSelection).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('does not infer bandwidth limiting from pause/resume support alone', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-limit-cap-'));
    try {
      const cli=path.join(root,'target','release','xodus-cli');await fs.mkdir(path.dirname(cli),{recursive:true});
      const bytes=elf();bytes[63]=5;await fs.writeFile(cli,bytes,{mode:0o755});
      const status=await new BackendManager(root,root,()=>{},()=>false).refresh();
      expect(status.capabilities.streamingControls).toBe(true);expect(status.capabilities.streamingBandwidthLimit).toBe(false);
    } finally {await fs.rm(root,{recursive:true,force:true});}
  });
  it.each(['valid', 'archive-digest', 'recipe', 'binary-digest', 'symlink', 'hardlink', 'missing-service', 'bad-elf', 'bad-service-elf', 'missing-capability', 'missing-auth-ui', 'missing-launch-chain', 'missing-system-library', 'busy-after-download'])('verifies install and preserves the old pointer on failure: %s', async scenario => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-backend-test-'));
    try {
      const build = path.join(root, 'build');
      const bundle = path.join(build, backendPackageName(backendLock.version));
      await fs.mkdir(bundle, { recursive: true });
      const cli = elf();
      if (scenario === 'missing-capability') cli[63] = 1;
      if (scenario === 'missing-launch-chain') cli[63] = 2;
      if (scenario === 'missing-auth-ui') cli[63] = 4;
      if (scenario === 'missing-system-library') cli[63] = 7;
      await fs.writeFile(path.join(bundle, 'xodus-cli'), scenario === 'bad-elf' ? 'not an ELF' : cli);
      await fs.writeFile(path.join(bundle, 'xodus-service'), scenario === 'bad-service-elf' ? 'not an ELF' : elf());
      await fs.writeFile(path.join(bundle, 'LICENSE'), 'synthetic license fixture');
      const files: Record<string, string> = {};
      for (const name of ['xodus-cli', 'xodus-service', 'LICENSE']) files[name] = sha(await fs.readFile(path.join(bundle, name)));
      if (scenario === 'binary-digest') files['xodus-cli'] = '0'.repeat(64);
      if (scenario === 'symlink' || scenario === 'hardlink') {
        await fs.unlink(path.join(bundle, 'xodus-service'));
        if (scenario === 'symlink') await fs.symlink('xodus-cli', path.join(bundle, 'xodus-service'));
        else await fs.link(path.join(bundle, 'xodus-cli'), path.join(bundle, 'xodus-service'));
      }
      if (scenario === 'missing-service') await fs.unlink(path.join(bundle, 'xodus-service'));
      const archive = `${backendPackageName(backendLock.version)}.tar.xz`;
      expect((await run('tar', ['-cJf', path.join(build, archive), '-C', build, backendPackageName(backendLock.version)])).code).toBe(0);
      const data = await fs.readFile(path.join(build, archive));
      const manifest = { schema: 1, authUi: 'electron', version: backendLock.version, commit: backendLock.commit, compatibility: backendLock.compatibility,
        recipeSha256: scenario === 'recipe' ? 'not-a-valid-hash' : backendRecipeSha256, platform: 'linux', arch: currentArch(), archive,
        archiveSha512: scenario === 'archive-digest' ? '0'.repeat(128) : sha(data, 'sha512'), files };
      const assets = [archive, `${backendPackageName(backendLock.version)}.manifest.json`, `${backendPackageName(backendLock.version)}.sha512sum`, `${backendPackageName(backendLock.version)}-source.tar.xz`, `${backendPackageName(backendLock.version)}-source.sha512sum`];
      let downloading = false;
      const fetcher = vi.fn(async (input: URL | RequestInfo) => {
        const target = String(input);
        if (target.includes('/releases?')) return new Response(JSON.stringify([
          { tag_name: 'v0.1.0', assets: [] },
          { tag_name: tag, prerelease: true, assets: [] },
          { tag_name: tag, assets: assets.map(name => ({ name, browser_download_url: url(name) })) },
        ]));
        if (target.endsWith('.manifest.json')) return new Response(JSON.stringify(manifest));
        if (target.endsWith('.sha512sum')) return new Response(`${manifest.archiveSha512}  ${archive}\n`);
        downloading = true;
        return new Response(data);
      }) as unknown as typeof fetch;
      const managed = path.join(root, 'xodus-backends');
      await fs.mkdir(managed);
      const old = '{"previous":"keep intact"}';
      await fs.writeFile(path.join(managed, 'current.json'), old);
      const manager = new BackendManager(root, '', () => {}, () => scenario === 'busy-after-download' && downloading, fetcher);
      if (scenario === 'valid') {
        await manager.update(() => {});
        const pointer = JSON.parse(await fs.readFile(path.join(managed, 'current.json'), 'utf8'));
        expect(pointer.delivery).toBe('release');
        expect(pointer.recipeSha256).toBe(backendRecipeSha256);
        expect(manager.current.available).toBe(true);
        expect(manager.current.prerequisites.cargo).toBe(false);
        expect((await manager.checkUpdate()).updateAvailable).toBe(false);
        await manager.update(() => {}); // Reinstall identical bytes safely.
      } else {
        await expect(manager.update(() => {})).rejects.toThrow(scenario==='missing-system-library'?'D-Bus runtime library is missing':undefined);
        expect(await fs.readFile(path.join(managed, 'current.json'), 'utf8')).toBe(old);
      }
      expect(manager.current.updating).toBe(false);
      expect((await fs.readdir(managed)).some(name => name.startsWith('.download-'))).toBe(false);
      expect(vi.mocked(run).mock.calls.some(([cmd]) => cmd.endsWith('/xodus-service'))).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('blocks installation before any download while a game/operation is active', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const manager = new BackendManager('/unused', '', () => {}, () => true, fetcher);
    await expect(manager.update(() => {})).rejects.toThrow('while authentication');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not fall back to compiling when no release is available', async () => {
    const fetcher = vi.fn(async () => new Response('[]')) as unknown as typeof fetch;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-absent-test-'));
    try {
      const manager = new BackendManager(root, '', () => {}, () => false, fetcher);
      const status = await manager.checkUpdate();
      expect(status.releaseAvailable).toBe(false);
      expect(status.blockReason).toBe('No compatible Nexus backend release has been published yet.');
      await expect(manager.update(() => {})).rejects.toThrow('No compatible');
      await expect(fs.stat(path.join(root, 'xodus-backends/current.json'))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects wrong source/platform and traversal archive layouts', () => {
    expect(() => validateBackendManifest({ schema: 1, commit: 'a'.repeat(40) })).toThrow('not a valid compatible release');
    expect(() => validateBackendArchive([`${backendPackageName(backendLock.version)}/../../outside`], ['-rw-r--r-- user/group 1 time outside'])).toThrow('Unsafe');
  });

  it('discovers the newest stable backend release above the launcher minimum, ignoring older ones', async () => {
    const newest = `backend-v9.9.9`;
    const name = (version: string, suffix: string) => `xodus-nexus-backend-${version}-linux-${BACKEND_ARCH_SUFFIX[currentArch()]}${suffix}`;
    const manifest = { schema: 1, authUi: 'electron', version: '9.9.9', commit: 'a'.repeat(40), recipeSha256: 'b'.repeat(64), compatibility: 'linux-run-fixture',
      platform: 'linux', arch: currentArch(), archive: name('9.9.9', '.tar.xz'), archiveSha512: 'c'.repeat(128),
      files: { 'xodus-cli': 'd'.repeat(64), 'xodus-service': 'e'.repeat(64), LICENSE: 'f'.repeat(64) } };
    const newestUrl = (asset: string) => `https://github.com/domsvoboda/xodus-nexus/releases/download/${newest}/${asset}`;
    const fetcher = (async (input: URL | RequestInfo) => {
      const target = String(input);
      if (target.includes('/releases?')) return new Response(JSON.stringify([
        { tag_name: 'v9.9.9', assets: [] },
        { tag_name: `backend-v${backendLock.version}`, assets: [{ name: name(backendLock.version, '.tar.xz'), browser_download_url: 'https://github.com/domsvoboda/xodus-nexus/releases/download/ignored/x' }] },
        { tag_name: 'backend-v0.1.0', assets: [] },
        { tag_name: newest, assets: ['.tar.xz', '.manifest.json', '.sha512sum', '-source.tar.xz', '-source.sha512sum']
          .map(suffix => ({ name: name('9.9.9', suffix), browser_download_url: newestUrl(name('9.9.9', suffix)) })) },
      ]));
      if (target.endsWith('.manifest.json')) return new Response(JSON.stringify(manifest));
      if (target.endsWith('.sha512sum')) return new Response(`${manifest.archiveSha512}  ${manifest.archive}\n`);
      return new Response('source-or-archive-bytes');
    }) as unknown as typeof fetch;
    const artifact = await discoverBackend(fetcher);
    expect(artifact.tag).toBe(newest);
    expect(artifact.manifest.version).toBe('9.9.9');
  });

  it('rejects backend releases older than the launcher minimum', async () => {
    const fetcher = (async () => new Response(JSON.stringify([
      { tag_name: 'backend-v0.1.0', assets: [] },
      { tag_name: 'v0.1.0', assets: [] },
    ]))) as unknown as typeof fetch;
    await expect(discoverBackend(fetcher)).rejects.toThrow('No compatible Nexus backend release');
  });

  it('rejects foreign asset URLs rather than downloading executable code from them', async () => {
    const fetcher = (async () => new Response(JSON.stringify([{ tag_name: tag, assets: [
      { name: `${backendPackageName(backendLock.version)}.manifest.json`, browser_download_url: 'https://other.example/manifest' },
      ...['.tar.xz', '.sha512sum', '-source.tar.xz', '-source.sha512sum'].map(suffix => ({ name: backendPackageName(backendLock.version) + suffix, browser_download_url: 'https://other.example/file' })),
    ] }]))) as typeof fetch;
    await expect(discoverBackend(fetcher)).rejects.toThrow('Unexpected');
  });

  it.each(['x64', 'arm64'] as const)('discovers only complete %s releases even when a newer release ships the other architecture', async arch => {
    const requests: string[] = [];
    const version = '9.8.0', expectedTag = 'backend-v' + version;
    const name = backendPackageName(version, arch);
    const sum = 'c'.repeat(128);
    const release = (v: string, a: 'x64' | 'arm64', complete = true) => ({ tag_name: 'backend-v' + v,
      assets: ['.tar.xz', '.manifest.json', '.sha512sum', '-source.tar.xz', ...(complete ? ['-source.sha512sum'] : [])].map(suffix => ({
        name: backendPackageName(v, a) + suffix,
        browser_download_url: `https://github.com/domsvoboda/xodus-nexus/releases/download/backend-v${v}/${backendPackageName(v, a)}${suffix}`,
      })) });
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input); requests.push(url);
      if (url.includes('/releases?')) return new Response(JSON.stringify([release('9.9.9', arch === 'arm64' ? 'x64' : 'arm64'), release('9.9.8', arch, false), release(version, arch)]));
      if (url.endsWith('.manifest.json')) return new Response(JSON.stringify({ schema: 1, authUi: 'electron', version, commit: 'a'.repeat(40), recipeSha256: 'b'.repeat(64), compatibility: 'linux-run-fixture', platform: 'linux', arch,
        archive: name + '.tar.xz', archiveSha512: sum, files: { 'xodus-cli': 'd'.repeat(64), 'xodus-service': 'e'.repeat(64), LICENSE: 'f'.repeat(64) } }));
      return new Response(`${sum}  ${name}.tar.xz\n`);
    }) as typeof fetch;
    expect((await discoverBackend(fetcher, arch)).tag).toBe(expectedTag);
    expect(requests.slice(1).every(url => url.includes(expectedTag + '/' + name))).toBe(true);
  });
});
