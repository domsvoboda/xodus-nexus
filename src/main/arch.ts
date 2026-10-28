/** CPU architectures the launcher ships for, and the names each artifact uses. */
export type NexusArch = 'x64' | 'arm64';
export const NEXUS_ARCHES: readonly NexusArch[] = ['x64', 'arm64'];
/** Backend archives: `xodus-nexus-backend-<version>-linux-<suffix>.tar.xz` (uname -m names). */
export const BACKEND_ARCH_SUFFIX: Record<NexusArch, string> = { x64: 'x86_64', arm64: 'aarch64' };
/** AppImages: `Xodus-Nexus-<version>-<suffix>.AppImage` (electron-builder's `${arch}`). */
export const APPIMAGE_ARCH_SUFFIX: Record<NexusArch, string> = { x64: 'x86_64', arm64: 'arm64' };
/** ELF `e_machine` values the installers verify before executing anything. */
export const ELF_MACHINE: Record<NexusArch, number> = { x64: 62, arm64: 183 };

export function nexusArch(arch: string = process.arch): NexusArch | undefined {
  return arch === 'x64' || arch === 'arm64' ? arch : undefined;
}

/** The architecture this launcher process runs as; its downloads must match it. */
export function currentArch(arch: string = process.arch): NexusArch {
  const supported = nexusArch(arch);
  if (!supported) throw new Error(`Xodus Nexus does not support ${arch} hosts.`);
  return supported;
}

/** True when `header` begins a 64-bit little-endian ELF for `arch`. */
export function isLinuxElf64(header: Buffer, arch: NexusArch): boolean {
  return header.length >= 64 && header.subarray(0, 4).toString('hex') === '7f454c46'
    && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === ELF_MACHINE[arch];
}
