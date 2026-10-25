#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Turn the ARM64X/ARM64EC PE modules built by build-components.sh into a
// components directory with the same contract as build-shared-runtime.mjs
// produces for x86_64, so assemble-shared-runtime.mjs can consume it: the
// pinned-source provenance from --prepare-only, component checksums, the
// native compatibility layer (aarch64 host shim, x86_64 compatibility PEs),
// an ARM64EC DXVK build and the licence texts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCompatibility } from '../runtime-compat/build.mjs';
import { buildRuntimeDxvk } from '../build-runtime-dxvk.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--shared', '--pe', '--work', '--output', '--jobs'].includes(process.argv[i]) || !process.argv[i + 1])
    throw new Error('Usage: collect-components.mjs --shared PREPARED_WORK --pe BUILT_PE_DIRECTORY --work NEW_DXVK_PARENT --output NEW_COMPONENTS [--jobs N]');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!options.shared || !options.pe || !options.work || !options.output) throw new Error('shared, pe, work and output are required');
const shared = path.resolve(options.shared), pe = path.resolve(options.pe), work = path.resolve(options.work), output = path.resolve(options.output);
const jobs = options.jobs ?? '4';
const sha = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const run = (command, args, cwd = work) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });

// Provenance written by build-shared-runtime.mjs --prepare-only: the same
// pinned checkouts, patches and verified sources as the x86_64 runtime.
const provenance = JSON.parse(await fs.readFile(path.join(shared, 'source-manifest.json'), 'utf8'));
if (provenance.schema !== 1 || Object.keys(provenance.components ?? {}).length) throw new Error('Expected a prepare-only source manifest');
const machines = JSON.parse(await fs.readFile(path.join(pe, 'arm64-components.json'), 'utf8'));
const expected = {
  'xgameruntime.dll': 'ARM64', 'winhttp.dll': 'ARM64', 'mscoree.dll': 'ARM64', 'windows.web.dll': 'ARM64',
  'twinapi.appcore.dll': 'ARM64', 'd3dcompiler_47.dll': 'ARM64', 'libnghttp2.dll': 'ARM64EC', 'libvkd3d-shader-1.dll': 'ARM64EC',
};
if (Object.keys(machines).sort().join() !== Object.keys(expected).sort().join()) throw new Error('Unexpected arm64 PE component set');
await fs.mkdir(output, { recursive: false });
for (const [name, machine] of Object.entries(expected)) {
  const file = path.join(pe, name);
  if (machines[name].machine !== machine) throw new Error(`${name} is ${machines[name].machine}, expected ${machine}`);
  if (await sha(file) !== machines[name].sha256) throw new Error(`${name} changed after its machine check`);
  await fs.copyFile(file, path.join(output, name), fs.constants.COPYFILE_EXCL);
  provenance.components[name] = machines[name].sha256;
}
// Host shim for aarch64 Linux; PlayFab/Gaming Services compatibility PEs stay
// x86_64 and run through the base's ARM64EC/FEX path like the games they serve.
provenance.runtimeCompatibility = await buildCompatibility(output);
const shim = run('file', ['-b', path.join(output, 'wine-launcher')]);
if (!/ELF 64-bit LSB.*ARM aarch64/.test(shim)) throw new Error(`The runtime shim is not an aarch64 ELF: ${shim.trim()}`);
provenance.dxvk = await buildRuntimeDxvk(work, output, jobs, 'arm64ec');
Object.assign(provenance.components, provenance.dxvk.components);
const source = path.join(shared, 'wine-src');
for (const [from, to] of [
  [path.join(shared, 'nghttp2-src/COPYING'), 'nghttp2-LICENSE'], [path.join(shared, 'vkd3d-src/COPYING'), 'vkd3d-LICENSE'],
  [path.join(shared, 'vulkan-headers/LICENSE.md'), 'Vulkan-Headers-LICENSE'], [path.join(shared, 'vulkan-headers/LICENSES/Apache-2.0.txt'), 'Vulkan-Headers-Apache-2.0'],
  [path.join(shared, 'vulkan-headers/LICENSES/MIT.txt'), 'Vulkan-Headers-MIT'], [path.join(shared, 'spirv-headers/LICENSE'), 'SPIRV-Headers-LICENSE'],
  [path.join(source, 'COPYING.LIB'), 'Wine-LICENSE'],
]) await fs.copyFile(from, path.join(output, to));
await fs.copyFile(path.join(source, 'dlls/xgameruntime/COPYING.LIB'), path.join(output, 'xgameruntime-LICENSE')).catch(async e => {
  if (e.code !== 'ENOENT') throw e;
  await fs.copyFile(path.join(source, 'COPYING.LIB'), path.join(output, 'xgameruntime-LICENSE'));
});
provenance.peArch = 'aarch64-windows';
provenance.configure = ['--enable-archs=aarch64,arm64ec', '--without-x', '--without-wayland', '--disable-tests', '--without-freetype', '--without-gnutls'];
provenance.toolchain = Object.fromEntries(['gcc', 'clang', 'arm64ec-w64-mingw32-clang', 'aarch64-w64-mingw32-clang', 'x86_64-w64-mingw32-gcc', 'cmake', 'make', 'autoconf', 'automake', 'libtoolize', 'widl', 'bison', 'flex']
  .map(tool => [tool, run(tool, [tool === 'widl' ? '-V' : '--version']).trim().split('\n')[0]]));
await fs.writeFile(path.join(output, 'source-manifest.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
console.log(`Collected ${Object.keys(provenance.components).length} arm64 runtime components: ${output}`);
