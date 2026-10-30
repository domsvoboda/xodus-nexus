import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { demoSnapshot } from '../shared/demo-data.js';
import { StateStore } from './store.js';
import { GameContent } from './game-content.js';
import { DownloadCleanup } from './download-cleanup.js';

// Run the real IPC/admission/download lifecycle with synthetic child processes.
// No account, executable, network, installed game or production profile is used.
const h = vi.hoisted(() => ({
  root: '', wine: '', backend: {} as any, runtime: {} as any,
  savedPausedId: '',
  updateSignals: [] as AbortSignal[],
  updateReplies: [] as any[],
  updateStops: vi.fn(async () => {}),
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => any>(),
  downloads: [] as { args: string[]; progress: (paused?: boolean, phase?: string) => void; finish: (code: number) => void }[],
  installQueue: undefined as undefined | { settled(id: string): Promise<void> },
  game: undefined as undefined | { finish: (code?: number, output?: string) => void },
  quit: vi.fn(), maximize: vi.fn(),
  blockDisplay: vi.fn(() => 7), releaseDisplay: vi.fn(() => true),
  steamProfiles: [] as string[], steamIsRunning: true,
  liveImport: vi.fn(), offlineImport: vi.fn(), showMessage: vi.fn(),
  showSave: vi.fn(),
  trash: vi.fn(), deleteFiles: vi.fn(), removeShortcut: vi.fn(async () => {}), signals: [] as string[],
  notifications: [] as { title: string; body: string }[],
  holdCancellation: false,
  holdAccountReads: false,
  contentSupported: false,
  discoverySupported: false,
  offlineRuntimeSupported: false,
  connectivityState: 'unknown' as 'unknown'|'online'|'offline',
  libraryReads: 0,
  launchEnvironments: [] as NodeJS.ProcessEnv[],
  launchArguments: [] as string[][],
  backendRefreshes: 0, runtimeRefreshes: 0,
  accountRequests: 0,
  trayCreated: vi.fn(), trayDestroyed: vi.fn(),
  prefixLocales: [] as (string | undefined)[],
  planOverrides: new Map<string, any>(),
  libraryRows: [] as any[],
  accountReads: [] as ((result: { code: number; output: string }) => void)[],
  posters: vi.fn(async (ids: string[]) => new Map(ids.map(id => [id, `https://store-images.s-microsoft.com/${id}`]))),
}));
vi.mock('./launcher-tray-desktop.js',()=>({desktopTrayAvailable:()=>true}));
vi.mock('electron', () => ({
  Notification: class { static isSupported() { return true; } constructor(private options: { title: string; body: string }) {} on() {} show() { h.notifications.push(this.options); } },
  app: { requestSingleInstanceLock: () => true, getPath: (name: string) => path.join(h.root, name),
    setPath: vi.fn(), on: (name: string, callback: (...args: any[]) => any) => h.events.set(name, callback), once: vi.fn(),
    whenReady: () => Promise.resolve(), getVersion: () => '0.0.0', isPackaged: false, emit:vi.fn(), quit: h.quit },
  ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => h.handlers.set(name, callback),removeHandler:(name:string)=>h.handlers.delete(name) },
  BrowserWindow: class { webContents = { on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() };
    on() {} once() {} show() {} hide() {} isVisible() {return true;} focus() {} maximize = h.maximize; isDestroyed() { return false; } async loadFile() {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
  globalShortcut:{register:vi.fn(()=>false),unregister:vi.fn()},
  dialog: { showMessageBox: h.showMessage, showSaveDialog: h.showSave }, nativeImage: {createFromPath:()=>({isEmpty:()=>false})}, Menu:{buildFromTemplate:(items:unknown)=>items}, Tray:class {constructor(){h.trayCreated();}setToolTip(){}on(){}setContextMenu(){}destroy(){h.trayDestroyed();}}, shell: { trashItem: h.trash }, powerSaveBlocker: { start: h.blockDisplay, stop: h.releaseDisplay },
}));
vi.mock('./backend.js', () => ({ LINUX_RUN_PATCH: 'test-patch', BackendManager: class {
  get current() { return h.backend; } async refresh() {h.backendRefreshes++;} async checkUpdate() {} async externalDownloadRunning() { return false; }
  setExternalRoot() {} } }));
vi.mock('./runtime.js', () => ({ RuntimeManager: class { get current() { return h.runtime; } async refresh() {h.runtimeRefreshes++;} async checkNexus() {} setRoot() {} } }));
vi.mock('./catalog.js', () => ({ CatalogService: class { async artwork() { return new Map(); } posters = h.posters; } }));
vi.mock('./account-profile.js', () => ({ AccountProfile: class { async select() {} cancel() {} } }));
vi.mock('./launcher-update.js', () => ({ LauncherUpdater: class { state = {}; async initialize() {} async check() {} cancel() {} } }));
// Keep download integration fixtures isolated from the real compositor and shortcut portal.
vi.mock('./xbox-game-guide.js',()=>({XboxGameGuide:class {reset(){} bind(){} unbind(){} publish(){} async shutdown(){}}}));
vi.mock('./xbox-overlay-shortcut.js',()=>({ensureOverlayDesktopEntry:async()=>{},XboxOverlayShortcut:class {current={state:'disabled'};async configure(){}async shutdown(){}}}));
vi.mock('./launcher-fonts.js', () => ({ adoptLauncherFonts: () => undefined, externalFontEnvironment: (env: unknown) => env }));
// Keep the real queue and its cleanup barrier. A terminal snapshot can precede
// asynchronous metadata writes, so fixture phases must await actual settlement.
vi.mock('./install-queue.js', async original => {
  const module = await original<typeof import('./install-queue.js')>();
  return { ...module, InstallQueue: class extends module.InstallQueue {
    constructor(idle?: () => void) { super(idle); h.installQueue = this; }
  } };
});
// Deletion is restricted to disposable fixture directories, never real games.
vi.mock('./game-delete.js', () => ({ deleteGameDirectory: (target: { path: string }) => h.deleteFiles(target.path) }));
vi.mock('./session-environment.js', () => ({ prepareGameModeKeyring: async () => 'skipped' }));
vi.mock('./game-shortcuts.js', () => ({ shortcutArguments: () => ({}), shortcutInstanceData: () => ({}), shortcutInstanceRequest: () => ({}),
  GameShortcuts: class { async initialize() {} remove = h.removeShortcut; async steamDesktop() { return { file: path.join(h.root, 'game.desktop'),
    launch: { icon: h.wine, title: 'Sample game', executable: '/bin/sh', options: 'fixture', directory: h.root, identity: 'fixture' } }; } } }));
vi.mock('./steam-shortcuts.js', async original => ({ ...await original<typeof import('./steam-shortcuts.js')>(),
  steamAccounts: async () => h.steamProfiles, steamRunning: async () => h.steamIsRunning, addSteamShortcut: h.offlineImport }));
vi.mock('./steam-live.js', () => ({ addLiveSteamShortcut: h.liveImport }));
vi.mock('./shortcut-icon.js', () => ({ loadShortcutIcon: async () => undefined }));
vi.mock('./steam-artwork.js', () => ({ gameSteamPortrait: async (bytes: Buffer) => bytes, nexusSteamArtwork: async (bytes: Buffer) => ({ cover: bytes, wide: bytes }) }));
vi.mock('./install-plan.js', async original => ({ ...await original<typeof import('./install-plan.js')>(),
  readInstallPlan: async (_binary: string, productId: string, market: string) => h.planOverrides.get(productId) ?? ({
    schema:1,rootProductId:productId,market,status:'ready',choices:[{productId,contentId:'11111111-1111-4111-8111-111111111111',title:'Synthetic game',kind:'Game',platform:'Windows.Desktop',packageFormat:'MSIXVC',supported:true}],
  }),
}));
vi.mock('./xodus-service.js', () => ({ cloudSaveRuntime: async () => false, unbridgedCloudSaveRuntime: async () => false,
  gameInviteRuntime: async () => false,
  offlineIdentityRuntime: async () => h.offlineRuntimeSupported,
  selectedWinePath: () => h.wine, storeContentRuntime: async () => h.contentSupported, storeDiscoveryRuntime: async () => h.discoverySupported, startXodusService: async () => ({ socketPath: '/synthetic-updates', stop: h.updateStops }) }));
vi.mock('./game-updates.js', () => ({ queryGameUpdate: async (_socket: string, _id: string, _version: string, signal: AbortSignal) => {
  h.updateSignals.push(signal);
  if (h.updateReplies.length) return h.updateReplies.shift();
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Error('Update check cancelled.'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
} }));
// No public connectivity probes from an account-free launch integration fixture.
vi.mock('./connectivity.js',()=>({ConnectivityMonitor:class {
  get current(){return {state:h.connectivityState};} start(){} stop(){}
  async check(){return this.current;}
}}));
vi.mock('./proton.js', () => ({ prepareProtonRunner: async () => undefined, syncPrefixUserLocale: async (_wine: string, _prefix: string, locale: string | undefined) => { h.prefixLocales.push(locale); }, syncUnrealCultureGameIni: async () => {} }));
vi.mock('./game-wrapper.js', () => ({ prepareGameWrapper: async () => ({ command: h.wine, cleanup: async () => {} }) }));
vi.mock('./process.js', () => ({
  run: async (_command: string, args: string[]) => ({ code: 0, output: args[0] === 'account' ? JSON.stringify({ stored: true, username: 'sample@example.test' }) : '' }),
  spawnTracked: (_command: string, args: string[], options: any) => {
    if (args[0] === 'library') { h.libraryReads++;return {
      child: { kill: vi.fn(), stderr: { on() {}, removeListener() {} } },
      result: Promise.resolve({code:0,output:JSON.stringify({schema:1,account:'sample@example.test',market:'US',checkedAt:new Date().toISOString(),entitlements:h.libraryRows})}),
    }; }
    if (args[0] === 'account') { h.accountRequests++;return {
      child: { kill: vi.fn(() => true), stdin: { end: vi.fn() } },
      result: h.holdAccountReads
        ? new Promise<{ code: number; output: string }>(resolve => { h.accountReads.push(resolve); })
        : Promise.resolve({ code: 0, output: JSON.stringify({ stored: true, username: 'sample@example.test' }) }),
    }; }
    let resolve!: (result: { code: number; output: string }) => void, sequence = 0;
    const result = new Promise<{ code: number; output: string }>(done => { resolve = done; });
    const progress = (paused = false, phase = 'downloading') => options.onLine('NEXUS_PROGRESS ' + JSON.stringify({ schema: 1, event: 'progress', sequence: sequence++, phase,
      completedBytes: phase === 'complete' ? 100 : 20, totalBytes: 100, bytesPerSecond: 10, paused, canPause: phase === 'downloading' }));
    h.downloads.push({ args, progress, finish: code => resolve({ code, output: '' }) });
    return { child: { stdin: { on() {}, write: (line: string) => progress(JSON.parse(line).command === 'pause') }, kill: (signal: string) => { h.signals.push(signal); if (!h.holdCancellation) resolve({ code: 130, output: '' }); return true; } }, result };
  },
}));
vi.mock('./game-process.js', () => ({ spawnGameProcess: async (_command:string,_args:string[],options:{env:NodeJS.ProcessEnv}) => {
  h.launchArguments.push([..._args]);
  h.launchEnvironments.push({...options.env});
  let resolve!: (result: { code: number; output: string }) => void;
  const result = new Promise<{ code: number; output: string }>(done => { resolve = done; });
  h.game = { finish: (code = 0, output = '') => resolve({ code, output }) };
  return { child: {}, result, cleanup: async () => {}, stop: async () => resolve({ code: 0, output: '' }), forceStop: async () => {} };
} }));

const ipc = (name: string, ...args: any[]) => h.handlers.get(name)!(undefined, ...args);
const snapshot = () => ipc('get-snapshot');
const install = (letter: string, destination = path.join(h.root, `download-${letter}`)) => ipc('start-install', { productId: `9${letter.repeat(11)}`, title: `Sample ${letter}`, destination });

it('saves interface language without probing account, restarting components or altering game language and market', async () => {
  const before = await snapshot();
  const counts = [h.backendRefreshes, h.runtimeRefreshes, h.accountRequests, h.downloads.length];
  const settings = await ipc('update-settings', { interfaceLanguage: 'cs' });
  expect(settings).toEqual({ ...before.settings, interfaceLanguage: 'cs' });
  expect([h.backendRefreshes, h.runtimeRefreshes, h.accountRequests, h.downloads.length]).toEqual(counts);
  expect((await snapshot()).games).toEqual(before.games);
  for (const value of ['../cs', 'cs_CZ', '', null, 42]) await expect(ipc('update-settings', { interfaceLanguage: value })).rejects.toThrow('Invalid interface language');
  expect((await snapshot()).settings.interfaceLanguage).toBe('cs');
  await ipc('update-settings', { interfaceLanguage: before.settings.interfaceLanguage ?? 'system' });
});

it('adds fresh advisory target storage to public package preflight without creating a folder or starting a transfer (#247)', async () => {
  const destination=path.join(h.root,'storage-preview','game'),before=h.downloads.length;
  const plan=await ipc('install-plan','9AAAAAAAAAAA',destination);
  expect(plan.availableBytes).toBeTypeOf('number');expect(plan.choices[0].supported).toBe(true);
  expect(await fs.access(path.dirname(destination)).then(()=>true,()=>false)).toBe(false);
  expect(h.downloads).toHaveLength(before);
  await expect(ipc('install-plan','9AAAAAAAAAAA','relative')).rejects.toThrow('absolute path');
  expect((await ipc('install-plan','9AAAAAAAAAAA')).availableBytes).toBeUndefined();
});

it('saves shader cache limits through real IPC without refreshing components or changing installation state',async()=>{
  const refreshes=[h.backendRefreshes,h.runtimeRefreshes],downloads=snapshot().downloads,library=snapshot().games;
  await ipc('update-settings',{shaderCacheLimitGiB:8.5});expect(snapshot().settings.shaderCacheLimitGiB).toBe(8.5);
  expect([h.backendRefreshes,h.runtimeRefreshes]).toEqual(refreshes);
  expect(snapshot().downloads).toEqual(downloads);expect(snapshot().games).toEqual(library);
  for(const value of [0,-1,'bad',2048])await expect(ipc('update-settings',{shaderCacheLimitGiB:value})).rejects.toThrow('Shader cache limit');
  expect(snapshot().settings.shaderCacheLimitGiB).toBe(8.5);expect([h.backendRefreshes,h.runtimeRefreshes]).toEqual(refreshes);
});

it('saves ordinary launcher preferences without re-probing components or reading the account', async () => {
  const before=snapshot(),refreshes=[h.backendRefreshes,h.runtimeRefreshes],accounts=h.accountRequests;
  const settings={...before.settings,installRoot:path.join(h.root,'future-games'),parallelDownloads:6,verboseLogs:!before.settings.verboseLogs};
  await ipc('update-settings',settings);
  expect([h.backendRefreshes,h.runtimeRefreshes]).toEqual(refreshes);
  expect(h.accountRequests).toBe(accounts);
  expect(snapshot().settings).toMatchObject({installRoot:settings.installRoot,parallelDownloads:6,verboseLogs:settings.verboseLogs});
  expect(snapshot().settings.externalXodusRoot).toBe(before.settings.externalXodusRoot);
  expect(snapshot().games).toEqual(before.games);expect(snapshot().downloads).toEqual(before.downloads);
  expect(await fs.access(settings.installRoot).then(()=>true,()=>false)).toBe(false);
  await ipc('update-settings',before.settings);
  await ipc('update-settings',{externalXodusRoot:'   '});
  expect(snapshot().settings.externalXodusRoot).toBe('');
  expect([h.backendRefreshes,h.runtimeRefreshes]).toEqual(refreshes);
  expect(h.accountRequests).toBe(accounts);
});

it.each(['market','winePath','externalXodusRoot','runtimeRoot'] as const)
('still revalidates components and account scope after a real %s selection change',async key=>{
  const previous=snapshot().settings[key],counts=[h.backendRefreshes,h.runtimeRefreshes],accounts=h.accountRequests;
  const selected=key==='market'?'CZ':path.join(h.root,'selected-'+key);
  try{
    await ipc('update-settings',{[key]:selected});
    expect([h.backendRefreshes,h.runtimeRefreshes]).toEqual(counts.map(n=>n+1));
    expect(h.accountRequests).toBe(accounts+1);expect(snapshot().settings[key]).toBe(selected);
  }finally{await ipc('update-settings',{[key]:previous});}
});

beforeAll(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-install-integration-'));
  h.wine = path.join(h.root, 'runtime', 'wine'); await fs.mkdir(path.dirname(h.wine)); await fs.writeFile(h.wine, 'fixture', { mode: 0o700 });
  const data = demoSnapshot(); h.backend = { ...data.backend, capabilities: { ...data.backend.capabilities, packageSelection: true, streamingUpdateRecovery: true }, binaryPath: path.join(h.root, 'synthetic-cli'), linuxRunPatch: 'test-patch' }; h.runtime = data.runtime;
  const store = new StateStore(path.join(h.root, 'userData'));
  await store.setSettings({ firstRunCompleted: true, market: 'US', runtimeRoot: path.join(h.root, 'runtime'), winePath: h.wine });
  h.savedPausedId=randomUUID();
  const partial={id:h.savedPausedId,kind:'install' as const,productId:'9TTTTTTTTTTT',title:'Paused fixture',
    selectedContentId:'11111111-1111-4111-8111-111111111111',selectionMarket:'US',destination:path.join(h.root,'resumable-partial'),
    status:'paused' as const,phase:'',log:[],progress:1,startedAt:''};
  await new DownloadCleanup(path.join(h.root,'userData')).prepare(partial);
  await fs.writeFile(path.join(partial.destination,'partial.bin'),'disposable interrupted download');
  await store.addDownload(partial);
  const gamePath = path.join(h.root, 'installed-game'); await fs.mkdir(gamePath);
  await fs.writeFile(path.join(gamePath, 'MicrosoftGame.config'), '<Game><Identity Name="Example.Base" Version="1.0.0.0" Publisher="CN=Example"/><ShellVisuals DefaultDisplayName="Sample game"/><ExecutableList><Executable Name="Game.exe"/></ExecutableList><StoreId>9ZZZZZZZZZZZ</StoreId></Game>');
  await fs.writeFile(path.join(gamePath, 'Game.exe'), 'MZ fixture');
  await fs.writeFile(path.join(gamePath, '.xodus-streaming.msixvc'), 'synthetic container');
  await store.upsertGame({ ...data.games[0], id: 'sample', path: gamePath, storeId: '9ZZZZZZZZZZZ', packageName:'Example.Base', executable: 'Game.exe', installState: 'ready' });
  for (const id of ['remove-library', 'remove-delete', 'remove-fail', 'remove-playing-other']) {
    const directory = path.join(h.root, id); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'MicrosoftGame.config'), '<Game/>');
    await fs.writeFile(path.join(directory, 'keep.txt'), 'synthetic game files');
    await store.upsertGame({ ...data.games[0], id, path: directory, installState: 'ready' });
  }
  h.deleteFiles.mockImplementation(async (directory: string) => {
    if (path.dirname(directory) !== h.root) throw Error('Fixture refuses a non-test path');
    await fs.rm(directory, { recursive: true, force: false });
  });
  await import('./index.js');
  await vi.waitFor(() => expect(h.handlers.has('start-install')).toBe(true));
  // The window deliberately precedes the asynchronous startup account check.
  // Establish its completion before measuring requests caused by Settings.
  await vi.waitFor(() => {
    expect(h.accountRequests).toBe(1);
    expect(snapshot().auth.stored).toBe(true);
  });
  expect(h.maximize).toHaveBeenCalledOnce();
  expect(h.quit).not.toHaveBeenCalled();
});
afterAll(async () => {
  h.game?.finish(); for (const job of h.downloads) job.finish(130);
  await new Promise(resolve => setTimeout(resolve, 50));
  await fs.rm(h.root, { recursive: true, force: true });
});

