import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/** Where a Proton build keeps its loader, pristine prefix and host PE modules. */
export interface ProtonLayout {
  /** Directory under `files/` holding the Wine loader. */
  bin: 'bin' | 'bin-arm64';
  /** Directory under `files/share/` holding the pristine prefix. */
  defaultPrefix: 'default_pfx' | 'default_pfx_arm64';
  /** Directory under `files/lib/<library>/` holding the prefix's system32 modules. */
  peArch: 'x86_64-windows' | 'aarch64-windows';
}

/** x86_64 Proton (and an x86_64 runtime run under FEX on an arm64 host). */
export const X86_64_LAYOUT: ProtonLayout = { bin: 'bin', defaultPrefix: 'default_pfx', peArch: 'x86_64-windows' };
/** Proton built with `--target-arch=arm64`: native loader, ARM64X modules. */
export const ARM64_LAYOUT: ProtonLayout = { bin: 'bin-arm64', defaultPrefix: 'default_pfx_arm64', peArch: 'aarch64-windows' };

/** The layout a Wine loader path belongs to, from its bin directory. */
export function layoutOfWine(winePath: string): ProtonLayout {
  return path.basename(path.dirname(winePath)) === ARM64_LAYOUT.bin ? ARM64_LAYOUT : X86_64_LAYOUT;
}

/** The Proton root for a Wine loader path: two levels above its bin directory. */
export function protonRootOf(winePath: string): string {
  return path.resolve(path.dirname(winePath), '..', '..');
}

/** The runtime archive suffix for a host: `-x86_64.tar.xz` or `-aarch64.tar.xz`. */
export function runtimeArchiveArch(arch: string = process.arch): 'x86_64' | 'aarch64' {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  throw new Error(`Xodus Nexus runtimes are not built for ${arch} hosts.`);
}

/**
 * The loader to run from a Proton root on this host. An arm64 host prefers the
 * native arm64 loader; every other combination uses `files/bin/wine`.
 */
export async function runtimeLoader(protonRoot: string, arch: string = process.arch, allowEmulated = true): Promise<string> {
  runtimeArchiveArch(arch);
  if (arch === 'arm64') {
    const native = path.join(protonRoot, 'files', ARM64_LAYOUT.bin, 'wine');
    if (await fs.access(native, constants.X_OK).then(() => true, () => false)) return native;
    if (!allowEmulated) throw new Error('The ARM64 runtime has no executable native loader.');
  }
  return path.join(protonRoot, 'files', X86_64_LAYOUT.bin, 'wine');
}
