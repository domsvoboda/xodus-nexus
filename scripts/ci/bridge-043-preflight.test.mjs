import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  BRIDGE_BASE, BRIDGE_PRODUCT, BRIDGE_REF, BRIDGE_VERSION, CI_SUPPORT_FILES, FROZEN_PRODUCT_FILES,
  assertCiSupportOnly, assertExactProductPatch, assertOnlyVersionsChanged, assertVersionMetadata,
  assertBridgeRequest, parseNameStatus, parseRequest, verifyBridgeCheckout,
} from './bridge-043-preflight.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const MAIN_GUARD = "github.ref == 'refs/heads/main' && !contains(github.event.head_commit.message, '[source-only]')";
const BRIDGE_GUARD = "steps.bridge.outputs.candidate == 'true' && github.ref == 'refs/heads/fix/launcher-repo-bridge-0411'";
const CANDIDATE_GUARD = `(${MAIN_GUARD}) || (${BRIDGE_GUARD})`;
const SOURCE_CHECK_GUARD = "steps.bridge.outputs.candidate != 'true' && (github.ref != 'refs/heads/main' || contains(github.event.head_commit.message, '[source-only]'))";
const HEAD = 'c'.repeat(40);
const workflow = async () => yaml.load(await fs.readFile('.github/workflows/ci.yml', 'utf8'));
const dispatch = ref => ({ requested: 'true', eventName: 'workflow_dispatch', ref });
const PRODUCT_DIFF = 'M\tpackage-lock.json\nM\tpackage.json\nA\tsrc/main/backend-releases.test.ts\nM\tsrc/main/backend-package.ts\nM\tsrc/main/launcher-update.test.ts\nM\tsrc/main/launcher-update.ts\nA\tsrc/main/release-repositories.ts\n';
const SUPPORT_DIFF = 'M\t.github/workflows/ci.yml\nA\tscripts/ci/bridge-043-preflight.mjs\nA\tscripts/ci/bridge-043-preflight.test.mjs\nM\tscripts/ci/main-only-builds.test.mjs\n';

test('the maintenance candidate requires an explicit manual dispatch of the exact branch', () => {
  for (const value of [undefined, null, '', 'false']) assert.equal(parseRequest(value), false);
  assert.equal(parseRequest('true'), true);
  assert.throws(() => parseRequest('yes'), /must be a boolean input/);
  assert.equal(assertBridgeRequest(dispatch(BRIDGE_REF)), true);
  assert.equal(assertBridgeRequest({ requested: '', eventName: 'push', ref: 'refs/heads/main' }), false);
  assert.equal(assertBridgeRequest({ requested: false, eventName: 'pull_request', ref: 'refs/pull/1/merge' }), false);
  assert.throws(() => assertBridgeRequest({ ...dispatch(BRIDGE_REF), eventName: 'push' }), /manual workflow_dispatch only/);
  assert.throws(() => assertBridgeRequest({ ...dispatch(BRIDGE_REF), eventName: 'pull_request' }), /manual workflow_dispatch only/);
  for (const ref of ['refs/heads/main', 'refs/heads/develop', 'refs/tags/v0.4.2', 'refs/pull/1/merge']) {
    assert.throws(() => assertBridgeRequest(dispatch(ref)), /requires refs\/heads\/fix\/launcher-repo-bridge-0411/);
  }
  assert.equal(BRIDGE_REF, 'refs/heads/fix/launcher-repo-bridge-0411');
});

test('the workflow keeps main-only candidates by default and disables the bridge flag', async () => {
  const ci = await workflow();
  const inputs = ci.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ['architecture', 'bridge_043_candidate']);
  assert.deepEqual(inputs.architecture.options, ['both', 'x64']);
  assert.equal(inputs.architecture.default, 'both');
  assert.equal(inputs.bridge_043_candidate.type, 'boolean');
  assert.equal(inputs.bridge_043_candidate.default, false);
  assert.deepEqual(ci.on.push.branches, ['main', 'develop']);
  assert.ok(ci.on.pull_request);
  const steps = ci.jobs.checks.steps;
  const preflight = steps.findIndex(step => step.id === 'bridge');
  assert.equal(steps[preflight].run, 'node scripts/ci/bridge-043-preflight.mjs');
  assert.equal(steps[preflight].env.BRIDGE_043_REQUESTED, "${{ inputs.bridge_043_candidate || 'false' }}");
  const install = steps.findIndex(step => step.run === 'npm ci');
  assert.ok(preflight >= 0 && preflight < install, 'the maintenance guard must run before dependency installation');
  const candidates = steps.filter(step => [step.run === 'npm run build', step.run?.includes('electron-builder'), step.run?.includes('artifact-manifest.mjs'), step.uses?.startsWith('actions/upload-artifact')].some(Boolean));
  assert.equal(candidates.length, 4);
  for (const step of candidates) assert.equal(step.if, CANDIDATE_GUARD);
  const source = steps.find(step => step.name === 'Check source without compiling a distribution candidate');
  assert.equal(source.if, SOURCE_CHECK_GUARD);
});

