import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {afterEach,expect,it,vi} from 'vitest';
import {nativeDialogsAvailable} from './launcher-environment.js';

// Extract the real guard and both chooser registrations from registerIpc so the
// test exercises the actual wiring rather than a reimplementation.
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const start=source.indexOf('  const assertNativeDialogs = () => {',source.indexOf('function registerIpc():'));
const chooseFile=source.indexOf("  ipcMain.handle('choose-file'",start);
const close=source.indexOf('\n  });',chooseFile);
if(start<0||chooseFile<0||close<0)throw Error('Could not locate the native chooser registrations');
const block=source.slice(start,close+'\n  });'.length);
const code=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

type Handler=(event:unknown,...args:unknown[])=>Promise<unknown>;
function fixture() {
  const handlers=new Map<string,Handler>();
  const showOpenDialog=vi.fn(async()=>({canceled:false,filePaths:['/picked']}));
  const context:any={ipcMain:{handle:(name:string,fn:Handler)=>handlers.set(name,fn)},dialog:{showOpenDialog},mainWindow:{},nativeDialogsAvailable};
  runInNewContext(code,context);
  return {showOpenDialog,call:(name:string,...args:unknown[])=>handlers.get(name)!(undefined,...args)};
}
const saved=process.env.XDG_CURRENT_DESKTOP;
afterEach(()=>{
  if(saved===undefined)delete process.env.XDG_CURRENT_DESKTOP;else process.env.XDG_CURRENT_DESKTOP=saved;
  vi.restoreAllMocks();
});

it('refuses both native chooser routes under gamescope without opening a dialog',async()=>{
  process.env.XDG_CURRENT_DESKTOP='KDE:gamescope';
  const f=fixture();
  for(const name of ['choose-directory','choose-file'])await expect(f.call(name)).rejects.toThrow('unavailable in Gaming Mode');
  expect(f.showOpenDialog).not.toHaveBeenCalled();
});

it('returns the selected desktop path and null on cancel for both routes',async()=>{
  process.env.XDG_CURRENT_DESKTOP='KDE';
  const f=fixture();
  await expect(f.call('choose-directory','/start')).resolves.toBe('/picked');
  expect(f.showOpenDialog).toHaveBeenLastCalledWith({},{properties:['openDirectory','createDirectory'],defaultPath:'/start'});
  await expect(f.call('choose-file','/file')).resolves.toBe('/picked');
  expect(f.showOpenDialog).toHaveBeenLastCalledWith({},{properties:['openFile'],defaultPath:'/file'});
  f.showOpenDialog.mockResolvedValue({canceled:true,filePaths:[]});
  await expect(f.call('choose-directory')).resolves.toBeNull();
  await expect(f.call('choose-file')).resolves.toBeNull();
});
