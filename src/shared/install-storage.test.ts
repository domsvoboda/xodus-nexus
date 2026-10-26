import { expect, it } from 'vitest';
import { estimatedInstallBytes, installByteLabel } from './install-storage';

it('formats known sizes including a full disk without inventing a missing estimate', () => {
  expect(installByteLabel(undefined)).toBe('Unavailable');expect(installByteLabel(NaN)).toBe('Unavailable');
  expect(installByteLabel(-1)).toBe('Unavailable');expect(installByteLabel(0)).toBe('0 B');
  expect(installByteLabel(511)).toBe('511 B');expect(installByteLabel(1024 ** 3 * 4)).toBe('4.0 GiB');
});
it('uses the larger catalog estimate but never treats missing, zero or invalid sizes as free space', () => {
  expect(estimatedInstallBytes(undefined)).toBeUndefined();expect(estimatedInstallBytes({})).toBeUndefined();
  expect(estimatedInstallBytes({downloadBytes:0,installBytes:NaN})).toBeUndefined();
  expect(estimatedInstallBytes({downloadBytes:100,installBytes:200})).toBe(200);
  expect(estimatedInstallBytes({downloadBytes:200,installBytes:100})).toBe(200);
  expect(estimatedInstallBytes({downloadBytes:100})).toBe(100);
});
