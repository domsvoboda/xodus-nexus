import { describe,expect,it,vi } from 'vitest';
import { XboxSocial } from './xbox-native-social.js';

const person = {xuid:'1',gamertag:'Example',online:true,presence:'Playing E-Day',favorite:false,inParty:false};
const response = (account = 'account',kind = 'friends',items: unknown[] = [person]) => JSON.stringify({schema:1,account,kind,items});
describe('native Xbox social account boundary',() => {
  it('rejects wrong-peer messages, duplicate IDs and invalid timestamps, and strips hidden text',async()=>{
    const item={id:'a',sender:'2',mine:false,hidden:false,text:'Fixture',timestamp:'2026-10-28T00:00:00Z'};
    const reader=vi.fn(async()=>response('account','conversation',[item]));
    const api=new XboxSocial(()=>({binary:'cli',account:'account'}),reader);
    for(const items of [[{...item,sender:'3'}],[item,item],[{...item,timestamp:'now'}],[{...item,mine:true}]]){
      reader.mockResolvedValueOnce(response('account','conversation',items));await expect(api.conversation('2')).rejects.toThrow();api.clear();
    }
    reader.mockResolvedValueOnce(response('account','conversation',[{...item,hidden:true,text:'PRIVATE'}]));
    expect((await api.conversation('2'))[0].text).toBe('');
  });
  it('accepts Xbox-hosted gamerpics and rejects arbitrary remote or credential-bearing image URLs',async()=>{
    for(const avatarUrl of ['https://gamerpic.xboxlive.com/profile.png','https://images-eds-ssl.xboxlive.com/image?url=public']){
      const value={...person,avatarUrl};const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),async()=>response('account','friends',[value]));expect(await api.friends()).toEqual([value]);
    }
    for(const avatarUrl of ['https://example.test/pic','https://private@gamerpic.xboxlive.com/pic','http://gamerpic.xboxlive.com/pic','file:///private']){
      const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),async()=>response('account','friends',[{...person,avatarUrl}]));await expect(api.friends()).rejects.toThrow('invalid format');
    }
  });
  it('resolves the self-profile through the account-bound backend without requiring a renderer-supplied XUID',async()=>{
    const reader=vi.fn(async()=>response('account','profile',[{xuid:'2',gamertag:'Self',gamerscore:'100'}]));
    const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),reader);expect((await api.profile('me')).xuid).toBe('2');expect(reader.mock.calls[0][1]).toEqual(['profile','me']);
  });
  it('loads the exact selected player and strips unrelated service fields',async()=>{
    const card={xuid:'2',gamertag:'Player',gamerscore:'12500'};const reader=vi.fn(async()=>response('account','profile',[{...card,realName:'private'}]));
    const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),reader);
    expect(await api.profile('2')).toEqual(card);expect(reader.mock.calls[0][1]).toEqual(['profile','2']);
    await expect(api.profile('1')).rejects.toThrow('different player');await expect(api.profile('0')).rejects.toThrow('Select');
  });
  it('deduplicates reads without exposing authentication or using a web session',async () => {
    const reader=vi.fn(async()=>response());const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),reader);
    expect(await api.friends()).toEqual([person]);await api.friends();expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0].slice(0,3)).toEqual(['xodus-cli',['friends'],undefined]);
  });
  it('rejects the old account when an in-flight read completes after a switch',async () => {
    let account='account';let finish!:(output:string)=>void;
    const api=new XboxSocial(()=>({binary:'xodus-cli',account}),()=>new Promise(resolve=>{finish=resolve;}));
    const result=api.friends();account='another';finish(response());await expect(result).rejects.toThrow('account changed');
  });
  it('aborts pending reads and discards their results when cleared',async () => {
    let finish!:(output:string)=>void;
    const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),()=>new Promise(resolve=>{finish=resolve;}));
    const result=api.friends();api.clear();finish(response());await expect(result).rejects.toThrow();
  });
  it('rejects wrong identity, malformed identifiers, and raw service objects',async () => {
    for(const value of [response('another'),response('account','friends',[{...person,xuid:'../me'}]),response('account','friends',[{token:'private'}])]) {
      const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),async()=>value);await expect(api.friends()).rejects.toThrow();
    }
  });
  it('projects only social fields even if a backend adds unrelated private data',async()=>{
    const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),async()=>response('account','friends',[{...person,authorization:'never-publish'}]));
    expect(await api.friends()).toEqual([person]);
  });
  it('validates a send before calling the backend and uses private stdin without retries',async () => {
    const reader=vi.fn(async()=>response('account','sent',[{id:'sent'}]));const api=new XboxSocial(()=>({binary:'xodus-cli',account:'account'}),reader);
    await expect(api.send('another','1','Hi')).rejects.toThrow('account changed');
    await expect(api.send('account','../me','Hi')).rejects.toThrow();expect(reader).not.toHaveBeenCalled();
    expect(await api.send('account','1','Hi')).toEqual({id:'sent'});expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0].slice(0,3)).toEqual(['xodus-cli',['send-message'],JSON.stringify({account:'account',xuid:'1',text:'Hi'})]);
  });
  it('requires exactly one nonempty server receipt and never invents success or retries',async()=>{
    for(const items of [[],[{id:''}],[{id:' '}],[{id:'bad\nid'}],[{id:'one'},{id:'two'}]]){
      const reader=vi.fn(async()=>response('account','sent',items));const api=new XboxSocial(()=>({binary:'cli',account:'account'}),reader);
      await expect(api.send('account','1','Hi')).rejects.toThrow('confirm');expect(reader).toHaveBeenCalledOnce();
    }
  });
  it('invalidates conversation reads started while sending even if the acknowledgement is lost',async()=>{
    let finish!:(value:string)=>void;
    const reader=vi.fn(async(_binary:string,args:string[])=>args[0]==='send-message'?new Promise<string>(resolve=>{finish=resolve;}):response('account','conversation',[]));
    const api=new XboxSocial(()=>({binary:'cli',account:'account'}),reader);
    const send=api.send('account','1','Hi');await api.conversation('1');finish(response('account','sent',[{id:'receipt'}]));await send;
    await api.conversation('1');expect(reader.mock.calls.filter(call=>call[1][0]==='conversation')).toHaveLength(2);
  });
});
