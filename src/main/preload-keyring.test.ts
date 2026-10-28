import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';

it('delivers automatic wallet status and removes exactly its own preload listener', () => {
  let api: any;
  const on = vi.fn(), removeListener = vi.fn(), invoke = vi.fn();
  const electron = { contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { api = value; } }, ipcRenderer: { on, removeListener, invoke } };
  const js = transpileModule(readFileSync('src/preload/index.cts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(js, { exports: {}, require: (name: string) => { expect(name).toBe('electron'); return electron; } });
  const callback = vi.fn(), dispose = api.onKeyringStatus(callback);
  const [channel, listener] = on.mock.calls[0];
  expect(channel).toBe('keyring-state');
  const status = { state: 'ready', canStart: false, gameMode: true, message: 'Ready' };
  listener({ sender: 'not exposed' }, status);
  expect(callback).toHaveBeenCalledWith(status);
  dispose(); expect(removeListener).toHaveBeenCalledWith('keyring-state', listener);
  api.createKeyringCollection(); expect(invoke).toHaveBeenCalledWith('keyring-create');
  api.createDiagnosticReport('0123456789abcdef'); expect(invoke).toHaveBeenCalledWith('create-diagnostic-report', '0123456789abcdef');
  api.saveDiagnosticReport('reviewed text'); expect(invoke).toHaveBeenCalledWith('save-diagnostic-report', 'reviewed text');
});

it('passes only bounded chat-read metadata through named IPC channels and cleans up its own listener',()=>{
  let api:any;
  const on=vi.fn(),removeListener=vi.fn(),invoke=vi.fn();
  const electron={contextBridge:{exposeInMainWorld:(_name:string,value:unknown)=>{api=value;}},ipcRenderer:{on,removeListener,invoke}};
  const js=transpileModule(readFileSync('src/preload/index.cts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
  runInNewContext(js,{exports:{},require:()=>electron});
  const receive=vi.fn(),dispose=api.onXboxChatReads(receive),state={account:'Fixture',binary:'/fixture',keys:['["message","42","one"]']};
  const [channel,listener]=on.mock.calls[0];expect(channel).toBe('xbox-chat-reads');listener({sender:'not exposed'},state);
  expect(receive.mock.calls).toEqual([[state]]);dispose();expect(removeListener).toHaveBeenCalledWith(channel,listener);
  api.getXboxChatReads();expect(invoke).toHaveBeenCalledWith('xbox-chat-reads');
  api.viewedXboxChat('Fixture','/fixture','42',['one']);expect(invoke).toHaveBeenCalledWith('xbox-chat-viewed','Fixture','/fixture','42',['one']);
  api.nativeSocial.popOutXboxChat('42');expect(invoke).toHaveBeenCalledWith('pop-out-xbox-chat','42');
  api.closeXboxChat();expect(invoke).toHaveBeenCalledWith('close-xbox-chat');
});