it('diagnostic IPC previews without a save/upload, saves exactly reviewed text and honors cancellation', async () => {
  const downloadsBefore = h.downloads.length;
  const report = await ipc('create-diagnostic-report');
  expect(report.content).toContain('Launcher: 0.0.0'); expect(report.content).toContain('Backend:');
  expect(report.content).not.toContain('sample@example.test');
  expect(h.showSave).not.toHaveBeenCalled(); expect(h.downloads).toHaveLength(downloadsBefore);
  await expect(ipc('create-diagnostic-report', '../private')).rejects.toThrow('Game not found');
  h.showSave.mockResolvedValueOnce({ canceled: true });
  expect(await ipc('save-diagnostic-report', 'edited report')).toBe(false);
  const file = path.join(h.root, 'reviewed-report.txt');
  h.showSave.mockResolvedValueOnce({ canceled: false, filePath: file });
  expect(await ipc('save-diagnostic-report', 'reviewed text only')).toBe(true);
  expect(await fs.readFile(file, 'utf8')).toBe('reviewed text only');
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  const calls = h.showSave.mock.calls.length;
  await expect(ipc('save-diagnostic-report', { content: 'invalid' })).rejects.toThrow('Invalid');
  expect(h.showSave).toHaveBeenCalledTimes(calls);
});

