import {expect,it,vi} from 'vitest';
import {SteamKeyboard} from './steam-keyboard.js';
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
  let finish!:()=>void;const f=fixture(vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})));
  const pending=f.keyboard.show(f.event,f.window);f.advance();expect(await f.keyboard.show(f.event,f.window)).toBe(false);
  finish();expect(await pending).toBe(true);expect(f.open).toHaveBeenCalledOnce();
  const failed=fixture(vi.fn(async()=>{throw Error('Steam is not running');}));
  expect(await failed.keyboard.show(failed.event,failed.window)).toBe(false);
  expect(await failed.keyboard.show(failed.event,failed.window)).toBe(false);expect(failed.open).toHaveBeenCalledOnce();
  failed.advance();expect(await failed.keyboard.show(failed.event,failed.window)).toBe(false);expect(failed.open).toHaveBeenCalledTimes(2);
});
