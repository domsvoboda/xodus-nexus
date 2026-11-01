import {afterEach,expect,it,vi} from 'vitest';
import {SteamKeyboard,steamKeyboardUrl} from './steam-keyboard.js';
afterEach(()=>vi.restoreAllMocks());
function fixture(open=vi.fn(async()=>{})){
  let now=1000;const window:any={webContents:{mainFrame:{}},isDestroyed:()=>false,isFocused:()=>true};
  const event:any={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  return {open,window,event,keyboard:new SteamKeyboard(open,()=>now,'linux'),advance:()=>{now+=501;}};
}
it('opens only from the focused owning window and main frame',async()=>{
  const f=fixture();
  expect(await f.keyboard.show({...f.event,senderFrame:{}},f.window)).toBe(false);
  expect(await f.keyboard.show({...f.event,sender:{mainFrame:{}}},f.window)).toBe(false);
  expect(await f.keyboard.show(f.event,{...f.window,isFocused:()=>false})).toBe(false);
  expect(await f.keyboard.show(f.event,null)).toBe(false);expect(f.open).not.toHaveBeenCalled();
  expect(await f.keyboard.show(f.event,f.window)).toBe(true);expect(f.open).toHaveBeenCalledOnce();
});
it('coalesces gestures and never retries a missing or stopped Steam client',async()=>{
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  let finish!:()=>void;const f=fixture(vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})));
  const pending=f.keyboard.show(f.event,f.window);f.advance();expect(await f.keyboard.show(f.event,f.window)).toBe(false);
  finish();expect(await pending).toBe(true);expect(f.open).toHaveBeenCalledOnce();
  const failed=fixture(vi.fn(async()=>{throw Error('Steam is not running');}));
  expect(await failed.keyboard.show(failed.event,failed.window)).toBe(false);
  expect(await failed.keyboard.show(failed.event,failed.window)).toBe(false);expect(failed.open).toHaveBeenCalledOnce();
  failed.advance();expect(await failed.keyboard.show(failed.event,failed.window)).toBe(false);expect(failed.open).toHaveBeenCalledTimes(2);
});

it('passes field bounds and mode through the Steam URL without including the text being typed',async()=>{
  const f=fixture();
  const field={x:20.4,y:100.6,width:300.2,height:40,mode:1};
  expect(await f.keyboard.show(f.event,f.window,field)).toBe(true);
  expect(f.open).toHaveBeenCalledWith('steam://open/keyboard?XPosition=20&YPosition=101&Width=300&Height=40&Mode=1');
  expect(steamKeyboardUrl()).toBe('steam://open/keyboard');
});

it.each([null,{}, {x:-1,y:0,width:1,height:1,mode:0}, {x:0,y:NaN,width:1,height:1,mode:0}, {x:0,y:0,width:0,height:1,mode:0}, {x:0,y:0,width:1,height:1,mode:4}, {x:'0&other=true',y:0,width:1,height:1,mode:0}])('rejects invalid keyboard field data: %j',async field=>{
  const f=fixture();
  expect(await f.keyboard.show(f.event,f.window,field)).toBe(false);expect(f.open).not.toHaveBeenCalled();
});
