// Manual promotion only: download and verify tested bytes, never rebuild.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { verifyManifest } from './artifact-manifest.mjs';
import { assertRuntimePromotion } from './runtime-promotion-policy.mjs';
import { releaseNotesRef, assertApprovedReleaseNotes } from './release-notes-policy.mjs';
const kind = process.env.CANDIDATE_KIND, runId = process.env.CANDIDATE_RUN;
const repo = process.env.GITHUB_REPOSITORY;
if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.APPROVE_RELEASE !== 'true') throw Error('Explicit main-branch release authorization required');
if (!['launcher', 'runtime', 'backend'].includes(kind) || !/^\d+$/.test(runId ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw Error('Invalid promotion selection');
const command = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const run = JSON.parse(command('gh', ['api', `repos/${repo}/actions/runs/${runId}`]));
const workflow = JSON.parse(command('gh', ['api', `repos/${repo}/actions/workflows/${run.workflow_id}`]));
const expectedWorkflow = kind === 'launcher' ? '.github/workflows/ci.yml' : `.github/workflows/${kind}.yml`;
if (run.conclusion !== 'success' || run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event) ||
    workflow.path !== expectedWorkflow || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) throw Error('Not a successful main candidate build');
command('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD']);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-promotion-'));
try {
  command('gh', ['run', 'download', runId, '--repo', repo, '--name', kind === 'launcher' ? 'launcher-candidate' : `nexus-${kind}`, '--dir', directory]);
  const manifest = await verifyManifest(directory, { kind, repository: repo, commit: run.head_sha, runId });
  const hash = createHash('sha256').update(await fs.readFile(path.join(directory, 'candidate.json'))).digest('hex');
  const approvals = JSON.parse(await fs.readFile('.github/release-validation.json', 'utf8'));
  const approval = approvals.schema === 1 && approvals.approvals?.find(item => item.kind === kind && item.runId === runId &&
    item.commit === run.head_sha && item.manifestSha256 === hash && item.approved === true && item.approvedBy === process.env.GITHUB_ACTOR &&
    typeof item.evidence === 'string' && item.evidence.trim().length > 0);
  if (!approval) throw Error('No recorded human validation for this exact artifact');
  let tag;
  if (kind === 'runtime') {
    const lock = JSON.parse(command('git', ['show', `${run.head_sha}:scripts/runtime-patches.lock.json`]));
    const at = (commit, file) => JSON.parse(command('git', ['show', `${commit}:${file}`]));
    assertRuntimePromotion(lock, at('HEAD', 'scripts/runtime-patches.lock.json'),
      at(run.head_sha, 'scripts/runtime-base.lock.json'), at('HEAD', 'scripts/runtime-base.lock.json'),
      at(run.head_sha, 'scripts/runtime-media.lock.json'), at('HEAD', 'scripts/runtime-media.lock.json'));
    const changed = command('git', ['diff', '--name-only', run.head_sha, 'HEAD', '--', 'assets/*.patch',
      'scripts/build-shared-runtime.mjs', 'scripts/assemble-shared-runtime.mjs', 'scripts/build-runtime-media.mjs',
      'scripts/runtime-tests', '.github/workflows/runtime.yml']).trim();
    if (changed) throw Error('Runtime build inputs changed after candidate validation');
    const archive = manifest.files.find(file => /-(?:x86_64|aarch64)\.tar\.xz$/.test(file.name));
    tag = archive.name.replace(/^xodus-nexus-runtime-/, 'runtime-').replace(/-(?:x86_64|aarch64)\.tar\.xz$/, '');
  } else if (kind === 'backend') {
    const lock = JSON.parse(command('git', ['show', `${run.head_sha}:assets/backend-source.lock.json`]));
    const recipeHash = createHash('sha256').update(command('git', ['show', `${run.head_sha}:assets/backend-source.lock.json`])).digest('hex');
    const metadataFiles = manifest.files.filter(file => file.name.endsWith('.manifest.json'));
    if (metadataFiles.length === 0) throw Error('Backend metadata missing');
    // One candidate may carry x86_64 and aarch64; each archive carries its own provenance.
    for (const file of metadataFiles) {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, file.name), 'utf8'));
      if (!/^\d+\.\d+\.\d+$/.test(lock.version) || metadata.version !== lock.version || metadata.commit !== lock.commit ||
          metadata.recipeSha256 !== recipeHash || metadata.compatibility !== lock.compatibility ||
          !['x64', 'arm64'].includes(metadata.arch) || metadata.platform !== 'linux' || metadata.authUi !== 'electron' ||
          metadata.archive !== `xodus-nexus-backend-${lock.version}-linux-${{x64:'x86_64',arm64:'aarch64'}[metadata.arch]}.tar.xz` ||
          file.name !== metadata.archive?.replace('.tar.xz', '.manifest.json')) throw Error('Backend recipe provenance mismatch');
      const checksumFile = manifest.files.find(entry => entry.name === metadata.archive?.replace('.tar.xz', '.sha512sum'));
      if (!checksumFile || (await fs.readFile(path.join(directory, checksumFile.name), 'utf8')).trim() !== `${metadata.archiveSha512}  ${metadata.archive}`) throw Error('Backend archive identity mismatch');
    }
    tag = `backend-v${lock.version}`;
  } else {
    const pkg = JSON.parse(command('git', ['show', `${run.head_sha}:package.json`]));
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error('Not a stable launcher version');
    tag = `v${pkg.version}`;
  }
  const notesPath = `.github/release-notes/${kind === 'runtime' ? 'runtime-signin-updates.md' : `${kind}-${kind === 'launcher' ? tag.slice(1) : tag.slice('backend-v'.length)}.md`}`;
  const notes = command('git', ['show', `${releaseNotesRef(kind, run.head_sha, approval)}:${notesPath}`]);
  assertApprovedReleaseNotes(notes, approval);
  // One new release per tag. Never edit an existing release or replace assets.
  try { command('gh', ['release', 'view', tag, '--repo', repo]); throw Error('Release already exists'); }
  catch (error) { if (!error.status) throw error; }
  command('gh', ['release', 'create', tag, '--repo', repo, '--target', run.head_sha,
    ...manifest.files.map(file => path.join(directory, file.name)), path.join(directory, 'candidate.json'),
    ...(kind === 'launcher' ? [] : ['--latest=false']),
    '--title', `Xodus Nexus ${kind} ${kind === 'backend' ? tag.slice('backend-v'.length) : tag}`, '--notes', notes]);
  console.log(`Promoted tested ${kind} candidate ${runId} as ${tag}; no rebuild performed.`);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