test('the guard pins the released base, the accepted product commit, version and frozen hashes', () => {
  assert.equal(BRIDGE_BASE, 'a87145e3c698b3b5d77c113d7f2e77beb308c73a');
  assert.equal(BRIDGE_PRODUCT, 'd6d0d21dac59644dc9d1ba060bfe6100d85d6fee');
  assert.equal(BRIDGE_VERSION, '0.4.3');
  assert.deepEqual(Object.keys(FROZEN_PRODUCT_FILES).sort(), [
    'package-lock.json', 'package.json', 'src/main/backend-package.ts', 'src/main/backend-releases.test.ts',
    'src/main/launcher-update.test.ts', 'src/main/launcher-update.ts', 'src/main/release-repositories.ts',
  ]);
  assert.deepEqual(FROZEN_PRODUCT_FILES, {
    'package-lock.json': '24fb314ab82efa99b5114fe18ff620b29e42f51759ed409e7289c59fc3c8794a',
    'package.json': '34a866832005cf426370c1727923922a5d1e4f4a382684697d49ca477a9a69b8',
    'src/main/backend-package.ts': 'a3b9f6c6cb1d2678b74a9b7d52aa00d93bf12ec8fa2431c3523d1c3551fad8bf',
    'src/main/backend-releases.test.ts': '09892d6eece19b578f83eeaebc9fb4a1faaf01d2be5f9b432905e49e1de82007',
    'src/main/launcher-update.test.ts': 'd08db51707cbedb075bb95d34e277d462fe837a62eb40fb84cfff32b04b96a79',
    'src/main/launcher-update.ts': '735952fec95174ac5be547c4b05ed88de2d2c0b634567854139009bc13ac8773',
    'src/main/release-repositories.ts': '79eeb34b9eed81d71e0ab063c8bcd65e8ba257e84c2309b69915edc29183607e',
  });
  assert.deepEqual([...CI_SUPPORT_FILES], [
    '.github/workflows/ci.yml', 'scripts/ci/bridge-043-preflight.mjs', 'scripts/ci/bridge-043-preflight.test.mjs',
    'scripts/ci/main-only-builds.test.mjs',
  ]);
  assert.ok(BRIDGE_GUARD.includes(BRIDGE_REF));
  assert.doesNotMatch(CANDIDATE_GUARD, /inputs\.bridge_043_candidate/);
  assert.doesNotMatch(CANDIDATE_GUARD, /refs\/tags|refs\/pull/);
});

test('the product patch must be exactly the accepted seven files with accepted bytes', () => {
  const changes = parseNameStatus(PRODUCT_DIFF);
  const hashes = Object.fromEntries(Object.keys(FROZEN_PRODUCT_FILES).map(file => [file, FROZEN_PRODUCT_FILES[file]]));
  assertExactProductPatch({ changes, hashes });
  assert.throws(() => assertExactProductPatch({ changes: changes.filter(change => change.path !== 'src/main/release-repositories.ts'), hashes }), /differs from the accepted seven files/);
  assert.throws(() => assertExactProductPatch({ changes: [...changes, { status: 'M', path: 'src/App.tsx' }], hashes }), /differs from the accepted seven files/);
  assert.throws(() => assertExactProductPatch({ changes: changes.map(change => change.path === 'src/main/launcher-update.ts' ? { ...change, status: 'D' } : change), hashes }), /must not delete or retype/);
  assert.throws(() => assertExactProductPatch({ changes, hashes: { ...hashes, 'src/main/launcher-update.ts': '0'.repeat(64) } }), /content differs from the accepted hashes/);
  assert.throws(() => parseNameStatus('R100\tsrc/a.ts\tsrc/b.ts'), /Unsupported git diff entry/);
});

test('the candidate commit must contain exactly the four approved CI support files', () => {
  const approved = parseNameStatus(SUPPORT_DIFF);
  assertCiSupportOnly({ changes: approved });
  const mismatched = /CI support files differ from the approved set/;
  for (const file of CI_SUPPORT_FILES) {
    assert.throws(() => assertCiSupportOnly({ changes: approved.filter(change => change.path !== file) }), mismatched, `missing ${file}`);
  }
  assert.throws(() => assertCiSupportOnly({ changes: [...approved, { status: 'M', path: 'src/main/launcher-update.ts' }] }), mismatched);
  assert.throws(() => assertCiSupportOnly({ changes: [...approved, { status: 'A', path: 'scripts/ci/other-helper.mjs' }] }), mismatched);
  assert.throws(() => assertCiSupportOnly({ changes: parseNameStatus(SUPPORT_DIFF.replace('M\t.github/workflows/ci.yml', 'D\t.github/workflows/ci.yml')) }), /must not delete or retype/);
});

