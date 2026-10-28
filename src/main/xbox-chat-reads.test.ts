import {expect,it,vi} from 'vitest';
import {XboxChatReads} from './xbox-chat-reads.js';

function fixture(){
  let connection:{account:string;binary:string}|undefined={account:'Account A',binary:'/backend/a'};
  const changed=vi.fn(),ledger=new XboxChatReads(()=>connection,changed);
  return {ledger,changed,connect:(next:typeof connection)=>{connection=next;}};
}
it('bridges exact message IDs without text, deduplicates notifications and survives main-window reopening',()=>{
  const f=fixture();f.ledger.viewed('Account A','/backend/a','42',['one','two','one']);
  expect(f.ledger.current()).toEqual({account:'Account A',binary:'/backend/a',keys:['["message","42","one"]','["message","42","two"]']});
  f.ledger.viewed('Account A','/backend/a','42',['two']);expect(f.changed).toHaveBeenCalledOnce();
  const reopen=f.ledger.current()!;reopen.keys.push('not actually read');expect(f.ledger.current()!.keys).toHaveLength(2);
  f.changed.mock.calls[0][0].keys.length=0;expect(f.ledger.current()!.keys).toHaveLength(2);
  f.ledger.viewed('Account A','/backend/a','43',['one']);expect(f.ledger.current()!.keys.at(-1)).toBe('["message","43","one"]');
});
it('rejects stale account or backend contexts and clears old metadata on change, sign-out and reset',()=>{
  const f=fixture();f.ledger.viewed('Account A','/backend/a','42',['one']);
  for(const [account,binary] of [['Account B','/backend/a'],['Account A','/backend/b']])expect(()=>f.ledger.viewed(account,binary,'42',['two'])).toThrow('account changed');
  f.connect({account:'Account B',binary:'/backend/a'});expect(f.ledger.current()!.keys).toEqual([]);
  expect(()=>f.ledger.viewed('Account A','/backend/a','42',['one'])).toThrow('account changed');
  f.ledger.viewed('Account B','/backend/a','42',['two']);f.connect({account:'Account B',binary:'/backend/b'});expect(f.ledger.current()!.keys).toEqual([]);
  f.ledger.viewed('Account B','/backend/b','42',['three']);f.ledger.clear();expect(f.ledger.current()!.keys).toEqual([]);
  f.connect(undefined);expect(f.ledger.current()).toBeUndefined();expect(()=>f.ledger.viewed('Account B','/backend/b','42',['three'])).toThrow('account changed');
});
it('bounds IPC data and retains only the most recent 500 exact identifiers',()=>{
  const f=fixture();
  for(const peer of ['0','01','me','18446744073709551616',{},null])expect(()=>f.ledger.viewed('Account A','/backend/a',peer,['one'])).toThrow('Invalid');
  for(const ids of [null,{},'one',[null],[''],['x'.repeat(257)],['bad\nvalue'],Array(501).fill('one')])expect(()=>f.ledger.viewed('Account A','/backend/a','42',ids)).toThrow('Invalid');
  expect(f.changed).not.toHaveBeenCalled();
  f.ledger.viewed('Account A','/backend/a','18446744073709551615',Array.from({length:500},(_,i)=>String(i)));
  f.ledger.viewed('Account A','/backend/a','42',['latest']);const keys=f.ledger.current()!.keys;
  expect(keys).toHaveLength(500);expect(keys[0]).toBe('["message","18446744073709551615","1"]');expect(keys.at(-1)).toBe('["message","42","latest"]');
});
