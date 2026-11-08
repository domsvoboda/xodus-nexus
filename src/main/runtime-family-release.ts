import { createHash } from 'node:crypto';
import type { RuntimeFamily } from '../shared/runtime-selection.js';
const repositories = {
    nexus: 'domsvoboda/nexus-runtime', 'nexus-cachyos': 'domsvoboda/nexus-runtime-cachyos'
} as const;
const selectedReleases = new WeakSet<object>();
const maxMetadata = 2 * 1024 * 1024, maxChecksum = 64 * 1024;
interface Asset {
    readonly name: string;
    readonly url: string;
    readonly size: number;
}
export interface ManagedFamilyRelease {
    readonly family: RuntimeFamily;
    readonly repository: string;
    readonly tag: string;
    readonly commitHint: string;
    readonly targetCommitish: string;
    readonly arch: 'x64';
    readonly prerelease: boolean;
    readonly publishedAt: string;
    readonly assets: Readonly<{
        candidate: Asset;
        binary: Asset;
        checksum: Asset;
        source: Asset;
        sourceChecksum: Asset;
    }>;
    readonly installedVersions: Readonly<{
        launcher: string;
        backend: string;
    }>;
}
export interface VerifiedManagedFamilyRelease extends ManagedFamilyRelease {
    readonly commit: string;
    readonly runId?: string;
    /** Set only by the trusted local-import validation entrypoint. */
    readonly local?: boolean;
    readonly localBuildId?: string;
    readonly candidateSha256: string;
    readonly files: readonly Readonly<{
        name: string;
        size: number;
        sha256: string;
    }>[];
    readonly requiresLauncherVersion: string;
    readonly requiresBackendVersion: string;
    readonly sourceGraph: Readonly<Record<string, unknown>>;
    /** Publisher metadata only, not an independent native test or release approval. */
    readonly validation: Readonly<{
        nativeGateCount: 12;
        treeSha256: string;
        resultsSha256: string;
        realGameTest: boolean;
        stableApproved: boolean;
    }>;
}
function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Invalid ' + label);
    return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp, label: string, max = 160): string {
    if (typeof value !== 'string' || value.length > max || !pattern.test(value))
        throw Error('Invalid ' + label);
    return value;
}
function flag(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean')
        throw Error('Invalid ' + label);
    return value;
}
function size(value: unknown, max: number, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max)
        throw Error('Invalid ' + label);
    return value;
}
function version(value: unknown, label: string): string {
    const result = text(value, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/, label, 48);
    if (result.split('.').some(part => !Number.isSafeInteger(Number(part)) || Number(part) > 999999))
        throw Error('Invalid ' + label);
    return result;
}
function sufficient(installed: string, required: string): boolean {
    const a = installed.split('.').map(Number), b = required.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i])
            return a[i] > b[i];
    }
    return true;
}
const sha = (value: unknown, label: string) => text(value, /^[a-f0-9]{64}$/, label, 64);
/** Pure published-release selection. There is no network access, archive
 * extraction, installation or implicit CachyOS/prerelease opt-in here. */