test('the approved CI set matches the actual pending or committed change set', () => {
  // Derived from the real repository state, so an accidental fifth path or a
  // forgotten support file fails here instead of in a hand-written fixture.
  const git = args => execFileSync('git', args, { encoding: 'utf8' });
  // Dependency trees are never candidate content. The .gitignore pattern for a
  // node_modules directory does not match a locally linked node_modules, so it is
  // filtered explicitly instead of making the fixture environment-dependent.
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n').filter(Boolean).filter(file => !file.split('/').includes('node_modules'));
  const changes = [
    ...parseNameStatus(git(['diff', '--name-status', '--no-renames', '--no-ext-diff', '--no-textconv', BRIDGE_PRODUCT])),
    ...untracked.map(file => ({ status: 'A', path: file })),
  ];
  assert.deepEqual(changes.map(({ path: file }) => file).sort(), [...CI_SUPPORT_FILES].sort());
  assert.deepEqual(parseNameStatus(SUPPORT_DIFF).map(({ path: file }) => file).sort(), changes.map(({ path: file }) => file).sort());
  assertCiSupportOnly({ changes });
});

test('version metadata is pinned and nothing else may change around it', () => {
  const packageJson = { name: 'xodus-nexus', version: '0.4.3', description: 'launcher' };
  const packageLock = { name: 'xodus-nexus', version: '0.4.3', lockfileVersion: 3, packages: { '': { name: 'xodus-nexus', version: '0.4.3', dependencies: { a: '1.0.0' } } } };
  assertVersionMetadata({ packageJson: JSON.stringify(packageJson), packageLock: JSON.stringify(packageLock) });
  assert.throws(() => assertVersionMetadata({ packageJson: JSON.stringify({ ...packageJson, version: '0.4.2' }), packageLock: JSON.stringify(packageLock) }), /package\.json version must be 0\.4\.3/);
  assert.throws(() => assertVersionMetadata({ packageJson: JSON.stringify(packageJson), packageLock: JSON.stringify({ ...packageLock, version: '0.4.2' }) }), /package-lock\.json version must be 0\.4\.3/);
  const rootMismatch = structuredClone(packageLock);
  rootMismatch.packages[''].version = '0.4.2';
  assert.throws(() => assertVersionMetadata({ packageJson: JSON.stringify(packageJson), packageLock: JSON.stringify(rootMismatch) }), /root package version must be 0\.4\.3/);
  const basePackage = { ...packageJson, version: '0.4.2' };
  const baseLock = structuredClone(packageLock);
  baseLock.version = '0.4.2';
  baseLock.packages[''].version = '0.4.2';
  assertOnlyVersionsChanged({ basePackage, headPackage: packageJson, baseLock, headLock: packageLock });
  assert.throws(() => assertOnlyVersionsChanged({ basePackage, headPackage: { ...packageJson, description: 'changed' }, baseLock, headLock: packageLock }), /may only change its version/);
  const bumpedDependency = structuredClone(packageLock);
  bumpedDependency.packages[''].dependencies.a = '2.0.0';
  assert.throws(() => assertOnlyVersionsChanged({ basePackage, headPackage: packageJson, baseLock, headLock: bumpedDependency }), /may only change its version fields/);
});

async function repositoryFixture() {
  // The checked-out transition files are the accepted bytes, so their hashes are
  // the real frozen hashes from the reviewed evidence.
  const frozen = new Map(await Promise.all(Object.keys(FROZEN_PRODUCT_FILES).map(async file => [file, await fs.readFile(file)])));
  const headPackage = JSON.parse(frozen.get('package.json').toString('utf8'));
  const headLock = JSON.parse(frozen.get('package-lock.json').toString('utf8'));
  const basePackage = { ...structuredClone(headPackage), version: '0.4.2' };
  const baseLock = structuredClone(headLock);
  baseLock.version = '0.4.2';
  baseLock.packages[''].version = '0.4.2';
  const refs = new Map([['HEAD', HEAD], [`${BRIDGE_PRODUCT}^`, BRIDGE_BASE], ['refs/tags/v0.4.2^{commit}', BRIDGE_BASE]]);
  const diffs = new Map([[`${BRIDGE_BASE} ${BRIDGE_PRODUCT}`, PRODUCT_DIFF], [`${BRIDGE_PRODUCT} ${HEAD}`, SUPPORT_DIFF]]);
  const blobs = new Map();
  for (const [file, bytes] of frozen) {
    blobs.set(`${BRIDGE_PRODUCT}:${file}`, bytes);
    blobs.set(`${HEAD}:${file}`, bytes);
  }
  blobs.set(`${BRIDGE_BASE}:package.json`, Buffer.from(JSON.stringify(basePackage)));
  blobs.set(`${BRIDGE_BASE}:package-lock.json`, Buffer.from(JSON.stringify(baseLock)));
  const git = {
    resolve: revision => {
      const value = refs.get(revision);
      if (value === undefined) throw Error(`unknown revision ${revision}`);
      return value;
    },
    tryResolve: revision => refs.get(revision) ?? null,
    isAncestor: (ancestor, descendant) => ancestor === BRIDGE_PRODUCT && descendant === HEAD,
    diff: (from, to) => {
      const value = diffs.get(`${from} ${to}`);
      if (value === undefined) throw Error(`unknown diff ${from}..${to}`);
      return value;
    },
    blob: (commit, file) => {
      const value = blobs.get(`${commit}:${file}`);
      if (!value) throw Error(`unknown blob ${commit}:${file}`);
      return value;
    },
  };
  return { git, refs, diffs, blobs };
}

