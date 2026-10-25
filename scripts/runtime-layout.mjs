// SPDX-License-Identifier: MIT
// Where a Proton tree keeps its loader, pristine prefix, PE modules and host
// libraries. The x86_64 snapshot and the CachyOS arm64 build differ; the
// launcher mirrors this in src/main/proton-layout.ts.
import fs from 'node:fs/promises';
import path from 'node:path';

export const LAYOUTS = {
  x86_64: { arch: 'x86_64', bin: 'files/bin', defaultPrefix: 'files/share/default_pfx', peArch: 'x86_64-windows',
    hostLibraries: 'files/lib/x86_64-linux-gnu', hostTriplet: 'x86_64-linux-gnu', peTarget: 'x86_64' },
  aarch64: { arch: 'aarch64', bin: 'files/bin-arm64', defaultPrefix: 'files/share/default_pfx_arm64', peArch: 'aarch64-windows',
    hostLibraries: 'files/lib/aarch64-linux-gnu', hostTriplet: 'aarch64-linux-gnu', peTarget: 'arm64ec' },
};

/** The layout of an extracted Proton tree: arm64 when it carries `files/bin-arm64/wine`. */
export async function detectLayout(base) {
  try { await fs.access(path.join(base, LAYOUTS.aarch64.bin, 'wine')); return LAYOUTS.aarch64; }
  catch (e) { if (e.code !== 'ENOENT') throw e; return LAYOUTS.x86_64; }
}

/** The uname -m style name of the current host. */
export function hostArch(arch = process.arch) {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  throw new Error(`Unsupported runtime host architecture: ${arch}`);
}
