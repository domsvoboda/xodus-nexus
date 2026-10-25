import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dxvkComponents } from './build-runtime-dxvk.mjs';
const script = fileURLToPath(new URL('./assemble-shared-runtime.mjs', import.meta.url));
// `arm64` builds the CachyOS arm64 layout: bin-arm64, default_pfx_arm64, aarch64-windows.
async function fixture(layout = 'x86_64') {
  const arm64 = layout === 'arm64';
  const bin = arm64 ? 'files/bin-arm64' : 'files/bin', pfx = arm64 ? 'files/share/default_pfx_arm64' : 'files/share/default_pfx', pe = arm64 ? 'aarch64-windows' : 'x86_64-windows';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-assembly-test-'));
  const base = path.join(root, 'base'), components = path.join(root, 'components'), output = path.join(root, 'output');
  await fs.mkdir(path.join(base, bin), { recursive: true });
  await fs.mkdir(path.join(base, `files/lib/wine/${pe}`), { recursive: true });
  await fs.mkdir(path.join(base, `${pfx}/drive_c/windows/system32`), { recursive: true });
  for (const file of [path.join(base, bin, 'wine'), path.join(base, 'proton')]) await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.mkdir(components);
  await fs.writeFile(path.join(base, `files/lib/wine/${pe}/wined3d.dll`), 'base renderer');
  const manifest = { components: {}, runtimeCompatibility: {}, ...(arm64 ? { peArch: pe } : {}) };
  for (const name of ['PlayFabGameSave.dll', 'wine-launcher', 'gaming-services-version.exe']) {
    const bytes = Buffer.from(`new-${name}`);
    await fs.writeFile(path.join(components, name), bytes);
    manifest.runtimeCompatibility[name] = createHash('sha256').update(bytes).digest('hex');
  }
  for (const name of ['xgameruntime.dll', 'winhttp.dll', 'mscoree.dll', 'libnghttp2.dll', 'windows.web.dll', 'libvkd3d-shader-1.dll', 'twinapi.appcore.dll', ...dxvkComponents, ...(arm64 ? ['d3dcompiler_47.dll'] : [])]) {
    const bytes = Buffer.from(`new-${name}`);
    await fs.writeFile(path.join(components, name), bytes);
    manifest.components[name] = createHash('sha256').update(bytes).digest('hex');
  }
  manifest.dxvk = { sourceLockSha256: createHash('sha256').update(await fs.readFile(new URL('./runtime-dxvk.lock.json', import.meta.url))).digest('hex'),
    ...(arm64 ? { target: 'arm64ec' } : {}),
    components: Object.fromEntries(dxvkComponents.map(name => [name, manifest.components[name]])) };
  for (const name of ['nghttp2-LICENSE', 'Wine-LICENSE', 'xgameruntime-LICENSE', 'runtime-compat-LICENSE', 'vkd3d-LICENSE', 'Vulkan-Headers-LICENSE', 'Vulkan-Headers-Apache-2.0', 'Vulkan-Headers-MIT', 'SPIRV-Headers-LICENSE',
    'DXVK-LICENSE', 'DXBC-SPIRV-LICENSE', 'DXVK-display-LICENSE', 'DXVK-directx-LICENSE', 'DXVK-Vulkan-LICENSE', 'DXVK-SPIRV-LICENSE']) await fs.writeFile(path.join(components, name), 'test license');
  await fs.writeFile(path.join(components, 'source-manifest.json'), JSON.stringify(manifest));
  const run = () => execFileSync(process.execPath, [script, '--base', base, '--components', components, '--output', output], { stdio: 'pipe' });
  return { root, base, components, output, manifest, run, bin, pfx, pe };
}
test('assembly follows the arm64 base layout and records per-architecture checksums', async () => {
  const f = await fixture('arm64');
  try {
    f.run();
    const metadata = JSON.parse(await fs.readFile(path.join(f.output, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
    assert.equal(metadata.arch, 'aarch64');
    assert.equal(metadata.hostPeArch, 'aarch64-windows');
    assert.deepEqual(metadata.componentsByArch, { 'aarch64-windows': f.manifest.components });
    assert.equal(await fs.readFile(path.join(f.output, 'files/bin-arm64/wine.nexus-original'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal(await fs.readFile(path.join(f.output, 'files/bin-arm64/wine'), 'utf8'), 'new-wine-launcher');
    await assert.rejects(fs.lstat(path.join(f.output, 'files/bin')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(f.output, 'files/share/default_pfx')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(f.output, 'files/lib/wine/x86_64-windows')), { code: 'ENOENT' });
    for (const name of ['xgameruntime.dll', 'd3dcompiler_47.dll', 'libnghttp2.dll']) {
      assert.equal(await fs.readFile(path.join(f.output, `files/lib/wine/aarch64-windows/${name}`), 'utf8'), `new-${name}`);
      assert.equal(await fs.readFile(path.join(f.output, `files/share/default_pfx_arm64/drive_c/windows/system32/${name}`), 'utf8'), `new-${name}`);
    }
    assert.equal(await fs.readFile(path.join(f.output, 'files/lib/vkd3d/aarch64-windows/libvkd3d-shader-1.dll'), 'utf8'), 'new-libvkd3d-shader-1.dll');
    for (const name of dxvkComponents) for (const relative of [`files/lib/wine/dxvk/aarch64-windows/${name}`, `files/lib/wine/aarch64-windows/${name}`])
      assert.equal(await fs.readFile(path.join(f.output, relative), 'utf8'), `new-${name}`);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('components built for the other PE architecture are rejected before creating output', async () => {
  const f = await fixture('arm64');
  try {
    for (const mutate of [m => { delete m.peArch; }, m => { m.peArch = 'x86_64-windows'; }, m => { delete m.dxvk.target; }]) {
      const copy = structuredClone(f.manifest); mutate(copy);
      await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(copy));
      assert.throws(f.run, /Command failed/);
      await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
    }
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('the x86_64 set does not carry a d3dcompiler overlay and records its own architecture', async () => {
  const f = await fixture();
  try {
    f.run();
    const metadata = JSON.parse(await fs.readFile(path.join(f.output, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
    assert.equal(metadata.arch, 'x86_64');
    assert.deepEqual(metadata.componentsByArch, { 'x86_64-windows': f.manifest.components });
    await assert.rejects(fs.lstat(path.join(f.output, 'files/lib/wine/x86_64-windows/d3dcompiler_47.dll')), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('assembly replaces symlink entries without altering base/old runtime', async () => {
  const f = await fixture();
  try {
    const previous = path.join(f.root, 'previous.dll');
    await fs.writeFile(previous, 'previous runtime');
    await fs.symlink(previous, path.join(f.base, 'files/lib/wine/x86_64-windows/xgameruntime.dll'));
    await fs.symlink(previous, path.join(f.base, 'files/share/default_pfx/drive_c/windows/system32/windows.web.dll'));
    f.run();
    const metadata = JSON.parse(await fs.readFile(path.join(f.output, 'XODUS_NEXUS_PATCH.json'), 'utf8'));
    assert.ok(metadata.features.includes('appstate-registration-v1'));
    assert.ok(metadata.features.includes('appconstrained-registration-v1'));
    assert.equal(await fs.readFile(path.join(f.output, 'files/lib/wine/x86_64-windows/twinapi.appcore.dll'), 'utf8'), 'new-twinapi.appcore.dll');
    assert.equal(await fs.readFile(path.join(f.output, 'files/share/default_pfx/drive_c/windows/system32/twinapi.appcore.dll'), 'utf8'), 'new-twinapi.appcore.dll');
    for (const capability of ['xstore-entitlements-v1', 'xpackage-content-v1', 'xstore-package-license-v1']) assert.ok(metadata.features.includes(capability));
    assert.equal(await fs.readFile(path.join(f.output, 'files/bin/wine.nexus-original'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal(await fs.readFile(path.join(f.output, 'files/bin/wine'), 'utf8'), 'new-wine-launcher');
    assert.equal(await fs.readFile(path.join(f.output, 'files/share/xodus-nexus/compat/PlayFabGameSave.dll'), 'utf8'), 'new-PlayFabGameSave.dll');
    assert.equal(await fs.readFile(path.join(f.output, 'files/share/xodus-nexus/compat/gaming-services-version.exe'), 'utf8'), 'new-gaming-services-version.exe');
    assert.equal(await fs.readFile(previous, 'utf8'), 'previous runtime');
    assert.equal(await fs.readlink(path.join(f.base, 'files/lib/wine/x86_64-windows/xgameruntime.dll')), previous);
    assert.equal(await fs.readFile(path.join(f.output, 'files/lib/wine/x86_64-windows/xgameruntime.dll'), 'utf8'), 'new-xgameruntime.dll');
    assert.equal(await fs.readFile(path.join(f.output, 'files/lib/wine/x86_64-windows/wined3d.dll'), 'utf8'), 'base renderer');
    assert.equal(await fs.readFile(path.join(f.output, 'files/lib/vkd3d/x86_64-windows/libvkd3d-shader-1.dll'), 'utf8'), 'new-libvkd3d-shader-1.dll');
    assert.equal(await fs.readFile(path.join(f.output, 'files/share/default_pfx/drive_c/windows/system32/libnghttp2.dll'), 'utf8'), 'new-libnghttp2.dll');
    assert.equal(await fs.readFile(path.join(f.output, 'files/share/default_pfx/drive_c/windows/system32/windows.web.dll'), 'utf8'), 'new-windows.web.dll');
    assert.equal(await fs.readFile(path.join(f.output, 'files/share/default_pfx/drive_c/windows/system32/libvkd3d-shader-1.dll'), 'utf8'), 'new-libvkd3d-shader-1.dll');
    assert.ok(metadata.features.includes('hlsl-state-keywords-v1'));
    assert.ok(metadata.features.includes('xtaskqueue-repeat-termination-v1'));
    assert.ok(metadata.features.includes('xgame-relaunch-current-user-v1'));
    assert.ok(metadata.features.includes('dxvk-constant-compare-v1'));
    for (const name of dxvkComponents) for (const relative of [`files/lib/wine/dxvk/x86_64-windows/${name}`, `files/lib/wine/x86_64-windows/${name}`, `files/share/default_pfx/drive_c/windows/system32/${name}`])
      assert.equal(await fs.readFile(path.join(f.output, relative), 'utf8'), `new-${name}`);
    assert.throws(f.run, /Command failed/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('incomplete, mismatched or unrelated DXVK source manifest is rejected before assembly', async () => {
  const f = await fixture();
  try {
    for (const mutate of [m => { delete m.dxvk; }, m => { m.dxvk.sourceLockSha256 = 'a'.repeat(64); },
      m => { delete m.dxvk.components['dxgi.dll']; }, m => { m.dxvk.components['d3d11.dll'] = 'b'.repeat(64); }]) {
      const copy = structuredClone(f.manifest); mutate(copy);
      await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(copy));
      assert.throws(f.run, /Command failed/);
      await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
    }
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('missing JSON dependency is rejected before creating output', async () => {
  const f = await fixture();
  try {
    delete f.manifest.components['windows.web.dll'];
    await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(f.manifest));
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('invalid component checksum is rejected before creating output', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.components, 'winhttp.dll'), 'corrupted');
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('missing or corrupt shader component is rejected before assembly', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.components, 'libvkd3d-shader-1.dll'), 'corrupt');
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
    delete f.manifest.components['libvkd3d-shader-1.dll'];
    await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(f.manifest));
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('unknown component paths are rejected before creating output', async () => {
  const f = await fixture();
  try {
    f.manifest.components['../escape.dll'] = 'a'.repeat(64);
    await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(f.manifest));
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('missing or corrupt app-state component is rejected before assembly', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.components, 'twinapi.appcore.dll'), 'corrupt');
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
    delete f.manifest.components['twinapi.appcore.dll'];
    await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(f.manifest));
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('renderer replacement is not a permitted compiler component', async () => {
  const f = await fixture();
  try {
    f.manifest.components['wined3d.dll'] = 'a'.repeat(64);
    await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(f.manifest));
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('missing or tampered compatibility layer is rejected before creating output', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.components, 'wine-launcher'), 'corrupted helper');
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
    delete f.manifest.runtimeCompatibility;
    await fs.writeFile(path.join(f.components, 'source-manifest.json'), JSON.stringify(f.manifest));
    assert.throws(f.run, /Command failed/);
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
