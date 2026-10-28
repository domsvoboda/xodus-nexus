import { describe, expect, it } from 'vitest';
import { currentArch, isLinuxElf64, nexusArch } from './arch.js';

describe('native component architecture', () => {
  it('never guesses x64 for an unsupported process architecture', () => {
    for (const arch of ['ia32', 'arm', 'riscv64', '', 'aarch64']) {
      expect(nexusArch(arch)).toBeUndefined();
      expect(() => currentArch(arch)).toThrow('does not support');
    }
    expect(currentArch('arm64')).toBe('arm64');
    expect(currentArch('x64')).toBe('x64');
  });
  it('rejects the other architecture, endian and ELF class before execution', () => {
    const header = Buffer.alloc(64); header.set([0x7f, 69, 76, 70, 2, 1]);
    header.writeUInt16LE(183, 18);
    expect(isLinuxElf64(header, 'arm64')).toBe(true);
    expect(isLinuxElf64(header, 'x64')).toBe(false);
    header[5] = 2;
    expect(isLinuxElf64(header, 'arm64')).toBe(false);
    header[5] = 1; header[4] = 1;
    expect(isLinuxElf64(header, 'arm64')).toBe(false);
    expect(isLinuxElf64(header.subarray(0, 40), 'arm64')).toBe(false);
  });
});
