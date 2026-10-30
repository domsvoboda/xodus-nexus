/** Loader diagnostics only, without forwarding user paths or child output. */
export function runtimeWineFailure(output:string):string|undefined{
  const tail=output.slice(-16000);
  const versions=[...tail.matchAll(/version [`']GLIBC_(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?['`] not found/g)]
    .map(match=>[Number(match[1]),Number(match[2])]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]);
  if(versions.length)return `This Wine runtime requires glibc ${versions[0].join('.')} or newer. Use a compatible distribution or runtime build.`;
  if(/version [`'](?:GLIBCXX_|CXXABI_)\d{1,3}\.\d{1,3}(?:\.\d{1,3})?['`] not found/.test(tail))return 'This Wine runtime requires newer GCC runtime libraries. Update the distribution runtime packages or use a compatible runtime build.';
  for(const line of tail.split(/\r?\n/)){
    const missing=/(?:error while loading shared libraries: |cannot open shared object file: )([A-Za-z0-9_.+-]{1,100}): cannot open shared object file: No such file or directory\s*$/.exec(line);
    if(missing)return `The Wine runtime cannot start because ${missing[1]} is missing. Install the matching system runtime library for your distribution.`;
  }
}
