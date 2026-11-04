import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One-off maintenance candidate: the exact released launcher 0.4.2 plus the
// accepted seven-file repository-transition patch. Distribution candidates stay
// main-only, so this exception is reachable only through the explicit manual
// workflow_dispatch documented in .github/workflows/ci.yml, and it never claims
// main provenance: candidate metadata keeps the actual branch ref and commit.
export const BRIDGE_REF = 'refs/heads/fix/launcher-repo-bridge-0411';
export const BRIDGE_BASE = 'a87145e3c698b3b5d77c113d7f2e77beb308c73a';
export const BRIDGE_PRODUCT = 'd6d0d21dac59644dc9d1ba060bfe6100d85d6fee';
export const BRIDGE_VERSION = '0.4.3';
export const BASE_TAG = 'v0.4.2';

// Frozen bytes of the independently reviewed transition patch. These hashes are
// the accepted ROOT-VERIFICATION.json values; the guard refuses to build a
// candidate whose product files differ from them.
export const FROZEN_PRODUCT_FILES = Object.freeze({
  'package-lock.json': '24fb314ab82efa99b5114fe18ff620b29e42f51759ed409e7289c59fc3c8794a',
  'package.json': '34a866832005cf426370c1727923922a5d1e4f4a382684697d49ca477a9a69b8',
  'src/main/backend-package.ts': 'a3b9f6c6cb1d2678b74a9b7d52aa00d93bf12ec8fa2431c3523d1c3551fad8bf',
  'src/main/backend-releases.test.ts': '09892d6eece19b578f83eeaebc9fb4a1faaf01d2be5f9b432905e49e1de82007',
  'src/main/launcher-update.test.ts': 'd08db51707cbedb075bb95d34e277d462fe837a62eb40fb84cfff32b04b96a79',
  'src/main/launcher-update.ts': '735952fec95174ac5be547c4b05ed88de2d2c0b634567854139009bc13ac8773',
  'src/main/release-repositories.ts': '79eeb34b9eed81d71e0ab063c8bcd65e8ba257e84c2309b69915edc29183607e',
});

// The only tracked files the maintenance workflow change may add on top of the
// frozen product patch. Exact paths, no wildcards, and the candidate commit must
// contain exactly this set: a new tool needs a new review.
export const CI_SUPPORT_FILES = Object.freeze([
  '.github/workflows/ci.yml',
  'scripts/ci/bridge-043-preflight.mjs',
  'scripts/ci/bridge-043-preflight.test.mjs',
  'scripts/ci/main-only-builds.test.mjs',
]);

/** A boolean workflow input reaches the runner as 'true' or 'false'. */
export function parseRequest(value) {
  if (value === undefined || value === null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw Error(`bridge_043_candidate must be a boolean input, received ${JSON.stringify(String(value))}`);
}

/** The exception is valid only for an explicit manual dispatch of the exact branch. */
export function assertBridgeRequest({ requested, eventName, ref }) {
  if (!parseRequest(requested)) return false;
  if (eventName !== 'workflow_dispatch') throw Error(`The 0.4.3 bridge candidate is manual workflow_dispatch only, received ${eventName}`);
  if (ref !== BRIDGE_REF) throw Error(`The 0.4.3 bridge candidate requires ${BRIDGE_REF}, received ${ref}`);
  return true;
}

/** Parse `git diff --name-status --no-renames` output. */
export function parseNameStatus(output) {
  return output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [status, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!/^[AMDTUXB]$/.test(status ?? '') || !file) throw Error(`Unsupported git diff entry: ${line}`);
    return { status, path: file };
  });
}

function difference(actual, expected) {
  const extra = actual.filter(value => !expected.includes(value));
  const missing = expected.filter(value => !actual.includes(value));
  return [...extra.map(value => `+${value}`), ...missing.map(value => `-${value}`)].join(', ');
}

