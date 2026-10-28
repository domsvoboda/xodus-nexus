import {expect,it} from 'vitest';
import {demoSnapshot} from '../shared/demo-data';
import {catalogXboxTitleId,gameDetailsTarget} from './game-details-target';
const games=demoSnapshot().games;
it('keeps installed identities separate from a read-only catalog target',()=>{
 expect(gameDetailsTarget(games[0].id,games)).toEqual({game:games[0],productId:games[0].storeId});
 expect(gameDetailsTarget({productId:'9AAAAAAAAAAA'},games)).toEqual({productId:'9AAAAAAAAAAA'});
 expect(()=>gameDetailsTarget('9AAAAAAAAAAA',games)).toThrow('Game not found');
});
it.each([null,[],{},123,{productId:'bad'},{productId:'9aaaaaaaaaaa'},{productId:'9AAAAAAAAAAA',path:'/tmp/game'},{productId:'9AAAAAAAAAAA',titleId:'123'},{productId:['9AAAAAAAAAAA']}])('rejects malformed catalog targets without accepting a path or caller title ID: %j',value=>{
 expect(()=>gameDetailsTarget(value,games)).toThrow();
});
it('uses only one exact, validated Display Catalog XboxTitleId mapping',()=>{
 const row=(Value:unknown)=>({IdType:'XboxTitleId',Value});
 expect(catalogXboxTitleId([row('1877522801'),{IdType:'OtherId',Value:'444'}])).toBe('1877522801');
 expect(catalogXboxTitleId([row('00012'),row('12')])).toBe('12');
 for(const value of [undefined,[],[row('12'),row('13')],[row('0')],[row('4294967296')],[row(12)],[row('0x42')],[row('12'),row('bad')],Array(101).fill(row('12'))])expect(catalogXboxTitleId(value)).toBeUndefined();
});
