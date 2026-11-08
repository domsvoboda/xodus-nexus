import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateBackendSource} from '../build-backend.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
test('backend pin owns no patch overlay and delegates recipe validation to the real source boundary',async()=>{
  const lock=JSON.parse(await fs.readFile('assets/backend-source.lock.json','utf8'));
  assert.equal(lock.schema,2);
  assert.equal(lock.repository,'https://github.com/domsvoboda/nexus-backend.git');
  assert.match(lock.commit,/^[a-f0-9]{40}$/);
  for(const key of ['cargoLockSha256','buildConfigSha256']) assert.match(lock[key],/^[a-f0-9]{64}$/);
  assert.equal(lock.patches,undefined);assert.equal(lock.patchId,undefined);
  assert.equal(lock.minimumVersion,'0.2.14');
  assert.ok(!(await fs.readdir('assets')).some(file=>/^xodus-.*\.patch$/.test(file)));
  const manager=await fs.readFile('src/main/backend.ts','utf8');
  const packageSource=await fs.readFile('src/main/backend-package.ts','utf8');
  const builder=await fs.readFile('scripts/build-backend.mjs','utf8');
  // The maintainer build validates the exact source recipe at the real clone boundary.
  assert.match(packageSource,/export const backendRecipeSha256 = backendLock\.buildConfigSha256;/);
  assert.ok(builder.indexOf('validateBackendSource(lock,') >= 0);
  assert.ok(builder.indexOf('validateBackendSource(lock,') < builder.indexOf("path.join(source,'scripts/build-backend.mjs')"));
  // The user-facing manager stays prebuilt-only: discover and install, never compile.
  assert.match(manager,/discoverBackend\(this\.fetcher\)/);
  assert.match(manager,/installBackend\(this\.managedRoot/);
  assert.doesNotMatch(manager,/async rebuild\s*\(|buildConfigSha256|backendLock\.patches|'apply'/);
});
test('delegated builds reject a different source or build recipe before executing it',()=>{
  const cargo=Buffer.from('locked dependencies');
  const config={schema:1,repository:'domsvoboda/nexus-backend',authUi:'electron',version:'0.2.15',rust:'1.99.0',
    cargoLockSha256:digest(cargo),compatibility:'linux-run-v25'};
  const bytes=Buffer.from(JSON.stringify(config));
  const lock={...config,schema:2,repository:'https://github.com/domsvoboda/nexus-backend.git',commit:'a'.repeat(40),buildConfigSha256:digest(bytes)};
  validateBackendSource(lock,bytes,cargo,lock.commit);
  for(const changed of [{commit:'b'.repeat(40)},{buildConfigSha256:'c'.repeat(64)},{cargoLockSha256:'d'.repeat(64)},
    {repository:'https://github.com/other/backend.git'},{version:'0.2.16'},{rust:'stable'},{compatibility:'other'}])
    assert.throws(()=>validateBackendSource({...lock,...changed},bytes,cargo,lock.commit));
  assert.throws(()=>validateBackendSource(lock,Buffer.from('{}'),cargo,lock.commit));
});
test('backend candidates and promotion belong to the backend repository',async()=>{
  await assert.rejects(fs.access('.github/workflows/backend.yml'));
  const release=await fs.readFile('.github/workflows/release.yml','utf8');
  assert.match(release,/options: \[launcher, runtime\]/);
  const promotion=await fs.readFile('scripts/ci/promote-candidate.mjs','utf8');
  assert.match(promotion,/!\['launcher', 'runtime'\].includes\(kind\)/);
});
test('launcher retains incomplete-update launch barriers and capability gates',async()=>{
  const state=await fs.readFile('src/main/installation-state.ts','utf8');
  assert.ok(state.includes("'.nexus-update-incomplete-v1'"));
  const source=await fs.readFile('src/main/index.ts','utf8');
  assert.match(source,/updateGame && !backend.current.capabilities.streamingUpdateRecovery/);
  assert.match(source,/if \(await refreshIncompleteUpdate\(game\)\)/);
});