/** The released base may only be followed by the accepted seven product files. */
export function assertExactProductPatch({ changes, hashes }) {
  if (changes.some(({ status }) => status !== 'A' && status !== 'M')) throw Error('The accepted product patch must not delete or retype tracked files');
  const actual = changes.map(({ path: file }) => file).sort();
  const expected = Object.keys(FROZEN_PRODUCT_FILES).sort();
  if (!isDeepStrictEqual(actual, expected)) throw Error(`Product patch differs from the accepted seven files: ${difference(actual, expected)}`);
  const mismatched = expected.filter(file => hashes[file] !== FROZEN_PRODUCT_FILES[file]);
  if (mismatched.length) throw Error(`Product patch content differs from the accepted hashes: ${mismatched.join(', ')}`);
}

/** Everything added after the product commit must be exactly this CI exception. */
export function assertCiSupportOnly({ changes }) {
  if (changes.some(({ status }) => status !== 'A' && status !== 'M')) throw Error('The maintenance candidate must not delete or retype tracked files');
  const actual = changes.map(({ path: file }) => file).sort();
  const expected = [...CI_SUPPORT_FILES].sort();
  if (!isDeepStrictEqual(actual, expected)) throw Error(`Maintenance candidate CI support files differ from the approved set: ${difference(actual, expected)}`);
}

export function assertVersionMetadata({ packageJson, packageLock }) {
  const manifest = JSON.parse(packageJson);
  const lock = JSON.parse(packageLock);
  if (manifest.version !== BRIDGE_VERSION) throw Error(`Maintenance candidate package.json version must be ${BRIDGE_VERSION}, received ${manifest.version}`);
  if (lock.version !== BRIDGE_VERSION) throw Error(`Maintenance candidate package-lock.json version must be ${BRIDGE_VERSION}, received ${lock.version}`);
  if (lock.packages?.['']?.version !== BRIDGE_VERSION) throw Error(`Maintenance candidate package-lock.json root package version must be ${BRIDGE_VERSION}, received ${lock.packages?.['']?.version}`);
}

/** Strip the three permitted version fields so everything else must stay identical. */
export function withoutVersionFields(document, lock) {
  const copy = structuredClone(document);
  delete copy.version;
  if (lock && copy.packages && Object.hasOwn(copy.packages, '')) {
    copy.packages[''] = { ...copy.packages[''] };
    delete copy.packages[''].version;
  }
  return copy;
}

/** No dependency, product, branding or build metadata may change around the version bump. */
export function assertOnlyVersionsChanged({ basePackage, headPackage, baseLock, headLock }) {
  if (!isDeepStrictEqual(withoutVersionFields(basePackage), withoutVersionFields(headPackage)))
    throw Error('Maintenance candidate package.json may only change its version');
  if (!isDeepStrictEqual(withoutVersionFields(baseLock, true), withoutVersionFields(headLock, true)))
    throw Error('Maintenance candidate package-lock.json may only change its version fields');
}

/**
 * Fail-closed verification of a requested maintenance candidate.
 * `git` exposes resolve, tryResolve, isAncestor, diff and blob.
 */
