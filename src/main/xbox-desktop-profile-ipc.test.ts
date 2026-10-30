import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ScriptTarget,transpileModule} from 'typescript';
import {expect,it} from 'vitest';

const source=readFileSync('src/main/index.ts','utf8');
const start=source.indexOf("  ipcMain.handle('xbox-desktop-profile'");
const handler=transpileModule(source.slice(start,source.indexOf(" ipcMain.handle('xbox-game-invite-availability'",start)),{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
function fixture(profile?:{id:string;xuid:string}){
  const main={webContents:{mainFrame:{}}};let callback:Function;
  runInNewContext(handler,{mainWindow:main,desktopProfileRequest:profile,ipcMain:{handle:(_channel:string,fn:Function)=>{callback=fn;}}});
  return {main,call:(sender=main.webContents,senderFrame=sender.mainFrame)=>callback({sender,senderFrame})};
}
it('reads the empty desktop request in demo and before backend initialization',()=>{
  expect(fixture().call()).toBeUndefined();
});
it('returns an existing desktop request without requiring native Social capabilities',()=>{
  const request={id:'request',xuid:'42'};expect(fixture(request).call()).toEqual(request);
});
it('rejects foreign windows and child frames before returning a desktop request',()=>{
  const f=fixture({id:'request',xuid:'42'});
  expect(()=>f.call({mainFrame:{}})).toThrow('through Nexus');
  expect(()=>f.call(f.main.webContents,{})).toThrow('through Nexus');
});
