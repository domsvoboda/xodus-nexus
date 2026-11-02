// Fetch the pinned backend fork and delegate packaging to its owned recipe.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export function validateBackendSource(lock, configBytes, cargoBytes, commit) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (lock.schema !== 2 || lock.repository !== 'https://github.com/domsvoboda/nexus-backend.git' ||
      !/^[a-f0-9]{40}$/.test(lock.commit ?? '') || commit !== lock.commit ||
      hash(configBytes) !== lock.buildConfigSha256 || hash(cargoBytes) !== lock.cargoLockSha256)
    throw Error('Backend source lock mismatch');
  const config = JSON.parse(configBytes);
  if (config.schema !== 1 || config.repository !== 'domsvoboda/nexus-backend' || config.authUi !== 'electron' ||
      config.version !== lock.version || config.rust !== lock.rust || config.cargoLockSha256 !== lock.cargoLockSha256 ||
      config.compatibility !== lock.compatibility) throw Error('Backend build configuration mismatch');
}
async function main() {
  const args=process.argv.slice(2);
  const option=(name,fallback)=>{const i=args.indexOf(name);if(i<0)return fallback;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`Missing ${name}`);return args[i+1];};
  const root=fileURLToPath(new URL('../',import.meta.url));
  const lock=JSON.parse(await fs.readFile(path.join(root,'assets/backend-source.lock.json'),'utf8'));
  const work=path.resolve(option('--work','backend-build'));
  const output=path.resolve(option('--output','backend-release'));
  const target=path.resolve(option('--target-dir',path.join(work,'target')));
  // A local mirror may replace network transport, never the locked identity.
  const repository=option('--repository',lock.repository);
  await fs.mkdir(work);
  const source=path.join(work,'source');
  const run=(cmd,args,capture=false)=>execFileSync(cmd,args,{stdio:capture?'pipe':'inherit',encoding:'utf8'});
  run('git',['clone','--no-checkout','--no-hardlinks','--no-local',repository,source]);
  run('git',['-C',source,'checkout','--detach',lock.commit]);
  validateBackendSource(lock,await fs.readFile(path.join(source,'build-config.json')),await fs.readFile(path.join(source,'Cargo.lock')),
    run('git',['-C',source,'rev-parse','HEAD'],true).trim());
  run(process.execPath,[path.join(source,'scripts/build-backend.mjs'),'--work',path.join(work,'build'),'--output',output,
    '--target-dir',target,...(args.includes('--offline')?['--offline']:[])]);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
