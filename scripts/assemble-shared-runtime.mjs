#!/usr/bin/env node
// Overlay verified clean-build components onto a separately supplied Proton.
// Creates a new directory, never changes the base or current runtime pointer.
// The base may be the x86_64 snapshot or the CachyOS arm64 build; its layout
// (loader directory, pristine prefix, PE directory, host libraries) is detected
// and the components must have been built for that PE architecture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dxvkComponents } from './build-runtime-dxvk.mjs';
import { detectLayout } from './runtime-layout.mjs';
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--base', '--components', '--media', '--output'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('Usage: assemble-shared-runtime.mjs --base PROTON --components BUILT_COMPONENTS [--media BUILT_MEDIA] --output NEW_DIRECTORY')
  options[process.argv[i].slice(2)] = path.resolve(process.argv[i + 1]);
}
if (!options.base || !options.components || !options.output) throw new Error('base, components and output are required');
const shaFile = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(options.components, 'source-manifest.json'), 'utf8'));
const layout = await detectLayout(options.base);
const componentNames = ['xgameruntime.dll', 'winhttp.dll', 'mscoree.dll', 'libnghttp2.dll', 'windows.web.dll', 'libvkd3d-shader-1.dll', 'twinapi.appcore.dll', ...dxvkComponents];
// The arm64 base links vkd3d-shader into d3dcompiler_47 statically, so that
// set also carries a patched d3dcompiler_47; the x86_64 set does not.
const optionalComponentNames = ['d3dcompiler_47.dll'];
if (!manifest.components || Object.keys(manifest.components).some(name => !componentNames.includes(name) && !optionalComponentNames.includes(name))) throw new Error('Unrecognized runtime component');
const overlayNames = [...componentNames, ...optionalComponentNames.filter(name => name in manifest.components)];
for (const name of overlayNames) {
  if (!/^[a-f0-9]{64}$/.test(manifest.components[name] ?? '') || await shaFile(path.join(options.components, name)) !== manifest.components[name]) throw new Error(`Component checksum mismatch: ${name}`);
}
if ((manifest.peArch ?? 'x86_64-windows') !== layout.peArch) throw new Error(`Components were built for ${manifest.peArch ?? 'x86_64-windows'}, the base needs ${layout.peArch}`);
const dxvkLockSha256 = await shaFile(new URL('./runtime-dxvk.lock.json', import.meta.url));
if (manifest.dxvk?.sourceLockSha256 !== dxvkLockSha256 || (manifest.dxvk.target ?? 'x86_64') !== layout.peTarget ||
    Object.keys(manifest.dxvk?.components ?? {}).sort().join() !== [...dxvkComponents].sort().join() ||
    dxvkComponents.some(name => manifest.dxvk.components[name] !== manifest.components[name])) throw new Error('DXVK source or component manifest mismatch');
const compatibilityNames = ['PlayFabGameSave.dll', 'wine-launcher', 'gaming-services-version.exe'];
if (!manifest.runtimeCompatibility || Object.keys(manifest.runtimeCompatibility).sort().join() !== compatibilityNames.sort().join())
  throw new Error('Missing or unknown runtime compatibility component');
