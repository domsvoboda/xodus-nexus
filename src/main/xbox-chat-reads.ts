import type {XboxChatReadState} from '../shared/types.js';

type Connection={account:string;binary:string};
const identity=(value:Connection)=>JSON.stringify([value.account,value.binary]);

/** Session-only bridge between sandboxed partitions. It never marks Xbox messages read. */
export class XboxChatReads {
  private state:XboxChatReadState|undefined;
  constructor(private readonly connection:()=>Connection|undefined,private readonly changed:(state:XboxChatReadState)=>void){}

  clear():void{this.state=undefined;}
  current():XboxChatReadState|undefined{
    const connection=this.connection();
    if(!connection){this.clear();return;}
    if(!this.state||identity(this.state)!==identity(connection))this.state={...connection,keys:[]};
    return {...this.state,keys:[...this.state.keys]};
  }
  viewed(account:unknown,binary:unknown,peer:unknown,ids:unknown):void{
    const state=this.current();
    if(!state||account!==state.account||binary!==state.binary)throw Error('The chat account changed. Reopen the conversation.');
    if(typeof peer!=='string'||!/^[1-9][0-9]{0,19}$/.test(peer)||BigInt(peer)>18446744073709551615n||!Array.isArray(ids)||ids.length>500||
      ids.some(id=>typeof id!=='string'||!id.length||id.length>256||/[\x00-\x1f\x7f]/.test(id)))throw Error('Invalid viewed chat messages.');
    const keys=[...new Set([...state.keys,...ids.map(id=>JSON.stringify(['message',peer,id]))])].slice(-500);
    if(keys.length===state.keys.length&&keys.every((key,index)=>key===state.keys[index]))return;
    this.state={...state,keys};this.changed({...this.state,keys:[...keys]});
  }
}
