import {expect,it,vi} from 'vitest';
import {createConnection} from 'node:net';
import {GameInviteBridge,encodeInviteFields,decodeInviteFields,combinedInviteState} from './game-invite-bridge';
import {validateGameInviteUri} from '../shared/game-invites';
const id='12345678-1234-1234-1234-123456789abc',scid='87654321-4321-4321-4321-cba987654321';
const uri=`ms-xbl-multiplayer://inviteHandleAccept?handle=${id}&invitedXuid=42&senderXuid=43&context=`;
function fixture(){let current=true;const changed=vi.fn(),show=vi.fn();const bridge=new GameInviteBridge('own','Synthetic Game','123',()=>current,changed,show,()=>1000);return {bridge,changed,show,invalidate:()=>{current=false;}};}
it('requires an exact launch-bound account/title handshake',()=>{
  const {bridge,invalidate}=fixture();expect(bridge.exchange(['events','0'])[0]).not.toBe(0);
  expect(bridge.exchange(['hello','42','124'])[0]).not.toBe(0);expect(bridge.exchange(['hello','42','123'])[0]).toBe(0);
  expect(bridge.exchange(['hello','43','123'])[0]).not.toBe(0);invalidate();expect(bridge.exchange(['hello','42','123'])[0]).not.toBe(0);
});
it('does not report sent until the actual game acknowledges the service result',()=>{
  const {bridge,show}=fixture();bridge.exchange(['hello','42','123']);
  expect(bridge.exchange(['present',id,scid,'lobby','real-session','',''])[0]).toBe(0);expect(show).toHaveBeenCalledOnce();
  expect(bridge.exchange(['selection',id])[0]).toBe(0x8000000a);
  bridge.choose('own:'+id,'43');expect(bridge.exchange(['selection',id])).toEqual([0,['43']]);
  expect(bridge.state().outgoing[0].phase).toBe('sending');bridge.exchange(['complete',id,String(0x80070005)]);expect(bridge.state().outgoing[0].phase).toBe('failed');
  expect(bridge.exchange(['complete',id,'0'])[0]).not.toBe(0);
  bridge.exchange(['cancel',id]);expect(bridge.state().outgoing[0].phase).toBe('failed');
});
it('expires invitations and choices and rejects self, unknown and duplicate requests',()=>{
  let time=1000;const bridge=new GameInviteBridge('own','Synthetic','123',()=>true,()=>{},()=>{},()=>time);
  bridge.exchange(['hello-events','42','123']);bridge.exchange(['present-activity',id]);
  expect(bridge.exchange(['present-activity',id])[0]).not.toBe(0);expect(()=>bridge.choose('own:'+id,'42')).toThrow();
  expect(()=>bridge.choose('other:'+id,'43')).toThrow();expect(()=>bridge.accept('own:unknown')).toThrow();
  bridge.exchange(['notify',id,uri,'Example','1500']);time=1501;expect(bridge.state().incoming).toEqual([]);expect(()=>bridge.accept('own:'+id)).toThrow();
  time=182000;expect(bridge.state().active).toEqual([]);expect(bridge.state().outgoing[0].phase).toBe('cancelled');
  expect(bridge.exchange(['selection',id])[0]).not.toBe(0);time+=10001;expect(bridge.state().outgoing).toEqual([]);
});
it('rejects a wrong capability on an actual fragmented TCP frame',async()=>{
  const {bridge}=fixture();await bridge.start();
  try{
    const result=await new Promise<Buffer>((resolve,reject)=>{
      const socket=createConnection(bridge.port,'127.0.0.1'),chunks:Buffer[]=[];
      socket.on('error',reject);socket.on('data',b=>chunks.push(b));socket.on('end',()=>resolve(Buffer.concat(chunks)));
      socket.on('connect',()=>{const body=encodeInviteFields(['hello','42','123']),header=Buffer.alloc(8);header.write('NXSI');header.writeUInt32LE(body.length,4);socket.write(Buffer.from('0'.repeat(64)));socket.write(header);socket.write(body);});
    });expect(result.length).toBe(0);expect(bridge.exchange(['events','0'])[0]).toBe(0x80070005);
  }finally{await bridge.stop();}
});
it('accepts a bound incoming invite once and keeps capability URIs out of renderer state',()=>{
  const {bridge,invalidate}=fixture();bridge.exchange(['hello','42','123']);
  expect(bridge.exchange(['notify',id,uri,'Example Friend','5000'])[0]).toBe(0);
  expect(JSON.stringify(bridge.state())).not.toContain('handle=');expect(bridge.exchange(['events','0'])[0]).toBe(0x8000000a);
  bridge.accept('own:'+id);expect(bridge.exchange(['events','0'])).toEqual([0,['1','accepted',uri]]);expect(bridge.exchange(['events','1'])[0]).toBe(0x8000000a);
  expect(()=>bridge.accept('own:'+id)).toThrow();invalidate();expect(combinedInviteState([bridge])).toEqual({active:[],incoming:[],outgoing:[]});
});
it('requires an actual active callback consumer before sending to a running game',()=>{
  const {bridge}=fixture();expect(()=>bridge.invite('43')).toThrow();bridge.exchange(['hello-events','42','123']);
  bridge.invite('43');expect(()=>bridge.invite('43')).toThrow('already');expect(bridge.state().outgoing[0].phase).toBe('sending');
  const result=bridge.exchange(['events','0']);expect(result[0]).toBe(0);expect(result[1][1]).toBe('activity');expect(result[1][3]).toBe('43');
});
it('validates invitation syntax without running protocols, granting rights or guessing a session',()=>{
  expect(validateGameInviteUri(uri,'42')).toBe(true);
  for(const value of [uri.replace('invitedXuid=42','invitedXuid=44'),uri+'&handle='+id,uri+'&url=https://evil.invalid',uri.replace('ms-xbl-multiplayer:','file:'),uri.replace('context=','context=%0a'),uri.replace(id,'not-a-session')])expect(validateGameInviteUri(value,'42')).toBe(false);
  expect(validateGameInviteUri('ms-xbl-multiplayer://inviteAccept?invitedUser=42&sender=43&connectionString=opaque%20title%20data','42')).toBe(true);
});
it('rejects oversized, invalid UTF8, NUL and trailing wire fields',()=>{
  const valid=encodeInviteFields(['notify','žluťoučký']);expect(decodeInviteFields(valid)).toEqual(['notify','žluťoučký']);
  for(const value of [Buffer.alloc(0),Buffer.concat([valid,Buffer.from([1])]),encodeInviteFields(['a\0b']),Buffer.from([1,0,0,0,1,0,0,0,255]),encodeInviteFields(['x'.repeat(8193)])])expect(()=>decodeInviteFields(value)).toThrow();
});
it('authenticates an actual loopback frame and tears down only its own listener',async()=>{
  const {bridge}=fixture();await bridge.start();
  try{
    const response=await new Promise<Buffer>((resolve,reject)=>{
      const socket=createConnection(bridge.port,'127.0.0.1');const chunks:Buffer[]=[];socket.on('error',reject);socket.on('data',b=>chunks.push(b));socket.on('end',()=>resolve(Buffer.concat(chunks)));
      socket.on('connect',()=>{const body=encodeInviteFields(['hello','42','123']),header=Buffer.alloc(8);header.write('NXSI');header.writeUInt32LE(body.length,4);socket.write(Buffer.concat([Buffer.from(bridge.key),header,body]));});
    });expect(response.readUInt32LE(4)).toBe(0);expect(decodeInviteFields(response.subarray(8))).toEqual([]);
  }finally{await bridge.stop();}
  expect(bridge.exchange(['hello','42','123'])[0]).not.toBe(0);
});