it('real account-refresh IPC shares status reads and cannot publish a late old backend response', async () => {
  const backend = h.backend;
  h.holdAccountReads = true; h.accountReads = [];
  const old = ipc('account-refresh'), repeated = ipc('account-refresh');
  try {
    await vi.waitFor(() => expect(h.accountReads).toHaveLength(1));
    h.backend = { ...backend, binaryPath: path.join(h.root, 'new-synthetic-cli') };
    const current = ipc('account-refresh');
    await vi.waitFor(() => expect(h.accountReads).toHaveLength(2));
    h.accountReads[1]({ code: 0, output: JSON.stringify({ stored: true, username: 'sample@example.test' }) });
    await current;
    h.accountReads[0]({ code: 0, output: JSON.stringify({ stored: false }) });
    await Promise.all([old, repeated]);
    expect(snapshot().auth.stored).toBe(true);
    expect(snapshot().auth.username).toBe('sample@example.test');
  } finally {
    for (const resolve of h.accountReads) resolve({ code: 0, output: JSON.stringify({ stored: false }) });
    h.backend = backend; h.holdAccountReads = false;
    await ipc('account-refresh');
  }
});

it('passes all native profiles to Steam-owned live import without login preferences, preserving offline choice', async () => {
  const native = ['123', '456'].map(id => path.join(h.root, 'Steam/userdata', id, 'config'));
  const flatpak = path.join(h.root, '.var/app/com.valvesoftware.Steam/userdata/789/config');
  h.steamProfiles = [...native, flatpak]; h.liveImport.mockResolvedValue('live-uri');
  expect(await ipc('add-to-steam', 'sample')).toBe('live-uri');
  expect(h.showMessage).not.toHaveBeenCalled();
  expect(h.liveImport.mock.calls[0][0]).toEqual(native);
  const choose = h.liveImport.mock.calls[0][6];
  h.showMessage.mockResolvedValueOnce({ response: 1 });
  expect(await choose(native)).toBe(native[1]);
  h.showMessage.mockResolvedValueOnce({ response: 2 });
  expect(await choose(native)).toBeUndefined();
  h.showMessage.mockResolvedValueOnce({ response: 3 });
  await expect(choose(native)).rejects.toThrow('cancelled');
  h.steamIsRunning = false; h.offlineImport.mockResolvedValue('offline-uri');
  h.showMessage.mockResolvedValueOnce({ response: 1 });
  expect(await ipc('add-to-steam', 'sample')).toBe('offline-uri');
  expect(h.offlineImport.mock.calls[0][0]).toBe(native[1]);
  h.steamIsRunning = true; h.steamProfiles = [flatpak];
  await expect(ipc('add-to-steam', 'sample')).rejects.toThrow('Flatpak');
  expect(h.liveImport).toHaveBeenCalledOnce();
});