test('a requested candidate is accepted only for the accepted base, patch and CI support files', async () => {
  const { git } = await repositoryFixture();
  assert.deepEqual(verifyBridgeCheckout({ request: dispatch(BRIDGE_REF), sha: HEAD, git }), {
    candidate: true, base: BRIDGE_BASE, product: BRIDGE_PRODUCT, commit: HEAD, ref: BRIDGE_REF,
  });
  const untouched = new Proxy({}, { get() { throw Error('git must not be inspected for skipped candidates'); } });
  assert.deepEqual(verifyBridgeCheckout({ request: { requested: '', eventName: 'push', ref: 'refs/heads/main' }, sha: HEAD, git: untouched }), { candidate: false });
});

test('a stale, unexpected or drifted checkout is rejected before any build', async () => {
  const request = dispatch(BRIDGE_REF);
  const wrongHead = await repositoryFixture();
  assert.throws(() => verifyBridgeCheckout({ request, sha: 'd'.repeat(40), git: wrongHead.git }), /differs from GITHUB_SHA/);
  const wrongParent = await repositoryFixture();
  wrongParent.refs.set(`${BRIDGE_PRODUCT}^`, 'e'.repeat(40));
  assert.throws(() => verifyBridgeCheckout({ request, sha: HEAD, git: wrongParent.git }), /direct child of the released 0\.4\.2 base/);
  const drifted = await repositoryFixture();
  drifted.git.isAncestor = () => false;
  assert.throws(() => verifyBridgeCheckout({ request, sha: HEAD, git: drifted.git }), /does not contain the accepted product commit/);
  const movedTag = await repositoryFixture();
  movedTag.refs.set('refs/tags/v0.4.2^{commit}', 'f'.repeat(40));
  assert.throws(() => verifyBridgeCheckout({ request, sha: HEAD, git: movedTag.git }), /no longer points at the accepted base commit/);
  const noTag = await repositoryFixture();
  noTag.refs.delete('refs/tags/v0.4.2^{commit}');
  assert.equal(verifyBridgeCheckout({ request, sha: HEAD, git: noTag.git }).candidate, true);
  const extraSource = await repositoryFixture();
  extraSource.diffs.set(`${BRIDGE_PRODUCT} ${HEAD}`, SUPPORT_DIFF + 'M\tsrc/main/launcher-update.ts');
  assert.throws(() => verifyBridgeCheckout({ request, sha: HEAD, git: extraSource.git }), /CI support files differ from the approved set/);
  const driftedProduct = await repositoryFixture();
  driftedProduct.blobs.set(`${BRIDGE_PRODUCT}:src/main/launcher-update.ts`, Buffer.from('// drifted\n'));
  assert.throws(() => verifyBridgeCheckout({ request, sha: HEAD, git: driftedProduct.git }), /content differs from the accepted hashes/);
  const wrongVersion = await repositoryFixture();
  wrongVersion.blobs.set(`${HEAD}:package.json`, Buffer.from(JSON.stringify({ ...JSON.parse(wrongVersion.blobs.get(`${HEAD}:package.json`).toString('utf8')), version: '0.4.2' })));
  assert.throws(() => verifyBridgeCheckout({ request, sha: HEAD, git: wrongVersion.git }), /package\.json version must be 0\.4\.3/);
  const changedLock = await repositoryFixture();
  const changed = JSON.parse(changedLock.blobs.get(`${HEAD}:package-lock.json`).toString('utf8'));
  changed.packages[''].dependencies.i18next = '0.0.0';
  changedLock.blobs.set(`${HEAD}:package-lock.json`, Buffer.from(JSON.stringify(changed)));
  assert.throws(() => verifyBridgeCheckout({ request, sha: HEAD, git: changedLock.git }), /may only change its version fields/);
});