export function verifyBridgeCheckout({ request, sha, git }) {
  if (!assertBridgeRequest(request)) return { candidate: false };
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Maintenance candidate requires the exact GITHUB_SHA');
  if (git.resolve('HEAD') !== sha) throw Error('Checked out commit differs from GITHUB_SHA');
  if (git.resolve(`${BRIDGE_PRODUCT}^`) !== BRIDGE_BASE) throw Error('Accepted product commit is not the direct child of the released 0.4.2 base');
  if (!git.isAncestor(BRIDGE_PRODUCT, sha)) throw Error('Maintenance candidate does not contain the accepted product commit');
  const published = git.tryResolve(`refs/tags/${BASE_TAG}^{commit}`);
  if (published && published !== BRIDGE_BASE) throw Error(`Published ${BASE_TAG} no longer points at the accepted base commit`);
  const productChanges = parseNameStatus(git.diff(BRIDGE_BASE, BRIDGE_PRODUCT));
  assertExactProductPatch({
    changes: productChanges,
    hashes: Object.fromEntries(Object.keys(FROZEN_PRODUCT_FILES).map(file => [file, sha256(git.blob(BRIDGE_PRODUCT, file))])),
  });
  assertCiSupportOnly({ changes: parseNameStatus(git.diff(BRIDGE_PRODUCT, sha)) });
  assertVersionMetadata({ packageJson: git.blob(sha, 'package.json').toString('utf8'), packageLock: git.blob(sha, 'package-lock.json').toString('utf8') });
  assertOnlyVersionsChanged({
    basePackage: JSON.parse(git.blob(BRIDGE_BASE, 'package.json')),
    headPackage: JSON.parse(git.blob(sha, 'package.json')),
    baseLock: JSON.parse(git.blob(BRIDGE_BASE, 'package-lock.json')),
    headLock: JSON.parse(git.blob(sha, 'package-lock.json')),
  });
  return { candidate: true, base: BRIDGE_BASE, product: BRIDGE_PRODUCT, commit: sha, ref: BRIDGE_REF };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// A syntactically valid full hash can be echoed by `git rev-parse --verify`
// without the object being present, so history preparation must never trust
// that check. These revisions need real commit objects before validation.
export const REQUIRED_HISTORY = Object.freeze([BRIDGE_BASE, BRIDGE_PRODUCT]);

/**
 * Prepare the object graph for a requested maintenance candidate only.
 * A shallow clone is always deepened: its grafts can hide the pinned commits,
 * their parent chain or the ancestry path even when one object happens to exist.
 * A complete clone that lacks a pinned object gets one bounded fetch.
 */
export function ensureHistory({ required = REQUIRED_HISTORY, isShallow, hasCommit, fetch }) {
  const missing = () => required.filter(revision => !hasCommit(revision));
  let action = 'none';
  if (isShallow()) {
    fetch({ unshallow: true });
    action = 'unshallow';
  } else if (missing().length) {
    fetch({ unshallow: false });
    action = 'fetch';
  }
  const unavailable = missing();
  if (unavailable.length) throw Error(`Pinned commit objects are unavailable after history preparation: ${unavailable.join(', ')}`);
  return { action };
}

/** Production entry: skipped candidates must not touch Git history or fetch. */
export function runPreflight({ request, sha, git, history }) {
  if (!assertBridgeRequest(request)) return { candidate: false };
  ensureHistory(history);
  return verifyBridgeCheckout({ request, sha, git });
}

export function createRepositoryGit({ cwd } = {}) {
  const prefix = cwd ? ['-C', cwd] : [];
  const run = (args, options = {}) => execFileSync('git', [...prefix, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  return {
    resolve: revision => run(['rev-parse', '--verify', revision]).trim(),
    tryResolve: revision => {
      try { return run(['rev-parse', '--verify', revision]).trim(); } catch { return null; }
    },
    // Requires the actual commit object; unlike rev-parse this cannot echo a
    // missing hash from a shallow checkout.
    hasCommit: revision => {
      try { run(['cat-file', '-e', `${revision}^{commit}`]); return true; } catch { return false; }
    },
    isAncestor: (ancestor, descendant) => {
      try { run(['merge-base', '--is-ancestor', ancestor, descendant]); return true; } catch { return false; }
    },
    diff: (from, to) => run(['diff', '--name-status', '--no-renames', '--no-ext-diff', '--no-textconv', from, to]),
    blob: (commit, file) => run(['show', `${commit}:${file}`], { encoding: null }),
  };
}

/** Real history seam for the maintenance entry point. */
export function createRepositoryHistory({ cwd, git = createRepositoryGit({ cwd }) } = {}) {
  const prefix = cwd ? ['-C', cwd] : [];
  return {
    isShallow: () => execFileSync('git', [...prefix, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true',
    hasCommit: revision => git.hasCommit(revision),
    fetch: ({ unshallow }) => execFileSync('git', [...prefix, 'fetch', '--no-recurse-submodules', '--tags', ...(unshallow ? ['--unshallow'] : []), 'origin'], { stdio: ['ignore', 'inherit', 'inherit'] }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const git = createRepositoryGit();
    const request = { requested: process.env.BRIDGE_043_REQUESTED, eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF };
    const result = runPreflight({ request, sha: process.env.GITHUB_SHA, git, history: createRepositoryHistory({ git }) });
    const output = `candidate=${result.candidate}\n`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
    if (result.candidate) console.log(`Maintenance candidate accepted: ${result.commit} from ${result.base} with accepted patch ${result.product}`);
    else console.log('No maintenance candidate requested; the main-only launcher candidate rules apply');
  } catch (error) {
    console.error(`Maintenance candidate rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