export function parseManagedFamilyRelease(family: unknown, value: unknown, options: unknown): Readonly<ManagedFamilyRelease> {
    if (family !== 'nexus' && family !== 'nexus-cachyos')
        throw Error('Unknown managed runtime family');
    const policy = record(options, 'runtime release policy');
    if (policy.arch !== 'x64')
        throw Error('Managed family payload requires reviewed x64 architecture');
    const allowCachyos = flag(policy.allowCachyos, 'CachyOS opt-in'), allowPrerelease = flag(policy.allowPrerelease, 'prerelease opt-in');
    if (family === 'nexus-cachyos' && !allowCachyos)
        throw Error('Explicit CachyOS opt-in is required');
    const launcher = version(policy.launcherVersion, 'installed launcher version'), backend = version(policy.backendVersion, 'installed backend version');
    const release = record(value, 'runtime release');
    if (flag(release.draft, 'draft flag'))
        throw Error('Draft runtime releases are not installable');
    const prerelease = flag(release.prerelease, 'prerelease flag');
    if (prerelease && !allowPrerelease)
        throw Error('Explicit prerelease opt-in is required');
    const prefix = family === 'nexus' ? 'runtime-' : 'runtime-cachyos-';
    const tag = text(release.tag_name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'runtime release tag', 128);
    if (!tag.startsWith(prefix) || tag.includes('..'))
        throw Error('Unexpected runtime release tag');
    const hint = tag.match(/-g([a-f0-9]{8,40})$/)?.[1];
    if (!hint)
        throw Error('Runtime release tag must bind a source commit');
    const targetCommitish = text(release.target_commitish, /^(?:main|[a-f0-9]{40})$/, 'release target commit', 40);
    const publishedAt = text(release.published_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/, 'publication date', 40);
    if (!Number.isFinite(Date.parse(publishedAt)))
        throw Error('Invalid publication date');
    if (!Array.isArray(release.assets) || release.assets.length < 5 || release.assets.length > 64)
        throw Error('Expected unique candidate, binary and corresponding-source assets');
    const repository = repositories[family], assets = new Map<string, Asset>();
    for (const input of release.assets) {
        const item = record(input, 'release asset'), name = text(item.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'release asset name', 200);
        if (name.includes('..') || assets.has(name))
            throw Error('Duplicate or unsafe release asset');
        const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
        if (item.browser_download_url !== url)
            throw Error('Release asset URL must match its fixed repository, tag and name');
        assets.set(name, Object.freeze({
            name, url, size: size(item.size, 32 * 1024 ** 3, 'release asset size')
        }));
    }
    const assetPrefix = family === 'nexus' ? 'nexus-runtime-' : 'nexus-runtime-cachyos-';
    const binary = [...assets.values()].filter(item => item.name.startsWith(assetPrefix) && new RegExp('^' + assetPrefix + '[0-9][A-Za-z0-9._-]*-g([a-f0-9]{8,40})-x86_64\\.tar\\.xz$').test(item.name));
    if (binary.length !== 1)
        throw Error('Expected one exact family binary archive');
    const name = binary[0].name, archiveHint = name.match(/-g([a-f0-9]{8,40})-x86_64\.tar\.xz$/)![1];
    if (hint !== archiveHint)
        throw Error('Runtime archive and release tag source commits differ');
    const base = name.slice(0, -'-x86_64.tar.xz'.length);
    const get = (name: string, max: number) => {
        const asset = assets.get(name);
        if (!asset)
            throw Error('Missing corresponding runtime asset: ' + name);
        size(asset.size, max, 'runtime asset size');
        return asset;
    };
    const selected = Object.freeze({
        candidate: get('candidate.json', maxMetadata), binary: get(name, 8 * 1024 ** 3), checksum: get(base + '-x86_64.sha512sum', maxChecksum), source: get(base + '-source.tar.xz', 32 * 1024 ** 3), sourceChecksum: get(base + '-source.sha512sum', maxChecksum)
    });
    const result = Object.freeze({
        family, repository, tag, commitHint: hint, arch: 'x64' as const, targetCommitish, prerelease, publishedAt, assets: selected, installedVersions: Object.freeze({
            launcher, backend
        })
    });
    selectedReleases.add(result);
    return result;
}
/** Bind candidate metadata to already selected fixed release assets. The family
 * manifest is authenticated later through the verified archive bytes and full
 * payload validation; candidate.json does not contain its standalone hash. */
