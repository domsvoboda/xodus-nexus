import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { currentArch, isLinuxElf64, type NexusArch } from './arch.js';

/** Where a Proton tree keeps its loader, pristine prefix and PE modules. */
export interface ProtonLayout {
  /** Directory under `files/` holding `wine` and `wineserver`. */
  bin: string;
  /** Directory under `files/share/` holding the pristine prefix. */
  defaultPrefix: string;
  /** Directory under `files/lib/<library>/` holding the host's PE modules. */
  peArch: 'x86_64-windows' | 'aarch64-windows';
}

/** Valve/xodus x86_64 Proton. */
export const X86_64_LAYOUT: ProtonLayout = { bin: 'bin', defaultPrefix: 'default_pfx', peArch: 'x86_64-windows' };
/** CachyOS arm64 Proton: its own loader directory and prefix, ARM64X modules. */
export const ARM64_LAYOUT: ProtonLayout = { bin: 'bin-arm64', defaultPrefix: 'default_pfx_arm64', peArch: 'aarch64-windows' };

/** The Proton root for a Wine loader path: two levels above its bin directory. */
export function protonRootOf(winePath: string): string {
  return path.resolve(path.dirname(winePath), '..', '..');
}

async function readable(file: string): Promise<boolean> {
  return fs.access(file, constants.R_OK).then(() => true, () => false);
}

async function elfArch(file: string): Promise<NexusArch | undefined> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, 64, 0);
    const bytes = header.subarray(0, bytesRead);
    if (isLinuxElf64(bytes, 'arm64')) return 'arm64';
    if (isLinuxElf64(bytes, 'x64')) return 'x64';
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The layout of the Proton tree a Wine loader belongs to. A `bin-arm64`
 * loader directory is the CachyOS arm64 layout; otherwise the loader's ELF
 * machine decides (a GE-Proton aarch64 build keeps `files/bin/wine`), with
 * the prefix directory probed because only CachyOS renames it.
 */
export async function detectProtonLayout(winePath: string): Promise<ProtonLayout> {
  const bin = path.basename(path.dirname(winePath));
  if (bin === ARM64_LAYOUT.bin) return ARM64_LAYOUT;
  if (await elfArch(winePath) !== 'arm64') return { ...X86_64_LAYOUT, bin };
  const root = protonRootOf(winePath);
  const renamedPrefix = await readable(path.join(root, 'files', 'share', ARM64_LAYOUT.defaultPrefix));
  return { bin, defaultPrefix: renamedPrefix ? ARM64_LAYOUT.defaultPrefix : X86_64_LAYOUT.defaultPrefix, peArch: ARM64_LAYOUT.peArch };
}

/**
 * The Wine loader an extracted Proton tree offers this launcher's
 * architecture: `files/bin-arm64/wine` first on arm64, else `files/bin/wine`.
 * Returns the conventional path when neither exists so callers report it.
 */
export async function locateProtonWine(protonRoot: string, arch: NexusArch = currentArch()): Promise<string> {
  const candidates = (arch === 'arm64' ? [ARM64_LAYOUT, X86_64_LAYOUT] : [X86_64_LAYOUT])
    .map((layout) => path.join(protonRoot, 'files', layout.bin, 'wine'));
  for (const candidate of candidates) if (await readable(candidate)) return candidate;
  return candidates[candidates.length - 1];
}
