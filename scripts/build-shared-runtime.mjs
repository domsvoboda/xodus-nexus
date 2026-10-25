#!/usr/bin/env node
// Reconstruct the shared development runtime from pinned Git objects only.
// Never reads a user's game/prefix/account or updates the active runtime.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCompatibility } from './runtime-compat/build.mjs';
import { buildPlayFabSessionProbe } from './runtime-tests/build-playfab-session.mjs';
import { buildStoreProbes } from './runtime-tests/build-store-probes.mjs';
import { buildSaveSyncProbe } from './runtime-tests/build-gamesave-sync-probe.mjs';
import { buildUserAudioProbe } from './runtime-tests/build-user-audio-probe.mjs';
import { buildUserPrivilegeProbe } from './runtime-tests/build-user-privilege-probe.mjs';
import { buildRuntimeDxvk } from './build-runtime-dxvk.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockBytes = await fs.readFile(path.join(project, 'scripts/runtime-patches.lock.json'));
const lock = JSON.parse(lockBytes);
const dxvkLockBytes = await fs.readFile(path.join(project, 'scripts/runtime-dxvk.lock.json'));
if (createHash('sha256').update(dxvkLockBytes).digest('hex') !== lock.dxvkSourceLockSha256) throw new Error('DXVK source lock checksum mismatch');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--prepare-only') options.prepareOnly = true;
  else if (['--work', '--jobs', '--wine-mirror', '--xgameruntime-mirror', '--nghttp2-mirror', '--vkd3d-mirror', '--vulkan-headers-mirror', '--spirv-headers-mirror', '--base-runtime', '--media-archive'].includes(key)) {
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = process.argv[++i];
  } else throw new Error(`Unknown argument ${key}`);
}
if (!options.work) throw new Error('Usage: node scripts/build-shared-runtime.mjs --work NEW_DIRECTORY [--jobs 4] [--base-runtime PROTON_DIRECTORY] [--media-archive PINNED_FFMPEG_TARBALL] [--prepare-only] [--wine-mirror GIT_REPO] [--xgameruntime-mirror GIT_REPO] [--nghttp2-mirror GIT_REPO]');
const work = path.resolve(options.work);
const jobs = options.jobs ?? '4';
if (!/^[1-9][0-9]?$/.test(jobs)) throw new Error('jobs must be 1..99');
const env = { ...process.env };
// Editors/AppImages may inject incompatible libraries into compiler utilities.
for (const name of ['LD_LIBRARY_PATH', 'WINEPREFIX', 'WINEDLLPATH', 'XODUS_SOCKET', 'XODUS_BRIDGE_KEY', 'XODUS_BRIDGE_PORT']) delete env[name];
function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: capture ? 'utf8' : undefined, maxBuffer: 32 * 1024 * 1024 });
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function shaFile(file) { return sha(await fs.readFile(file)); }
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function checkout(name, target) {
  const source = lock.sources[name];
  await fs.mkdir(target, { recursive: true });
  run('git', ['init', '--quiet', target], work);
  // Mirrors supply Git objects, never working-tree files or build artifacts.
  const remote = options[`${name}-mirror`] ? await fs.realpath(options[`${name}-mirror`]) : source.url;
  run('git', ['-C', target, 'fetch', '--depth', '1', '--no-tags', remote, source.commit], work);
  run('git', ['-C', target, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], work);
  if (run('git', ['-C', target, 'rev-parse', 'HEAD'], work, true).trim() !== source.commit ||
      run('git', ['-C', target, 'status', '--porcelain'], work, true).trim()) throw new Error(`Not a clean pinned ${name} checkout`);
}
if (await exists(work)) throw new Error(`Refusing to overwrite an existing work directory: ${work}`);
run('perl', ['-MJSON', '-e', '1'], project);
// Verify exports before doing any clone/build. A mismatch is never forced.
for (const patch of lock.patches) {
  if (await shaFile(path.join(project, patch.file)) !== patch.sha256) throw new Error(`Patch checksum mismatch: ${patch.file}`);
}
const compatibilitySources = ['scripts/runtime-compat/build.mjs', 'scripts/runtime-compat/playfab-save-folder.c',
  'scripts/runtime-compat/playfab-session.c', 'scripts/runtime-compat/playfab-session.h',
  'scripts/runtime-compat/playfab-save-folder.def', 'scripts/runtime-compat/wine-launcher.c',
  'scripts/runtime-compat/gaming-services-version.c'];
