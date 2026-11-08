import { expect, it } from 'vitest';
import { parseManagedFamilyRelease, verifyLocalManagedFamilyCandidate, verifyManagedFamilyCandidate } from './runtime-family-release';
// Sanitized public c070 release metadata, no download or native execution.
function fixture(family = 'nexus-cachyos') {
    const commit = 'c0702eafb4ff4043c54e38bc5028ea77fa6a9487', repository = 'domsvoboda/' + (family === 'nexus' ? 'nexus-runtime' : 'nexus-runtime-cachyos');
    const prefix = family === 'nexus' ? 'nexus-runtime' : 'nexus-runtime-cachyos', tag = (family === 'nexus' ? 'runtime' : 'runtime-cachyos') + '-11.0-20261103-gc0702eaf', base = prefix + '-11.0-experimental-gc0702eaf';
    const files = [{
            name: base + '-x86_64.tar.xz', sha256: 'aaa55320834ce53e1b238badebbea339aaaf5ead4aeb2707e7dd17144cc493fb', size: 401327524
        }, {
            name: base + '-x86_64.sha512sum', sha256: '6ad003d38ce978fe7ede9fcdbf147c39b584cb4caa058022329667cead51701e', size: 194
        }, {
            name: base + '-source.tar.xz', sha256: 'd75d7d496762dce28a1da596573398c238c6ea3403bd08cb1fdc7b55bcee2a6e', size: 862538548
        }, {
            name: base + '-source.sha512sum', sha256: 'ac146584bdb7a5a15e15f58cbfba1e139d788a51b3de655f629fb3dcf6187284', size: 194
        }];
    const candidate: any = {
        schema: 1, kind: 'runtime', repository, commit, ref: 'refs/heads/main', runId: '41623159548', files, sourceGraph: {
            proton: commit, wine: 'e449547994748ef9688a9b38ccb5dbb9dd4ba3ee', xgameruntime: '78780314332079f77052fbeb345b6f7e11e7a44d'
        }, requiresBackendVersion: '0.2.13', requiresLauncherVersion: '0.4.1', validation: {
            nativeGateCount: 12, treeSha256: '2cdce736bcd0234638fdcf9183c0a885bcf69eb2ec2159602025ec7fc9d0313d', resultsSha256: '45e2389a1fccec9613733bccafc89335eed48f31dafbaadf8132e4487c2c872f', realGameTest: false, stableApproved: false
        }
    };
    const release: any = {
        tag_name: tag, target_commitish: commit, draft: false, prerelease: true, published_at: '2026-11-03T12:43:55Z', assets: []
    };
    const policy: any = {
        arch: 'x64', allowCachyos: true, allowPrerelease: true, launcherVersion: '0.4.2', backendVersion: '0.2.14'
    };
    const sync = () => {
        const bytes = JSON.stringify(candidate);
        release.assets = [{
                name: 'candidate.json', size: Buffer.byteLength(bytes)
            }, ...files.map(file => ({
                name: file.name, size: file.size
            }))].map(file => ({
            ...file, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${file.name}`
        }));
        return bytes;
    };
    const bytes = sync();
    return {
        family, release, policy, candidate, bytes, sync, parse: () => parseManagedFamilyRelease(family, release, policy)
    };
}
it('accepts the actual c070 binary/source metadata contract offline without claiming native or stable approval', () => {
    const f = fixture(), selected = f.parse(), verified = verifyManagedFamilyCandidate(f.bytes, selected);
    expect(verified.commit).toBe(f.candidate.commit);
    expect(verified.files).toHaveLength(4);
    expect(verified.validation.nativeGateCount).toBe(12);
    expect(verified.validation.realGameTest).toBe(false);
    expect(verified.validation.stableApproved).toBe(false);
    expect(verified.candidateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.files[0])).toBe(true);
});
it('supports the standard fixed-repository contract as a synthetic future manifest release, without CachyOS opt-in', () => {
    const f = fixture('nexus');
    f.policy.allowCachyos = false;
    expect(verifyManagedFamilyCandidate(f.bytes, f.parse()).family).toBe('nexus');
});
it('requires distinct explicit CachyOS and prerelease permissions, and never accepts drafts', () => {
    for (const key of ['allowCachyos', 'allowPrerelease']) {
        const f = fixture();
        f.policy[key] = false;
        expect(() => f.parse()).toThrow('opt-in');
    }
    const f = fixture();
    f.release.draft = true;
    expect(() => f.parse()).toThrow('Draft');
});
it.each([undefined, null, [], true, 1, 'family'])('rejects non-object external release %s', value => {
    const f = fixture();
    expect(() => parseManagedFamilyRelease(f.family, value, f.policy)).toThrow();
});
it.each(['draft', 'prerelease'])('requires a real boolean %s', key => {
    for (const value of [undefined, 'false', 0, null]) {
        const f = fixture();
        f.release[key] = value;
        expect(() => f.parse()).toThrow();
    }
});
it.each(['allowCachyos', 'allowPrerelease'])('rejects truthy or absent policy %s', key => {
    for (const value of [undefined, 'true', 1, null]) {
        const f = fixture();
        f.policy[key] = value;
        expect(() => f.parse()).toThrow();
    }
});
it.each(['arm64', 'x86_64', '../nexus', undefined])('does not widen managed architecture %s', arch => {
    const f = fixture();
    f.policy.arch = arch;
    expect(() => f.parse()).toThrow('x64');
});
it.each(['../runtime', 'runtime-../x-gc0702eaf', 'runtime-cachyos-11%2f-gc0702eaf', 'runtime-cachyos-11-gc0702eaf?x', 'runtime-cachyos-11-gdeadbeef'])('rejects unsafe or mismatched tag %s', tag => {
    const f = fixture();
    f.release.tag_name = tag;
    expect(() => f.parse()).toThrow();
});
it.each(['https://evil.invalid/file', 'http://github.com/x', 'https://github.com/domsvoboda/nexus-runtime/releases/download/x/y', 'https://github.com:443/x', 'https://github.com@evil.invalid/x'])('rejects arbitrary asset origin/path %s', url => {
    const f = fixture();
    f.release.assets[1].browser_download_url = url;
    expect(() => f.parse()).toThrow('URL');
});
it('rejects duplicate assets, encoded traversal, query suffix and missing source pairs', () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => f.release.assets.push(f.release.assets[0]), (f: ReturnType<typeof fixture>) => f.release.assets[4] = f.release.assets[3], (f: ReturnType<typeof fixture>) => f.release.assets[1].name = '../escape', (f: ReturnType<typeof fixture>) => f.release.assets[1].browser_download_url += '?download=1', (f: ReturnType<typeof fixture>) => f.release.assets.pop()]) {
        const f = fixture();
        mutate(f);
        expect(() => f.parse()).toThrow();
    }
});
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '194', 33 * 1024 ** 3])('rejects invalid release size %s', value => {
    const f = fixture();
    f.release.assets[1].size = value;
    expect(() => f.parse()).toThrow('size');
});
it.each(['0.4', 'v0.4.2', '0.4.2-beta', '01.4.2', '0.4.NaN', '9999999.0.0', null])('validates installed version syntax %s before comparison', value => {
    const f = fixture();
    f.policy.launcherVersion = value;
    expect(() => f.parse()).toThrow('version');
});
it('does not accept a caller-forged or copied release descriptor', () => {
    const f = fixture(), selected = f.parse();
    expect(() => verifyManagedFamilyCandidate(f.bytes, {
        ...selected
    })).toThrow('locally verified');
    expect(() => verifyManagedFamilyCandidate(f.bytes, null)).toThrow();
});
it.each(['repository', 'commit', 'ref', 'kind', 'schema', 'runId'])('rejects candidate identity mismatch %s', key => {
    const f = fixture();
    f.candidate[key] = key === 'schema' ? 2 : 'invalid';
    const bytes = f.sync();
    expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow();
});
it('requires candidate source graph to bind exact Proton/Wine/XGR commits', () => {
    for (const key of ['proton', 'wine', 'xgameruntime']) {
        const f = fixture();
        f.candidate.sourceGraph[key] = 'd'.repeat(key === 'proton' ? 40 : 39);
        const bytes = f.sync();
        expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow();
    }
});
it('rejects missing, duplicate, foreign and size/hash-mismatched candidate file records', () => {
    const changes = [(f: ReturnType<typeof fixture>) => f.candidate.files.pop(), (f: ReturnType<typeof fixture>) => f.candidate.files[3] = f.candidate.files[2], (f: ReturnType<typeof fixture>) => f.candidate.files[0].name = 'foreign.tar.xz', (f: ReturnType<typeof fixture>) => f.candidate.files[0].sha256 = 'z'.repeat(64)];
    for (const mutate of changes) {
        const f = fixture();
        mutate(f);
        const bytes = JSON.stringify(f.candidate);
        f.release.assets[0].size = Buffer.byteLength(bytes);
        expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow();
    }
    const f = fixture();
    f.candidate.files[0].size++;
    const bytes = JSON.stringify(f.candidate);
    f.release.assets[0].size = Buffer.byteLength(bytes);
    expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow('size');
});
it.each(['nativeGateCount', 'treeSha256', 'resultsSha256', 'realGameTest', 'stableApproved'])('requires validation evidence shape %s without interpreting it as approval', key => {
    const f = fixture();
    f.candidate.validation[key] = key === 'nativeGateCount' ? 11 : key.endsWith('Sha256') ? 'bad' : 'false';
    const bytes = f.sync();
    expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow();
});
it('rejects malformed requirements and incompatible installed components', () => {
    for (const [key, value] of [['requiresLauncherVersion', '0.5.0'], ['requiresBackendVersion', '1.0.0'], ['requiresBackendVersion', 'bad']] as const) {
        const f = fixture();
        f.candidate[key] = value;
        const bytes = f.sync();
        expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow();
    }
});
it('rejects metadata size mismatch, malformed JSON and invalid UTF-8', () => {
    const f = fixture(), selected = f.parse();
    expect(() => verifyManagedFamilyCandidate(f.bytes + ' ', selected)).toThrow('size');
    expect(() => verifyManagedFamilyCandidate({}, selected)).toThrow('bytes');
    const bad = Buffer.alloc(f.release.assets[0].size, 0xff);
    expect(() => verifyManagedFamilyCandidate(bad, selected)).toThrow('UTF-8');
    expect(() => verifyManagedFamilyCandidate(' '.repeat(f.release.assets[0].size), selected)).toThrow();
});
it('binds the full release target when available, not only the short display commit', () => {
    const f = fixture();
    f.candidate.commit = 'c0702eaf' + 'd'.repeat(32);
    f.candidate.sourceGraph.proton = f.candidate.commit;
    const bytes = f.sync();
    expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow('target commit');
});
it('allows bounded ancillary release assets without weakening selected pair identity', () => {
    const f = fixture();
    f.release.assets.push({
        name: 'LICENSE', size: 100, browser_download_url: f.release.assets[0].browser_download_url.replace('candidate.json', 'LICENSE')
    });
    expect(verifyManagedFamilyCandidate(f.bytes, f.parse()).files).toHaveLength(4);
});

it('accepts an honest no-CI local candidate only through the trusted local entrypoint', () => {
    const f = fixture();
    delete f.candidate.runId;
    f.candidate.localBuild = true;
    f.candidate.diagnosticOnly = true;
    f.candidate.promotable = false;
    const bytes = f.sync();
    const local = verifyLocalManagedFamilyCandidate(bytes, f.parse());
    expect(local.local).toBe(true);
    expect(local.runId).toBeUndefined();
    expect(local.validation.stableApproved).toBe(false);
    expect(() => verifyManagedFamilyCandidate(bytes, f.parse())).toThrow('Invalid candidate run ID');
});
it.each([
    ['localBuild', false], ['localBuild', undefined],
    ['diagnosticOnly', false], ['diagnosticOnly', undefined],
    ['promotable', true], ['promotable', undefined],
])('rejects a local candidate with %s=%s', (key, value) => {
    const f = fixture();
    delete f.candidate.runId;
    f.candidate.localBuild = true;
    f.candidate.diagnosticOnly = true;
    f.candidate.promotable = false;
    f.candidate[key] = value;
    const bytes = f.sync();
    expect(() => verifyLocalManagedFamilyCandidate(bytes, f.parse())).toThrow('localBuild=true');
});
it('rejects a CI runId on the local entrypoint and never lets local flags bypass the network entrypoint', () => {
    const f = fixture();
    f.candidate.localBuild = true;
    f.candidate.diagnosticOnly = true;
    f.candidate.promotable = false;
    const bytes = f.sync();
    expect(() => verifyLocalManagedFamilyCandidate(bytes, f.parse())).toThrow('must not contain a CI run ID');
    delete f.candidate.runId;
    const localBytes = f.sync();
    expect(() => verifyManagedFamilyCandidate(localBytes, f.parse())).toThrow('Invalid candidate run ID');
});
it('records an optional local build ID without inventing a CI run ID', () => {
    const f = fixture();
    delete f.candidate.runId;
    f.candidate.localBuild = true;
    f.candidate.diagnosticOnly = true;
    f.candidate.promotable = false;
    f.candidate.localBuildId = 'local-20261108-1';
    const local = verifyLocalManagedFamilyCandidate(f.sync(), f.parse());
    expect(local.localBuildId).toBe('local-20261108-1');
    expect(local.runId).toBeUndefined();
});
