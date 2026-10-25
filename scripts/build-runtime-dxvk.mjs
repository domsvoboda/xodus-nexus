// SPDX-License-Identifier: MIT
// Rebuild the base's exact DXVK revision with its pinned compiler backport.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const dxvkComponents=['d3d8.dll','d3d9.dll','d3d10core.dll','d3d11.dll','dxgi.dll'];
const expectedPaths={dxvk:'dxvk-src',compiler:'dxvk-src/subprojects/dxbc-spirv',compilerSpirv:'dxvk-src/subprojects/dxbc-spirv/submodules/spirv_headers',
  directx:'dxvk-src/include/native/directx',vulkan:'dxvk-src/include/vulkan',spirv:'dxvk-src/include/spirv',
  display:'dxvk-src/subprojects/libdisplay-info',meson:'dxvk-tools/meson',ninja:'dxvk-tools/ninja'};
export function validateDxvkLock(lock,base){
  if(lock.schema!==1||lock.baseProtonCommit!==base.commit||
    Object.keys(lock.sources??{}).sort().join()!==Object.keys(expectedPaths).sort().join()||
    !/^[a-f0-9]{64}$/.test(lock.patch?.sha256??'')||lock.patch.file!=='assets/dxbc-spirv-constant-compare.patch'||
    !/^[a-f0-9]{64}$/.test(lock.expectedCompilerSource??''))throw Error('Invalid DXVK source lock');
  for(const [name,source] of Object.entries(lock.sources))
    if(source.path!==expectedPaths[name]||!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(source.url)||
      !/^[a-f0-9]{40}$/.test(source.commit))throw Error(`Invalid DXVK source: ${name}`);
}
// PE targets: the x86_64 set uses the tree's own cross file and GCC MinGW;
// `arm64ec` uses llvm-mingw's arm64ec wrappers, so the result loads into the
// ARM64EC processes that x86_64 games become on the arm64 Proton base. The
// source, patch and compiler unit tests are identical for both.
export const dxvkTargets=['x86_64','arm64ec'];
export function dxvkCrossFile(target){
  if(target==='x86_64')return null;
  if(target!=='arm64ec')throw Error(`Unsupported DXVK target: ${target}`);
  const prefix='arm64ec-w64-mingw32';
  return `[binaries]\nc = '${prefix}-clang'\ncpp = '${prefix}-clang++'\nar = '${prefix}-ar'\nstrip = '${prefix}-strip'\nwindres = '${prefix}-windres'\n\n`+
    `[properties]\nneeds_exe_wrapper = true\n\n[host_machine]\nsystem = 'windows'\ncpu_family = 'aarch64'\ncpu = 'arm64ec'\nendian = 'little'\n`;
}
/** True when the PE's load config carries CHPE metadata (an ARM64EC image). */
export function hasChpeMetadata(loadConfigText){
  const line=loadConfigText.split('\n').find(l=>l.includes('CHPEMetadataPointer'));
  return Boolean(line)&&!/:\s*0x0*\s*$/.test(line)&&!/:\s*0\s*$/.test(line);
}
export async function buildRuntimeDxvk(parent,output,jobs='4',target='x86_64'){
  const bytes=await fs.readFile(path.join(project,'scripts/runtime-dxvk.lock.json'));
  const lock=JSON.parse(bytes),base=JSON.parse(await fs.readFile(path.join(project,'scripts/runtime-base.lock.json'),'utf8'));
  validateDxvkLock(lock,base);
  if(!dxvkTargets.includes(target))throw Error(`Unsupported DXVK target: ${target}`);
  if(!/^[1-9][0-9]?$/.test(String(jobs)))throw Error('Invalid DXVK build job count');
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const hash=async file=>sha(await fs.readFile(file));
  if(await hash(path.join(project,lock.patch.file))!==lock.patch.sha256)throw Error('DXVK patch checksum mismatch');
  const root=path.join(parent,'dxvk');
  await fs.mkdir(root); // Never reuse a partially built or user-supplied tree.
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(?:LD_|CPATH$|LIBRARY_PATH$|WINE|XODUS_|XUSER_|STEAM_COMPAT_|SteamAppId$|SteamGameId$)/.test(key))delete env[key];
  const run=(command,args,cwd=root,capture=false)=>execFileSync(command,args,{cwd,env,encoding:capture?'utf8':undefined,
    stdio:capture?['ignore','pipe','pipe']:'inherit',maxBuffer:32*1024*1024});
  for(const [name,source] of Object.entries(lock.sources)){
    const target=path.join(root,source.path);
    await fs.mkdir(target,{recursive:true});
    run('git',['init','--quiet',target]);
    run('git',['-C',target,'fetch','--depth','1','--no-tags',source.url,source.commit]);
    run('git',['-C',target,'checkout','--quiet','--detach','FETCH_HEAD']);
    if(run('git',['-C',target,'rev-parse','HEAD'],root,true).trim()!==source.commit||
      run('git',['-C',target,'status','--porcelain'],root,true).trim())throw Error(`Dirty DXVK input: ${name}`);
    if(source.path.startsWith('dxvk-src/')){
      const owner=name==='compilerSpirv'?lock.sources.compiler.path:lock.sources.dxvk.path;
      const relative=source.path.slice(owner.length+1);
      if(!run('git',['-C',path.join(root,owner),'ls-tree','HEAD','--',relative],root,true)
        .startsWith(`160000 commit ${source.commit}\t`))throw Error(`DXVK submodule pin mismatch: ${name}`);
    }
  }
  const source=path.join(root,'dxvk-src'),compiler=path.join(source,'subprojects/dxbc-spirv');
  run('git',['apply','--check',path.join(project,lock.patch.file)],source);
  run('git',['apply',path.join(project,lock.patch.file)],source);
  if(await hash(path.join(compiler,'ir/passes/ir_pass_arithmetic.cpp'))!==lock.expectedCompilerSource)
    throw Error('Patched DXVK compiler source does not match its lock');
  const ninjaRoot=path.join(root,'dxvk-tools/ninja');
  run('python3',['configure.py','--bootstrap'],ninjaRoot);
  env.PATH=`${ninjaRoot}${path.delimiter}${env.PATH??''}`;
  const meson=path.join(root,'dxvk-tools/meson/meson.py');
  const native=path.join(root,'compiler-native');
  run('python3',[meson,'setup',native,compiler,'--wrap-mode=nodownload','--buildtype=debugoptimized',
    '-Db_ndebug=false','-Denable_tests=true','-Denable_tools=false',
    `-Dcpp_args=-I${path.join(source,'include/spirv/include')}`]);
  run(path.join(ninjaRoot,'ninja'),['-C',native,`-j${jobs}`,'tests/test_dxbc_spv']);
  const tested=spawnSync(path.join(native,'tests/test_dxbc_spv'),[],{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024});
  const upstreamTests=(tested.stdout??'')+(tested.stderr??'');
  await fs.writeFile(path.join(root,'compiler-unit.log'),upstreamTests);
  if(tested.status!==0||!/Tests run: [1-9][0-9]*, failed: 0(?:\r?\n|$)/.test(upstreamTests))throw Error('DXVK compiler unit regressions failed');
  const probe=path.join(root,'shader-compare-probe');
  run('g++',['-std=c++17','-O2','-fno-exceptions','-I',compiler,
    path.join(project,'scripts/runtime-tests/shader-compare-probe.cpp'),path.join(native,'libdxbc_spv.a'),'-o',probe]);
  const regression=run(probe,[],root,true);
  if(!/SHADER CHECKS [1-9][0-9]* FAILURES 0/.test(regression))throw Error('DXVK constant-comparison regression failed');
  await fs.writeFile(path.join(root,'shader-compare.log'),regression);
  const build=path.join(root,'windows-build'),stage=path.join(root,'stage');
  let crossFile=path.join(source,'build-win64.txt');
  if(target!=='x86_64'){crossFile=path.join(root,`build-${target}.txt`);await fs.writeFile(crossFile,dxvkCrossFile(target),{flag:'wx'});}
  run('python3',[meson,'setup',build,source,'--cross-file',crossFile,
    '--wrap-mode=nodownload','--buildtype=release','-Db_ndebug=false',`--prefix=${stage}`,'--bindir=x64','--libdir=x64']);
  run(path.join(ninjaRoot,'ninja'),['-C',build,`-j${jobs}`,'install']);
  const components={};
  for(const name of dxvkComponents){
    const file=path.join(stage,'x64',name);
    // ARM64EC images carry the AMD64 machine type; their CHPE metadata tells them apart.
    if(!/PE32\+ executable.*x86-64/.test(run('file',['-b',file],root,true)))throw Error(`Not a 64-bit DXVK component: ${name}`);
    if(target==='arm64ec'&&!hasChpeMetadata(run('llvm-readobj',['--coff-load-config',file],root,true)))throw Error(`Not an ARM64EC DXVK component: ${name}`);
    const imports=run(target==='x86_64'?'x86_64-w64-mingw32-objdump':'llvm-objdump',['-p',file],root,true);
    if(/DLL Name: (?:libstdc\+\+|libgcc|libwinpthread|libc\+\+|libunwind)/i.test(imports))throw Error(`Nonportable DXVK import: ${name}`);
    await fs.copyFile(file,path.join(output,name),fs.constants.COPYFILE_EXCL);
    components[name]=await hash(file);
  }
  for(const [from,to] of [['LICENSE','DXVK-LICENSE'],['subprojects/dxbc-spirv/LICENSE','DXBC-SPIRV-LICENSE'],
    ['subprojects/libdisplay-info/LICENSE','DXVK-display-LICENSE'],['include/native/directx/COPYING.MinGW-w64.txt','DXVK-directx-LICENSE']])
    await fs.copyFile(path.join(source,from),path.join(output,to));
  for(const [from,to] of [['include/vulkan/LICENSE.md','DXVK-Vulkan-LICENSE'],['include/spirv/LICENSE','DXVK-SPIRV-LICENSE']])
    await fs.copyFile(path.join(source,from),path.join(output,to));
  const manifest={sourceLockSha256:sha(bytes),version:lock.version,target,sources:lock.sources,patch:lock.patch,
    verifiedCompilerSource:lock.expectedCompilerSource,components,compilerTests:upstreamTests.trim().split('\n').at(-1),regression:regression.trim()};
  await fs.writeFile(path.join(output,'dxvk-source-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length<5||process.argv.length>6)throw Error('Usage: build-runtime-dxvk.mjs WORK_PARENT NEW_COMPONENTS_DIRECTORY JOBS [x86_64|arm64ec]');
  await fs.mkdir(path.resolve(process.argv[3]),{recursive:true});
  await buildRuntimeDxvk(path.resolve(process.argv[2]),path.resolve(process.argv[3]),process.argv[4],process.argv[5]??'x86_64');
}
