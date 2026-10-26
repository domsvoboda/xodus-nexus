import {afterEach,expect,it,vi} from 'vitest';
import {FriendsRefresh} from './friends-refresh';
afterEach(()=>vi.useRealTimers());
it('refreshes only after its interval and stops all future reads on close',async()=>{
  vi.useFakeTimers();const read=vi.fn(async()=>true),poll=new FriendsRefresh(read,()=>true);
  poll.start();expect(read).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(15_000);expect(read).toHaveBeenCalledOnce();
  poll.stop();await vi.advanceTimersByTimeAsync(300_000);expect(read).toHaveBeenCalledOnce();
});
it('does not query while hidden and resumes without a burst when visible',async()=>{
  vi.useFakeTimers();let visible=false;const read=vi.fn(async()=>true),poll=new FriendsRefresh(read,()=>visible);
  poll.start();await vi.advanceTimersByTimeAsync(60_000);expect(read).not.toHaveBeenCalled();visible=true;
  for(let n=0;n<20;n++)poll.wake();await vi.advanceTimersByTimeAsync(14_999);expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledOnce();poll.stop();
});
it('never overlaps a slow read or restarts after it completes following close',async()=>{
  vi.useFakeTimers();let done!:(value:boolean)=>void;const read=vi.fn(()=>new Promise<boolean>(resolve=>{done=resolve;}));
  const poll=new FriendsRefresh(read,()=>true);poll.start();await vi.advanceTimersByTimeAsync(15_000);
  poll.wake();await vi.advanceTimersByTimeAsync(300_000);expect(read).toHaveBeenCalledOnce();poll.stop();done(true);
  await vi.advanceTimersByTimeAsync(300_000);expect(read).toHaveBeenCalledOnce();
});
it('backs off failed reads and restores the normal interval after recovery',async()=>{
  vi.useFakeTimers();const read=vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
  const poll=new FriendsRefresh(read,()=>true);poll.start();await vi.advanceTimersByTimeAsync(15_000);expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29_999);expect(read).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);expect(read).toHaveBeenCalledTimes(3);await vi.advanceTimersByTimeAsync(15_000);expect(read).toHaveBeenCalledTimes(4);poll.stop();
});
it('bounds repeated errors to one retry per five minutes and catches thrown reads',async()=>{
  vi.useFakeTimers();const read=vi.fn(async()=>{throw Error('synthetic offline');});
  const poll=new FriendsRefresh(read,()=>true);poll.start();await vi.advanceTimersByTimeAsync(15_000+30_000+60_000+120_000+240_000);
  expect(read).toHaveBeenCalledTimes(5);await vi.advanceTimersByTimeAsync(299_999);expect(read).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);expect(read).toHaveBeenCalledTimes(6);poll.stop();
});
