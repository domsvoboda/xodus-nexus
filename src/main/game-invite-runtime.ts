/** This shipped source already implements invitations, but its manifest omitted
 * the capability. Recognize only its exact source and both actual PE modules. */
const released={
 proton:'bae8ff867dbe4746b5d948b35d272d7cad3b5808',
 wine:'35f25832bb881ce7f1cc8b2f07944124277b19f6',
 xgameruntime:'d229c4833608b64f0d5afa92d80bde3c36614a3e',
};
export const releasedInviteDllHashes={
 x86_64:'bfec301a5c24c23c0d19250dde6abb53ee0431ee3cd79d86a17aa4b2f2030a44',
 i386:'7452f2fafe96209fb49cb25d384b66178fc34f67e8936b147f1b50caf74bd332',
} as const;
export function releasedInviteSource(value:unknown):boolean{
 if(!value||typeof value!=='object')return false;
 const graph=(value as {sourceGraph?:Record<string,unknown>}).sourceGraph;
 return Boolean(graph&&Object.entries(released).every(([key,hash])=>graph[key]===hash));
}
export function releasedInviteModules(hashes:Record<string,string>):boolean{
 return Object.entries(releasedInviteDllHashes).every(([arch,hash])=>hashes[arch]===hash);
}
