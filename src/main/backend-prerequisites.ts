/** Classify loader failures without forwarding paths, environment or provider text. */
export class BackendPrerequisiteError extends Error {}

export function backendPrerequisiteFailure(output: string): { stage: string; message: string } | undefined {
  const tail = output.slice(-16_000);
  for (const line of tail.split(/\r?\n/)) {
    const missing = /: error while loading shared libraries: ([A-Za-z0-9_.+-]{1,100}): cannot open shared object file: No such file or directory\s*$/.exec(line);
    if (missing) {
      if (['libssl.so.3', 'libcrypto.so.3'].includes(missing[1])) return {
        stage: 'loader-openssl', message: 'The backend could not start because OpenSSL 3 runtime libraries are missing. Install the OpenSSL 3 compatibility package for your distribution, then retry backend setup.',
      };
      if (missing[1] === 'libdbus-1.so.3') return {
        stage: 'loader-dbus', message: 'The backend could not start because the D-Bus runtime library is missing. Install the D-Bus runtime package for your distribution, then retry backend setup. This is separate from unlocking the system keyring.',
      };
      if (['libgcc_s.so.1', 'libstdc++.so.6'].includes(missing[1])) return {
        stage: 'loader-compiler-runtime', message: 'The backend could not start because GCC runtime libraries are missing. Install the GCC runtime package for your distribution, then retry backend setup.',
      };
      return { stage: 'loader-library', message: 'The backend could not start because a required system library is missing. Check your distribution runtime packages and retry backend setup. The backend diagnostic log records the failure without private paths.' };
    }
    if (/version [`']GLIBC_\d{1,3}\.\d{1,3}(?:\.\d{1,3})?['`] not found/.test(line)) return {
      stage: 'loader-glibc', message: 'The installed backend requires a newer glibc than this system provides. Use a supported distribution or a compatible backend release. Do not replace system glibc manually.',
    };
    if (/version [`'](?:GLIBCXX_|CXXABI_)\d{1,3}\.\d{1,3}(?:\.\d{1,3})?['`] not found/.test(line)) return {
      stage: 'loader-compiler-runtime', message: 'The installed backend requires a newer GCC runtime than this system provides. Update the distribution runtime packages or use a compatible backend release.',
    };
  }
}
