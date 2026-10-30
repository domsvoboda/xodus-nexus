import {expect,it} from 'vitest';
import {runtimeWineFailure} from './runtime-prerequisites.js';
it('explains the Ubuntu 22.04 loader failure without exposing installation paths',()=>{
  const raw='wine: could not load ntdll.so: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38\' not found (required by /home/private-person/candidate/files/lib/wine/x86_64-unix/ntdll.so)';
  const message=runtimeWineFailure(raw);expect(message).toContain('glibc 2.38 or newer');expect(message).not.toContain('/home/');expect(message).not.toContain('private-person');
});
it('reports the highest missing glibc version and distinguishes library and compiler requirements',()=>{
  expect(runtimeWineFailure("version 'GLIBC_2.9' not found\nversion 'GLIBC_2.38' not found")).toContain('2.38');
  expect(runtimeWineFailure("version 'GLIBCXX_3.4.32' not found")).toContain('GCC runtime');
  expect(runtimeWineFailure('/private/wine: error while loading shared libraries: libgnutls.so.30: cannot open shared object file: No such file or directory')).toContain('libgnutls.so.30 is missing');
  expect(runtimeWineFailure('unknown private output')).toBeUndefined();
});