it('removes only unrelated games while downloading, without interrupting the queue', async () => {
  const active = await install('Q'), queued = await install('R');
  await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
  await vi.waitFor(() => {
    expect(snapshot().downloads.find((task: any) => task.id === queued)?.coverUrl).toBe('https://store-images.s-microsoft.com/9RRRRRRRRRRR');
    expect(snapshot().downloads.find((task: any) => task.id === active)?.coverUrl).toBe('https://store-images.s-microsoft.com/9QQQQQQQQQQQ');
  });
  expect(h.downloads).toHaveLength(1); // Waiting artwork never starts its process.
  h.downloads[0].progress();
  await ipc('pause-download', active);
  const downloadsBefore = structuredClone(snapshot().downloads);
  await ipc('remove-game', 'remove-library', 'library');
  expect(await fs.readFile(path.join(h.root, 'remove-library/keep.txt'), 'utf8')).toBe('synthetic game files');
  expect(h.trash).not.toHaveBeenCalled();
  expect(h.deleteFiles).not.toHaveBeenCalled();
  await expect(ipc('remove-game', 'remove-fail', 'trash-files')).rejects.toThrow('Invalid removal option');
  expect(h.deleteFiles).not.toHaveBeenCalled();

  h.deleteFiles.mockRejectedValueOnce(Error('Synthetic deletion failure'));
  await expect(ipc('remove-game', 'remove-fail', 'delete-files')).rejects.toThrow('Synthetic deletion failure');
  expect(snapshot().games.some((game: any) => game.id === 'remove-fail')).toBe(true);
  expect(await fs.readFile(path.join(h.root, 'remove-fail/keep.txt'), 'utf8')).toBe('synthetic game files');

  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  h.deleteFiles.mockImplementationOnce(async (directory: string) => {
    entered(); await gate;
    await fs.rm(directory, { recursive: true, force: false });
  });
  const removing = ipc('remove-game', 'remove-delete', 'delete-files');
  await ready;
  try {
    await expect(install('S')).rejects.toThrow('being removed');
    await expect(ipc('launch-game', 'sample')).rejects.toThrow('being removed');
    await expect(ipc('remove-game', 'remove-fail', 'library')).rejects.toThrow('being removed');
    await expect(ipc('update-settings', { runtimeRoot: path.join(h.root, 'other-runtime') })).rejects.toThrow('being removed');
    await ipc('resume-download', active);
    expect(snapshot().downloads.find((task: any) => task.id === active).status).toBe('running');
  } finally { release(); }
  await removing;
  expect(h.deleteFiles).toHaveBeenLastCalledWith(path.join(h.root, 'remove-delete'));
  await expect(fs.access(path.join(h.root, 'remove-delete'))).rejects.toThrow();
  expect(h.trash).not.toHaveBeenCalled();
  expect(h.removeShortcut).toHaveBeenCalledWith('remove-library');
  expect(h.removeShortcut).toHaveBeenCalledWith('remove-delete');
  expect(h.signals).toEqual([]);
  expect(h.downloads).toHaveLength(1);
  expect(snapshot().downloads.find((task: any) => task.id === queued).status).toBe('queued');
  expect(snapshot().downloads.map((task: any) => task.id)).toEqual(downloadsBefore.map((task: any) => task.id));
  expect(snapshot().games.some((game: any) => ['remove-library', 'remove-delete'].includes(game.id))).toBe(false);
  const persisted = new StateStore(path.join(h.root, 'userData')); await persisted.load();
  expect(persisted.games.some(game => ['remove-library', 'remove-delete'].includes(game.id))).toBe(false);
  await ipc('remove-game', 'remove-fail', 'library'); // Failed deletion released the admission lock.
  await ipc('cancel-download', queued); h.downloads[0].finish(1);
  await vi.waitFor(() => expect(snapshot().downloads.find((task: any) => task.id === active).status).toBe('failed'));
  h.downloads.splice(0);
  expect(h.notifications).toEqual([]);
});

