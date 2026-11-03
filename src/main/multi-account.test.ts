import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { assertActivityCompatible } from './install-queue';
import { parseSavedAccounts, useSavedAccount, forgetSavedAccount } from './saved-accounts';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
function savedFixture() {
  const calls: string[] = [];
  let finish!: () => void;
  const mutation = new Promise<void>(resolve => { finish = resolve; });
  const context: Record<string, any> = {
    authState: { stored: true, username: 'store-one', player: 'personal-player', running: false },
    backend: { current: { binaryPath: '/synthetic/cli', capabilities: { savedAccounts: true } } },
    authJob: undefined, shutdownStarted: false, revokeOffline: vi.fn(async () => {}),
    accountRefresh: { invalidate: () => calls.push('invalidate') },
    accountLibrary: { reset: () => calls.push('library-reset') },
    gameActivities: { select: vi.fn() }, gameAchievements: { select: vi.fn() },
    xboxSocial: { close: () => calls.push('close-social') },
    nativeSocialBeforeAuth: [async () => { calls.push('prepare-social'); }],
    resetNativeSocial: () => calls.push('reset-social'),
    accountProfile: { select: async () => calls.push('clear-player-profile') },
    licenseProfile: { select: async () => calls.push('clear-license-profile') },
    emitSnapshot: () => {},
    useSavedAccount: vi.fn(async () => { calls.push('use'); await mutation; }),
    forgetSavedAccount: vi.fn(async () => { calls.push('forget'); await mutation; }),
    refreshAccount: vi.fn(async () => { calls.push('refresh'); }),
  };
  context.ensureIdle = () => { if (context.authJob || context.authState.running) throw Error('busy'); };
  const start = source.indexOf('function requestSavedAccount(');
  const code = ts.transpileModule(source.slice(start, source.indexOf('async function startInstall(', start)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, context);
  return { context, calls, finish, request: (action: string, name = 'store-two') => context.requestSavedAccount(action, name) as Promise<void> };
}

it.each(['use', 'forget'])('serializes %s before its first await and reconciles identity before unlocking', async action => {
  const f = savedFixture();
  const job = f.request(action);
  expect(() => f.request('use')).toThrow('busy');
  await vi.waitFor(() => expect(f.calls).toContain(action));
  expect(f.context.authState.running).toBe(true);
  expect(f.context.authState.player).toBe('personal-player');
  expect(f.calls.indexOf('prepare-social')).toBeLessThan(f.calls.indexOf(action));
  expect(f.calls.indexOf('clear-player-profile')).toBeLessThan(f.calls.indexOf(action));
  f.finish(); await job; await Promise.resolve();
  expect(f.calls.at(-1)).toBe('refresh');
  expect(f.context.authState.running).toBe(false);
  expect(f.context.authJob).toBeUndefined();
});

it('reconciles a failed switch and releases its auth reservation', async () => {
  const f = savedFixture();
  f.context.useSavedAccount.mockRejectedValueOnce(Error('expired'));
  await expect(f.request('use')).rejects.toThrow('expired');
  expect(f.context.refreshAccount).toHaveBeenCalled();
  expect(f.context.authState.running).toBe(false);
  expect(f.context.authJob).toBeUndefined();
});

it('parses only bounded valid saved identities and rejects malformed envelopes', async () => {
  expect(parseSavedAccounts('diagnostic\n' + JSON.stringify({ accounts: ['one', 'one', '', '\nunsafe', 3, 'two'], active: 'one' }))).toEqual({ accounts: ['one', 'two'], active: 'one' });
  expect(parseSavedAccounts('{"accounts":null}')).toBeNull();
  expect(parseSavedAccounts('null')).toBeNull();
  expect(parseSavedAccounts('{"accounts":[],"active":"bad\\nname"}')).toEqual({ accounts: [], active: undefined });
  await expect(useSavedAccount('/never-executed', '\ninvalid')).rejects.toThrow('Invalid account');
  await expect(forgetSavedAccount('/never-executed', '')).rejects.toThrow('Invalid account');
});

it.each(['success','busy','timeout'])('automatically selects the install Store account without changing player identity (%s)', async mode => {
 const busy=mode==='busy';let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const use=vi.fn(async()=>{await gate;if(mode==='timeout')throw Error('timeout after commit');}),authState={stored:true,username:'other-store',player:'personal-player'};
 const context:any={game:{licenseAccount:'install-store'},authState,savedAccounts:['install-store'],
  backend:{current:{binaryPath:'/synthetic/cli',capabilities:{savedAccounts:true}}},
  operations:new Map(),store:{downloads:[]},gameOperation:undefined,installQueue:{size:busy?1:0},
  assertActivityCompatible,nativeSocialBeforeAuth:[],resetNativeSocial:vi.fn(),xboxSocial:{close:vi.fn()},
  useSavedAccount:use,accountRefresh:{invalidate:vi.fn()},emitSnapshot:vi.fn(),accountProfile:{select:vi.fn(async()=>{})},licenseProfile:undefined,
  refreshAccount:async()=>{context.authState.username='install-store';}};
 const start=source.indexOf('  if (game.licenseAccount &&',source.indexOf('async function prepareGameLaunch('));
 const block=source.slice(start,source.indexOf('  const inspected',start));
 const code=ts.transpileModule('async function selectInstallAccount(){'+block+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(code,context);
 if(busy){await expect(context.selectInstallAccount()).rejects.toThrow('Another Xodus operation');expect(use).not.toHaveBeenCalled();}
 else {const job=context.selectInstallAccount();await vi.waitFor(()=>expect(use).toHaveBeenCalled());expect(context.authState.running).toBe(true);release();if(mode==='timeout')await expect(job).rejects.toThrow('timeout after commit');else await job;expect(context.authState.running).toBe(false);expect(use).toHaveBeenCalledWith('/synthetic/cli','install-store');expect(context.authState.username).toBe('install-store');}
 expect(authState.player).toBe('personal-player');
});

it('revokes offline licenses when forgetting the active Store, leaving other saved accounts alone', async () => {
 for(const name of ['store-one','store-two']) {
  const f=savedFixture(),job=f.request('forget',name);f.finish();await job;
  expect(f.context.revokeOffline).toHaveBeenCalledTimes(name==='store-one'?1:0);
 }
});

it('reconciles active Forget despite offline cleanup failure and releases the reservation', async () => {
 const f=savedFixture();f.context.revokeOffline.mockRejectedValueOnce(Error('cleanup blocked'));
 const job=f.request('forget','store-one');f.finish();
 await expect(job).rejects.toThrow('cleanup blocked');
 expect(f.context.refreshAccount).toHaveBeenCalledWith(false,true);
 expect(f.context.authState.running).toBe(false);expect(f.context.authJob).toBeUndefined();
});

it('requires readable active Store status before Forget can mutate credentials', async () => {
 const f=savedFixture();f.context.authState.stored=null;
 await expect(f.request('forget')).rejects.toThrow('Refresh account status');
 expect(f.context.forgetSavedAccount).not.toHaveBeenCalled();expect(f.context.authJob).toBeUndefined();
});
