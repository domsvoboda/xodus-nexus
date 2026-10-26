import { expect, it } from 'vitest';
import { backendPrerequisiteFailure } from './backend-prerequisites.js';

it.each([
  ['libssl.so.3','loader-openssl','OpenSSL 3'],['libcrypto.so.3','loader-openssl','OpenSSL 3'],
  ['libdbus-1.so.3','loader-dbus','D-Bus runtime'],['libgcc_s.so.1','loader-compiler-runtime','GCC runtime'],
  ['libstdc++.so.6','loader-compiler-runtime','GCC runtime'],['unrecognized.so.123','loader-library','required system library'],
])('classifies a real missing %s without returning arbitrary paths or library names', (library,stage,message) => {
  const output=`/home/private-person/backend/xodus-cli: error while loading shared libraries: ${library}: cannot open shared object file: No such file or directory\n`;
  const result=backendPrerequisiteFailure(output);expect(result?.stage).toBe(stage);expect(result?.message).toContain(message);
  expect(JSON.stringify(result)).not.toMatch(/private-person|xodus-cli|unrecognized\.so/);
});
it('classifies ABI version failures but never forwards the provider line, requested paths or tokens', () => {
  expect(backendPrerequisiteFailure("/private/backend: /lib/libc.so.6: version `GLIBC_2.38' not found (required by /private/backend)")?.stage).toBe('loader-glibc');
  expect(backendPrerequisiteFailure("/private/backend: /lib/libstdc++.so.6: version `GLIBCXX_3.4.32' not found")?.stage).toBe('loader-compiler-runtime');
  for(const text of ['private-token','arbitrary backend failure','version GLIBC_fake not found',
    'error while loading shared libraries: private-user@example.test',
    '/x: error while loading shared libraries: /private/secret: cannot open shared object file: No such file or directory',
    '/x: error while loading shared libraries: libssl.so.3: cannot open shared object file: No such file or directory EXTRA_PRIVATE'])
    expect(backendPrerequisiteFailure(text)).toBeUndefined();
  expect(backendPrerequisiteFailure('x'.repeat(20_000))).toBeUndefined();
});
