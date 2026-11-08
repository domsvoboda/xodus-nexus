import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export interface LegacyManagedState {
    family: 'nexus' | 'nexus-cachyos';
    root: string;
    configuredWine: string;
    name: string;
    winePath: string;
    sourceCommit: string;
    pointerSha256: string;
    identity: string;
    candidateSha256?: string;
    releaseTag: string;
    channel?: 'stable' | 'prerelease';
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Recognize the existing global Standard installer layout, never a custom
 * Wine, preview, family variant or arbitrary directory supplied by a caller. */
async function legacyState(root: string, configuredWine: string, family: 'nexus' | 'nexus-cachyos'): Promise<Readonly<LegacyManagedState> | undefined> {
    try {
        if (typeof configuredWine !== 'string')
            return;
        const repository = family === 'nexus' ? 'domsvoboda/nexus-runtime' : 'domsvoboda/nexus-runtime-cachyos';
        const namePrefix = family === 'nexus' ? 'nexus-runtime-' : 'nexus-runtime-cachyos-';
        const tagPrefix = family === 'nexus' ? 'runtime-' : 'runtime-cachyos-';
        const namePattern = new RegExp('^' + namePrefix + '[0-9][A-Za-z0-9._-]*-g[a-f0-9]{8,40}$');
        const tagPattern = new RegExp('^' + tagPrefix + '[A-Za-z0-9._-]+-g[a-f0-9]{8,40}$');
        const current = path.join(root, 'current.json'), stamp = await fs.lstat(current);
        if (!stamp.isFile() || stamp.size > 65536)
            return;
        const bytes = await fs.readFile(current), pointer = JSON.parse(bytes.toString('utf8'));
        if (typeof pointer.name !== 'string' || !namePattern.test(pointer.name) || pointer.name.includes('..'))
            return;
        const hint = pointer.name.match(/-g([a-f0-9]{8,40})$/)![1];
        if (typeof pointer.commit !== 'string' || !tagPattern.test(pointer.commit) || pointer.commit.match(/-g([a-f0-9]{8,40})$/)?.[1] !== hint)
            return;
        const expected = path.join(root, 'releases', pointer.name, 'files/bin/wine');
        if (pointer.winePath !== expected)
            return;
        if (configuredWine && configuredWine !== expected)
            return;
        for (const directory of [root, path.join(root, 'releases'), path.join(root, 'releases', pointer.name), path.dirname(path.dirname(expected)), path.dirname(expected)])
            if (!(await fs.lstat(directory)).isDirectory())
                return;
        const metadataFile = path.join(root, 'releases', pointer.name, 'XODUS_NEXUS_PATCH.json'), metadataStat = await fs.lstat(metadataFile);
        if (!metadataStat.isFile() || metadataStat.size > 2 * 1024 * 1024)
            return;
        const metadataBytes = await fs.readFile(metadataFile), metadata = JSON.parse(metadataBytes.toString('utf8')), source = metadata.sourceGraph?.proton;
        if (metadata.schema !== 1 || typeof source !== 'string' || !/^[a-f0-9]{40}$/.test(source) || !source.startsWith(hint) || typeof metadata.sourceLockSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sourceLockSha256))
            return;
        // Older CachyOS builds may not carry variant.family; the fixed name,
        // repository, commit and path checks above are already family-specific.
        if (family === 'nexus' ? metadata.variant?.family === 'nexus-cachyos' : metadata.variant?.family !== undefined && metadata.variant.family !== 'nexus-cachyos')
            return;
        if (pointer.sourceRepository !== undefined && pointer.sourceRepository !== repository)
            return;
        if (pointer.prerelease !== undefined && typeof pointer.prerelease !== 'boolean')
            return;
        const before = await fs.lstat(expected);
        if (!before.isFile())
            return;
        await fs.access(expected, constants.X_OK);
        const file = await fs.open(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
        const digest = createHash('sha256');
        try {
            const opened = await file.stat();
            if (opened.ino !== before.ino || opened.dev !== before.dev)
                return;
            for await (const chunk of file.createReadStream({ autoClose: false }))
                digest.update(chunk);
        }
        finally {
            await file.close();
        }
        const after = await fs.lstat(expected);
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !(await fs.readFile(current)).equals(bytes))
            return;
        const identity = hash(JSON.stringify([family, await fs.realpath(root), hash(bytes), hash(metadataBytes), before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, digest.digest('hex')]));
        return Object.freeze({ family, root, configuredWine, name: pointer.name, winePath: expected, sourceCommit: source, pointerSha256: hash(bytes), identity, releaseTag: pointer.commit, channel: pointer.sourceRepository === repository && typeof pointer.prerelease === 'boolean' && typeof pointer.candidateSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.candidateSha256) ? (pointer.prerelease ? 'prerelease' : 'stable') : undefined, candidateSha256: typeof pointer.candidateSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.candidateSha256) ? pointer.candidateSha256 : undefined });
    }
    catch {
        return;
    }
}
/** Recognize only the existing global Standard installer layout. */
export async function legacyManagedState(root: string, configuredWine: string): Promise<Readonly<LegacyManagedState> | undefined> {
    return legacyState(root, configuredWine, 'nexus');
}
/** Recognize only the existing verified global CachyOS installer layout. This
 * is migration evidence, not a managed-family installation. */
export async function legacyCachyosState(root: string, configuredWine: string): Promise<Readonly<LegacyManagedState> | undefined> {
    return legacyState(root, configuredWine, 'nexus-cachyos');
}
