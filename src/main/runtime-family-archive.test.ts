import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { materializeRuntimeArchive } from './runtime-family-archive';
const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => fs.rm(root, {
        recursive: true, force: true
    })));
});
const generator = String.raw `
import sys,tarfile,io,json,lzma
file,items,format=sys.argv[1:];items=json.loads(items)
if format=='huge':
 root=tarfile.TarInfo('runtime');root.type=tarfile.DIRTYPE;big=tarfile.TarInfo('runtime/big');big.size=8*1024**3+1
 open(file,'wb').write(lzma.compress(root.tobuf()+big.tobuf()+bytes(1024)));sys.exit()
if format=='pax-huge':
 root=tarfile.TarInfo('runtime');root.type=tarfile.DIRTYPE;big=tarfile.TarInfo('pax');big.type=tarfile.XHDTYPE;big.size=2*1024**2+1
 open(file,'wb').write(lzma.compress(root.tobuf()+big.tobuf()+bytes(1024)));sys.exit()
with tarfile.open(file,'w:xz',format=tarfile.GNU_FORMAT if format=='gnu' else tarfile.PAX_FORMAT) as tf:
 for item in items:
  member=tarfile.TarInfo(item['name']);member.type={'dir':tarfile.DIRTYPE,'file':tarfile.REGTYPE,'link':tarfile.SYMTYPE,'hard':tarfile.LNKTYPE,'device':tarfile.CHRTYPE,'sparse':tarfile.GNUTYPE_SPARSE}[item.get('type','file')];member.mode=0o755 if member.isdir() else 0o644
  member.linkname=item.get('target','');data=item.get('data','contents').encode();member.size=len(data) if member.isreg() else 0
  if 'pax' in item: member.pax_headers=item['pax']
  tf.addfile(member,io.BytesIO(data) if member.isreg() else None)
`;
async function fixture(items: unknown[], format = 'pax') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'family-archive-'));
    roots.push(root);
    const archive = path.join(root, 'archive.tar.xz'), stage = path.join(root, 'stage');
    await fs.mkdir(stage, {
        mode: 0o700
    });
    await execute('python3', ['-I', '-c', generator, archive, JSON.stringify([{
                name: 'runtime', type: 'dir'
            }, ...items]), format]);
    return {
        root, archive, stage
    };
}
it.each(['pax', 'gnu'])('materializes %s long names, literal links and copied forward hardlinks without following z:', async (format) => {
    const long = 'runtime/' + 'long'.repeat(40), f = await fixture([{
            name: 'runtime/hard', type: 'hard', target: long
        }, {
            name: long, data: 'actual bytes'
        }, {
            name: 'runtime/link', type: 'link', target: long.slice('runtime/'.length)
        }, {
            name: 'runtime/files/share/default_pfx/dosdevices/z:', type: 'link', target: '/'
        }], format);
    const result = await materializeRuntimeArchive(f.archive, f.stage, 'runtime');
    expect(await fs.readFile(path.join(result, 'hard'), 'utf8')).toBe('actual bytes');
    expect((await fs.stat(path.join(result, 'hard'))).ino).not.toBe((await fs.stat(path.join(f.stage, long))).ino);
    expect(await fs.readlink(path.join(result, 'files/share/default_pfx/dosdevices/z:'))).toBe('/');
});
const attacks: Record<string, unknown[]> = {
    absolute: [{
            name: '/escape'
        }], parent: [{
            name: 'runtime/../escape'
        }], duplicate: [{
            name: 'runtime/a'
        }, {
            name: 'runtime/a'
        }], linkParent: [{
            name: 'runtime/alias', type: 'link', target: 'target'
        }, {
            name: 'runtime/alias/child'
        }, {
            name: 'runtime/target', type: 'dir'
        }], hardEscape: [{
            name: 'runtime/hard', type: 'hard', target: '../escape'
        }], hardCycle: [{
            name: 'runtime/a', type: 'hard', target: 'runtime/b'
        }, {
            name: 'runtime/b', type: 'hard', target: 'runtime/a'
        }], wrongHardType: [{
            name: 'runtime/a', type: 'dir'
        }, {
            name: 'runtime/b', type: 'hard', target: 'runtime/a'
        }], linkCycle: [{
            name: 'runtime/a', type: 'link', target: 'b'
        }, {
            name: 'runtime/b', type: 'link', target: 'a'
        }], externalLink: [{
            name: 'runtime/a', type: 'link', target: '/tmp'
        }], zTraversal: [{
            name: 'runtime/files/share/default_pfx/dosdevices/z:', type: 'link', target: '/'
        }, {
            name: 'runtime/b', type: 'link', target: 'files/share/default_pfx/dosdevices/z:/tmp'
        }], device: [{
            name: 'runtime/device', type: 'device'
        }], backslash: [{
            name: 'runtime/one\\two'
        }], paxTraversal: [{
            name: 'safe', pax: {
                path: 'runtime/../escape'
            }
        }], paxNull: [{
            name: 'safe', pax: {
                path: 'runtime/bad\u0000name'
            }
        }], deep: [{
            name: 'runtime/' + Array(65).fill('d').join('/')
        }], dangling: [{
            name: 'runtime/link', type: 'link', target: 'missing'
        }]
};
it.each(Object.entries(attacks))('rejects %s before creating payload files', async (_name, items) => {
    const f = await fixture(items);
    await expect(materializeRuntimeArchive(f.archive, f.stage, 'runtime')).rejects.toThrow();
    expect(await fs.readdir(f.stage)).toEqual([]);
});
it.each(['huge', 'pax-huge'])('bounds declared %s metadata/content before writes', async (format) => {
    const f = await fixture([], format);
    await expect(materializeRuntimeArchive(f.archive, f.stage, 'runtime')).rejects.toThrow();
    expect(await fs.readdir(f.stage)).toEqual([]);
});
it('rejects a staging symlink without writing its target', async () => {
    const f = await fixture([{
            name: 'runtime/a'
        }]), alias = path.join(f.root, 'alias');
    await fs.symlink(f.stage, alias);
    await expect(materializeRuntimeArchive(f.archive, alias, 'runtime')).rejects.toThrow();
    expect(await fs.readdir(f.stage)).toEqual([]);
});
it('bounds decoded extension metadata and padding independently of exposed member bytes', async () => {
    const f = await fixture(Array.from({
        length: 12
    }, (_, i) => ({
        name: 'runtime/f' + i, pax: {
            comment: 'metadata '.repeat(50)
        }, data: 'x'
    })));
    await expect(materializeRuntimeArchive(f.archive, f.stage, 'runtime', 4096)).rejects.toThrow();
    expect(await fs.readdir(f.stage)).toEqual([]);
});
it('rejects a symlink path that tries to traverse a regular file through parent syntax before writes', async () => {
    const f = await fixture([{
            name: 'runtime/file'
        }, {
            name: 'runtime/target', type: 'dir'
        }, {
            name: 'runtime/link', type: 'link', target: 'file/../target'
        }]);
    await expect(materializeRuntimeArchive(f.archive, f.stage, 'runtime')).rejects.toThrow();
    expect(await fs.readdir(f.stage)).toEqual([]);
});
it('reports a missing Python prerequisite clearly without exposing an interpreter command', async () => {
    const f = await fixture([{
            name: 'runtime/a'
        }]);
    const previous = process.env.PATH;
    try {
        process.env.PATH = f.stage;
        await expect(materializeRuntimeArchive(f.archive, f.stage, 'runtime')).rejects.toThrow('Python 3 is required');
    }
    finally {
        process.env.PATH = previous;
    }
});
