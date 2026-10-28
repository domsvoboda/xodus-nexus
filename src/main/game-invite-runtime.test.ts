import {expect,it} from 'vitest';
import {releasedInviteDllHashes,releasedInviteModules,releasedInviteSource} from './game-invite-runtime';
const graph={proton:'bae8ff867dbe4746b5d948b35d272d7cad3b5808',wine:'35f25832bb881ce7f1cc8b2f07944124277b19f6',xgameruntime:'d229c4833608b64f0d5afa92d80bde3c36614a3e'};
it('recognizes only the exact released invitation implementation with its omitted capability',()=>{
 expect(releasedInviteSource({sourceGraph:graph})).toBe(true);
 for(const key of Object.keys(graph))expect(releasedInviteSource({sourceGraph:{...graph,[key]:'other'}})).toBe(false);
 for(const value of [null,{},[],{sourceGraph:null},{sourceGraph:{xgameruntime:graph.xgameruntime}}])expect(releasedInviteSource(value)).toBe(false);
});
it('requires both actual 64-bit and 32-bit module digests, never a filename or claimed manifest hash',()=>{
 expect(releasedInviteModules({...releasedInviteDllHashes})).toBe(true);
 expect(releasedInviteModules({})).toBe(false);
 for(const arch of Object.keys(releasedInviteDllHashes))expect(releasedInviteModules({...releasedInviteDllHashes,[arch]:'changed'})).toBe(false);
});