if (Object.keys(lock.runtimeCompatibilitySources ?? {}).sort().join() !== compatibilitySources.sort().join())
  throw new Error('Missing or unknown runtime compatibility source lock');
for (const [file, expected] of Object.entries(lock.runtimeCompatibilitySources)) {
  if (await shaFile(path.join(project, file)) !== expected) throw new Error(`Runtime compatibility source checksum mismatch: ${file}`);
}
await fs.mkdir(work, { recursive: true });
const source = path.join(work, 'wine-src');
const ngSource = path.join(work, 'nghttp2-src');
const ngBuild = path.join(work, 'nghttp2-build');
const shaderSource = path.join(work, 'vkd3d-src');
const shaderBuild = path.join(work, 'vkd3d-build');
const shaderStage = path.join(work, 'vkd3d-stage');
const vulkanHeaders = path.join(work, 'vulkan-headers');
const spirvHeaders = path.join(work, 'spirv-headers');
const build = path.join(work, 'wine-build');
await checkout('wine', source);
await checkout('xgameruntime', path.join(source, 'dlls/xgameruntime'));
await checkout('nghttp2', ngSource);
await checkout('vkd3d', shaderSource);
await checkout('vulkan-headers', vulkanHeaders);
await checkout('spirv-headers', spirvHeaders);
for (const patch of lock.patches) {
  console.log(`Applying ${patch.file}`);
  if (patch.repository && patch.repository !== 'vkd3d') throw new Error(`Unknown patch repository: ${patch.repository}`);
  const target = patch.repository === 'vkd3d' ? shaderSource : source;
  run('git', ['apply', '--check', path.join(project, patch.file)], target);
  run('git', ['apply', path.join(project, patch.file)], target);
}
for (const [relative, expected] of Object.entries(lock.expectedXgameruntimeSources)) {
  if (await shaFile(path.join(source, relative)) !== expected) throw new Error(`Source reproduction mismatch: ${relative}`);
}
for (const [relative, expected] of Object.entries(lock.expectedWineSources ?? {})) {
  if (await shaFile(path.join(source, relative)) !== expected) throw new Error(`Source reproduction mismatch: ${relative}`);
}
for (const [relative, expected] of Object.entries(lock.expectedVkd3dSources ?? {})) {
  if (await shaFile(path.join(shaderSource, relative)) !== expected) throw new Error(`Source reproduction mismatch: ${relative}`);
}
const provenance = {
  schema: 1, status: lock.status, sourceLockSha256: sha(lockBytes), sources: lock.sources,
  patches: lock.patches, verifiedXgameruntimeSources: lock.expectedXgameruntimeSources,
  verifiedWineSources: lock.expectedWineSources ?? {},
  verifiedVkd3dSources: lock.expectedVkd3dSources ?? {},
  requiresBackendVersion: lock.requiresBackendVersion,
  limitations: lock.limitations, components: {},
  runtimeCompatibilitySources: lock.runtimeCompatibilitySources,
  configure: ['--enable-win64', '--without-x', '--without-wayland', '--disable-tests'],
  toolchain: Object.fromEntries(['gcc', 'x86_64-w64-mingw32-gcc', 'cmake', 'make', 'autoconf', 'automake', 'libtoolize', 'widl', 'bison', 'flex'].map(tool => [tool, run(tool, [tool === 'widl' ? '-V' : '--version'], work, true).trim().split('\n')[0]])),
};
await fs.writeFile(path.join(work, 'source-manifest.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
console.log(`All ${Object.keys(lock.expectedXgameruntimeSources).length} modified/added xgameruntime source files match their source locks.`);
if (options.prepareOnly) process.exit(0);

// Use the exact external shader compiler and headers pinned by the base
// Proton, never Wine's older bundled fallback or a system/latest library.
// Proton builds a release-style source snapshot without .git. Preserve the
// checkout metadata separately so its diagnostic suffix does not change CTAB
// creator strings or otherwise-identical shader bytecode.
await fs.rename(path.join(shaderSource, '.git'), path.join(work, 'vkd3d-git-metadata'));
run('autoreconf', ['-fiv'], shaderSource);
await fs.mkdir(shaderBuild);
const shaderConfigure = ['--host=x86_64-w64-mingw32', '--enable-shared', '--disable-static',
  '--disable-tests', '--disable-demos', '--without-opengl', '--without-xcb',
  '--without-ncurses', '--without-spirv-tools', `--prefix=${shaderStage}`];
run('env', ['SONAME_LIBVULKAN=vulkan-1', `CPPFLAGS=-I${path.join(vulkanHeaders, 'include')} -I${path.join(spirvHeaders, 'include')}`,
  'CFLAGS=-O2 -fno-lto', 'LDFLAGS=-static-libgcc', path.join(shaderSource, 'configure'), ...shaderConfigure], shaderBuild);
run('make', [`-j${jobs}`], shaderBuild);
run('make', ['install'], shaderBuild);
run('cmake', ['-S', ngSource, '-B', ngBuild, '-DCMAKE_SYSTEM_NAME=Windows', '-DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc', '-DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres', '-DENABLE_LIB_ONLY=ON', '-DBUILD_SHARED_LIBS=ON', '-DBUILD_STATIC_LIBS=OFF', '-DENABLE_DOC=OFF', '-DENABLE_APP=OFF', '-DENABLE_EXAMPLES=OFF', '-DENABLE_FAILMALLOC=OFF', '-DBUILD_TESTING=OFF'], work);
run('cmake', ['--build', ngBuild, '--parallel', jobs], work);
// Wine makedep resolves includes under Wine/include. No private sibling paths.
await fs.mkdir(path.join(source, 'include/nghttp2'));
await fs.copyFile(path.join(ngSource, 'lib/includes/nghttp2/nghttp2.h'), path.join(source, 'include/nghttp2/nghttp2.h'));
await fs.copyFile(path.join(ngBuild, 'lib/includes/nghttp2/nghttp2ver.h'), path.join(source, 'include/nghttp2/nghttp2ver.h'));
run('python3', ['make_vulkan', '-x', 'vk.xml', '-X', 'video.xml'], path.join(source, 'dlls/winevulkan'));
run('perl', ['tools/make_specfiles'], source);
run('autoreconf', ['-fiv'], source);
await fs.mkdir(build);
run(path.join(source, 'configure'), provenance.configure, build);
run('make', [`-j${jobs}`, 'dlls/xgameruntime/x86_64-windows/xgameruntime.dll', 'dlls/winhttp/x86_64-windows/winhttp.dll', 'dlls/mscoree/x86_64-windows/mscoree.dll', 'dlls/windows.web/x86_64-windows/windows.web.dll', 'dlls/twinapi.appcore/x86_64-windows/twinapi.appcore.dll'], build);
const shaderDll = path.join(shaderBuild, '.libs/libvkd3d-shader-1.dll');
// Match Proton's builtin-module marker, retaining its unchanged WineD3D and
// vkd3d core/utils DLLs. Only the separate shader compiler is overlaid.
run(path.join(build, 'tools/winebuild/winebuild'), ['--builtin', shaderDll], work);
const components = path.join(work, 'components');
await fs.mkdir(components);
const outputs = {
  'libvkd3d-shader-1.dll': shaderDll,
  'xgameruntime.dll': path.join(build, 'dlls/xgameruntime/x86_64-windows/xgameruntime.dll'),
  'winhttp.dll': path.join(build, 'dlls/winhttp/x86_64-windows/winhttp.dll'),
  'mscoree.dll': path.join(build, 'dlls/mscoree/x86_64-windows/mscoree.dll'),
  // XUser parses endpoint/auth replies through Windows.Data.Json. Stock
  // Proton may expose these interfaces but return E_NOTIMPL from Parse.
  'windows.web.dll': path.join(build, 'dlls/windows.web/x86_64-windows/windows.web.dll'),
  'twinapi.appcore.dll': path.join(build, 'dlls/twinapi.appcore/x86_64-windows/twinapi.appcore.dll'),
  'libnghttp2.dll': path.join(ngBuild, 'lib/libnghttp2.dll'),
};
for (const [name, file] of Object.entries(outputs)) {
  if (!/PE32\+ executable.*x86-64/.test(run('file', ['-b', file], work, true))) throw new Error(`Not a 64-bit Windows DLL: ${name}`);
  await fs.copyFile(file, path.join(components, name));
  provenance.components[name] = await shaFile(file);
}
const tests = path.join(work, 'tests');
provenance.runtimeCompatibility = await buildCompatibility(components);
await fs.mkdir(tests);
run('x86_64-w64-mingw32-gcc', ['-D__WINESRC__', '-municode', '-O2', '-Wall', '-Wextra',
  '-I', path.join(build, 'dlls/xgameruntime'), '-I', path.join(source, 'dlls/xgameruntime'),
  '-I', path.join(build, 'include'), '-I', path.join(source, 'include'),
  path.join(project, 'scripts/runtime-tests/game-relaunch-probe.c'), '-o', path.join(tests, 'game-relaunch-probe.exe')], work);
for (const constrained of [false, true]) for (const fixture of [false, true]) run('x86_64-w64-mingw32-gcc', ['-O2', '-Wall', '-Wextra', '-Werror',
  ...(constrained ? ['-DAPPCONSTRAINED_PROBE'] : []),
  ...(fixture ? ['-DAPPSTATE_SOURCE_FIXTURE', '-I', path.join(source, 'dlls/twinapi.appcore')] : []),
  path.join(project, 'scripts/runtime-tests/appstate-probe.c'), '-o', path.join(tests,
    `${constrained ? 'appconstrained' : 'appstate'}${fixture ? '-source' : ''}-probe.exe`), '-lruntimeobject'], work);
run('x86_64-w64-mingw32-gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(project, 'scripts/runtime-tests/hlsl-state-keywords-probe.c'), '-o', path.join(tests, 'hlsl-state-keywords-probe.exe')], work);
// Account-free SDK fixture lives only in tests, never in the shipped runtime.
const pgsTests = path.join(tests, 'playfab-folder');
await fs.mkdir(pgsTests);
const pgsDefinition = await fs.readFile(path.join(project, 'scripts/runtime-compat/playfab-save-folder.def'), 'utf8');
await fs.writeFile(path.join(pgsTests, 'fixture.def'), pgsDefinition.replace(/^(PF\w+)(?:=\S+)? @(\d+)$/gm,
  (_, name, ordinal) => `${name}${name === 'PFGameSaveFilesInitialize' ? '' : '=probe_stub'} @${ordinal}`));
const pgsProbeSource = path.join(project, 'scripts/runtime-tests/playfab-folder-probe.c');
for (const [define, name, extra] of [
  ['PROBE_SDK', 'nexus_pgs_native.dll', [path.join(pgsTests, 'fixture.def')]],
  ['PROBE_RUNTIME', 'xgameruntime.dll', []],
]) run('x86_64-w64-mingw32-gcc', ['-shared', '-O2', '-Wall', '-Wextra', '-Werror', `-D${define}`, pgsProbeSource, ...extra, '-o', path.join(pgsTests, name)], work);
run('x86_64-w64-mingw32-gcc', ['-O2', '-Wall', '-Wextra', '-Werror', pgsProbeSource, '-o', path.join(pgsTests, 'playfab-folder-probe.exe')], work);
await fs.copyFile(path.join(components, 'PlayFabGameSave.dll'), path.join(pgsTests, 'PlayFabGameSave.dll'));
const initTests = path.join(tests, 'runtime-init');
await buildPlayFabSessionProbe(path.join(tests,'playfab-session'),[
  '-I',path.join(build,'dlls/xgameruntime'),'-I',path.join(source,'dlls/xgameruntime'),
  '-I',path.join(build,'include'),'-I',path.join(source,'include')]);
await fs.mkdir(initTests);
run('x86_64-w64-mingw32-gcc', ['-O2', '-Wall', '-Wextra', '-Werror', path.join(project, 'scripts/runtime-tests/runtime-init-probe.c'), '-o', path.join(initTests, 'runtime-init-probe.exe')], work);
await fs.writeFile(path.join(initTests, 'MicrosoftGame.config'), '<Game><!-- <Identity Name="Wrong.Example" Publisher="CN=Wrong"/><TitleId>0000</TitleId> --><Identity Name="Nexus.Init.Inline" Publisher="CN=NexusProbe"/><TitleId>1234</TitleId></Game>');
for (const test of ['taskqueue-teardown', 'taskqueue-contract', 'taskqueue-close', 'async-provider-contract', 'async-completion-lifetime', 'async-schedule', 'gamesave-files']) {
  run('x86_64-w64-mingw32-gcc', ['-D__WINESRC__', '-O2', '-Wall', '-I', path.join(build, 'dlls/xgameruntime'), '-I', path.join(source, 'dlls/xgameruntime'), '-I', path.join(build, 'include'), '-I', path.join(source, 'include'), path.join(project, `scripts/runtime-tests/${test}-probe.c`), '-o', path.join(tests, `${test}-probe.exe`)], work);
}
for (const name of ['package-identity', 'package-legacy', 'package-chunks', 'package-monitors', 'package-progress-bytes', 'system-device-id', 'user-device-association', 'offline-identity']) {
  run('x86_64-w64-mingw32-gcc', ['-D__WINESRC__', '-O2', '-Wall', '-Wextra', '-Werror',
    '-I', path.join(build, 'dlls/xgameruntime'), '-I', path.join(source, 'dlls/xgameruntime'),
    '-I', path.join(build, 'include'), '-I', path.join(source, 'include'),
    path.join(project, `scripts/runtime-tests/${name}-probe.c`), '-o', path.join(tests, `${name}-probe.exe`)], work);
}
// windows.web generated these WinRT headers from the pinned IDL sources.
run('x86_64-w64-mingw32-gcc', ['-D__WINESRC__', '-O2', '-Wall', '-I', path.join(build, 'dlls/xgameruntime'), '-I', path.join(source, 'dlls/xgameruntime'), '-I', path.join(build, 'include'), '-I', path.join(source, 'include'), path.join(project, 'scripts/runtime-tests/token-dispatch-probe.c'), '-o', path.join(tests, 'token-dispatch-probe.exe'), '-lruntimeobject'], work);
await buildUserPrivilegeProbe({ source, build, tests, project }, run);
// Compile the exact entitlement helpers with a test-only failing license bridge.
// Its synthetic signing key never changes production trust or reaches packaging.
buildStoreProbes({ build, source, tests, project }, run);
buildSaveSyncProbe({ build, source, tests, project }, run);
buildUserAudioProbe({ build, source, tests, project }, run);
// Ubuntu's older MinGW SDK need not contain windows.data.json.h at all.
run('x86_64-w64-mingw32-gcc', ['-O2', '-Wall', '-I', path.join(build, 'include'), '-I', path.join(source, 'include'), path.join(project, 'scripts/runtime-tests/winrt-json-probe.c'), '-o', path.join(tests, 'winrt-json-probe.exe'), '-lruntimeobject'], work);
await fs.copyFile(path.join(ngSource, 'COPYING'), path.join(components, 'nghttp2-LICENSE'));
await fs.copyFile(path.join(shaderSource, 'COPYING'), path.join(components, 'vkd3d-LICENSE'));
await fs.copyFile(path.join(vulkanHeaders, 'LICENSE.md'), path.join(components, 'Vulkan-Headers-LICENSE'));
await fs.copyFile(path.join(vulkanHeaders, 'LICENSES/Apache-2.0.txt'), path.join(components, 'Vulkan-Headers-Apache-2.0'));
await fs.copyFile(path.join(vulkanHeaders, 'LICENSES/MIT.txt'), path.join(components, 'Vulkan-Headers-MIT'));
await fs.copyFile(path.join(spirvHeaders, 'LICENSE'), path.join(components, 'SPIRV-Headers-LICENSE'));
await fs.copyFile(path.join(source, 'COPYING.LIB'), path.join(components, 'Wine-LICENSE'));
await fs.copyFile(path.join(source, 'dlls/xgameruntime/COPYING.LIB'), path.join(components, 'xgameruntime-LICENSE')).catch(async e => {
  if (e.code !== 'ENOENT') throw e;
  await fs.copyFile(path.join(source, 'COPYING.LIB'), path.join(components, 'xgameruntime-LICENSE'));
});
provenance.dxvk = await buildRuntimeDxvk(work, components, jobs);
Object.assign(provenance.components, provenance.dxvk.components);
await fs.writeFile(path.join(components, 'source-manifest.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
if (options['base-runtime']) {
  const media = path.join(work, 'media');
  run('node', [path.join(project, 'scripts/build-runtime-media.mjs'), '--work', media,
    '--jobs', String(Math.min(Number(jobs), 32)), ...(options['media-archive'] ? ['--archive', path.resolve(options['media-archive'])] : [])], project);
  run('node', [path.join(project, 'scripts/assemble-shared-runtime.mjs'), '--base', path.resolve(options['base-runtime']), '--components', components, '--media', media, '--output', path.join(work, 'runtime')], project);
}
console.log(`Built shared runtime components and ABI probes: ${components}`);
