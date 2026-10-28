import {expect,it,vi} from 'vitest';
import {demoSnapshot} from '../shared/demo-data';
import {watchChatDesktop} from './chat-desktop-snapshot';

function fixture(){
  let resolve!:(value:ReturnType<typeof demoSnapshot>)=>void,reject!:(error:Error)=>void,receive!:(value:ReturnType<typeof demoSnapshot>)=>void;
  const pending=new Promise<ReturnType<typeof demoSnapshot>>((yes,no)=>{resolve=yes;reject=no;});
  const order:string[]=[],unsubscribe=vi.fn(),changed=vi.fn(),failed=vi.fn();
  const dispose=watchChatDesktop({onSnapshot:callback=>{order.push('subscribe');receive=callback;return unsubscribe;},getSnapshot:()=>{order.push('get');return pending;}},changed,failed);
  return {resolve,reject,receive,order,unsubscribe,changed,failed,dispose};
}
it('subscribes before reading and uses the initial context when there is no newer event',async()=>{
  const f=fixture(),data=demoSnapshot();expect(f.order).toEqual(['subscribe','get']);f.resolve(data);await Promise.resolve();
  expect(f.changed).toHaveBeenCalledWith(data);expect(f.failed).not.toHaveBeenCalled();f.dispose();expect(f.unsubscribe).toHaveBeenCalledOnce();
});
it('cannot restore a stale account after sign-out or a newer backend snapshot',async()=>{
  const f=fixture(),old=demoSnapshot(),next=demoSnapshot();next.auth={...next.auth,username:undefined,running:false,stored:false};
  f.receive(next);f.resolve(old);await Promise.resolve();expect(f.changed.mock.calls).toEqual([[next]]);expect(f.failed).not.toHaveBeenCalled();f.dispose();
});
it('does not show a stale startup error after a successful newer context',async()=>{
  const f=fixture();f.receive(demoSnapshot());f.reject(Error('Old failure'));await Promise.resolve();expect(f.failed).not.toHaveBeenCalled();f.dispose();
});
it('reports an initial read failure without retrying, and ignores all results after disposal',async()=>{
  const failed=fixture();failed.reject(Error('Offline'));await Promise.resolve();expect(failed.failed).toHaveBeenCalledOnce();failed.dispose();
  const f=fixture();f.dispose();f.receive(demoSnapshot());f.resolve(demoSnapshot());await Promise.resolve();expect(f.changed).not.toHaveBeenCalled();expect(f.failed).not.toHaveBeenCalled();
});
