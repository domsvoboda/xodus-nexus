import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedFamilyStatus, ManagedFamilyInstallResult, ManagedRuntimeOptions } from '../shared/types.js';
import { runtimeFamilies, type RuntimeFamily } from '../shared/runtime-selection.js';
import { parseManagedFamilyRelease, verifyManagedFamilyCandidate, type VerifiedManagedFamilyRelease } from './runtime-family-release.js';
import { resolveRuntimeFamily, retainRuntimeFamilyBuild, verifyRuntimeFamilyPayload, type RuntimeFamilyReceipt } from './runtime-families.js';
import { materializeRuntimeArchive } from './runtime-family-archive.js';
import { runtimePayloadMatches } from './runtime-payload-identity.js';
import { commitRuntimePointer } from './runtime-pointer-commit.js';
const repositories = {
    nexus: 'domsvoboda/nexus-runtime', 'nexus-cachyos': 'domsvoboda/nexus-runtime-cachyos'
};
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function familyId(v: unknown): RuntimeFamily {
    if (v !== 'nexus' && v !== 'nexus-cachyos')
        throw Error('Unknown managed runtime family');
    return v;
}
function options(v: unknown): ManagedRuntimeOptions {
    if (!object(v) || typeof v.allowCachyos !== 'boolean' || typeof v.allowPrerelease !== 'boolean')
        throw Error('Explicit runtime release options are required');
    return {
        allowCachyos: v.allowCachyos, allowPrerelease: v.allowPrerelease
    };
}
export interface ManagedRuntimeLease {
    root: string;
    release(): void;
}
interface Target {
    root: string;
    release: VerifiedManagedFamilyRelease;
    input: unknown;
    bytes: Buffer;
    policy: ManagedRuntimeOptions;
}
interface Context {
    root: () => string;
    reserve: () => ManagedRuntimeLease;
    versions: () => {
        launcher: string;
        backend: string;
    };
    completed: () => void;
    notify: () => void;
    fetcher?: typeof fetch;
    arch?: string;
}
/** Shared managed components only. Never writes global selection, games or prefixes. */
export class ManagedRuntimeManager {
    private states = new Map<RuntimeFamily, ManagedFamilyStatus>(runtimeFamilies.map(id => [id, {
            id, checking: false, installing: false
        }]));
    private selectionEpoch = 0;
    private targets = new Map<RuntimeFamily, Target>();
    private epochs = new Map<RuntimeFamily, number>();
    constructor(private context: Context) {
    }
    get revision(): number { return this.selectionEpoch; }
    get current(): ManagedFamilyStatus[] {
        return structuredClone([...this.states.values()]);
    }
    private async installed(id: RuntimeFamily, root: string) {
        const directory = path.join(root, 'variants', id), pointerFile = path.join(directory, 'current.json');
        const stamp = await fs.lstat(pointerFile);
        if (!stamp.isFile() || stamp.size > 65536)
            throw Error('Invalid managed pointer');
        const pointerBytes = await fs.readFile(pointerFile);
        const verified = await resolveRuntimeFamily(root, id, this.context.arch ?? process.arch), pointer = JSON.parse(pointerBytes.toString('utf8'));
        if (pointer.buildId !== verified.buildId || pointer.sourceCommit !== verified.sourceCommit || pointer.manifestSha256 !== verified.manifestSha256)
            throw Error('Managed selection changed while checking');
        let provenance: Record<string, unknown> | undefined;
        if (typeof pointer.candidateSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.candidateSha256))
            try {
                const file = path.join(directory, 'provenance', verified.buildId + '.' + pointer.candidateSha256 + '.json');
                const stat = await fs.lstat(file);
                if (!stat.isFile() || stat.size > 65536)
                    throw Error('Invalid release provenance');
                const record = JSON.parse(await fs.readFile(file, 'utf8'));
                if (record.schema === 1 && record.family === id && record.buildId === verified.buildId && record.sourceCommit === verified.sourceCommit && record.manifestSha256 === verified.manifestSha256 && record.candidateSha256 === pointer.candidateSha256 && typeof record.tag === 'string' && typeof record.prerelease === 'boolean')
                    provenance = record;
            }
            catch { /* A legacy verified build is not silently assigned a release channel. */
            }
        if (!(await fs.readFile(pointerFile)).equals(pointerBytes))
            throw Error('Managed selection changed while checking');
        return {
            verified, provenance
        };
    }
    async refresh(): Promise<void> {
        const root = this.context.root(), epoch = this.selectionEpoch;
        await Promise.all(runtimeFamilies.map(async (id) => {
            const state = this.states.get(id)!;
            try {
                const { verified, provenance } = await this.installed(id, root);
                if (root !== this.context.root() || epoch !== this.selectionEpoch)
                    return;
                state.installed = {
                    id: verified.id, label: verified.label, buildId: verified.buildId, sourceCommit: verified.sourceCommit, manifestSha256: verified.manifestSha256
                };
                state.version = provenance?.tag as string | undefined;
                state.channel = provenance ? (provenance.prerelease ? 'prerelease' : 'stable') : undefined;
                state.updateAvailable = state.available ? provenance?.candidateSha256 !== state.available.candidateSha256 : undefined;
            }
            catch {
                if (root === this.context.root() && epoch === this.selectionEpoch) {
                    state.installed = undefined;
                    state.version = undefined;
                    state.channel = undefined;
                    state.updateAvailable = state.available ? true : undefined;
                }
            }
        }));
    }
    private async policy(id: RuntimeFamily, root: string, value: unknown): Promise<ManagedRuntimeOptions> {
        const request = options(value);
        try {
            const installed = await this.installed(id, root);
            return {
                allowCachyos: request.allowCachyos || id === 'nexus-cachyos', allowPrerelease: request.allowPrerelease
            };
        }
        catch {
            return request;
        }
    }
    private async response(url: string): Promise<Response> {
        let next = url;
        for (let redirects = 0; redirects < 5; redirects++) {
            const response = await (this.context.fetcher ?? fetch)(next, {
                redirect: 'manual', signal: AbortSignal.timeout(600000), headers: {
                    Accept: 'application/vnd.github+json'
                }
            });
            if (![301, 302, 303, 307, 308].includes(response.status)) {
                if (!response.ok)
                    throw Error('Runtime release download failed: HTTP ' + response.status);
                return response;
            }
            const location = response.headers.get('location');
            if (!location)
                throw Error('Missing runtime asset redirect');
            const target = new URL(location, next);
            if (target.protocol !== 'https:' || target.username || target.password || target.port || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname))
                throw Error('Untrusted runtime asset redirect');
            next = target.href;
        }
        throw Error('Too many runtime asset redirects');
    }
    private async bytes(url: string, limit: number, exact?: number): Promise<Buffer> {
        const response = await this.response(url);
        if (!response.body)
            throw Error('Empty runtime metadata response');
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            length += chunk.length;
            if (length > limit)
                throw Error('Runtime metadata exceeds limit');
            chunks.push(Buffer.from(chunk));
        }
        if (exact !== undefined && length !== exact)
            throw Error('Runtime metadata size mismatch');
        return Buffer.concat(chunks);
    }
    async check(selection: unknown, value: unknown): Promise<ManagedFamilyStatus> {
        const id = familyId(selection), state = this.states.get(id)!, root = this.context.root(), epoch = (this.epochs.get(id) ?? 0) + 1;
        this.epochs.set(id, epoch);
        state.checking = true;
        state.error = undefined;
        try {
            this.context.notify();
            const policy = await this.policy(id, root, value), versions = this.context.versions(), arch = this.context.arch ?? process.arch;
            const json = JSON.parse((await this.bytes('https://api.github.com/repos/' + repositories[id] + '/releases?per_page=30', 2 * 1024 * 1024)).toString('utf8'));
            if (!Array.isArray(json) || json.length > 100)
                throw Error('Invalid runtime release list');
            // Legacy releases without candidate metadata are not managed-family targets.
            // Select newest in the chosen channel first, then validate it exactly. Never
            // fall back past a malformed newest trusted-format candidate.
            const candidates = json.filter(item => object(item) && item.draft !== true && (item.prerelease !== true || policy.allowPrerelease) && typeof item.tag_name === 'string' && item.tag_name.startsWith(id === 'nexus' ? 'runtime-' : 'runtime-cachyos-') && Array.isArray(item.assets) && item.assets.some(asset => object(asset) && asset.name === 'candidate.json'));
            for (const item of candidates)
                if (typeof item.published_at !== 'string' || !Number.isFinite(Date.parse(item.published_at)))
                    throw Error('Invalid managed runtime publication date');
            candidates.sort((a, b) => Date.parse(String(b.published_at)) - Date.parse(String(a.published_at)));
            if (!candidates.length)
                throw Error('No supported published managed-family release is available');
            const selected = {
                input: candidates[0], release: parseManagedFamilyRelease(id, candidates[0], {
                    ...policy, arch, launcherVersion: versions.launcher, backendVersion: versions.backend
                })
            };
            const bytes = await this.bytes(selected.release.assets.candidate.url, 2 * 1024 * 1024, selected.release.assets.candidate.size), release = verifyManagedFamilyCandidate(bytes, selected.release);
            if (root !== this.context.root() || this.epochs.get(id) !== epoch)
                throw Error('Runtime release selection changed while checking');
            this.targets.set(id, {
                root, release, input: selected.input, bytes, policy
            });
            state.available = {
                version: release.tag, candidateSha256: release.candidateSha256, sourceCommit: release.commit, archiveName: release.assets.binary.name, requiresBackendVersion: release.requiresBackendVersion, requiresLauncherVersion: release.requiresLauncherVersion
            };
            await this.refresh();
        }
        catch (error) {
            if (this.epochs.get(id) === epoch) {
                this.targets.delete(id);
                state.available = undefined;
                state.updateAvailable = undefined;
                state.error = (error as Error).message;
            }
        }
        finally {
            if (this.epochs.get(id) === epoch) {
                state.checking = false;
                try {
                    this.context.notify();
                }
                catch (error) {
                    state.error = [state.error, 'Updating runtime status failed: ' + (error as Error).message].filter(Boolean).join(' ');
                }
            }
        }
        return structuredClone(state);
    }
    /** A frozen internal target is provided for later component coordinators. */
    target(selection: unknown): Readonly<VerifiedManagedFamilyRelease> | undefined {
        return this.targets.get(familyId(selection))?.release;
    }
    private async directory(root: string, ...parts: string[]): Promise<string> {
        let next = root;
        await fs.mkdir(root, {
            recursive: true, mode: 0o700
        });
        if (!(await fs.lstat(root)).isDirectory())
            throw Error('Managed runtime root must not be a symlink');
        for (const part of parts) {
            next = path.join(next, part);
            try {
                await fs.mkdir(next, {
                    mode: 0o700
                });
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw error;
            }
            if (!(await fs.lstat(next)).isDirectory())
                throw Error('Managed runtime directory must not be a symlink');
        }
        return next;
    }
    private async immutable(file: string, bytes: Buffer | string): Promise<void> {
        const temporary = path.join(path.dirname(file), '.receipt-' + randomUUID());
        let owned = false;
        try {
            const handle = await fs.open(temporary, 'wx', 0o600);
            owned = true;
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            try {
                await fs.link(temporary, file);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw error;
                if (!(await fs.lstat(file)).isFile() || !(await fs.readFile(file)).equals(Buffer.from(bytes)))
                    throw Error('Conflicting managed runtime receipt');
            }
            const directory = await fs.open(path.dirname(file), 'r');
            try {
                await directory.sync();
            }
            finally {
                await directory.close();
            }
        }
        finally {
            if (owned)
                await fs.unlink(temporary).catch(() => {
                });
        }
    }
    private async pointer(directory: string): Promise<Buffer | undefined> {
        const file = path.join(directory, 'current.json');
        try {
            const before = await fs.lstat(file);
            if (!before.isFile() || before.size > 65536)
                throw Error('Invalid managed family pointer');
            const bytes = await fs.readFile(file), after = await fs.lstat(file);
            if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size)
                throw Error('Managed family pointer changed');
            return bytes;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return undefined;
            throw error;
        }
    }
    private async archive(target: Target, file: string): Promise<void> {
        const asset = target.release.assets.binary, record = target.release.files.find(item => item.name === asset.name)!;
        const checksumAsset = target.release.assets.checksum, checksumRecord = target.release.files.find(item => item.name === checksumAsset.name)!, sum = await this.bytes(checksumAsset.url, 65536, checksumAsset.size);
        if (digest(sum) !== checksumRecord.sha256)
            throw Error('Runtime checksum metadata changed');
        const line = sum.toString('utf8').match(/^([a-f0-9]{128})[ \t]+\*?([^\r\n]+)\r?\n?$/);
        if (!line || line[2] !== asset.name)
            throw Error('Runtime checksum does not name the selected archive');
        const response = await this.response(asset.url);
        if (!response.body)
            throw Error('Empty runtime archive');
        const handle = await fs.open(file, 'wx', 0o600), h256 = createHash('sha256'), h512 = createHash('sha512');
        let bytes = 0;
        try {
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                bytes += chunk.length;
                if (bytes > asset.size)
                    throw Error('Runtime archive exceeds selected size');
                h256.update(chunk);
                h512.update(chunk);
                await handle.writeFile(chunk);
            }
        }
        finally {
            await handle.close();
        }
        if (bytes !== asset.size || h256.digest('hex') !== record.sha256 || h512.digest('hex') !== line[1])
            throw Error('Runtime archive checksum mismatch');
    }
    async install(selection: unknown, expected: unknown, value: unknown): Promise<ManagedFamilyInstallResult> {
        const id = familyId(selection), state = this.states.get(id)!, lease = this.context.reserve();
        let staging: string | undefined, committed = false, buildId: string | undefined, durability: ManagedFamilyInstallResult['durability'] = 'not-committed';
        this.selectionEpoch++;
        this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
        state.checking = false;
        state.installing = true;
        state.error = undefined;
        let outcome: ManagedFamilyInstallResult = {
            family: id, success: false, committed: false, durability: 'not-committed'
        };
        const completionError = (message: string, error: unknown) => {
            const text = message + ': ' + (error instanceof Error ? error.message : String(error));
            state.error = [state.error, text].filter(Boolean).join(' ');
            state.phase = committed ? 'Runtime installed; confirmation needs attention' : 'Active runtime selection was not changed';
            outcome = {
                ...outcome, success: false, committed, durability, error: state.error
            };
        };
        try {
            const selected = this.targets.get(id);
            if (!selected || selected.root !== lease.root || typeof expected !== 'string' || selected.release.candidateSha256 !== expected)
                throw Error('Check this runtime release again before installing');
            const policy = await this.policy(id, lease.root, value), versions = this.context.versions();
            const release = verifyManagedFamilyCandidate(selected.bytes, parseManagedFamilyRelease(id, selected.input, {
                ...policy, arch: this.context.arch ?? process.arch, launcherVersion: versions.launcher, backendVersion: versions.backend
            }));
            const target = {
                ...selected, release
            };
            const directory = await this.directory(lease.root, 'variants', id), releases = await this.directory(lease.root, 'variants', id, 'releases'), receipts = await this.directory(lease.root, 'variants', id, 'receipts'), provenance = await this.directory(lease.root, 'variants', id, 'provenance');
            const before = await this.pointer(directory);
            if (before) {
                let valid = false;
                try {
                    await resolveRuntimeFamily(lease.root, id, this.context.arch ?? process.arch);
                    valid = true;
                }
                catch { /* Preserve invalid old evidence, never bless it into a trusted receipt. */
                }
                if (valid)
                    await retainRuntimeFamilyBuild(lease.root, id, this.context.arch ?? process.arch);
                else {
                    const evidence = await this.directory(lease.root, 'variants', id, 'preserved');
                    await this.immutable(path.join(evidence, digest(before) + '.json'), before);
                }
            }
            staging = await this.directory(lease.root, 'variants', id, '.staging-' + randomUUID());
            const archive = path.join(staging, release.assets.binary.name);
            state.phase = 'Downloading and verifying runtime';
            this.context.notify();
            await this.archive(target, archive);
            const extracted = path.join(staging, 'payload');
            await fs.mkdir(extracted, {
                mode: 0o700
            });
            state.phase = 'Checking runtime files';
            this.context.notify();
            const top = release.assets.binary.name.slice(0, -'.tar.xz'.length).replace(/-x86_64$/, '');
            const payload = await materializeRuntimeArchive(archive, extracted, top);
            const manifestFile = path.join(payload, 'nexus-family.json');
            if (!(await fs.lstat(manifestFile)).isFile() || (await fs.stat(manifestFile)).size > 4 * 1024 * 1024)
                throw Error('Missing bounded managed-family manifest');
            const bytes = await fs.readFile(manifestFile), manifest = JSON.parse(bytes.toString('utf8'));
            buildId = manifest.buildId;
            const receipt: RuntimeFamilyReceipt = {
                schema: 1, family: id, sourceRepository: repositories[id], buildId: manifest.buildId, manifestSha256: digest(bytes), sourceCommit: release.commit
            };
            const { buildId: ignored, ...identity } = manifest;
            if (digest(JSON.stringify(identity)) !== buildId)
                throw Error('Runtime build identity is not derived from its manifest');
            await verifyRuntimeFamilyPayload(payload, receipt, this.context.arch ?? process.arch);
            const metadata = JSON.parse(await fs.readFile(path.join(payload, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
            if (!isDeepStrictEqual(metadata.sourceGraph, release.sourceGraph) || metadata.requiresBackendVersion !== release.requiresBackendVersion || metadata.requiresLauncherVersion !== release.requiresLauncherVersion)
                throw Error('Runtime payload differs from candidate source graph or requirements');
            const destination = path.join(releases, receipt.buildId);
            let exists = true;
            try {
                await fs.lstat(destination);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                exists = false;
            }
            if (exists) {
                if (!await runtimePayloadMatches(payload, destination))
                    throw Error('The existing build differs from this verified release and was preserved. Choose a different release or restore it explicitly.');
            }
            else {
                await fs.rename(payload, destination);
                const parent = await fs.open(releases, 'r');
                try {
                    await parent.sync();
                }
                finally {
                    await parent.close();
                }
            }
            await verifyRuntimeFamilyPayload(destination, receipt, this.context.arch ?? process.arch);
            const canonical = {
                schema: 1, family: id, sourceRepository: repositories[id], buildId: receipt.buildId, manifestSha256: receipt.manifestSha256, sourceCommit: receipt.sourceCommit
            };
            await this.immutable(path.join(receipts, receipt.buildId + '.json'), JSON.stringify(canonical) + '\n');
            const proof = {
                ...canonical, tag: release.tag, prerelease: release.prerelease, candidateSha256: release.candidateSha256, files: release.files
            };
            await this.immutable(path.join(provenance, receipt.buildId + '.' + release.candidateSha256 + '.json'), JSON.stringify(proof) + '\n');
            const actual = await this.pointer(directory);
            if (before === undefined ? actual !== undefined : actual === undefined || !actual.equals(before))
                throw Error('Managed runtime selection changed before publication');
            const result = await commitRuntimePointer(directory, {
                ...canonical, releaseTag: release.tag, prerelease: release.prerelease, candidateSha256: release.candidateSha256
            });
            committed = true;
            this.selectionEpoch++;
            durability = result.durability;
            await this.refresh();
            if (state.installed?.buildId !== receipt.buildId || state.installed.manifestSha256 !== receipt.manifestSha256)
                throw Error('Runtime selection was published, but installed files could not be verified afterward');
            if (result.errors.length)
                throw new AggregateError(result.errors, 'Runtime installed, but confirming its saved selection failed: ' + result.errors.map(error => error.message).join(' '));
            state.phase = 'Runtime installed';
            outcome = {
                family: id, success: true, committed: true, buildId, durability
            };
        }
        catch (error) {
            state.error = (error as Error).message;
            state.phase = committed ? 'Runtime installed; confirmation needs attention' : 'Active runtime selection was not changed';
            outcome = {
                family: id, success: false, committed, buildId, durability, error: state.error
            };
        }
        finally {
            if (staging)
                await fs.rm(staging, {
                    recursive: true, force: true
                }).catch(error => completionError('Cleaning runtime staging failed', error));
            state.installing = false;
            try {
                this.context.completed();
            }
            catch (error) {
                completionError('Updating runtime readiness failed', error);
            }
            finally {
                try {
                    lease.release();
                }
                catch (error) {
                    completionError('Releasing runtime reservation failed', error);
                }
                finally {
                    try {
                        this.context.notify();
                    }
                    catch (error) {
                        completionError('Updating runtime status failed', error);
                    }
                }
            }
        }
        return outcome;
    }
}