it('offers cleanup only for a new folder and waits for process exit before deleting it', async () => {
  const id = await install('X'); await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
  const task = snapshot().downloads.find((task: any) => task.id === id), partial = path.join(task.destination, 'part.bin');
  await fs.writeFile(partial, 'disposable'); expect(await ipc('download-cancel-options', id)).toEqual({ deleteFilesAllowed: true });
  h.holdCancellation = true; const count = h.signals.length, pending = ipc('cancel-download', id, 'delete-files');
  try {
    await vi.waitFor(() => expect(h.signals.length).toBe(count + 1));
    expect(snapshot().downloads.find((task: any) => task.id === id).cancelling).toBe(true);
    expect(await fs.readFile(partial, 'utf8')).toBe('disposable');
    await expect(install('Y')).rejects.toThrow('being cancelled');
    await expect(ipc('import-game', task.destination)).rejects.toThrow('being cancelled');
    await expect(ipc('remove-download', id)).rejects.toThrow('cancellation cleanup');
    await expect(ipc('cancel-download', id, 'keep')).rejects.toThrow('already being cancelled');
    h.downloads[0].progress(); expect(await fs.readFile(partial, 'utf8')).toBe('disposable');
  } finally { h.holdCancellation = false; h.downloads[0].finish(130); }
  await pending;
  await expect(fs.access(task.destination)).rejects.toThrow();
  expect(snapshot().downloads.find((task: any) => task.id === id)).toMatchObject({ status: 'cancelled', phase: 'Cancelled; downloaded files were deleted.' });
  h.downloads.splice(0);
});

it('keeps new partials by default and refuses deletion of an existing folder or an update', async () => {
  const id = await install('U'); await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
  const directory = snapshot().downloads.find((task: any) => task.id === id).destination;
  await fs.writeFile(path.join(directory, 'keep'), 'partial'); await ipc('cancel-download', id);
  expect(await fs.readFile(path.join(directory, 'keep'), 'utf8')).toBe('partial'); h.downloads.splice(0);
  const existing = path.join(h.root, 'pre-existing-folder'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'original'), 'existing files');
  const next = await install('V', existing); await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
  expect((await ipc('download-cancel-options', next)).deleteFilesAllowed).toBe(false);
  const signals = h.signals.length; await expect(ipc('cancel-download', next, 'delete-files')).rejects.toThrow('Existing or untracked');
  expect(h.signals.length).toBe(signals); expect(await fs.readFile(path.join(existing, 'original'), 'utf8')).toBe('existing files');
  await ipc('cancel-download', next, 'keep'); h.downloads.splice(0);
  const update = await ipc('update-installed-game', 'sample'); await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
  expect((await ipc('download-cancel-options', update)).deleteFilesAllowed).toBe(false);
  await expect(ipc('cancel-download', update, 'delete-files')).rejects.toThrow('Updates and DLC');
  expect(await fs.readFile(path.join(h.root, 'installed-game/Game.exe'), 'utf8')).toBe('MZ fixture');
  await ipc('cancel-download', update, 'keep'); h.downloads.splice(0);
  await expect(ipc('cancel-download', update, 'invalid')).rejects.toThrow('Invalid cancellation');
});

it('resumes a persisted partial through real IPC and preserves safe cancellation cleanup under the new task ID',async()=>{
  expect(await ipc('download-cancel-options',h.savedPausedId)).toEqual({deleteFilesAllowed:true});
  await ipc('resume-download',h.savedPausedId);
  await vi.waitFor(()=>expect(h.downloads).toHaveLength(1));
  const task=snapshot().downloads.find((task:any)=>task.productId==='9TTTTTTTTTTT');
  expect(task.id).not.toBe(h.savedPausedId);expect(task.status).toBe('running');
  expect(snapshot().downloads.some((task:any)=>task.id===h.savedPausedId)).toBe(false);
  expect(await fs.readFile(path.join(task.destination,'partial.bin'),'utf8')).toBe('disposable interrupted download');
  expect(await ipc('download-cancel-options',task.id)).toEqual({deleteFilesAllowed:true});
  await ipc('cancel-download',task.id,'delete-files');
  await expect(fs.access(task.destination)).rejects.toThrow();
  expect(await fs.readFile(path.join(h.root,'installed-game','Game.exe'),'utf8')).toBe('MZ fixture');
  h.downloads.splice(0);
});

it('routes a direct Durable through real managed-content admission and completion without changing the base or adding a game',async()=>{
  const id='9MMMMMMMMMMM',base='9ZZZZZZZZZZZ',cid='22222222-2222-4222-8222-222222222222';
  const gamePath=path.join(h.root,'installed-game'),before=await fs.readFile(path.join(gamePath,'MicrosoftGame.config'),'utf8');
  const gamesBefore=snapshot().games.length,fetcher=globalThis.fetch;
  const originalCleanup = DownloadCleanup.prototype.complete;
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const cleanup = vi.spyOn(DownloadCleanup.prototype, 'complete').mockImplementation(async function(this: DownloadCleanup, task) {
    await cleanupGate;
    return originalCleanup.call(this, task);
  });
  const packageData={ContentId:cid,PackageFormat:'MSIXVC',Architectures:['x64'],PlatformDependencies:[{PlatformName:'Windows.Desktop'}],PackageFamilyName:'Example.Dlc_hash',MainPackageFamilyNameForDlc:'Example.Base_hash'};
  const records=[{ProductId:base,ProductType:'Game',DisplaySkuAvailabilities:[{Sku:{Properties:{IsTrial:false,Packages:[{...packageData,PackageFamilyName:'Example.Base_hash',MainPackageFamilyNameForDlc:undefined}]}}}]},
    {ProductId:id,ProductType:'Durable',LocalizedProperties:[{ProductTitle:'Synthetic DLC'}],DisplaySkuAvailabilities:[{Sku:{Properties:{IsTrial:false,Packages:[packageData]}}}]}];
  h.planOverrides.set(id,{schema:1,rootProductId:id,market:'US',status:'choice',choices:[{productId:id,contentId:cid,title:'Synthetic DLC',kind:'Durable',platform:'Windows.Desktop',packageFormat:'MSIXVC',supported:true,parentProductId:base,mainPackageFamilyName:'Example.Base_hash'}]});
  h.libraryRows=[{productId:id,status:'Active',isTrial:false,special:false,sharingSource:'None',endDate:'2099-01-01T00:00:00Z'}];h.contentSupported=true;
  globalThis.fetch=async input=>{const url=new URL(String(input));if(url.hostname!=='displaycatalog.mp.microsoft.com')throw Error('No fixture network permitted');const ids=url.searchParams.get('bigIds')!.split(',');return new Response(JSON.stringify({Products:records.filter(p=>ids.includes(p.ProductId))}));};
  try{
    await vi.waitFor(()=>expect(snapshot().auth.stored).toBe(true));
    const taskId=await ipc('start-install',{productId:id,title:'Synthetic DLC',destination:gamePath,selectedContentId:cid,selectionMarket:'US'});
    await vi.waitFor(()=>expect(h.downloads).toHaveLength(1));
    const task=snapshot().downloads.find((task:any)=>task.id===taskId);
    expect(task.kind).toBe('content');expect(task.gameId).toBe('sample');expect(task.destination.startsWith(gamePath)).toBe(false);
    expect(h.downloads[0].args[1]).toBe(cid);expect((await ipc('download-cancel-options',taskId)).deleteFilesAllowed).toBe(false);
    await fs.writeFile(path.join(task.destination,'MicrosoftGame.config'),`<Game><Identity Name="Example.Dlc" Version="1.0.0.0" Publisher="CN=Example"/><StoreId>${id}</StoreId><AllowedProducts><AllowedProduct>${base}</AllowedProduct></AllowedProducts><DesktopRegistration><MainPackageDependency Name="Example.Base"/></DesktopRegistration></Game>`);
    await fs.writeFile(path.join(task.destination,'appxmanifest.xml'),'<Package><Identity Name="Example.Dlc" Version="1.0.0.0" Publisher="CN=Example"/><Dependencies><MainPackageDependency Name="Example.Base"/></Dependencies></Package>');
    await fs.writeFile(path.join(task.destination,`layout_${cid}.xml`),'<Package><Chunk><FileGroup SourcePath="." Include="MicrosoftGame.config"/></Chunk></Package>');
    h.downloads[0].progress(false,'complete');h.downloads[0].finish(0);
    await vi.waitFor(()=>expect(snapshot().downloads.find((task:any)=>task.id===taskId).status).toBe('complete'));
    expect(await fs.readFile(path.join(gamePath,'MicrosoftGame.config'),'utf8')).toBe(before);
    expect(await fs.readFile(path.join(gamePath,'Game.exe'),'utf8')).toBe('MZ fixture');
    expect(snapshot().games).toHaveLength(gamesBefore);
    expect((await fs.readdir(task.destination))).toContain('.nexus-content-complete.json');
    // Persisted status is visible before asynchronous cleanup and notification.
    // Do not clear this fixture while that previous job can still notify later.
    expect(h.notifications).toEqual([]);
    releaseCleanup();
    await vi.waitFor(() => expect(h.notifications).toEqual([
      expect.objectContaining({ title: 'Content download complete', body: `${task.title} has finished downloading.` }),
    ]));
  }finally{releaseCleanup();cleanup.mockRestore();globalThis.fetch=fetcher;h.contentSupported=false;h.downloads.splice(0);h.notifications.splice(0);}
});