for (const name of compatibilityNames) {
  if (!/^[a-f0-9]{64}$/.test(manifest.runtimeCompatibility[name] ?? '') ||
      await shaFile(path.join(options.components, name)) !== manifest.runtimeCompatibility[name])
    throw new Error(`Runtime compatibility checksum mismatch: ${name}`);
}
const loaderPath = `${layout.bin}/wine`;
await fs.access(path.join(options.base, loaderPath), fs.constants.X_OK);
await fs.access(path.join(options.base, 'proton'), fs.constants.X_OK);
await fs.access(path.join(options.base, layout.defaultPrefix));
try { await fs.lstat(options.output); throw new Error('Output already exists; refusing overwrite'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
// Copies symlink entries as symlinks, not their external referents.
execFileSync('cp', ['-a', '--reflink=auto', options.base, options.output], { stdio: 'inherit' });
async function safeParent(relative) {
  let directory = options.output;
  for (const segment of path.dirname(relative).split('/')) {
    directory = path.join(directory, segment);
    try {
      const entry = await fs.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe assembly directory: ${relative}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; await fs.mkdir(directory); }
  }
}
for (const name of overlayNames) {
  const library = name === 'libvkd3d-shader-1.dll' ? 'vkd3d' : dxvkComponents.includes(name) ? 'wine/dxvk' : 'wine';
  for (const relative of [`files/lib/${library}/${layout.peArch}/${name}`, `${layout.defaultPrefix}/drive_c/windows/system32/${name}`,
    ...(dxvkComponents.includes(name) ? [`files/lib/wine/${layout.peArch}/${name}`] : [])]) {
    const target = path.join(options.output, relative);
    const temporary = `${target}.nexus-${process.pid}`;
    await safeParent(relative);
    await fs.copyFile(path.join(options.components, name), temporary, fs.constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o644);
    await fs.rename(temporary, target);
  }
}
const licenseDirectory = path.join(options.output, 'files/share/doc/xodus-nexus-runtime');
await safeParent('files/share/doc/xodus-nexus-runtime/license');
for (const name of ['nghttp2-LICENSE', 'Wine-LICENSE', 'xgameruntime-LICENSE', 'vkd3d-LICENSE', 'Vulkan-Headers-LICENSE', 'Vulkan-Headers-Apache-2.0', 'Vulkan-Headers-MIT', 'SPIRV-Headers-LICENSE',
  'DXVK-LICENSE', 'DXBC-SPIRV-LICENSE', 'DXVK-display-LICENSE', 'DXVK-directx-LICENSE', 'DXVK-Vulkan-LICENSE', 'DXVK-SPIRV-LICENSE']) await fs.copyFile(path.join(options.components, name), path.join(licenseDirectory, name));
await fs.copyFile(path.join(options.components, 'runtime-compat-LICENSE'), path.join(licenseDirectory, 'runtime-compat-LICENSE'));
let mediaMetadata;
if (options.media) {
  const mediaLock = JSON.parse(await fs.readFile(new URL('./runtime-media.lock.json', import.meta.url), 'utf8'));
  const mediaManifest = JSON.parse(await fs.readFile(path.join(options.media, 'media-manifest.json'), 'utf8'));
  if (mediaManifest.sourceSha256 !== mediaLock.sha256 || mediaManifest.version !== mediaLock.version ||
      mediaManifest.license !== 'LGPL-2.1-or-later' ||
      (mediaManifest.arch ?? 'x86_64') !== layout.arch ||
      !/^[0-9]+\.[0-9]+$/.test(mediaManifest.maxGlibc ?? '') ||
      !mediaManifest.configure?.includes('--disable-gpl') || !mediaManifest.configure.includes('--disable-nonfree') ||
      Object.keys(mediaManifest.libraries).sort().join(',') !== Object.keys(mediaLock.libraries).sort().join(','))
    throw new Error('Unexpected media source or library manifest.');
  if (await shaFile(path.join(options.media, mediaLock.archive)) !== mediaLock.sha256)
    throw new Error('Pinned FFmpeg source archive checksum mismatch.');
  const sourceDir = path.join(options.media, `ffmpeg-${mediaLock.version}`);
  const libraryDir = path.join(options.media, 'stage/usr/lib', layout.hostTriplet);
  for (const [soname, filename] of Object.entries(mediaLock.libraries)) {
    const item = mediaManifest.libraries[soname];
    const source = path.join(libraryDir, filename);
    const bytes = await fs.readFile(source);
    if (item?.filename !== filename || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw new Error(`Media library checksum mismatch: ${filename}`);
    const relative = `${layout.hostLibraries}/${filename}`;
    await safeParent(relative);
    const target = path.join(options.output, relative);
    const temporary = `${target}.nexus-${process.pid}`;
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, target);
    const link = path.join(options.output, `${layout.hostLibraries}/${soname}`);
    const temporaryLink = `${link}.nexus-${process.pid}`;
    await fs.symlink(filename, temporaryLink);
    await fs.rename(temporaryLink, link);
  }
  await fs.copyFile(path.join(sourceDir, 'COPYING.LGPLv2.1'), path.join(licenseDirectory, 'FFmpeg-COPYING.LGPLv2.1'));
  mediaMetadata = { version: mediaLock.version, sourceSha256: mediaLock.sha256,
    maxGlibc: mediaManifest.maxGlibc, libraries: mediaManifest.libraries };
}
const baseWineSha256 = await shaFile(path.join(options.base, loaderPath));
if (baseWineSha256 !== await shaFile(path.join(options.output, loaderPath))) throw new Error('Base Wine loader unexpectedly changed');
// Keep the genuine loader in the same bin directory so its Wine library lookup
// remains unchanged. The runtime shim execs it for every ordinary Wine command.
await safeParent('files/share/xodus-nexus/compat/PlayFabGameSave.dll');
await fs.copyFile(path.join(options.components, 'PlayFabGameSave.dll'), path.join(options.output, 'files/share/xodus-nexus/compat/PlayFabGameSave.dll'), fs.constants.COPYFILE_EXCL);
await fs.copyFile(path.join(options.components, 'gaming-services-version.exe'), path.join(options.output, 'files/share/xodus-nexus/compat/gaming-services-version.exe'), fs.constants.COPYFILE_EXCL);
const originalLoader = path.join(options.output, `${loaderPath}.nexus-original`);
try { await fs.lstat(originalLoader); throw new Error('Base already contains a runtime Wine shim'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
await fs.rename(path.join(options.output, loaderPath), originalLoader);
const temporaryLoader = path.join(options.output, `${layout.bin}/.wine-nexus-${process.pid}`);
await fs.copyFile(path.join(options.components, 'wine-launcher'), temporaryLoader, fs.constants.COPYFILE_EXCL);
await fs.chmod(temporaryLoader, 0o755);
await fs.rename(temporaryLoader, path.join(options.output, loaderPath));
if (baseWineSha256 !== await shaFile(originalLoader)) throw new Error('Original Wine loader changed');
let baseMetadata = {};
try { baseMetadata = JSON.parse(await fs.readFile(path.join(options.base, 'XODUS_NEXUS_PATCH.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const metadata = {
  ...manifest, name: 'Nexus runtime',
  description: 'Pinned shared XGameRuntime and HTTP/2 compatibility line. Experimental; see limitations.',
  arch: layout.arch, hostPeArch: layout.peArch,
  // The launcher verifies the overlay set of the PE directory it uses from here.
  componentsByArch: { [layout.peArch]: manifest.components },
  features: [...new Set([...(baseMetadata.features ?? []), 'cloud-saves-pr28', 'xodus-tcp-bridge-v1', 'package-locale', 'xuser-contract-v1', 'wine-winhttp-http2-v1', 'nghttp2-v1', 'winrt-json-v1', 'xasync-provider-contract-v1', 'xtaskqueue-lifecycle-v1', 'playfab-package-save-folder-v1', 'xstore-entitlements-v1', 'xpackage-content-v1', 'xstore-package-license-v1', ...(mediaMetadata ? ['bundled-ffmpeg-media-v1'] : [])])],
  baseWineSha256, patchedDllSha256: manifest.components['xgameruntime.dll'],
  ...(mediaMetadata ? { media: mediaMetadata } : {}),
};
const metadataTemporary = path.join(options.output, `.nexus-metadata-${process.pid}`);
metadata.features = [...new Set([...metadata.features, 'hlsl-state-keywords-v1', 'appstate-registration-v1', 'appconstrained-registration-v1', 'xtaskqueue-repeat-termination-v1', 'xgame-relaunch-current-user-v1', 'dxvk-constant-compare-v1'])];
await fs.writeFile(metadataTemporary, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
await fs.rename(metadataTemporary, path.join(options.output, 'XODUS_NEXUS_PATCH.json'));
console.log(`Assembled isolated runtime: ${options.output}. Active runtime unchanged.`);
