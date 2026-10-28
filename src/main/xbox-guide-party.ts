import type {XboxParty} from './xbox-party.js';
import type {XboxInvites} from './xbox-invites.js';
import type {XboxVoiceHost} from './xbox-voice-host.js';

const reads=new Set(['getXboxParty','getXboxVoiceState','getXboxActiveParties','getXboxInvites']);
const mutations=new Set(['leaveExistingXboxParty','inviteXboxPartyFriend','controlXboxVoice']);
type Options={
 party:Pick<XboxParty,'current'|'activeParties'|'leaveExisting'|'invite'>;
 invites:Pick<XboxInvites,'list'>;
 voice:Pick<XboxVoiceHost,'state'|'control'>;
 interactive:()=>boolean;
};

/** A view-only facade for the existing media owner, never a second audio host. */
export class XboxGuideParty {
 constructor(private readonly options:Options){}
 handles(method:string):boolean{return reads.has(method)||mutations.has(method);}
 async invoke(method:string,args:unknown[]):Promise<unknown>{
  if(!this.handles(method))throw Error('Unsupported Guide party action.');
  const mutation=mutations.has(method);
  if(args.length!==(mutation?1:0))throw Error('Invalid Guide party request.');
  if(mutation&&!this.options.interactive())throw Error('Open the Guide to use Xbox party controls.');
  const text=()=>{if(typeof args[0]!=='string')throw Error('Invalid Guide party request.');return args[0];};
  switch(method){
   case 'getXboxParty':return this.options.party.current;
   case 'getXboxVoiceState':return this.options.voice.state;
   case 'getXboxActiveParties':return this.options.party.activeParties();
   case 'getXboxInvites':return (await this.options.invites.list()).filter(invite=>invite.kind==='party');
   case 'leaveExistingXboxParty':return this.options.party.leaveExisting(text());
   case 'inviteXboxPartyFriend':return this.options.party.invite(text());
   // control validates the command and serializes it on the single shared owner.
   case 'controlXboxVoice':return this.options.voice.control(args[0]);
  }
 }
}