function verifyManagedFamilyCandidateMode(bytes: unknown, selected: unknown, local: boolean): Readonly<VerifiedManagedFamilyRelease> {
    if (!selected || typeof selected !== 'object' || !selectedReleases.has(selected))
        throw Error('Candidate requires a locally verified release descriptor');
    const release = selected as Readonly<ManagedFamilyRelease>;
    if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes))
        throw Error('Candidate must be bounded UTF-8 JSON bytes');
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    if (raw.length !== release.assets.candidate.size || raw.length > maxMetadata)
        throw Error('Candidate metadata size mismatch');
    const json = raw.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(raw))
        throw Error('Invalid candidate UTF-8');
    const candidate = record(JSON.parse(json), 'runtime candidate');
    if (candidate.schema !== 1 || candidate.kind !== 'runtime' || candidate.repository !== release.repository || candidate.ref !== 'refs/heads/main')
        throw Error('Candidate must match the selected main runtime repository');
    const commit = text(candidate.commit, /^[a-f0-9]{40}$/, 'candidate source commit', 40);
    if (release.targetCommitish !== 'main' && release.targetCommitish !== commit)
        throw Error('Candidate differs from release target commit');
    if (!commit.startsWith(release.commitHint))
        throw Error('Candidate commit differs from release tag and archive');
    let runId: string | undefined, localBuildId: string | undefined;
    if (local) {
        // Provenance mode is selected by the trusted import entrypoint, never by
        // these flags. They only prove that the candidate is an honest local,
        // non-promotable build and must not claim a CI run.
        if (candidate.localBuild !== true || candidate.diagnosticOnly !== true || candidate.promotable !== false)
            throw Error('Local candidate requires localBuild=true, diagnosticOnly=true and promotable=false');
        if (Object.hasOwn(candidate, 'runId'))
            throw Error('Local candidate must not contain a CI run ID');
        if (candidate.localBuildId !== undefined)
            localBuildId = text(candidate.localBuildId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'local build ID', 128);
    }
    else {
        runId = text(candidate.runId, /^[1-9][0-9]*$/, 'candidate run ID', 16);
        size(Number(runId), Number.MAX_SAFE_INTEGER, 'candidate run ID');
    }
    const graph = record(candidate.sourceGraph, 'candidate source graph');
    if (graph.proton !== commit)
        throw Error('Candidate Proton source graph mismatch');
    text(graph.wine, /^[a-f0-9]{40}$/, 'Wine source commit', 40);
    text(graph.xgameruntime, /^[a-f0-9]{40}$/, 'XGameRuntime source commit', 40);
    const freeze = (value: unknown, depth = 0): void => {
        if (depth > 32)
            throw Error('Candidate source graph is too deep');
        if (value && typeof value === 'object') {
            for (const child of Object.values(value))
                freeze(child, depth + 1);
            Object.freeze(value);
        }
    };
    freeze(graph);
    const sourceGraph = graph;
    const requiresLauncherVersion = version(candidate.requiresLauncherVersion, 'required launcher version'), requiresBackendVersion = version(candidate.requiresBackendVersion, 'required backend version');
    if (!sufficient(release.installedVersions.launcher, requiresLauncherVersion))
        throw Error('Update the launcher before installing this runtime');
    if (!sufficient(release.installedVersions.backend, requiresBackendVersion))
        throw Error('Update the backend before installing this runtime');
    const expected = new Map([release.assets.binary, release.assets.checksum, release.assets.source, release.assets.sourceChecksum].map(item => [item.name, item]));
    if (!Array.isArray(candidate.files) || candidate.files.length !== 4)
        throw Error('Candidate must bind the exact binary and source asset pairs');
    const files = candidate.files.map(input => {
        const file = record(input, 'candidate file'), name = file.name;
        if (typeof name !== 'string' || !expected.has(name))
            throw Error('Unexpected or duplicate candidate file');
        const asset = expected.get(name)!;
        expected.delete(name);
        if (size(file.size, 32 * 1024 ** 3, 'candidate file size') !== asset.size)
            throw Error('Candidate file size differs from release asset');
        return Object.freeze({
            name, size: asset.size, sha256: sha(file.sha256, 'candidate file SHA-256')
        });
    });
    const validation = record(candidate.validation, 'candidate validation metadata');
    if (validation.nativeGateCount !== 12)
        throw Error('Expected twelve native validation gate records');
    const evidence = Object.freeze({
        nativeGateCount: 12 as const, treeSha256: sha(validation.treeSha256, 'validation tree hash'), resultsSha256: sha(validation.resultsSha256, 'validation results hash'), realGameTest: flag(validation.realGameTest, 'real-game metadata flag'), stableApproved: flag(validation.stableApproved, 'stable approval metadata flag')
    });
    return Object.freeze({
        ...release, commit, ...(local ? { local: true as const, localBuildId } : { runId }), candidateSha256: createHash('sha256').update(raw).digest('hex'), files: Object.freeze(files), requiresLauncherVersion, requiresBackendVersion, sourceGraph, validation: evidence
    });
}
/** Published-network entrypoint. It always requires a nonzero CI run ID and
 * never switches to local validation because candidate JSON contains local flags. */
export function verifyManagedFamilyCandidate(bytes: unknown, selected: unknown): Readonly<VerifiedManagedFamilyRelease> {
    return verifyManagedFamilyCandidateMode(bytes, selected, false);
}
/** Trusted local-import entrypoint. The caller must set this mode explicitly;
 * candidate JSON can only satisfy or fail the local provenance contract. */
export function verifyLocalManagedFamilyCandidate(bytes: unknown, selected: unknown): Readonly<VerifiedManagedFamilyRelease> {
    return verifyManagedFamilyCandidateMode(bytes, selected, true);
}
