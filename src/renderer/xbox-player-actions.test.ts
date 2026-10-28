import {expect,it} from 'vitest';
import type {XboxRelationship} from '../shared/types';
import {xboxRelationshipOptions,xboxPlayerOptions} from './XboxPlayerActions';

const relationship:XboxRelationship={xuid:'2',isFriend:false,isFollowing:false,isFollower:false,favorite:false,blocked:false,requestState:'none'};
const actions=(patch:Partial<XboxRelationship>)=>xboxRelationshipOptions({...relationship,...patch}).map(option=>option.action);
it('offers state-appropriate friend actions without sending a second request for an existing pending request',()=>{
 expect(actions({})).toEqual(['send-request','block']);
 expect(actions({requestState:'incoming'})).toEqual(['accept-request','decline-request','block']);
 expect(actions({requestState:'outgoing'})).toEqual(['cancel-request','block']);
 expect(actions({requestState:'unknown'})).toEqual(['block']);
});
it('requires confirmation for blocking/removing and makes unblock the only relationship action for blocked players',()=>{
 const options=xboxRelationshipOptions({...relationship,isFriend:true,favorite:true});
 expect(options).toContainEqual({action:'remove-friend',label:'Remove friend',confirm:true});
 expect(options).toContainEqual({action:'block',label:'Block',confirm:true});
 expect(actions({isFriend:true,favorite:true})).toEqual(['remove-friend','unfavorite','block']);
 expect(actions({blocked:true,isFriend:true,requestState:'incoming'})).toEqual(['unblock']);
});
it('keeps unblock available for a verified blocked-list entry whose deleted profile cannot load',()=>{
 expect(xboxPlayerOptions(undefined,true)).toEqual([{action:'unblock',label:'Unblock',confirm:false}]);
 expect(xboxPlayerOptions(undefined,false)).toEqual([]);
});
