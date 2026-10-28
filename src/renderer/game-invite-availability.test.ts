import {afterEach,expect,it,vi} from 'vitest';
import {watchGameInviteAvailability} from './game-invite-availability';
afterEach(()=>vi.useRealTimers());
it('refreshes an open menu when the native game starts or stops accepting invitations',async()=>{
 vi.useFakeTimers();let ready=false;
 const read=vi.fn(async()=>({canInvite:ready})),publish=vi.fn();
 const watcher=watchGameInviteAvailability(read,publish);await vi.advanceTimersByTimeAsync(0);
 expect(publish).toHaveBeenLastCalledWith({canInvite:false});ready=true;
 await vi.advanceTimersByTimeAsync(3000);expect(publish).toHaveBeenLastCalledWith({canInvite:true});
 ready=false;await watcher.refresh();expect(publish).toHaveBeenLastCalledWith({canInvite:false});
 watcher.stop();await vi.advanceTimersByTimeAsync(9000);expect(read).toHaveBeenCalledTimes(3);
});
it('does not overlap reads or publish a late result after closing or changing account',async()=>{
 vi.useFakeTimers();let resolve!:(value:{canInvite:boolean})=>void;
 const read=vi.fn(()=>new Promise<{canInvite:boolean}>(r=>{resolve=r;})),publish=vi.fn();
 const watcher=watchGameInviteAvailability(read,publish);await vi.advanceTimersByTimeAsync(9000);
 expect(read).toHaveBeenCalledOnce();watcher.stop();resolve({canInvite:true});await Promise.resolve();expect(publish).not.toHaveBeenCalled();
});
it('fails closed without retrying any invitation action',async()=>{
 vi.useFakeTimers();const publish=vi.fn();const watcher=watchGameInviteAvailability(async()=>{throw Error('unavailable');},publish);
 await vi.advanceTimersByTimeAsync(0);expect(publish).toHaveBeenLastCalledWith({canInvite:false,reason:expect.any(String)});watcher.stop();
});