it('gates runtime DLC hints, clears inherited foreign hints and still launches after optional discovery fails without reading accounts',async()=>{
  const old=process.env.NEXUS_RELATED_PRODUCT_IDS;
  process.env.NEXUS_RELATED_PRODUCT_IDS='9FFFFFFFFFFF';
  const discover=vi.spyOn(GameContent.prototype,'relatedProducts');
  const beforeReads=h.libraryReads;
  try{
    for(const mode of ['legacy','supported','failure']){
      h.discoverySupported=mode!=='legacy';
      if(mode==='failure')discover.mockRejectedValueOnce(Error('private.invalid/signed?secret'));
      else if(mode==='supported')discover.mockResolvedValueOnce(['9MMMMMMMMMMM']);
      await ipc('launch-game','sample');expect(snapshot().gameOperation.status).toBe('running');
      expect(h.launchEnvironments.at(-1)!.NEXUS_RELATED_PRODUCT_IDS).toBe(mode==='supported'?'9MMMMMMMMMMM':undefined);
      expect(h.libraryReads).toBe(beforeReads);
      if(mode==='legacy')expect(discover).not.toHaveBeenCalled();
      if(mode==='failure')expect(snapshot().gameOperation.log.join('\n')).not.toContain('secret');
      h.game!.finish();await vi.waitFor(()=>expect(snapshot().gameOperation.status).toBe('complete'));
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(discover).toHaveBeenCalledTimes(2);
  }finally{
    discover.mockRestore();h.discoverySupported=false;h.blockDisplay.mockClear();h.releaseDisplay.mockClear();
    if(old===undefined)delete process.env.NEXUS_RELATED_PRODUCT_IDS;else process.env.NEXUS_RELATED_PRODUCT_IDS=old;
  }
});

it('saves and launches locale overrides without catalog or exhaustive manifest languages, including System default reset', async () => {
  const manifest = path.join(h.root, 'installed-game/MicrosoftGame.config');
  const before = await fs.readFile(manifest, 'utf8');
  const reads = h.libraryReads, fetcher = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('Language settings must work offline'); };
  const oldPackage = process.env.XODUS_PACKAGE_LOCALE, oldWine = process.env.WINEUSERLOCALE;
  process.env.XODUS_PACKAGE_LOCALE = 'fr-FR'; process.env.WINEUSERLOCALE = 'fr-FR';
  try {
    await fs.rename(manifest, path.join(h.root, 'installed-game/MicrosoftGame.Config'));
    expect(await ipc('game-locales', 'sample')).toEqual([]);
    for (const [selection, expected] of [['pl-PL', 'pl-PL'], ['de', 'de-DE'], ['pt-PT', 'pt-PT'], ['', undefined]] as const) {
      const game = await ipc('update-game', 'sample', { locale: selection });
      expect(game.locale).toBe(selection);
      await ipc('launch-game', 'sample'); expect(snapshot().gameOperation.status).toBe('running');
      expect(h.prefixLocales.at(-1)).toBe(selection || undefined);
      const env = h.launchEnvironments.at(-1)!;
      expect(env.WINEUSERLOCALE).toBe(expected);
      expect(env.XODUS_PACKAGE_LOCALE).toBe(selection || undefined);
      if (selection === 'de') expect(env.LANG).toBe('de_DE.UTF-8');
      expect(h.libraryReads).toBe(reads);
      h.game!.finish(); await vi.waitFor(() => expect(snapshot().gameOperation.status).toBe('complete'));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await expect(ipc('update-game', 'sample', { locale: 'de\nUNSAFE=value' })).rejects.toThrow();
    expect(snapshot().games.find((game: any) => game.id === 'sample').locale).toBe('');
    expect(await fs.readFile(path.join(h.root, 'installed-game/MicrosoftGame.Config'), 'utf8')).toBe(before);
  } finally {
    await fs.rename(path.join(h.root, 'installed-game/MicrosoftGame.Config'), manifest);
    globalThis.fetch = fetcher;
    if (oldPackage === undefined) delete process.env.XODUS_PACKAGE_LOCALE; else process.env.XODUS_PACKAGE_LOCALE = oldPackage;
    if (oldWine === undefined) delete process.env.WINEUSERLOCALE; else process.env.WINEUSERLOCALE = oldWine;
    h.blockDisplay.mockClear(); h.releaseDisplay.mockClear();
  }
});

it('launches offline only with both compatible components and discards inherited identity modes', async () => {
  const keys=['XODUS_FORCE_OFFLINE','XODUS_OFFLINE_IDENTITY','XODUS_ACCOUNT_HASH'] as const;
  const old=keys.map(key=>process.env[key]);
  const cache=h.backend.capabilities.licenseCache,launch=h.backend.capabilities.offlineLaunch;
  try {
    for(const key of keys)process.env[key]='foreign';
    h.connectivityState='offline';h.offlineRuntimeSupported=false;
    const count=h.launchEnvironments.length;
    await expect(ipc('launch-game','sample')).rejects.toThrow('compatible Nexus backend and runtime');
    expect(h.launchEnvironments).toHaveLength(count);
    h.offlineRuntimeSupported=true;h.backend.capabilities.offlineLaunch=false;
    await expect(ipc('launch-game','sample')).rejects.toThrow('compatible Nexus backend and runtime');
    expect(h.launchEnvironments).toHaveLength(count);
    h.backend.capabilities.licenseCache=true;h.backend.capabilities.offlineLaunch=true;
    for(const offline of [false,true]) {
      h.connectivityState=offline?'offline':'online';
      await ipc('launch-game','sample');
      const env=h.launchEnvironments.at(-1)!,args=h.launchArguments.at(-1)!;
      expect(env.XODUS_FORCE_OFFLINE).toBe(offline?'1':undefined);
      expect(env.XODUS_OFFLINE_IDENTITY).toBeUndefined();
      expect(env.XODUS_ACCOUNT_HASH).toMatch(/^[a-f0-9]{32}$/);
      expect(args.includes('--offline')).toBe(offline);expect(args).toContain('--license-cache');
      h.game!.finish(0);await vi.waitFor(()=>expect(snapshot().gameOperation.status).toBe('complete'));
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  } finally {
    keys.forEach((key,index)=>{if(old[index]===undefined)delete process.env[key];else process.env[key]=old[index];});
    h.backend.capabilities.licenseCache=cache;h.backend.capabilities.offlineLaunch=launch;
    h.connectivityState='unknown';h.offlineRuntimeSupported=false;
    h.blockDisplay.mockClear();h.releaseDisplay.mockClear();
  }
});

it('shows safe specific licensing guidance on failed launch and preserves later non-license errors', async () => {
  for (const [output, expected] of [
    ['NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-device-limit 200\nprivate@example.test t=SECRET', 'Microsoft Store device limit reached'],
    ['NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-not-entitled 200', 'purchased edition'],
    ['NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-http 501', 'server error'],
    ['NEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-device-limit 200\nNEXUS_CONTENT_LICENSE_DIAGNOSTIC_V1 content-parsed 200\nlater extraction failure', 'later extraction failure'],
  ]) {
    await ipc('launch-game', 'sample');
    h.game!.finish(1, output);
    await vi.waitFor(() => expect(snapshot().gameOperation.status).toBe('failed'));
    const error = snapshot().gameOperation.error;
    expect(error).toContain(expected);
    if (expected === 'Microsoft Store device limit reached') {
      expect(error).toContain('https://account.microsoft.com/devices/content');
      expect(error).not.toMatch(/SECRET|example.test|NEXUS_CONTENT_LICENSE/);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  h.blockDisplay.mockClear(); h.releaseDisplay.mockClear();
});

it('keeps interrupted updates blocked after cancellation and queue removal, then permits verified recovery (#405)', async () => {
  const directory = path.join(h.root, 'update-recovery'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'MicrosoftGame.config'), '<Game><Identity Name="Recovery.Base" Version="1.0.0.0"/><ShellVisuals DefaultDisplayName="Recovery game"/><ExecutableList><Executable Name="Recovery.exe"/></ExecutableList><StoreId>9RRRRRRRRRRR</StoreId></Game>');
  await fs.writeFile(path.join(directory, 'Recovery.exe'), 'MZ old fixture');
  await fs.writeFile(path.join(directory, '.xodus-streaming.msixvc'), 'old fixture metadata');
  const game = await ipc('import-game', directory), marker = path.join(directory, '.nexus-update-incomplete-v1');
  const launches = h.launchEnvironments.length;
  const notifications = h.notifications.length;
  const row = (id: string) => snapshot().downloads.find((task: any) => task.id === id);
  const installed = () => snapshot().games.find((entry: any) => entry.id === game.id);
  h.backend.capabilities.streamingUpdateRecovery = false;
  const count = h.downloads.length;
  await expect(ipc('update-installed-game', game.id)).rejects.toThrow('Update the Nexus backend');
  expect(h.downloads).toHaveLength(count);
  expect(await fs.access(marker).then(() => true, () => false)).toBe(false);
  h.backend.capabilities.streamingUpdateRecovery = true;
  let previousUpdate: string | undefined;
  const start = async () => {
    if (previousUpdate) await h.installQueue!.settled(previousUpdate);
    h.downloads.splice(0);
    const id = await ipc('update-installed-game', game.id);
    await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
    previousUpdate = id;
    return id as string;
  };
  const cancelled = await start();
  await fs.writeFile(marker, ''); // Model backend replacing the first file.
  await fs.writeFile(path.join(directory, 'Recovery.exe'), 'MZ new fixture');
  await ipc('cancel-download', cancelled, 'keep');
  expect(row(cancelled).status).toBe('cancelled');
  expect(installed()).toMatchObject({ installState: 'incomplete', updateIncomplete: true });
  await ipc('remove-download', cancelled);
  await ipc('clear-finished-downloads');
  const restarted = new StateStore(path.join(h.root, 'userData')); await restarted.load();
  expect(restarted.games.find(entry => entry.id === game.id)).toMatchObject({ installState: 'incomplete', updateIncomplete: true });
  await expect(ipc('launch-game', game.id)).rejects.toThrow('Resume the update');
  expect(h.launchEnvironments).toHaveLength(launches);
  // Reimporting or deleting queue history cannot erase the on-disk barrier.
  expect(await ipc('import-game', directory)).toMatchObject({ installState: 'incomplete', updateIncomplete: true });
  const manifest = path.join(directory, 'MicrosoftGame.config');
  await fs.rename(manifest, manifest + '.saved');
  await expect(ipc('launch-game', game.id)).rejects.toThrow('Resume the update');
  const failed = await start(); // Recovery must still work if the interrupted manifest is missing.
  await fs.rename(manifest + '.saved', manifest);
  h.downloads[0].finish(1);
  await vi.waitFor(() => expect(row(failed).status).toBe('failed'));
  expect(installed().updateIncomplete).toBe(true);
  const unconfirmed = await start();
  h.downloads[0].progress(false, 'complete'); h.downloads[0].finish(0);
  await vi.waitFor(() => expect(row(unconfirmed).status).toBe('failed'));
  expect(row(unconfirmed).error).toContain('Resume the update');
  expect(h.notifications).toHaveLength(notifications);
  const recovered = await start();
  await fs.unlink(marker); // Only a successful native metadata commit removes it.
  h.downloads[0].progress(false, 'complete'); h.downloads[0].finish(0);
  await vi.waitFor(() => expect(row(recovered).status).toBe('complete'));
  await vi.waitFor(() => expect(h.notifications).toHaveLength(notifications + 1));
  await h.installQueue!.settled(recovered);
  expect(installed()).toMatchObject({ installState: 'ready' });
  expect(installed().updateIncomplete).toBeUndefined();
  expect(await fs.readFile(path.join(directory, 'Recovery.exe'), 'utf8')).toBe('MZ new fixture');
  await ipc('remove-game', game.id, 'library');
  h.downloads.splice(0); h.notifications.splice(notifications);
});

it('changes only the tray preference without restarting account/backend work',async()=>{
 const accounts=h.accountRequests,backend=h.backendRefreshes;
 await h.handlers.get('update-settings')!({}, {closeToTray:true});
 expect(snapshot().settings.closeToTray).toBe(true);expect(h.trayCreated).toHaveBeenCalledOnce();
 await h.handlers.get('update-settings')!({}, {closeToTray:false});
 expect(snapshot().settings.closeToTray).toBe(false);expect(h.trayDestroyed).toHaveBeenCalledOnce();
 expect(h.accountRequests).toBe(accounts);expect(h.backendRefreshes).toBe(backend);
 await expect(h.handlers.get('update-settings')!({}, {closeToTray:'true'})).rejects.toThrow('close-to-tray');
});

it('cancels background update checks before play, install and removal, and supports an explicit stop (#480)', async () => {
  const begin = async () => {
    const count = h.updateSignals.length;
    const job = ipc('check-game-updates');
    await vi.waitFor(() => expect(h.updateSignals.length).toBe(count + 1));
    return { job, signal: h.updateSignals.at(-1)! };
  };
  const prior = {checking: false, available: true, latestVersion: '2.0.0.0', checkedAt: new Date().toISOString()};
  h.updateReplies.push(prior); await ipc('check-game-updates', 'sample');
  let check = await begin();
  await ipc('stop-game-update-check'); await check.job;
  expect(check.signal.aborted).toBe(true);
  expect(snapshot().gameUpdates.sample).toEqual(prior);
  expect(Object.values(snapshot().gameUpdates).some((entry: any) => entry.checking)).toBe(false);
  check = await begin();
  await ipc('launch-game', 'sample'); await check.job;
  expect(check.signal.aborted).toBe(true); expect(snapshot().gameOperation.status).toBe('running');
  h.game!.finish(); await vi.waitFor(() => expect(snapshot().gameOperation.status).toBe('complete'));
  await new Promise(resolve => setTimeout(resolve, 10));
  check = await begin();
  const id = await install('V'); await check.job;
  expect(check.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(h.downloads.length).toBeGreaterThan(0));
  await ipc('cancel-download', id, 'keep'); await h.installQueue!.settled(id);
  await ipc('remove-download', id); h.downloads.splice(0);
  const directory = path.join(h.root, 'remove-during-update-check');
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'Game.exe'), 'MZ fixture');
  await fs.copyFile(path.join(h.root, 'installed-game', 'MicrosoftGame.config'), path.join(directory, 'MicrosoftGame.config'));
  const game = await ipc('import-game', directory);
  check = await begin(); await ipc('remove-game', game.id, 'library'); await check.job;
  expect(check.signal.aborted).toBe(true); expect(snapshot().games.some((row: any) => row.id === game.id)).toBe(false);
  expect(h.updateStops).toHaveBeenCalledTimes(5);
  h.blockDisplay.mockClear(); h.releaseDisplay.mockClear();
});

it('queues an installed-game update behind another download and keeps duplicate destinations protected (#480)', async () => {
  const first = await install('U');
  await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
  const update = await ipc('update-installed-game', 'sample');
  expect(snapshot().downloads.find((row: any) => row.id === update)).toMatchObject({kind: 'update', status: 'queued'});
  expect(h.downloads).toHaveLength(1);
  await expect(ipc('update-installed-game', 'sample')).rejects.toThrow('already in');
  await expect(ipc('launch-game', 'sample')).rejects.toThrow('Finish or cancel');
  await ipc('cancel-download', update, 'keep'); await h.installQueue!.settled(update);
  await ipc('cancel-download', first, 'keep'); await h.installQueue!.settled(first);
  await ipc('remove-download', update); await ipc('remove-download', first); h.downloads.splice(0);
});

it('runs real queue IPC, pause/cancel/failure/restart and simultaneous play/download safely', async () => {
  const first = await install('A'); await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
  expect(h.blockDisplay).not.toHaveBeenCalled();
  await ipc('launch-game', 'sample'); expect(snapshot().gameOperation.status).toBe('running');
  for (const mode of ['library', 'delete-files']) await expect(ipc('remove-game', 'sample', mode)).rejects.toThrow('Close this game');
  await ipc('remove-game', 'remove-playing-other', 'library');
  expect(snapshot().gameOperation.status).toBe('running');
  expect(h.blockDisplay).toHaveBeenCalledWith('prevent-display-sleep');
  const cancel = await install('B'), next = await install('C');
  expect(h.downloads).toHaveLength(1); expect(snapshot().downloads.find((task: any) => task.id === next).status).toBe('queued');
  await expect(install('C')).rejects.toThrow('already in');
  await expect(install('D', path.join(h.root, 'installed-game', 'nested'))).rejects.toThrow('overlaps');
  await expect(ipc('update-installed-game', 'sample')).rejects.toThrow('Close this game');
  await expect(ipc('update-settings', { market: 'GB' })).rejects.toThrow('Another Xodus');
  await ipc('cancel-download', cancel); h.downloads[0].finish(1);
  await vi.waitFor(() => expect(h.downloads).toHaveLength(2));
  expect(h.downloads[1].args[1]).toBe('9CCCCCCCCCCC');
  expect(snapshot().downloads.find((task: any) => task.id === first).status).toBe('failed');
  h.downloads[1].progress(); await ipc('pause-download', next);
  expect(snapshot().downloads.find((task: any) => task.id === next).status).toBe('paused');
  const fourth = await install('D'); expect(h.downloads).toHaveLength(2);
  await ipc('resume-download', next); h.downloads[1].progress(false, 'complete'); h.downloads[1].finish(0);
  await vi.waitFor(() => expect(h.downloads).toHaveLength(3));
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toMatchObject({ title: 'Download complete', body: 'Sample C has finished downloading.' });
  expect(h.downloads[2].args[1]).toBe('9DDDDDDDDDDD'); expect(snapshot().gameOperation.status).toBe('running');
  await install('E');
  const restarted = new StateStore(path.join(h.root, 'userData')); await restarted.load();
  expect(restarted.downloads.filter(task => task.status === 'paused')).toHaveLength(2);
  await ipc('cancel-download', fourth); await vi.waitFor(() => expect(h.downloads).toHaveLength(4));
  // Closing stops advancement, even when process termination finishes later.
  await install('F'); const preventDefault = vi.fn(); h.events.get('before-quit')!({ preventDefault });
  await vi.waitFor(() => expect(h.quit).toHaveBeenCalled()); expect(preventDefault).toHaveBeenCalled();
  expect(h.downloads).toHaveLength(4);
  expect(h.notifications).toHaveLength(1); // no completion toast for cancelled/stopped jobs
  expect(h.releaseDisplay).toHaveBeenCalledWith(7);
});

it('saves overlay preferences without refreshing account or runtime access',async()=>{
  const before=h.accountReads.length;
  const saved=await ipc('update-settings',{overlayShortcut:'Control+Shift+G',overlaySide:'right',overlayEnabled:true});
  expect(saved).toMatchObject({overlayShortcut:'Control+Shift+G',overlaySide:'right',overlayEnabled:true});
  expect(h.accountReads).toHaveLength(before);
  const persisted=new StateStore(path.join(h.root,'userData'));await persisted.load();expect(persisted.settings.overlaySide).toBe('right');
  await expect(ipc('update-settings',{overlayShortcut:'not a shortcut'})).rejects.toThrow('shortcut');
});
