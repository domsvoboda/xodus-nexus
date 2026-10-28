import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ScriptTarget,transpileModule} from 'typescript';
import {expect,it,vi} from 'vitest';
import {XboxChatReads} from './xbox-chat-reads.js';

// Exercise the actual registrations without creating windows or accessing an account.
const source=readFileSync('src/main/index.ts','utf8');
const handlers=transpileModule(source.slice(source.indexOf(" ipcMain.handle('pop-out-xbox-chat'"),source.indexOf("  ipcMain.handle('xbox-player-details'")),{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
function fixture(){
  const main={webContents:{mainFrame:{}},visible:true,minimized:false,focused:true,isVisible:()=>main.visible,isMinimized:()=>main.minimized,isFocused:()=>main.focused};
  const popup={mainFrame:{}},callbacks=new Map<string,Function>();
  const connection=vi.fn(()=>({account:'A',binary:'/a'} as {account:string;binary:string}|undefined));
  const changed=vi.fn(),chatReads=new XboxChatReads(connection,changed);
  const chatWindows={show:vi.fn(),close:vi.fn(),owns:(event:any)=>event.sender===popup&&event.senderFrame===popup.mainFrame,canView:vi.fn((event:any,peer:any)=>event.sender===popup&&event.senderFrame===popup.mainFrame&&peer==='42')};
  runInNewContext(handlers,{ipcMain:{handle:(channel:string,callback:Function)=>callbacks.set(channel,callback)},mainWindow:main,chatWindows,chatReads,nativeSocialConnection:connection,
    socialSender:(event:any)=>{if(event.sender!==main.webContents&&event.sender!==popup||event.senderFrame!==event.sender.mainFrame)throw Error('Untrusted sender');}});
  const event=(sender:any=main.webContents)=>({sender,senderFrame:sender.mainFrame});
  return {main,popup,connection,chatWindows,chatReads,changed,event,call:(name:string,...args:any[])=>callbacks.get(name)!(...args)};
}
it('requires a current account before opening and lets only the owning popup close itself',()=>{
  const f=fixture();f.call('pop-out-xbox-chat',f.event(),'42');expect(f.chatWindows.show).toHaveBeenCalledWith('42');
  f.connection.mockReturnValue(undefined);expect(()=>f.call('pop-out-xbox-chat',f.event(),'42')).toThrow('Sign in');expect(f.chatWindows.show).toHaveBeenCalledOnce();
  expect(()=>f.call('close-xbox-chat',f.event())).toThrow('own window');f.call('close-xbox-chat',f.event(f.popup));expect(f.chatWindows.close).toHaveBeenCalledWith(f.popup);
});
it('requires trusted main-frame callers and a focused visible chat before acknowledging exact IDs',()=>{
  const f=fixture();f.call('xbox-chat-viewed',f.event(),'A','/a','42',['one']);expect(f.changed).toHaveBeenCalledOnce();
  f.main.focused=false;expect(()=>f.call('xbox-chat-viewed',f.event(),'A','/a','42',['two'])).toThrow('active chat');
  f.main.focused=true;f.main.visible=false;expect(()=>f.call('xbox-chat-viewed',f.event(),'A','/a','42',['two'])).toThrow('active chat');
  f.main.visible=true;f.main.minimized=true;expect(()=>f.call('xbox-chat-viewed',f.event(),'A','/a','42',['two'])).toThrow('active chat');
  for(const sender of [f.main.webContents,f.popup,{mainFrame:{}}])expect(()=>f.call('xbox-chat-viewed',{sender,senderFrame:{}},'A','/a','42',['two'])).toThrow('Untrusted');
  expect(f.changed).toHaveBeenCalledOnce();
});
it('binds popup acknowledgements to its own peer and exposes the retained ledger only to the launcher',()=>{
  const f=fixture();f.call('xbox-chat-viewed',f.event(f.popup),'A','/a','42',['one']);
  expect(()=>f.call('xbox-chat-viewed',f.event(f.popup),'A','/a','43',['one'])).toThrow('active chat');
  expect(()=>f.call('xbox-chat-viewed',f.event(f.popup),'B','/a','42',['one'])).toThrow('account changed');
  expect(()=>f.call('xbox-chat-viewed',f.event(f.popup),'A','/b','42',['one'])).toThrow('account changed');
  expect(()=>f.call('xbox-chat-reads',f.event(f.popup))).toThrow('through Nexus');
  expect(f.call('xbox-chat-reads',f.event())).toEqual({account:'A',binary:'/a',keys:['["message","42","one"]']});
});
