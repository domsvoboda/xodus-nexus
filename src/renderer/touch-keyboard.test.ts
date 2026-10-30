import {expect,it,vi} from 'vitest';
import {installTouchKeyboard} from './touch-keyboard';
it('requests text entry only on trusted touch/pen releases and keeps focus and content intact',async()=>{
  let handler:(event:any)=>void=()=>{};
  const element:any={tagName:'INPUT',type:'search',isConnected:true,disabled:false,readOnly:false,value:'kept'};
  const win:any={document:{activeElement:element},addEventListener:(_name:string,fn:any)=>{handler=fn;},removeEventListener:vi.fn()};
  const show=vi.fn(async()=>{}),stop=installTouchKeyboard(win,show);
  const event={target:element,isTrusted:true,pointerType:'touch'};
  for(const patch of [{isTrusted:false},{pointerType:'mouse'},{target:null}])handler({...event,...patch});
  for(const patch of [{disabled:true},{readOnly:true},{isConnected:false},{type:'checkbox'}]){
    const old={...element};Object.assign(element,patch);handler(event);Object.assign(element,old);
  }
  expect(show).not.toHaveBeenCalled();handler(event);handler({...event,pointerType:'pen'});
  expect(show).toHaveBeenCalledTimes(2);expect(element.value).toBe('kept');expect(win.document.activeElement).toBe(element);
  stop();expect(win.removeEventListener).toHaveBeenCalledWith('click',handler,true);
});
