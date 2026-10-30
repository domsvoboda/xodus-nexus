import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { showBeforeAccountCheck } from './launcher-startup.js';

describe('visible launcher before keyring/account access (#212)', () => {
  const source = readFileSync('src/main/index.ts', 'utf8');
  const begin = source.indexOf('async function refreshInitialAccount()');
  const refreshSource = transpileModule(source.slice(begin, source.indexOf('\nasync function runAuth(', begin)), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  function initialFixture(automatic = false) {
    let complete!: (value: unknown) => void;
    const check = new Promise(resolve => { complete = resolve; });
    const startForStartup = vi.fn(async () => ({ gameMode: true, state: 'ready', message: 'Ready' }));
    const context = createContext({ keyringSupport: { check: () => check, startForStartup }, authState: { running: false, stored: null }, shutdownStarted: false,
      initialWalletAttempted: false, accountRefreshKey: () => 'original-backend',
      mainWindow: { isDestroyed: () => false, isVisible: () => true, webContents: { send: vi.fn() } },
      backend: { current: { available: automatic, capabilities: { commands: automatic ? ['keyring-unlock'] : [] } } },
      refreshAccount: vi.fn(async () => {}), emitSnapshot: vi.fn() });
    const job = runInContext(refreshSource + '\nrefreshInitialAccount()', context) as Promise<void>;
    return { context, job, complete };
  }
  it.each(['stopped', 'locked', 'ready'])('prepares the visible Game Mode wallet before account access: %s', async state => {
    const { context, job, complete } = initialFixture(true);
    const events: string[] = [];
    context.keyringSupport.startForStartup.mockImplementation(async () => { events.push('native-wallet'); return { gameMode: true, state: 'ready', message: 'Ready' }; });
    context.refreshAccount.mockImplementation(async () => { events.push('account'); });
    complete({ gameMode: true, state }); await job;
    expect(events).toEqual(['native-wallet', 'account']);
    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith('keyring-state', expect.objectContaining({ state: 'ready' }));
    expect(context.initialWalletAttempted).toBe(true);
  });
  it.each(['disabled', 'missing', 'needs-setup', 'locked', 'unavailable'])('keeps failed or cancelled automatic preparation honest and does not read the account: %s', async state => {
    const { context, job, complete } = initialFixture(true);
    context.keyringSupport.startForStartup.mockResolvedValue({ gameMode: true, state, message: 'Native wallet not ready' });
    complete({ gameMode: true, state: 'stopped' }); await job;
    expect(context.refreshAccount).not.toHaveBeenCalled();
    expect(context.authState).toMatchObject({ stored: null, note: 'Native wallet not ready' });
    await runInContext('refreshInitialAccount()', context);
    expect(context.keyringSupport.startForStartup).toHaveBeenCalledOnce();
  });
  it.each(['new-auth', 'shutdown', 'backend-change'])('discards a late native unlock result after %s', async change => {
    const { context, job, complete } = initialFixture(true);
    let finish!: (value: unknown) => void;
    context.keyringSupport.startForStartup.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    complete({ gameMode: true, state: 'locked' });
    await vi.waitFor(() => expect(context.keyringSupport.startForStartup).toHaveBeenCalledOnce());
    if (change === 'new-auth') context.authState = { stored: true, running: false, lastResult: 'success' };
    if (change === 'shutdown') context.shutdownStarted = true;
    if (change === 'backend-change') context.accountRefreshKey = () => 'replacement-backend';
    const current = context.authState;
    finish({ gameMode: true, state: 'ready' }); await job;
    expect(context.authState).toBe(current);
    expect(context.refreshAccount).not.toHaveBeenCalled();
    expect(context.mainWindow.webContents.send).not.toHaveBeenCalled();
  });
  it.each(['desktop', 'hidden-window', 'destroyed-window', 'no-unlock-capability'])('does not automatically prompt with %s', async reason => {
    const { context, job, complete } = initialFixture(true);
    if (reason === 'hidden-window') context.mainWindow.isVisible = () => false;
    if (reason === 'destroyed-window') context.mainWindow.isDestroyed = () => true;
    if (reason === 'no-unlock-capability') context.backend.current.capabilities.commands = [];
    complete({ gameMode: reason !== 'desktop', state: 'locked' }); await job;
    expect(context.keyringSupport.startForStartup).not.toHaveBeenCalled();
    expect(context.initialWalletAttempted).toBe(false);
  });
  it.each([true, false])('does not replace a newer sign-in result after a late keyring check: running=%s', async running => {
    const { context, job, complete } = initialFixture();
    const current = { running, stored: !running, lastResult: running ? undefined : 'success', note: 'Newer sign-in' };
    context.authState = current;
    complete({ gameMode: true, state: 'locked', message: 'Old locked state' });
    await job;
    expect(context.authState).toBe(current);
    expect(context.refreshAccount).not.toHaveBeenCalled();
    expect(context.emitSnapshot).not.toHaveBeenCalled();
  });
  it.each(['ready', 'unavailable'])('does not block normal account reads on a metadata result of %s', async state => {
    const { context, job, complete } = initialFixture();
    complete({ gameMode: true, state, message: 'Metadata only' });
    await job;
    expect(context.refreshAccount).toHaveBeenCalledOnce();
  });
  it('preserves the normal backend fallback when metadata tools are unavailable', async () => {
    const { context, job, complete } = initialFixture(true);
    complete({ gameMode: true, state: 'unavailable' }); await job;
    expect(context.refreshAccount).toHaveBeenCalledOnce();
    expect(context.keyringSupport.startForStartup).not.toHaveBeenCalled();
  });
  it('avoids a hidden wallet prompt in Game Mode without locking out Desktop Mode', async () => {
    for (const gameMode of [true, false]) {
      const { context, job, complete } = initialFixture();
      complete({ gameMode, state: 'locked', message: 'Unlock the wallet in Desktop Mode.' });
      await job;
      expect(context.refreshAccount).toHaveBeenCalledTimes(gameMode ? 0 : 1);
      if (gameMode) expect(context.authState.note).toBe('Unlock the wallet in Desktop Mode.');
    }
  });
  it('shows the window and resolves startup while a keyring read remains pending', async () => {
    const events: string[] = [];
    let done!: () => void;
    const refresh = new Promise<void>(resolve => { done = resolve; });
    await showBeforeAccountCheck(async () => { events.push('visible'); }, () => { events.push('keyring'); return refresh; }, () => events.push('failed'));
    expect(events).toEqual(['visible', 'keyring']);
    done();
  });
  it('handles both synchronous and asynchronous account failures without closing the UI', async () => {
    for (const refresh of [() => { throw Error('locked'); }, async () => { throw Error('locked'); }]) {
      const show = vi.fn(async () => {}), failed = vi.fn();
      await showBeforeAccountCheck(show, refresh, failed);
      await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
      expect(show).toHaveBeenCalledOnce();
    }
  });
  it('does not start account access when creating the window fails', async () => {
    const refresh = vi.fn();
    await expect(showBeforeAccountCheck(async () => { throw Error('window'); }, refresh, vi.fn())).rejects.toThrow('window');
    expect(refresh).not.toHaveBeenCalled();
  });
  it('uses nonblocking startup for the launcher but preserves ordered game shortcut initialization', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const tail = source.slice(source.indexOf('await syncManagedWinePath();', source.indexOf('app.whenReady()')));
    expect(tail).toContain('await showBeforeAccountCheck(');
    // Ready (so a party reset cannot end the shortcut session) only once the launch is handed over.
    expect(tail).toMatch(/if \(startupRequest.gameId\) \{\s*await prepareSystemWallet\(\);\s*await refreshAccount\(false\);(\s*\/\/[^\n]*)*\s*launchReady = true;\s*receiveLaunchRequest/);
    expect(tail.indexOf('launchReady = true')).toBeGreaterThan(tail.indexOf('if (startupRequest.gameId)'));
    expect(tail.indexOf('registerIpc();')).toBeLessThan(tail.indexOf('await showBeforeAccountCheck('));
  });
});

describe('explicit Game Mode wallet preparation', () => {
  const source = readFileSync('src/main/index.ts', 'utf8');
  const begin = source.indexOf('async function prepareSystemWallet()');
  const js = transpileModule(source.slice(begin, source.indexOf('\nasync function runAuth(', begin)), {compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
  it.each([{gameMode:false,state:'locked'},{gameMode:true,state:'ready'},{gameMode:true,state:'unavailable'}])('does not prompt for %j', async status => {
    const context=createContext({keyringSupport:{check:async()=>status,start:vi.fn()}});
    await runInContext(js+'\nprepareSystemWallet()',context);
    expect(context.keyringSupport.start).not.toHaveBeenCalled();
  });
  it('shows a parent before unlocking a direct shortcut and restores the shortcut lifecycle', async () => {
    const events:string[]=[];const hide=vi.fn();
    const context=createContext({shortcutOnly:true,mainWindow:undefined,keyringSupport:{check:async()=>({gameMode:true,state:'stopped'}),start:async()=>{events.push('unlock');return{state:'ready'};}}});
    context.showLauncher=async()=>{events.push('show');context.shortcutOnly=false;context.mainWindow={hide,isDestroyed:()=>false};};
    await runInContext(js+'\nprepareSystemWallet()',context);
    expect(events).toEqual(['show','unlock']);expect(hide).toHaveBeenCalledOnce();expect(context.shortcutOnly).toBe(true);
  });
  it('keeps a cancelled wallet locked and does not clear saved account state or hide the UI', async () => {
    const hide=vi.fn(),account={stored:true};
    const context=createContext({shortcutOnly:false,mainWindow:{isDestroyed:()=>false,hide},authState:account,
      keyringSupport:{check:async()=>({gameMode:true,state:'locked'}),start:async()=>({state:'locked',message:'Unlock cancelled'})}});
    await expect(runInContext(js+'\nprepareSystemWallet()',context)).rejects.toThrow('Unlock cancelled');
    expect(context.authState).toBe(account);expect(hide).not.toHaveBeenCalled();
  });
});

describe('capability-bound session wallet shutdown', () => {
  const source = readFileSync('src/main/index.ts', 'utf8');
  const begin = source.indexOf('const keyringSupport = new KeyringSupport(');
  const js = transpileModule(source.slice(begin, source.indexOf('\nconst demoArtwork', begin)), {compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
  it.each([true, false])('uses only the actual backend stop capability: %s', async available => {
    let actions: { startProvider: (...args: unknown[]) => Promise<void> } | undefined;
    const startSessionKeyring = vi.fn(async () => {});
    const context = createContext({ process: { env: {}, platform: 'linux' }, startSessionKeyring,
      backend: { current: { binaryPath: '/private/managed/backend', capabilities: { commands: available ? ['keyring-session-stop'] : ['keyring-unlock'] } } },
      KeyringSupport: class { constructor(...args: unknown[]) { actions = args[4] as typeof actions; } },
    });
    runInContext(js, context);
    const environment = {DISPLAY: ':1'}, owned = async () => false;
    await actions!.startProvider('ksecretd', environment, owned);
    expect(startSessionKeyring).toHaveBeenCalledWith('ksecretd', environment, owned, available ? '/private/managed/backend' : undefined);
  });
  it.each(['shutdown', 'no-window', 'destroyed-window'])('does not create a late native password prompt after %s', async reason => {
    let actions: { unlock: () => Promise<string> } | undefined;
    const unlock = vi.fn();
    const context = createContext({ process: { env: {}, platform: 'linux' }, walletUnlocker: { unlock },
      shutdownStarted: reason === 'shutdown', mainWindow: reason === 'no-window' ? undefined : { isDestroyed: () => reason === 'destroyed-window' },
      KeyringSupport: class { constructor(...args: unknown[]) { actions = args[4] as typeof actions; } },
    });
    runInContext(js, context);
    expect(await actions!.unlock()).toBe('cancelled');
    expect(unlock).not.toHaveBeenCalled();
  });
});
