import {desktopTrayAvailable} from './launcher-tray-desktop.js';
import {LauncherTray} from './launcher-tray.js';
import {SteamKeyboard} from './steam-keyboard.js';
import type {XboxProfileRequest} from '../shared/types.js';
import {XboxSocial as NativeXboxSocial} from './xbox-native-social.js';
import {resetSocialTransport} from './xbox-social-transport.js';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, net, Notification, powerSaveBlocker, screen, shell, Tray, Menu } from 'electron';
import { constants, createWriteStream, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AppSnapshot, AuthStatus, ConnectivityStatus, DownloadTask, Game, OfflinePermissions, GameLaunchOptions, GameOperation, GameUpdate, InstallRequest, Settings } from '../shared/types.js';
import { downloadFailure, safeProductId } from '../shared/utils.js';
import { contentLicenseFailure } from '../shared/content-license.js';
import { interfaceLanguagePreference } from '../shared/interface-language.js';
import { nativeTranslator } from './interface-language.js';
import { downloadLimitArgs, downloadLimitKiB } from '../shared/download-bandwidth.js';
import { DownloadBandwidthControls, isBandwidthOnlyPatch } from './download-bandwidth.js';
import { isShaderCacheOnlyPatch, shaderCacheLimits } from '../shared/shader-cache.js';
import { demoAccountLibrary, demoAccountProducts, demoDownloads, demoGames, demoLaunchOptions, demoLocales, demoSnapshot, type DemoArtwork } from '../shared/demo-data.js';
import { backendLock } from './backend-package.js';
import {XboxGameGuide,checkGuideHost} from './xbox-game-guide.js';
import {XboxGuideParty} from './xbox-guide-party.js';
import {XboxOverlayShortcut,ensureOverlayDesktopEntry} from './xbox-overlay-shortcut.js';
import {xboxOverlaySettings,xboxOverlayPatch} from '../shared/xbox-overlay-settings.js';
import { BackendManager } from './backend.js';
import { run, spawnTracked } from './process.js';
import { inspectGameDirectory, StateStore } from './store.js';
import { hasIncompleteUpdate, INCOMPLETE_UPDATE_MESSAGE } from './installation-state.js';
import { RuntimeManager } from './runtime.js';
import { prepareProtonRunner, syncPrefixUserLocale, syncUnrealCultureGameIni } from './proton.js';
import { layoutOfWine } from './proton-layout.js';
import { accountCacheKey } from './offline-identity.js';
import { applyOfflinePermissions, assertOfflineAccessReady, bindOfflineAccess, licenseCacheDirectory, offlineAccessRevoked, revokeOfflineAccess, type OfflineRevocation } from './offline-access.js';
import { CatalogService } from './catalog.js';
import { cloudSaveRuntime, gameInviteRuntime, offlineIdentityRuntime, selectedWinePath, startXodusService, storeContentRuntime, storeDiscoveryRuntime, unbridgedCloudSaveRuntime, type XodusServiceSession } from './xodus-service.js';
import { GameLogReducer, gameLoggingEnvironment, gameWindowEnvironment } from './game-log.js';
import { downloadVerifiedVcRedist, installedVcRuntimeVersion, VC_REDIST_VERSION, versionAtLeast } from './vc-runtime.js';
import { assertGameRemovalAvailable, validateGameDeleteTarget } from './game-removal.js';
import { deleteGameDirectory } from './game-delete.js';
import { spawnGameProcess, type GameProcess } from './game-process.js';
import { gameLocaleEnvironment, installedGameLocales, installedGameTitleId, supportedGameLocale } from './game-locale.js';
import { antiCheatEnvironment } from './anti-cheat.js';
import { gameLaunchArguments, preparedGameWine } from './game-launch.js';
import { ConnectivityMonitor } from './connectivity.js';
import { prepareGameWrapper, type GameWrapper } from './game-wrapper.js';
import { normalizeLaunchTools } from '../shared/launch-tools.js';
import { LauncherUpdater } from './launcher-update.js';
import {XboxChatWindows} from './xbox-chat-windows.js';
import {XboxChatReads} from './xbox-chat-reads.js';
import { copyDiagnosticFile, diagnosticLogFile, readDiagnosticTail } from './diagnostic-log.js';
import { BackendDiagnostics, backendDiagnostic, setBackendDiagnostics } from './backend-diagnostics.js';
import { createDiagnosticReport, reportSystemInfo, saveDiagnosticReport, validateReportContent } from './diagnostic-report.js';
import { queryGameUpdate } from './game-updates.js';
import { DownloadProgress, PROGRESS_PREFIX } from './download-progress.js';
import { DownloadCleanup } from './download-cleanup.js';
import { InstallQueue, assertActivityCompatible, assertInstallDestination, canonicalInstallPath, installPathsOverlap } from './install-queue.js';
import { GameDisplayBlocker } from './game-display.js';
import { GameShortcuts, shortcutArguments, shortcutInstanceData, shortcutInstanceRequest, shortcutLauncherPath, type ShortcutDestination } from './game-shortcuts.js';
import { ShortcutLaunch } from './shortcut-launch.js';
import { loadShortcutIcon } from './shortcut-icon.js';
import { AccountProfile } from './account-profile.js';
import { AccountRefresh, readAccount } from './account-refresh.js';
import { AccountLibrary } from './account-library.js';
import { RecentPcGamePass } from './gamepass-recent.js';
import { GameActivities, installedTitleId } from './game-activity.js';
import {gameDetailsTarget} from './game-details-target.js';
import { GameAchievementsReader } from './game-achievements.js';
import { GameContent, type ContentPackage } from './game-content.js';
import { backendRunner, changeOfflinePermissions, readOfflinePermissions } from './offline-permissions.js';
import { startAuthTransport } from './auth-transport.js';
import { authViewFactory } from './auth-window.js';
import { browserAuthViewFactory } from './auth-browser.js';
import { fallbackAuthViewFactory } from './auth-fallback.js';
import { contentParentForChoice, InstallPlans, installSelection, readInstallPlan } from './install-plan.js';
import { availableInstallBytes } from './install-storage.js';
import { adoptLauncherFonts } from './launcher-fonts.js';
import { externalLauncherEnvironment } from './launcher-environment.js';
import { openDesktopTarget } from './desktop-open.js';
import { addSteamShortcut, steamAccounts, steamRunning } from './steam-shortcuts.js';
import { gameSteamPortrait, nexusSteamArtwork } from './steam-artwork.js';
import { addLiveSteamShortcut } from './steam-live.js';
import { DownloadCompletionNotifications } from './download-notifications.js';
import { KeyringSupport } from './keyring.js';
import { XboxSocialSessions } from './xbox-social.js';
import { GameInviteBridge, combinedInviteState } from './game-invite-bridge.js';
import {XboxTitlePresence} from './xbox-title-presence.js';
import {XboxParty} from './xbox-party.js';
import {XboxInvites} from './xbox-invites.js';
import {XboxVoiceHost} from './xbox-voice-host.js';
import type {XboxInvite,XboxVoiceCommand} from '../shared/types.js';
import { WalletUnlocker } from './keyring-unlock.js';
import { startSessionKeyring } from './keyring-session.js';
import { showBeforeAccountCheck } from './launcher-startup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function nativeText(text: string): string {
  return nativeTranslator(store?.settings.interfaceLanguage ?? 'system', app.getPreferredSystemLanguages?.() ?? ['en']).text(text);
}
const downloadNotifications = new DownloadCompletionNotifications({
  isSupported: () => Notification.isSupported(),
  show: options => {
    const notification = new Notification({ ...options, title: nativeText(options.title), body: nativeText(options.body), icon: fileURLToPath(new URL('../../assets/icon.png', import.meta.url)), urgency: 'normal' });
    notification.on('failed', () => console.warn('The desktop could not display a download completion notification.'));
    notification.show();
  },
});
let mainWindow: BrowserWindow | null = null;
let xboxNativeSocial:NativeXboxSocial;
let desktopProfileRequest:XboxProfileRequest|undefined;
const nativeSocialKeepAlive:(()=>boolean)[]=[];
function clearDesktopProfile(){desktopProfileRequest=undefined;mainWindow?.webContents.send('xbox-desktop-profile',undefined);}
function runtimeInvitation(id:unknown){
 if(typeof id!=='string'||id.length>160)throw Error('Invalid invitation.');
 const bridge=[...gameInviteBridges.values()].find(value=>id.startsWith(value.id+':'));
 if(!bridge)throw Error('The game is no longer running.');return {bridge,id};
}
function guideAuth():AuthStatus{return{running:authState.running,stored:authState.stored,username:authState.stored?'current':undefined,gamertag:accountProfile?.value?.gamertag,avatarDataUrl:accountProfile?.value?.avatarDataUrl,note:''};}
function availableNativeInvite(){return [...gameInviteBridges.values()].find(bridge=>bridge.state().active.length);}
function nativeInviteAvailability(){
 const bridge=availableNativeInvite();
 if(bridge)return {canInvite:true,gameId:bridge.id,title:bridge.game};
 const running=gameOperation?.kind==='launch'&&['preparing','running'].includes(gameOperation.status);
 return {canInvite:false,reason:running?(gameInviteUnavailableReason??'The game has not enabled invitations yet. Start an online session.'):'Start an online game session to invite someone.'};
}

let chatWindows:XboxChatWindows;
const chatReads=new XboxChatReads(nativeSocialConnection,state=>{
 if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('xbox-chat-reads',state);
});
const nativeSocialSenders:((event:Electron.IpcMainInvokeEvent)=>boolean)[]=[];
const nativeSocialResets:(()=>void)[]=[];
let xboxParty:XboxParty;
let xboxInvites:XboxInvites;
let voiceHost:XboxVoiceHost;
let currentXboxInvites:XboxInvite[]=[];
const nativeSocialBeforeAuth:(()=>Promise<void>)[]=[];
const nativeSocialShutdown:(()=>Promise<void>)[]=[];
let gameGuide:XboxGameGuide;
let overlayShortcut:XboxOverlayShortcut|undefined;
const nativeSocialSnapshots:(()=>void)[]=[];
function nativeSocialConnection(){
 const status=backend?.current;
 return !demoMode&&!authState.running&&authState.stored===true&&authState.username&&status?.available&&status.binaryPath&&status.capabilities.nativeSocial?{account:authState.username,binary:status.binaryPath}:undefined;
}
function resetNativeSocial(){for(const reset of nativeSocialResets)reset();xboxNativeSocial?.clear();resetSocialTransport();}
let nativeSocialBackend:string|undefined;
function syncNativeSocialBackend():void{
 const status=backend?.current,next=status?.available&&status.capabilities.nativeSocial?status.binaryPath:undefined;
 if(nativeSocialBackend&&nativeSocialBackend!==next)resetNativeSocial();
 nativeSocialBackend=next;
}

async function showFriends(): Promise<void> {
  await showLauncher();
  mainWindow?.webContents.send('open-friends');
}
let store: StateStore;
let backend: BackendManager;
let backendDiagnostics: BackendDiagnostics;
let runtime: RuntimeManager;
let connectivity: ConnectivityMonitor | undefined;
const operations = new Map<string, ChildProcessWithoutNullStreams>();
const gameProcesses = new Map<string, GameProcess>();
const cancelledDownloads = new Set<string>();
const downloadCancellations = new Map<string, Promise<void>>();
let downloadCleanup: DownloadCleanup;
const downloadControls = new Map<string, (paused: boolean) => Promise<void>>();
const downloadLimitControls = new DownloadBandwidthControls();
const installQueue = new InstallQueue(() => finishShortcutSession());
const gameDisplay = new GameDisplayBlocker(powerSaveBlocker);
const serviceSessions = new Map<string, XodusServiceSession>();
const gameInviteBridges=new Map<string,GameInviteBridge>();
let gameInviteUnavailableReason:string|undefined;
const preparationControllers = new Map<string, AbortController>();
let gameOperation: GameOperation | undefined;
let gameRemovalInProgress = false;
let shutdownStarted = false;
let authState: AppSnapshot['auth'] = {
  running: false,
  stored: null,
  note: 'Checking the Xodus system keychain for a stored Microsoft account…',
};
let authJob: Promise<void> | undefined;
let initialWalletAttempted = false;
const catalog = new CatalogService();
const gameActivities = new GameActivities();
const gameAchievements = new GameAchievementsReader();
const recentPcGamePass = new RecentPcGamePass();
const accountLibrary = new AccountLibrary((ids, market) => catalog.licensedProducts(ids, market), undefined, market => recentPcGamePass.get(market));
/** The longest a launch waits for owned bundles (a library read takes about 2 s) before its DLC hints. */
const OWNED_ACCESS_WAIT_MS = 2_500;
const installPlans = new InstallPlans(readInstallPlan);
const demoMode = process.env.XODUS_DEMO === '1';
const steamKeyboard=new SteamKeyboard();
const launcherTray=new LauncherTray(()=>{
  const image=nativeImage.createFromPath(fileURLToPath(new URL('../../assets/icon.png',import.meta.url)));
  if(image.isEmpty())throw Error('Tray icon unavailable.');
  const tray=new Tray(image);
  const open=async(page?:'home'|'library'|'store'|'settings')=>{await showLauncher();if(page)mainWindow?.webContents.send('launcher-page',page);};
  const navigate=(page:'home'|'library'|'store'|'settings')=>()=>{void open(page).catch(()=>console.error('Could not restore Nexus.'));};
  try{
    tray.setToolTip('Xodus Nexus');tray.on('click',navigate('home'));
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:nativeText('Home'),click:navigate('home')},{label:nativeText('My Library'),click:navigate('library')},
      {label:nativeText('Store'),click:navigate('store')},{label:nativeText('Settings'),click:navigate('settings')},
      {type:'separator'},{label:nativeText('Quit'),click:()=>app.quit()},
    ]));return tray;
  }catch(error){tray.destroy();throw error;}
},()=>desktopTrayAvailable());

const walletUnlocker = new WalletUnlocker();
const xboxSocial = new XboxSocialSessions(() => {
  const status = backend?.current;
  return !shutdownStarted && !authState.running && authState.stored === true && authState.username
    && status?.available && status.binaryPath && status.capabilities.commands.includes('social')
    ? { account: authState.username, binary: status.binaryPath } : undefined;
});
const keyringSupport = new KeyringSupport(process.env, undefined, process.platform, undefined, {
  diagnostic: value => backendDiagnostic({ operation: 'keyring', event: 'diagnostic', keyring: value, elapsedMs: value.elapsedMs }),
  canCreate: () => Boolean(backend?.current.capabilities.commands.includes('keyring-create')),
  create: () => {
    if (shutdownStarted || !mainWindow || mainWindow.isDestroyed()) return Promise.resolve('cancelled');
    if (!backend?.current.capabilities.commands.includes('keyring-create')) return Promise.resolve('unavailable');
    const handle = mainWindow.getNativeWindowHandle();
    return walletUnlocker.create(requireBackend('commands'), handle.length >= 4 ? String(handle.readUInt32LE()) : '');
  },
  startProvider: (provider, environment, owned) => startSessionKeyring(provider, environment, owned,
    backend?.current.capabilities.commands.includes('keyring-session-stop') ? backend.current.binaryPath : undefined),
  canUnlock: () => Boolean(backend?.current.capabilities.commands.includes('keyring-unlock')),
  unlock: () => {
    if (shutdownStarted || !mainWindow || mainWindow.isDestroyed()) return Promise.resolve('cancelled');
    const handle = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getNativeWindowHandle() : undefined;
    return walletUnlocker.unlock(requireBackend('commands'), handle && handle.length >= 4 ? String(handle.readUInt32LE()) : '');
  },
});
const demoArtwork = new Map<string, DemoArtwork>();
let launcherUpdater: LauncherUpdater;
const gameUpdates: Record<string, GameUpdate> = {};
let checkingGameUpdates = false;
let gameUpdateController: AbortController | undefined;
let gameUpdateJob: Promise<void> | undefined;
let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
let shortcuts: GameShortcuts;
let accountProfile: AccountProfile;
let preparingLaunch = false;
let preparingInstall = false;
let preparingContent = false;
let finalizingGame = false;
let shortcutOnly = false;
let launchReady = false;
let windowOpening: Promise<void> | undefined;
const pendingRequests: (string | undefined)[] = [];
const pendingShortcutErrors: unknown[] = [];
let startupRequest: ReturnType<typeof shortcutArguments> = {};
let startupError: Error | undefined;
try {
  startupRequest = shortcutArguments(process.argv.slice(1));
  if (startupRequest.profile) app.setPath('userData', startupRequest.profile);
} catch (error) { startupError = error as Error; }
if (process.platform === 'linux') {
  try {
    const fonts = adoptLauncherFonts();
    if (fonts) app.once('will-quit', () => fonts.dispose());
  } catch (error) { console.warn('Launcher fallback font unavailable:', (error as Error).message); }
}
// Electron's lock is scoped to userData, so independent profiles stay isolated.
const primaryInstance = demoMode || app.requestSingleInstanceLock(shortcutInstanceData(startupRequest, Boolean(startupError)));
if (!primaryInstance) app.quit();
else if (!demoMode) app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
  try { receiveLaunchRequest(shortcutInstanceRequest(additionalData, app.getPath('userData')).gameId); }
  catch (error) {
    if (launchReady) void shortcutError(error);
    else pendingShortcutErrors.push(error);
  }
});
const shortcutLaunch = new ShortcutLaunch(
  () => gameOperation?.kind === 'launch' && ['preparing', 'running', 'stopping'].includes(gameOperation.status) ? gameOperation.gameId : undefined,
  (id) => launchGame(id),
);

async function showLauncher(): Promise<void> {
  shortcutOnly = false;
  if (windowOpening) await windowOpening;
  else if (!mainWindow || mainWindow.isDestroyed()) {
    windowOpening ??= createWindow().finally(() => { windowOpening = undefined; });
    await windowOpening;
  }
  mainWindow?.show(); mainWindow?.focus();
}
async function shortcutError(error: unknown): Promise<void> {
  await showLauncher();
  await dialog.showMessageBox(mainWindow!, { type: 'error', title: nativeText('Unable to launch game'),
    message: error instanceof Error ? error.message : 'The game could not be launched.' });
}
function finishShortcutSession(): void {
  // Account service and game-process cleanup must finish before normal quit.
  if (launchReady && (shortcutOnly || !mainWindow || mainWindow.isDestroyed()) && !nativeSocialKeepAlive.some(active=>active()) && !shortcutLaunch.preparing && !preparingLaunch && !finalizingGame && downloadCancellations.size === 0 && installQueue.size === 0 && operations.size === 0 && serviceSessions.size === 0) app.quit();
}
function receiveLaunchRequest(id?: string): void {
  if (!launchReady) { pendingRequests.push(id); return; }
  if (!id) { void showLauncher(); return; }
  void shortcutLaunch.request(id).catch(shortcutError).finally(finishShortcutSession);
}

function snapshot(): AppSnapshot {
  if (demoMode) return demoSnapshot({ launcher: app.getVersion(), backend: backendLock.version,
    backendCommit: backendLock.commit, backendCompatibility: backendLock.compatibility }, demoArtwork);
  return {
    backend: backend.current,
    runtime: runtime.current,
    connectivity: connectivity?.current ?? { state: 'unknown' },
    games: structuredClone(store.games),
    downloads: structuredClone(store.downloads.map(task => downloadCancellations.has(task.id)
      ? { ...task, cancelling: true, canPause: false, phase: 'Cancelling download and checking files…' } : task)),
    settings: structuredClone(store.settings),
    auth: structuredClone({ ...authState, gamertag: accountProfile?.value?.gamertag, avatarDataUrl: accountProfile?.value?.avatarDataUrl, subscription: accountProfile?.value?.subscription }),
    launcherUpdate: structuredClone(launcherUpdater.state),
    gameUpdates: structuredClone(gameUpdates),
    overlayShortcut:overlayShortcut?.current,
    downloadProgressSupported: Boolean(backend.current.capabilities.streamingProgressJson),
    gameOperation: gameOperation ? structuredClone(gameOperation) : undefined,
    social: combinedInviteState(gameInviteBridges.values()),
  };
}

async function saveReviewedReport(content: unknown): Promise<boolean> {
  validateReportContent(content);
  const options = {
    title: 'Save diagnostic report',
    defaultPath: path.join(app.getPath('downloads'), `nexus-diagnostics-${Date.now()}.txt`),
    filters: [{ name: 'Text report', extensions: ['txt'] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return false;
  await saveDiagnosticReport(result.filePath, content);
  return true;
}

async function checkLauncherUpdate(): Promise<void> {
  await launcherUpdater.check();
}

async function stopGameUpdateCheck(): Promise<void> {
  gameUpdateController?.abort();
  await gameUpdateJob?.catch(() => {});
}

async function checkGameUpdates(id?: string): Promise<void> {
  ensureIdle();
  if (authState.stored !== true) throw new Error('Sign in before checking game updates.');
  const binary = requireBackend('account');
  const games = id ? store.games.filter(game => game.id === id) : [...store.games];
  if (id && !games.length) throw new Error('Game not found.');
  const previous = new Map(games.map(game => [game.id, gameUpdates[game.id]]));
  const controller = new AbortController();
  checkingGameUpdates = true;
  gameUpdateController = controller;
  let session: XodusServiceSession | undefined;
  let temporary: string | undefined;
  try {
    for (const game of games) gameUpdates[game.id] = { ...gameUpdates[game.id], checking: true };
    emitSnapshot();
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-updates-'));
    if (controller.signal.aborted) return;
    session = await startXodusService(binary, temporary, () => {}, controller.signal);
    for (const game of games) {
      if (controller.signal.aborted) break;
      try {
        const inspected = await inspectGameDirectory(game.path);
        if (controller.signal.aborted) break;
        if (!inspected.storeId || !inspected.installedVersion) throw new Error('This manifest has no Store ID or installed package version.');
        gameUpdates[game.id] = await queryGameUpdate(session.socketPath, inspected.storeId, inspected.installedVersion, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) break;
        gameUpdates[game.id] = { checking: false, checkedAt: new Date().toISOString(), error: (error as Error).message };
      }
      emitSnapshot();
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      for (const game of games) if (gameUpdates[game.id]?.checking) gameUpdates[game.id] = { checking: false, error: (error as Error).message };
      throw error;
    }
  } finally {
    // Preserve completed results and restore previous availability for cancelled requests.
    for (const game of games) if (gameUpdates[game.id]?.checking) {
      const value = previous.get(game.id);
      if (value) gameUpdates[game.id] = value; else delete gameUpdates[game.id];
    }
    await session?.stop().catch(() => {});
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    checkingGameUpdates = false; gameUpdateController = undefined; emitSnapshot();
  }
}

async function refreshIncompleteUpdate(game: Game): Promise<boolean> {
  if (!await hasIncompleteUpdate(game.path)) return false;
  await store.patchGame(game.id, { installState: 'incomplete', updateIncomplete: true, installMessage: INCOMPLETE_UPDATE_MESSAGE });
  return true;
}

function emitSnapshot(): void {
  syncNativeSocialBackend();
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = undefined;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('snapshot', snapshot());
  for(const update of nativeSocialSnapshots)update();
}

function scheduleSnapshot(): void {
  if (!snapshotTimer) snapshotTimer = setTimeout(emitSnapshot, 250);
}

function emitLog(scope: string, line: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('operation-log', { scope, line });
}

function requireBackend(command: keyof typeof backend.current.capabilities): string {
  const status = backend.current;
  if (!status.available || !status.binaryPath) throw new Error('The Xodus backend is unavailable.');
  if (typeof status.capabilities[command] === 'boolean' && !status.capabilities[command]) {
    throw new Error(`The active Xodus backend does not support the ${String(command)} command.`);
  }
  return status.binaryPath;
}

function ensureIdle(mode?: 'install' | 'launch' | 'remove'): void {
  if (offlinePermissionChanging) throw Error('Wait for the offline-permission change to finish.');
  if (keyringSupport.busy) throw Error('Wait for the wallet operation to finish.');
  if (authState.running) throw Error('A sign-in operation is already in progress.');
  if (shutdownStarted) throw Error('The launcher is closing.');
  if (downloadCancellations.size) throw Error('A download is being cancelled. Wait for its cleanup to finish.');
  if (preparingInstall || preparingContent) throw new Error('An installation is being prepared.');
  if (preparingLaunch) throw new Error('A game launch is already being prepared.');
  if (finalizingGame) throw new Error('The previous game is still finishing cleanup.');
  if (launcherUpdater?.state.updating) throw new Error('The launcher is being updated.');
  if (checkingGameUpdates) throw new Error('A game update check is in progress.');
  if (gameRemovalInProgress) throw new Error('A game is being removed. Wait for it to finish.');
  assertActivityCompatible(operations.keys(), store.downloads, gameOperation, installQueue.size, mode);
  if (backend.current.updating) throw new Error('The backend is being updated.');
  if (runtime.current.updating) throw new Error('Xodus Runtime is being installed.');
}

async function syncManagedWinePath(): Promise<void> {
  const selected = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.current.winePath);
  if (selected && selected !== store.settings.winePath) await store.setSettings({ winePath: selected });
}

const accountRefresh = new AccountRefresh();
function accountRefreshKey(): string {
  const status = backend.current;
  return JSON.stringify([status.available, status.binaryPath, status.source, status.capabilities, currentMarket()]);
}
async function refreshAccount(emit = true, afterAuth = false): Promise<AuthStatus> {
  if (authState.running && !afterAuth) return structuredClone(authState);
  const status = backend.current;
  const key = accountRefreshKey();
  await accountRefresh.run(key, async signal => {
    let next: Pick<AuthStatus, 'stored' | 'username' | 'note'>;
    if (!status.available || !status.binaryPath) {
      next = { stored: null, username: undefined, note: 'Account status is unavailable because the Xodus backend is offline.' };
    } else if (!status.capabilities.account) {
      next = {
        stored: null,
        username: undefined,
        note: status.source === 'external'
          ? 'This external Xodus build cannot report the stored account. Install the Nexus backend from Settings.'
          : 'This managed backend predates read-only account status. Update it from Settings.',
      };
    } else {
      const result = await readAccount(status.binaryPath, signal).catch(() => ({ code: -1, output: '' }));
      if (result.code !== 0) {
        next = { stored: null, username: undefined, note: 'Xodus could not read its system-keychain account record.' };
      } else {
        try {
          const line = result.output.split('\n').map((entry) => entry.trim()).reverse().find((entry) => entry.startsWith('{'));
          const account = JSON.parse(line ?? '') as { stored?: unknown; username?: unknown };
          if (account.stored === true && typeof account.username === 'string' && account.username.trim()) {
            next = {
              stored: true,
              username: account.username.trim(),
              note: runtime?.current.name?.includes('-xgamesave-pr28-')
                ? 'Credentials are stored by Xodus. The experimental PR #28 runtime can try in-game Xbox sign-in and two-way cloud save sync; this account status alone does not verify either.'
                : 'Credentials are stored by Xodus in the system keychain. This does not mean in-game Xbox platform sign-in is implemented.',
            };
          } else if (account.stored === false) {
            next = { stored: false, username: undefined, note: 'No Microsoft account is stored by Xodus.' };
          } else {
            throw new Error('unexpected account response');
          }
        } catch {
          next = { stored: null, username: undefined, note: 'Xodus returned an unreadable account-status response.' };
        }
      }
    }
    return next;
  }, async next => {
    if (authState.username !== next.username || next.stored !== true) xboxSocial.close();
    if(next.username!==authState.username||next.stored!==true)resetNativeSocial();
    authState = { ...authState, ...next };
    accountLibrary.select(authState.stored === true ? authState.username : undefined,
      status.capabilities.library ? status.binaryPath : undefined, currentMarket());
    gameActivities.select(authState.stored === true ? authState.username : undefined,
      status.capabilities.gameActivity ? status.binaryPath : undefined);
    gameAchievements.select(authState.stored === true ? authState.username : undefined,
      status.capabilities.achievements ? status.binaryPath : undefined);
    await accountProfile?.select(authState.stored === true ? authState.username : undefined,
      status.capabilities.profile ? status.binaryPath : undefined, emit);
  }, () => key === accountRefreshKey() && (!authState.running || afterAuth));
  if (emit) emitSnapshot();
  return structuredClone(authState);
}

async function refreshInitialAccount(): Promise<void> {
  const initialAuthState = authState;
  const initialBackendKey = accountRefreshKey();
  const stillCurrent = () => !shutdownStarted && authState === initialAuthState && !authState.running && initialBackendKey === accountRefreshKey();
  let keyring = await keyringSupport.check();
  // Never overwrite a sign-in/refresh that the user started while metadata
  // was being checked, even if that newer operation has already completed.
  if (!stillCurrent()) return;
  if (keyring.gameMode && keyring.state !== 'unavailable' && !initialWalletAttempted && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
      && backend.current.available && backend.current.capabilities.commands.includes('keyring-unlock')) {
    // The launcher is already visible, so the native password prompt has a
    // parent. Attempt once: cancellation must not trigger repeated prompts.
    initialWalletAttempted = true;
    keyring = await keyringSupport.startForStartup();
    if (!stillCurrent()) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('keyring-state', keyring);
    if (keyring.state !== 'ready') {
      authState = { ...authState, stored: null, note: keyring.message };
      emitSnapshot();
      return;
    }
  }
  if (keyring.gameMode && ['locked', 'stopped', 'disabled', 'missing', 'needs-setup'].includes(keyring.state)) {
    authState = { ...authState, stored: null, note: keyring.message };
    emitSnapshot();
    return;
  }
  await refreshAccount();
}

async function prepareSystemWallet(): Promise<void> {
  const status = await keyringSupport.check();
  if (!status.gameMode || status.state === 'ready' || status.state === 'unavailable') return;
  // Direct Steam game shortcuts have no launcher window yet. Give the wallet
  // dialog a visible parent before any backend account read can block on it.
  const directShortcut = shortcutOnly;
  if (!mainWindow || mainWindow.isDestroyed()) {
    await showLauncher();
    shortcutOnly = directShortcut;
  }
  const result = await keyringSupport.start();
  if (result.state !== 'ready') throw Error(result.message);
  if (directShortcut) mainWindow?.hide();
}

function offlineDataRoot(): string { return path.dirname(store.settings.runtimeRoot); }
async function revokeOffline(reason: OfflineRevocation): Promise<void> {
  await revokeOfflineAccess(offlineDataRoot());
  emitLog('offline', `Removed stored offline licenses and identities (${reason}).`);
}
/** The backend removes its stored licenses itself when Microsoft reports this
 * device as not designated; the runtime identities are removed here. */
async function settleOfflinePermissions(status: OfflinePermissions, changed: boolean): Promise<OfflinePermissions> {
  if (changed) await revokeOffline('designation-changed');
  else if (await applyOfflinePermissions(offlineDataRoot(), status)) emitLog('offline', 'Removed stored offline licenses and identities (designation-off).');
  return status;
}
async function offlineLicenseCache(root = offlineDataRoot()): Promise<string | undefined> {
  if (await offlineAccessRevoked(root)) await revokeOfflineAccess(root);
  await assertOfflineAccessReady(root);
  return backend.current.capabilities.licenseCache ? licenseCacheDirectory(root) : undefined;
}
let designationCheck: Promise<void> | undefined;
let offlinePermissionChanging = false;
async function offlineLaunchSupported(): Promise<boolean> {
  const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.current.winePath);
  return Boolean(backend.current.capabilities.licenseCache && backend.current.capabilities.offlineLaunch && wine && await offlineIdentityRuntime(wine));
}
function assertOfflineScope(account: string | undefined, binary: string, root: string): void {
  if (shutdownStarted || authState.running || authState.stored !== true || !account || authState.username !== account || backend.current.binaryPath !== binary || offlineDataRoot() !== root)
    throw Error('Account changed. Check offline permissions again.');
}
/** Back online: ask Microsoft whether this device is still the offline PC, so a
 * designation moved elsewhere while it was offline ends offline play here at
 * once instead of at the next launch. Reading costs no yearly change. */
function verifyOfflineDesignation(): void {
  if (designationCheck || offlinePermissionChanging || shutdownStarted || authState.running || authState.stored !== true) return;
  const status = backend.current;
  if (!status.available || !status.binaryPath || !status.capabilities.offlinePc) return;
  const binary = status.binaryPath;
  designationCheck = (async () => {
    // Never open the wallet prompt from a background check.
    const keyring = await keyringSupport.check();
    if (keyring.state !== 'ready') return;
    const root = offlineDataRoot(), account = authState.username;
    assertOfflineScope(account, binary, root);
    const result = await readOfflinePermissions(backendRunner(binary), await offlineLicenseCache());
    assertOfflineScope(account, binary, root);
    await settleOfflinePermissions(result, false);
  })().catch(() => { /* Unanswered checks change nothing; the next launch or reconnect asks again. */ })
    .finally(() => { designationCheck = undefined; });
}

async function runAuth(command: 'login' | 'logout'): Promise<void> {
  ensureIdle();
  for(const prepare of nativeSocialBeforeAuth)await prepare();
  resetNativeSocial();
  const binary = requireBackend(command);
  const id = `auth-${randomUUID()}`;
  accountRefresh.invalidate();
  accountLibrary.reset();
  gameActivities.select();
  gameAchievements.select();
  xboxSocial.close();
  authState = { ...authState, running: true, lastResult: undefined };
  emitSnapshot();
  try {
    if (command === 'login' && !backend.current.capabilities.externalAuth) {
      throw Error('Update the Nexus backend in Settings before signing in with this launcher.');
    }
    if (command === 'login') await prepareSystemWallet();
    const view = fallbackAuthViewFactory(request => authViewFactory(mainWindow ?? undefined, undefined, request, nativeText), () => browserAuthViewFactory());
    if (shutdownStarted) throw Error('The launcher is closing.');
    await accountProfile.select(undefined);
    if (shutdownStarted) throw Error('The launcher is closing.');
    const tracked = command === 'login' ? startAuthTransport(binary, view)
      // Explicit sign-out removes the local device registration too. Ordinary
      // sign-in must keep it, including when renewing an existing account.
      : spawnTracked(binary, ['logout', '--device'], { onLine: (line) => emitLog('auth', line) });
    operations.set(id, tracked.child);
    const result = await tracked.result;
    accountRefresh.invalidate();
    // Another account signing in is caught before its first launch (bindOfflineAccess).
    if (command === 'logout') await revokeOffline('sign-out');
    if (result.code === 0) await refreshAccount(false, true);
    authState = {
      ...authState,
      running: false,
      lastAction: command,
      lastResult: result.code === 0 ? 'success' : 'failed',
    };
    if (result.code !== 0) throw new Error(`xodus-cli ${command} exited with code ${result.code}.`);
  } finally {
    operations.delete(id);
    authState.running = false;
    emitSnapshot();
  }
}

function requestAuth(command: 'login' | 'logout'): Promise<void> {
  if (authJob) return Promise.reject(Error('A sign-in operation is already in progress.'));
  const job = runAuth(command); authJob = job;
  const clear = () => { if (authJob === job) authJob = undefined; };
  void job.then(clear, clear); return job;
}

async function startInstall(request: InstallRequest, updateGame?: Game, resumed?: DownloadTask): Promise<string> {
  await stopGameUpdateCheck();
  ensureIdle('install');
  if (updateGame && gameOperation?.gameId === updateGame.id && ['preparing', 'running', 'stopping'].includes(gameOperation.status)) throw Error('Close this game before updating its installed files.');
  preparingInstall = true;
  try { await prepareSystemWallet(); return await prepareInstall(request, updateGame, undefined, resumed); }
  finally { preparingInstall = false; }
}

let managedContent: { root: string; manager: GameContent } | undefined;
function contentManager(): GameContent {
  const root = path.dirname(store.settings.runtimeRoot);
  if (!managedContent || managedContent.root !== root) managedContent = { root, manager: new GameContent(root) };
  return managedContent.manager;
}
async function gameContent(id: string) {
  const game = store.games.find(entry => entry.id === id);
  if (!game) throw Error('Game not found.');
  if (authState.running || authState.stored !== true) throw Error('Sign in before checking game content.');
  const identity = `${authState.username}:${backend.current.binaryPath}:${currentMarket()}`;
  accountLibrary.select(authState.username, backend.current.capabilities.library ? backend.current.binaryPath : undefined, currentMarket());
  const result = await contentManager().plan(game, () => accountLibrary.access(true), currentMarket());
  const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.current.winePath);
  result.plan.runtimeSupported = Boolean(wine && await storeContentRuntime(wine));
  if (authState.running || authState.stored !== true || identity !== `${authState.username}:${backend.current.binaryPath}:${currentMarket()}`) throw Error('Account changed. Check content again.');
  return result;
}
async function installGameContent(id: string, productId: string): Promise<string> {
  ensureIdle();
  preparingContent = true;
  try { return await prepareContentInstall(id, productId); }
  finally { preparingContent = false; preparingInstall = false; }
}
async function prepareContentInstall(id: string, productId: string, selectedContentId?: string): Promise<string> {
    const manager = contentManager();
    const { plan, packages } = await gameContent(id);
    if (shutdownStarted) throw Error('The launcher is closing.');
    if (!plan.runtimeSupported) throw Error('Update the Nexus runtime in Settings to install and use related content.');
    const game = store.games.find(entry => entry.id === id);
    const item = plan.items.find(item => item.productId === productId);
    const pkg = packages.find(pkg => pkg.productId === productId);
    if (!game || !item || (!item.access && item.status !== 'verify') || !pkg || !['available', 'installed', 'verify'].includes(item.status)) throw Error('No supported content package with a verified license or active source offer was found.');
    if (selectedContentId && pkg.contentId !== selectedContentId) throw Error('The add-on package changed. Check content again.');
    // Downloads use the existing genuine license-checked backend, not catalog URLs.
    requireBackend('streaming');
    if (await backend.externalDownloadRunning()) throw Error('Another Xodus download is running.');
    const destination = await manager.prepare(game, pkg, currentMarket());
    preparingInstall = true;
    return await prepareInstall({ productId, title: `${game.title}: ${item.title}`, destination }, undefined, { game, pkg, manager });
}

async function prepareInstall(request: InstallRequest, updateGame?: Game, content?: { game: Game; pkg: ContentPackage; manager: GameContent }, resumed?: DownloadTask): Promise<string> {
  const binary = requireBackend('streaming');
  if (updateGame && !backend.current.capabilities.streamingUpdateRecovery) throw Error('Update the Nexus backend in Settings before updating installed games safely.');
  const productId = safeProductId(request.productId);
  const market = currentMarket();
  let selectedContentId: string | undefined;
  if (!content) {
    if (!backend.current.capabilities.packageSelection) throw Error('Update the Xodus backend in Settings before installing games.');
    if (request.selectionMarket !== undefined && request.selectionMarket !== market) throw Error('Store market changed. Choose the installation package again.');
    if (request.selectedContentId !== undefined && request.selectionMarket !== market) throw Error('Invalid installation package selection.');
    const plan = await installPlans.get(binary, productId, market, Boolean(backend.current.capabilities.contentPackageSelection));
    selectedContentId = installSelection(plan, request.selectedContentId);
    if (binary !== backend.current.binaryPath || market !== currentMarket()) throw Error('Backend or Store market changed. Try installing again.');
    const choice = plan.choices.find(choice => choice.supported && choice.contentId === selectedContentId)!;
    if (updateGame && choice.kind === 'Durable') throw Error('An add-on cannot replace the base game. Use Manage content.');
    const parent = contentParentForChoice(choice, store.games);
    if (parent) return prepareContentInstall(parent, choice.productId, selectedContentId);
  }
  const activeTasks = store.downloads.filter(task => ['running', 'queued', 'paused'].includes(task.status));
  if (activeTasks.length >= 100) throw Error('The install queue is full. Cancel an installation before adding another.');
  if (activeTasks.some(task => task.productId === productId)) throw Error('This game is already in the install queue.');
  const destination = await assertInstallDestination(request.destination.trim(), [
    ...activeTasks.map(task => task.destination),
    ...store.games.filter(game => game.id !== updateGame?.id && game.id !== content?.game.id).map(game => game.path),
    app.getPath('userData'), store.settings.runtimeRoot,
  ]);
  if (updateGame) {
    const actual = await fs.realpath(destination);
    if (actual !== await fs.realpath(updateGame.path)) throw new Error('Update destination differs from the installed game.');
    const processes = await run('ps', ['-eo', 'args='], { maxOutput: 2_000_000 });
    if (processes.code !== 0) throw new Error('Could not verify that the game is closed. Update was not started.');
    const executable = updateGame.executable ? path.basename(updateGame.executable).toLowerCase() : '';
    if (processes.output.split('\n').some((line) => {
      const command = line.toLowerCase();
      return (/xodus-cli\s+run\s/.test(command) || /(?:wine|proton)/.test(command) &&
        (command.includes(actual.toLowerCase()) || executable.length > 0 && command.includes(executable)));
    })) throw new Error('A game process is active. Close the game before updating files in place.');
  }
  const id = randomUUID();
  const task: DownloadTask = {
    id,
    kind: content ? 'content' : updateGame ? 'update' : 'install',
    gameId: content?.game.id ?? updateGame?.id,
    title: request.title.trim() || productId,
    productId,
    selectedContentId,
    selectionMarket: selectedContentId ? market : undefined,
    destination,
    status: 'queued',
    progress: null,
    phase: 'Waiting in install queue',
    log: [],
    startedAt: new Date().toISOString(),
  };
  if (resumed) await downloadCleanup.inheritResume(resumed, task);
  await store.addDownload(task);
  void enrichDownloadCovers([task], market).catch(() => { /* Artwork is optional. */ });
  const identity = `${authState.username}:${binary}:${market}`;
  const isCancelled = () => task.status === 'cancelled';
  installQueue.enqueue({ id, run: async () => {
    if (shutdownStarted) throw Error('The launcher is closing.');
    if (identity !== `${authState.username}:${backend.current.binaryPath}:${currentMarket()}`) throw Error('Account, backend or Store market changed. Retry the installation.');
    if (await backend.externalDownloadRunning()) throw Error('Another Xodus download is running outside this queue.');
    await assertInstallDestination(destination, store.games.filter(game => game.id !== updateGame?.id && game.id !== content?.game.id).map(game => game.path));
    if (gameOperation && ['preparing', 'running', 'stopping'].includes(gameOperation.status)) {
      const playing = store.games.find(game => game.id === gameOperation?.gameId);
      if (playing && (playing.id === content?.game.id || installPathsOverlap(destination, await canonicalInstallPath(playing.path)))) throw Error('Close this game before changing its installed files.');
    }
    if (shutdownStarted || isCancelled()) return;
    await downloadCleanup.prepare(task);
    if (shutdownStarted || isCancelled()) return;
    await store.updateDownload(id, { status: 'running', phase: updateGame ? 'Checking installed files with Xodus…' : 'Starting Xodus streaming…' });
    if (shutdownStarted || isCancelled()) return;
    await runDownload(task, binary, market, updateGame, content);
  }, failed: async error => {
    if (isCancelled()) return;
    task.status = 'failed'; task.error = (error as Error).message; task.phase = 'Installation could not be started';
    task.finishedAt = new Date().toISOString();
    await store.updateDownload(id, task); emitSnapshot();
  } });
  emitSnapshot();
  return id;
}

async function runDownload(task: DownloadTask, binary: string, market: string, updateGame?: Game, content?: { game: Game; pkg: ContentPackage; manager: GameContent }): Promise<void> {
  const { id, productId, destination, selectedContentId } = task;
  const structured = Boolean(backend.current.capabilities.streamingProgressJson);
  const controllable = structured && Boolean(backend.current.capabilities.streamingControls);
  if (!structured) task.log.push('Update the Nexus backend in Settings for numeric progress and Pause/Resume. This download can continue without them.');
  emitSnapshot();
  const args = ['streaming', content?.pkg.contentId ?? productId, destination, '--parallel', String(store.settings.parallelDownloads)];
  args.push('--market', market);
  if (selectedContentId) args.push('--selected-content-id', selectedContentId);
  if (structured) args.push('--progress-json');
  if (controllable) args.push('--control-stdin');
  args.push(...downloadLimitArgs(store.settings.downloadLimitMiB, backend.current.capabilities));
  const progressTracker = new DownloadProgress();
  let lastLoggedPercent = -1;
  let pending: { paused: boolean; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  if (shutdownStarted) throw Error('The launcher is closing.');
  const tracked = spawnTracked(binary, args, {
    onLine: (line) => {
      const progress = structured ? progressTracker.update(line) : undefined;
      if (progress) {
          Object.assign(task, progress);
          task.canPause = controllable && progress.canPause;
          if (pending) {
            task.controlPending = true;
            if ((task.status === 'paused') === pending.paused || !task.canPause) {
              clearTimeout(pending.timer); pending.resolve(); pending = undefined;
              task.controlPending = false;
            }
          }
          const percent = Math.floor(task.progress ?? 0);
          if (percent !== lastLoggedPercent) {
            task.log.push(task.progress === null ? task.phase : `${percent}% · ${task.phase}`);
            lastLoggedPercent = percent;
          }
      } else {
        if (line.startsWith(PROGRESS_PREFIX)) return; // Malformed/future records aren't user logs.
        if (!structured) task.phase = line.length > 160 ? `${line.slice(0, 157)}…` : line;
        task.log.push(line);
      }
      task.log = task.log.slice(-300);
      scheduleSnapshot();
    },
    maxOutput: 8_000_000,
  });
  // Broken stdin is an operation error, not an unhandled Electron error event.
  tracked.child.stdin.on('error', error => {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
    task.controlPending = false; scheduleSnapshot();
  });
  operations.set(id, tracked.child);
  if (backend.current.capabilities.streamingBandwidthLimit) downloadLimitControls.attach(id, tracked.child.stdin);
  if (controllable) downloadControls.set(id, paused => new Promise<void>((resolve, reject) => {
    if (pending || !task.canPause || !['running', 'paused'].includes(task.status)) { reject(new Error('This download cannot be paused or resumed right now.')); return; }
    if ((task.status === 'paused') === paused) { resolve(); return; }
    task.controlPending = true; emitSnapshot();
    const timer = setTimeout(() => {
      pending = undefined; task.controlPending = false; emitSnapshot();
      reject(new Error('The backend did not acknowledge the download control.'));
    }, 10_000);
    pending = { paused, resolve, reject, timer };
    tracked.child.stdin.write(JSON.stringify({ schema: 1, command: paused ? 'pause' : 'resume' }) + '\n');
  }));
  const finishControls = () => {
    downloadLimitControls.detach(id);
    downloadControls.delete(id);
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('The download has ended.')); pending = undefined; }
    task.canPause = false; task.controlPending = false;
  };
  await tracked.result.then(async (result) => {
    finishControls();
    const cancelled = cancelledDownloads.delete(id);
    task.exitCode = result.code;
    task.finishedAt = new Date().toISOString();
    task.status = cancelled || result.code === 130 ? 'cancelled' : result.code === 0 && (!structured || progressTracker.terminal === 'complete') ? 'complete' : 'failed';
    if (task.status === 'cancelled') task.error = undefined;
    if (shutdownStarted && controllable && !cancelled && task.status !== 'complete') task.status = 'paused';
    task.progress = task.status === 'complete' ? 100 : task.progress;
    task.phase = task.status === 'complete' ? updateGame ? 'Update complete' : 'Installation complete' : task.status === 'cancelled' ? 'Cancelled by user' : structured && result.code === 0 ? 'The backend did not confirm a completed installation.' : `Xodus exited with code ${result.code}`;
    if (task.status === 'failed') task.error = downloadFailure(task.log, result.code);
    if (task.status === 'paused') {
      task.phase = 'Paused — resume to restore saved download checkpoints';
      task.canPause = true; task.error = undefined; task.finishedAt = undefined;
    }
    if (task.status === 'complete' && content) {
      try { await content.manager.complete(content.game, content.pkg); }
      catch (error) { task.status = 'failed'; task.error = (error as Error).message; task.phase = 'Content metadata validation failed. Files were kept for repair.'; }
    }
    if (!content && (task.status === 'complete' || updateGame)) {
      try {
        const inspected = await inspectGameDirectory(destination);
        if (updateGame) {
          await store.patchGame(updateGame.id, { installState: inspected.installState, installMessage: inspected.installMessage, updateIncomplete: inspected.updateIncomplete, antiCheat: inspected.antiCheat, vcRedistEncrypted: inspected.vcRedistEncrypted, coverDataUrl: inspected.coverDataUrl, storeId: inspected.storeId ?? updateGame.storeId, installedVersion: inspected.installedVersion, packageName: inspected.packageName });
          if (task.status === 'complete') {
            if (inspected.installState !== 'ready') throw Error(inspected.installMessage ?? 'The installation is not ready for Xodus run.');
            delete gameUpdates[updateGame.id];
          }
        }
        else await store.upsertGame({ ...inspected, offerProductId: /^[A-Z0-9]{12}$/.test(task.productId) ? task.productId : undefined });
      } catch (error) {
        if (updateGame) await refreshIncompleteUpdate(updateGame).catch(() => {});
        if (updateGame && task.status === 'complete') {
          task.status = 'failed'; task.error = (error as Error).message;
          task.phase = 'Update validation failed. Resume the update before playing.';
        }
        // Some new packages do not expose metadata yet. Never erase their files.
      }
    }
    await store.updateDownload(id, task);
    if (task.status === 'complete') await downloadCleanup.complete(task);
    operations.delete(id);
    emitSnapshot();
    downloadNotifications.complete(task);
    if (task.status === 'complete' && !content) void enrichLibraryCovers().then(() => emitSnapshot(), () => { /* Artwork is optional. */ });
  }).catch(async (error) => {
    finishControls();
    operations.delete(id);
    const cancelled = cancelledDownloads.delete(id);
    task.status = cancelled ? 'cancelled' : 'failed';
    task.error = cancelled ? undefined : (error as Error).message;
    task.phase = cancelled ? 'Cancelled by user' : 'The process could not be started';
    task.finishedAt = new Date().toISOString();
    if (updateGame) await refreshIncompleteUpdate(updateGame).catch(() => {});
    await store.updateDownload(id, task);
    emitSnapshot();
  });
  finishShortcutSession();
}

function downloadCleanupProtection(task: DownloadTask) {
  return {
    locked: [...store.games.map(game => game.path),
      ...store.downloads.filter(other => other.id !== task.id && ['queued', 'running', 'paused', 'complete'].includes(other.status)).map(other => other.destination),
      ...['/boot', '/dev', '/etc', '/proc', '/run', '/sys', '/usr', '/var', app.getPath('userData'), store.settings.runtimeRoot, store.settings.externalXodusRoot].filter(Boolean)],
    roots: ['/', '/tmp', os.homedir(), store.settings.installRoot].filter(Boolean),
  };
}

function cancellableDownload(id: string): DownloadTask {
  if (typeof id !== 'string') throw Error('Invalid download ID.');
  const task = store.downloads.find(entry => entry.id === id);
  if (!task || !['queued', 'running', 'paused'].includes(task.status)) throw Error('The download is no longer running.');
  return task;
}

function cancelDownload(id: string, mode: 'keep' | 'delete-files' = 'keep'): Promise<void> {
  if (mode !== 'keep' && mode !== 'delete-files') return Promise.reject(Error('Invalid cancellation option.'));
  if (downloadCancellations.has(id)) return Promise.reject(Error('This download is already being cancelled.'));
  if (shutdownStarted || preparingInstall || preparingContent || gameRemovalInProgress) return Promise.reject(Error('Wait for the current operation to finish.'));
  const task = cancellableDownload(id), release = installQueue.hold();
  const job = Promise.resolve().then(async () => {
    let stopped = false;
    try {
      if (mode === 'delete-files') {
        const { locked, roots } = downloadCleanupProtection(task), options = await downloadCleanup.options(task, locked, roots);
        if (!options.deleteFilesAllowed) throw Error(options.reason);
      }
      cancellableDownload(id); // Completion may have happened while checking the filesystem.
      const child = operations.get(id);
      if (child) {
        cancelledDownloads.add(id);
        if (!child.kill('SIGINT')) { cancelledDownloads.delete(id); throw Error('The download could not be stopped. Files were not deleted.'); }
        stopped = true;
      } else {
        installQueue.cancel(id); stopped = true;
        await store.updateDownload(id, { status: 'cancelled', canPause: false, finishedAt: new Date().toISOString() });
      }
      // Includes process exit, metadata persistence and the queue's finally block.
      await installQueue.settled(id);
      if (operations.has(id) || installQueue.has(id)) throw Error('The download is still stopping. Files were not deleted.');
      if (task.status !== 'cancelled') throw Error('The installation state changed. Files were not deleted.');
      if (mode === 'delete-files') {
        if (await backend.externalDownloadRunning()) throw Error('Another Xodus download is running. Files were not deleted.');
        const { locked, roots } = downloadCleanupProtection(task);
        await downloadCleanup.remove(task, locked, roots);
      }
      await store.updateDownload(id, { error: undefined, phase: mode === 'delete-files'
        ? 'Cancelled; downloaded files were deleted.' : 'Cancelled; downloaded files and checkpoints were kept.' });
    } catch (error) {
      if (stopped) await store.updateDownload(id, { error: error instanceof Error ? error.message : 'Cancellation cleanup failed.' });
      throw error;
    } finally { downloadCancellations.delete(id); release(); emitSnapshot(); }
  });
  downloadCancellations.set(id, job); emitSnapshot();
  return job;
}

async function importGame(input?: string): Promise<Game | null> {
  if (downloadCancellations.size) throw Error('A download is being cancelled. Wait for its cleanup to finish.');
  let directory = input;
  if (!directory) {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], defaultPath: store.settings.installRoot });
    if (result.canceled) return null;
    directory = result.filePaths[0];
  }
  const game = await inspectGameDirectory(path.resolve(directory));
  if (game.storeId) {
    const artwork = (await catalog.artwork([game.storeId], currentMarket())).get(game.storeId.toUpperCase());
    if (artwork) Object.assign(game, artwork);
  }
  if (downloadCancellations.size) throw Error('A download is being cancelled. Wait for its cleanup to finish.');
  await store.upsertGame(game);
  emitSnapshot();
  return game;
}

async function gameLaunchOptions(id: string): Promise<GameLaunchOptions> {
  const game = store.games.find((entry) => entry.id === id);
  if (!game) throw new Error('Game not found.');
  const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.current.winePath);
  if (!wine) return { cloudSaves: false, cloudReason: 'Select Xodus Runtime in Settings.', vcInstall: false, vcReason: 'Select Xodus Runtime in Settings.' };
  const wineAvailable = await fs.access(wine, constants.X_OK).then(() => true, () => false);
  if (!wineAvailable) return { cloudSaves: false, cloudReason: 'The selected Wine binary is unavailable.', vcInstall: false, vcReason: 'The selected Wine binary is unavailable.' };
  const protonRoot = path.resolve(path.dirname(wine), '..', '..');
  const protonAvailable = await Promise.all([
    fs.access(path.join(protonRoot, 'proton'), constants.X_OK).then(() => true, () => false),
    fs.access(path.join(protonRoot, 'files', 'share', layoutOfWine(wine).defaultPrefix), constants.R_OK).then(() => true, () => false),
  ]).then((values) => values.every(Boolean));
  const previewRuntime = await cloudSaveRuntime(wine);
  const servicePath = backend.current.binaryPath ? path.join(path.dirname(backend.current.binaryPath), 'xodus-service') : '';
  const serviceAvailable = Boolean(servicePath) && await fs.access(servicePath, constants.X_OK).then(() => true, () => false);
  return {
    cloudSaves: previewRuntime && serviceAvailable,
    cloudReason: !previewRuntime ? 'The selected Wine runtime does not include the cloud-save preview.' : !serviceAvailable ? 'This Xodus backend has no xodus-service.' : undefined,
    vcInstall: protonAvailable,
    vcReason: protonAvailable ? undefined : 'VC++ installation requires a full Proton runtime.',
  };
}

async function gameLocales(game: Game): Promise<string[]> {
  return installedGameLocales(game.path);
}

async function gameTitleId(game: Game): Promise<string | undefined> {
  return installedGameTitleId(game.path);
}

async function launchGame(id: string): Promise<void> {
  await stopGameUpdateCheck();
  ensureIdle('launch');
  preparingLaunch = true;
  try { await prepareGameLaunch(id); }
  finally { preparingLaunch = false; }
}

async function prepareGameLaunch(id: string): Promise<void> {
  const game = store.games.find((entry) => entry.id === id);
  if (!game) throw new Error('Game not found.');
  const target = await canonicalInstallPath(game.path);
  for (const task of store.downloads.filter(task => ['running', 'queued', 'paused'].includes(task.status))) {
    if (task.gameId === id || installPathsOverlap(target, await canonicalInstallPath(task.destination))) throw Error('Finish or cancel this game\'s installation before playing it.');
  }
  if (await refreshIncompleteUpdate(game)) { emitSnapshot(); throw Error(INCOMPLETE_UPDATE_MESSAGE); }
  const inspected = await inspectGameDirectory(game.path);
  await store.patchGame(id, {
    installState: inspected.installState,
    installMessage: inspected.installMessage,
    updateIncomplete: inspected.updateIncomplete,
    executable: inspected.executable,
    antiCheat: inspected.antiCheat,
    vcRedistEncrypted: inspected.vcRedistEncrypted,
    coverDataUrl: inspected.coverDataUrl,
    storeId: inspected.storeId ?? game.storeId,
  });
  emitSnapshot();
  const binary = requireBackend('run');
  if (inspected.installState !== 'ready') throw new Error(inspected.installMessage ?? 'The installation is not ready for Xodus run.');
  const locale = supportedGameLocale(game.locale ?? '');
  const titleId = await gameTitleId(game).catch(() => undefined);
  const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.current.winePath);
  if (!wine) throw new Error('Select a Wine / Proton binary in Settings.');
  try { await fs.access(wine, constants.X_OK); }
  catch { throw new Error(`The selected Wine runtime is unavailable: ${wine}. Select or reinstall Xodus Runtime in Settings.`); }
  const cloudRuntime = await cloudSaveRuntime(wine);
  if (await unbridgedCloudSaveRuntime(wine)) {
    throw new Error('The active runtime has cloud saves without the required service bridge. Update the active runtime in Settings.');
  }
  const dataRoot = path.dirname(store.settings.runtimeRoot);
  // Decide "offline" here, once, from a fresh probe: the backend then skips
  // its ticket, license and PlayFab requests and the runtime signs in from
  // its cached identity, instead of each waiting for its own connect timeout.
  const reachability: ConnectivityStatus = connectivity ? await connectivity.check() : { state: 'unknown' };
  const offlineLaunch = reachability.state === 'offline';
  // Owned bundles let DLC discovery find content the package does not list.
  // Load them while the launch prepares instead of only using a library the
  // Library page happened to load; offline there is nothing to fetch.
  const ownedAccess = offlineLaunch ? undefined : accountLibrary.startLaunchAccess();
  if (authState.stored === true && authState.username && await bindOfflineAccess(dataRoot, authState.username)) {
    emitLog('offline', 'Removed stored offline licenses and identities (account-changed).');
  }
  const offlineRuntime = await offlineIdentityRuntime(wine);
  if (offlineLaunch && (!offlineRuntime || !backend.current.capabilities.offlineLaunch)) {
    throw new Error('Offline play requires a compatible Nexus backend and runtime. Update them in Settings while online.');
  }
  const licenseCache = offlineRuntime ? await offlineLicenseCache() : undefined;
  const args = gameLaunchArguments(inspected, wine, store.settings.market, backend.current.linuxRunPatch,
    licenseCache, offlineLaunch && Boolean(licenseCache && backend.current.capabilities.offlineLaunch));
  const operationId = `game-${id}`;
  const logDirectory = path.join(dataRoot, 'logs');
  const logPath = path.join(logDirectory, `${id}-latest.log`);
  await fs.mkdir(logDirectory, { recursive: true });
  const launchLog = createWriteStream(logPath, { flags: 'w', encoding: 'utf8' });
  launchLog.on('error', (error) => console.error(`Unable to write launch log ${logPath}:`, error));
  const writeLaunchLog = (line: string) => launchLog.write(`[${new Date().toISOString()}] ${line}\n`);
  gameInviteUnavailableReason=undefined;
  gameOperation = {
    id: operationId,
    gameId: id,
    title: game.title,
    kind: 'launch',
    status: 'preparing',
    phase: 'Preparing Proton and Xodus…',
    log: [],
    logPath,
    startedAt: new Date().toISOString(),
  };
  const appendGameLog = (line: string) => {
    writeLaunchLog(line);
    if (!gameOperation || gameOperation.id !== operationId) return;
    gameOperation.log.push(line);
    if (gameOperation.log.length > 250) gameOperation.log.splice(0, gameOperation.log.length - 250);
    gameOperation.phase = line.length > 180 ? `${line.slice(0, 177)}…` : line;
    scheduleSnapshot();
  };
  const verboseLogs = process.env.XODUS_NEXUS_VERBOSE_LOGS === '1' || store.settings.verboseLogs;
  const gameLog = new GameLogReducer(appendGameLog, verboseLogs);
  const addGameLog = (line: string) => gameLog.push(line);
  writeLaunchLog(`Game: ${game.title}`);
  writeLaunchLog(`Mode: package manifest; cloud saves: ${cloudRuntime ? 'enabled' : 'not available in active runtime'}; verbose logs: ${verboseLogs ? 'on' : 'off'}`);
  writeLaunchLog(`Backend: ${binary}`);
  writeLaunchLog(`Wine: ${wine}`);
  writeLaunchLog(`Connectivity: ${reachability.state}${reachability.reason ? ` (${reachability.reason})` : ''}; offline launch: ${offlineLaunch ? 'yes' : 'no'}`);
  emitSnapshot();
  let serviceSession: XodusServiceSession | undefined;
  let inviteBridge: GameInviteBridge | undefined;
  let launchWrapper: GameWrapper | undefined;
  let releaseDisplay = () => {};
  try {
    if (game.launchTools?.dualSenseCompatibility) writeLaunchLog('DualSense compatibility mode enabled for this game (054c:0ce6).');
    if (game.launchTools?.dualShock4Compatibility) writeLaunchLog('DualShock 4 compatibility mode enabled for this game (v1, v2 and wireless adapter).');
    await prepareSystemWallet();
    const legacyPrefixRoot = path.join(dataRoot, 'prefixes', game.id);
    const compatibilityDataPath = path.join(dataRoot, 'compatdata', game.id);
    const steamRoot = path.join(app.getPath('home'), '.steam', 'root');
    launchWrapper = await prepareGameWrapper(wine, game.launchTools, path.join(dataRoot, 'launch-wrappers'), process.env, game.path);
    const protonRunner = await prepareProtonRunner(wine, compatibilityDataPath, steamRoot, launchWrapper.command, store.settings.shaderCacheLimitGiB);
    const wineCommand = protonRunner?.command ?? wine;
    args[2] = preparedGameWine(protonRunner, launchWrapper.command);
    if (inspected.vcRedistEncrypted) {
      if (!protonRunner) throw new Error('This encrypted VC++ prerequisite requires a Proton prefix. Select Xodus Runtime in Settings.');
      const installed = await installedVcRuntimeVersion(path.join(compatibilityDataPath, 'pfx'));
      if (!installed || !versionAtLeast(installed, VC_REDIST_VERSION)) {
        throw new Error(`VC++ runtime ${installed ?? 'not found'} is too old for this encrypted installer. Right-click the game and choose Install / update VC++, then press Play.`);
      }
      addGameLog(`VC++ runtime ${installed} verified; launching the original package executable from a temporary decrypted launch view.`);
    }
    const environment = antiCheatEnvironment(gameLocaleEnvironment(gameWindowEnvironment(gameLoggingEnvironment(protonRunner
      ? { ...process.env }
      : { ...process.env, WINEPREFIX: legacyPrefixRoot, WINEARCH: 'win64' }, verboseLogs)), locale));
    if (process.platform === 'linux' && shortcuts.available) {
      try {
        const png = await loadShortcutIcon({ coverDataUrl: inspected.coverDataUrl ?? game.coverDataUrl }, bytes => {
          const image = nativeImage.createFromBuffer(bytes);
          return image.isEmpty() ? undefined : image.resize({ width: 256, height: 256 }).toPNG();
        });
        environment.WINE_APPLICATION_ID = await shortcuts.windowIdentity({ ...game, installState: inspected.installState }, png);
      } catch { addGameLog('Game window icon unavailable.'); }
    }
    // Never inherit another title's discovery list. Hints are scoped public
    // metadata, not licenses, and cannot make an optional lookup block Play.
    delete environment.NEXUS_RELATED_PRODUCT_IDS;
    delete environment.NEXUS_INVITE_PORT;
    delete environment.NEXUS_INVITE_KEY;
    // A shell's stale offline mode or another account must not influence this
    // launch. The backend supplies identity mode only after license validation.
    delete environment.XODUS_OFFLINE_IDENTITY;
    delete environment.XODUS_FORCE_OFFLINE;
    delete environment.XODUS_ACCOUNT_HASH;
    if (await storeDiscoveryRuntime(wine)) {
      const access = ownedAccess ? await ownedAccess(OWNED_ACCESS_WAIT_MS) : accountLibrary.peekAccess();
      const related = await contentManager().relatedProducts(game, access, currentMarket(), undefined, offlineLaunch).catch(() => {
        addGameLog('Additional DLC discovery unavailable. Continuing with package-declared content.');
        return [] as string[];
      });
      if (related.length) environment.NEXUS_RELATED_PRODUCT_IDS = related.join(',');
    }
    const contentRoots = await contentManager().roots(game).catch(error => {
      addGameLog(`Managed content discovery unavailable: ${(error as Error).message}`);
      return [] as string[];
    });
    if (contentRoots.length) environment.XODUS_CONTENT_ROOTS = [environment.XODUS_CONTENT_ROOTS, ...contentRoots.map(root => 'Z:' + root.replaceAll('/', '\\'))].filter(Boolean).join(';');
    if (offlineLaunch) {
      // The runtime treats the network as unreachable at once instead of
      // waiting for its own connect timeouts. Whether it may sign in from its
      // cached identity is the backend's decision, made only after the stored
      // license passed its lease checks.
      environment.XODUS_FORCE_OFFLINE = '1';
      addGameLog(`Microsoft is unreachable (${reachability.reason ?? 'no answer'}); launching offline with the stored license.`);
    }
    if (locale) {
      addGameLog(`Selected game language: ${locale}.`);
    }
    await syncPrefixUserLocale(wineCommand, protonRunner ? path.join(compatibilityDataPath, 'pfx') : legacyPrefixRoot, locale, environment, addGameLog);
    await syncUnrealCultureGameIni(protonRunner ? path.join(compatibilityDataPath, 'pfx') : legacyPrefixRoot, game.path, titleId, locale, addGameLog);
    if (cloudRuntime) {
      serviceSession = await startXodusService(binary, app.getPath('userData'), addGameLog);
      serviceSessions.set(operationId, serviceSession);
      environment.XODUS_SOCKET = serviceSession.socketPath;
      environment.XODUS_BRIDGE_PORT = String(serviceSession.bridgePort);
      environment.XODUS_BRIDGE_KEY = serviceSession.bridgeKey;
      environment.XODUS_SAVE_SYNC = 'auto';
      addGameLog('Xbox cloud save preview is enabled. Saves may download from and upload to the account cloud.');
    }
    const inviteRuntime=await gameInviteRuntime(wine);
    gameInviteUnavailableReason=!inviteRuntime?'The selected runtime does not support game invitations. Update the runtime and restart the game.':!titleId?'The game has no Xbox title information for invitations.':undefined;
    if(titleId&&/^[a-f0-9]{1,8}$/i.test(titleId)&&inviteRuntime){
      const account=authState.username,epoch=xboxSocial.epoch;
      const current=()=>!shutdownStarted&&authState.stored===true&&authState.username===account&&xboxSocial.epoch===epoch;
      inviteBridge=new GameInviteBridge(operationId,game.title,String(parseInt(titleId,16)),current,emitSnapshot,()=>{void showFriends().catch(()=>{});},Date.now,sender=>{
        if(!Notification.isSupported())return;
        try{const notice=new Notification({title:nativeText('Game invitation'),body:nativeText(`${sender} invited you to ${game.title}. Open Friends to accept.`),urgency:'normal'});notice.on('click',()=>{void showFriends().catch(()=>{});});notice.on('failed',()=>{});notice.show();}catch{/* The dock remains available without desktop notifications. */}
      },new XboxTitlePresence(current,addGameLog));
      try{
        await inviteBridge.start();gameInviteBridges.set(operationId,inviteBridge);
        environment.NEXUS_INVITE_PORT=String(inviteBridge.port);environment.NEXUS_INVITE_KEY=inviteBridge.key;
      }catch{await inviteBridge.stop().catch(()=>{});inviteBridge=undefined;gameInviteUnavailableReason='The game invitation connection could not be started. Restart the game to try again.';addGameLog('Optional game invitations are unavailable for this launch.');}
    }
    // Names the account for the runtime's offline identity cache (an opaque key, never the username).
    if (authState.stored === true && authState.username) environment.XODUS_ACCOUNT_HASH = accountCacheKey(authState.username);
    if (protonRunner) addGameLog(`Proton prefix: ${protonRunner.compatibilityDataPath}/pfx`);
    else await fs.mkdir(legacyPrefixRoot, { recursive: true });
    const tracked = await spawnGameProcess(binary, args, {
      cwd: game.path,
      env: environment,
      onLine: addGameLog,
      maxOutput: 8_000_000,
    }, { stopPrefix: protonRunner?.stopPrefix });
    operations.set(operationId, tracked.child);
    gameProcesses.set(operationId, tracked);
    gameGuide?.bind(id,game.title,tracked.child.pid);
    releaseDisplay = gameDisplay.acquire();
    gameOperation.status = 'running';
    gameOperation.phase = 'Xodus is running; waiting for the game window…';
    emitSnapshot();
    void tracked.result.then((result) => {
      addGameLog(`The Xodus process exited with code ${result.code}.`);
      if (!gameOperation || gameOperation.id !== operationId) return;
      gameOperation.finishedAt = new Date().toISOString();
      if (result.code === 0 || gameOperation.status === 'stopping') {
        gameOperation.status = 'complete';
        gameOperation.phase = result.code === 0 ? 'The game has exited.' : 'The game was stopped. Forced shutdown may leave unsynchronized saves.';
      } else {
        const detail = result.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(-6).join(' | ');
        gameOperation.status = 'failed';
        gameOperation.error = contentLicenseFailure(result.output.split('\n'))
          ?? `Xodus run exited with code ${result.code}${detail ? `: ${detail.slice(0, 900)}` : '.'}`;
        gameOperation.phase = gameOperation.error;
      }
    }).catch((error) => {
      addGameLog(`Process error: ${(error as Error).message}`);
      if (!gameOperation || gameOperation.id !== operationId) return;
      gameOperation.status = 'failed';
      gameOperation.error = (error as Error).message;
      gameOperation.phase = gameOperation.error;
      gameOperation.finishedAt = new Date().toISOString();
    }).finally(async () => {
      releaseDisplay();gameGuide?.unbind(id);
      finalizingGame = true;
      try {
        operations.delete(operationId);
        gameProcesses.delete(operationId);
        await inviteBridge?.stop().catch(()=>{});gameInviteBridges.delete(operationId);
        if (serviceSession) {
          await serviceSession.stop().catch((error) => addGameLog(`Account service cleanup failed: ${(error as Error).message}`));
          serviceSessions.delete(operationId);
        }
        await tracked.cleanup().catch((error) => console.error('Game service cleanup failed:', error));
        await launchWrapper?.cleanup().catch((error) => console.error('Game wrapper cleanup failed:', error));
        gameLog.flush();
        launchLog.end();
        emitSnapshot();
        if (gameOperation?.status === 'failed' && shortcutOnly) await shortcutError(new Error(gameOperation.error ?? 'The game exited with an error.'));
      } finally { finalizingGame = false; finishShortcutSession(); }
    });
  } catch (error) {
    releaseDisplay();gameGuide?.unbind(id);
    await inviteBridge?.stop().catch(()=>{});gameInviteBridges.delete(operationId);
    await launchWrapper?.cleanup().catch(() => undefined);
    if (serviceSession) {
      await serviceSession.stop().catch(() => undefined);
      serviceSessions.delete(operationId);
    }
    writeLaunchLog(`Preparation error: ${(error as Error).message}`);
    gameLog.flush();
    launchLog.end();
    if (gameOperation?.id === operationId) gameOperation = undefined;
    emitSnapshot();
    throw error;
  }
}

async function installGameVcRuntime(id: string): Promise<void> {
  ensureIdle();
  const game = store.games.find((entry) => entry.id === id);
  if (!game) throw new Error('Game not found.');
  const inspected = await inspectGameDirectory(game.path);
  if (inspected.installState !== 'ready') throw new Error(inspected.installMessage ?? 'The game installation is not ready.');
  const wine = selectedWinePath(store.settings.winePath, store.settings.runtimeRoot, runtime.current.winePath);
  if (!wine) throw new Error('Select Xodus Runtime in Settings first.');
  await fs.access(wine, constants.X_OK);

  const operationId = `vc-${id}`;
  const dataRoot = path.dirname(store.settings.runtimeRoot);
  const logDirectory = path.join(dataRoot, 'logs');
  await fs.mkdir(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, `${id}-vc-runtime.log`);
  const log = createWriteStream(logPath, { flags: 'w', encoding: 'utf8' });
  log.on('error', (error) => console.error(`Unable to write VC++ log ${logPath}:`, error));
  gameOperation = {
    id: operationId,
    gameId: id,
    title: game.title,
    kind: 'prerequisite',
    status: 'preparing',
    phase: 'Preparing the Proton prefix…',
    log: [],
    logPath,
    startedAt: new Date().toISOString(),
  };
  const addLine = (line: string) => {
    log.write(`[${new Date().toISOString()}] ${line}\n`);
    if (gameOperation?.id !== operationId) return;
    gameOperation.log.push(line);
    if (gameOperation.log.length > 250) gameOperation.log.splice(0, gameOperation.log.length - 250);
    gameOperation.phase = line.length > 180 ? `${line.slice(0, 177)}…` : line;
    scheduleSnapshot();
  };
  emitSnapshot();
  const controller = new AbortController();
  preparationControllers.set(operationId, controller);
  try {
    const compatibilityDataPath = path.join(dataRoot, 'compatdata', game.id);
    const protonRunner = await prepareProtonRunner(wine, compatibilityDataPath, path.join(app.getPath('home'), '.steam', 'root'), undefined, store.settings.shaderCacheLimitGiB);
    if (!protonRunner) throw new Error('VC++ installation requires a full Proton runtime, not a standalone Wine binary.');
    const prefix = path.join(compatibilityDataPath, 'pfx');
    const previous = await installedVcRuntimeVersion(prefix);
    if (previous && versionAtLeast(previous, VC_REDIST_VERSION)) {
      addLine(`VC++ ${previous} is already installed. No changes needed.`);
    } else {
      addLine(`Current VC++ runtime: ${previous ?? 'not found'}. Downloading Microsoft VC++ ${VC_REDIST_VERSION}.`);
      let lastProgress = -1;
      const installer = await downloadVerifiedVcRedist(path.join(dataRoot, 'prerequisites'), (downloaded, total) => {
        const percent = total ? Math.floor(downloaded * 100 / total) : -1;
        if (percent === lastProgress || (percent >= 0 && percent < lastProgress + 5 && percent !== 100)) return;
        lastProgress = percent;
        if (gameOperation?.id === operationId) {
          gameOperation.phase = total ? `Downloading Microsoft VC++: ${percent}%` : `Downloading Microsoft VC++: ${(downloaded / 1024 / 1024).toFixed(1)} MiB`;
          scheduleSnapshot();
        }
      }, controller.signal);
      if (controller.signal.aborted) throw new Error('VC++ installation was cancelled.');
      preparationControllers.delete(operationId);
      addLine('Microsoft installer SHA-256 verified. Installing into this game’s Proton prefix…');
      const tracked = spawnTracked(protonRunner.command, [installer, '/install', '/quiet', '/norestart'], {
        env: gameLoggingEnvironment({ ...process.env }),
        onLine: addLine,
        maxOutput: 1_000_000,
      });
      operations.set(operationId, tracked.child);
      if (gameOperation?.id === operationId) gameOperation.status = 'running';
      emitSnapshot();
      const result = await tracked.result;
      operations.delete(operationId);
      const installed = await installedVcRuntimeVersion(prefix);
      if (!installed || !versionAtLeast(installed, VC_REDIST_VERSION)) {
        throw new Error(`Microsoft VC++ installer exited with code ${result.code}, but required version ${VC_REDIST_VERSION} was not registered (found ${installed ?? 'none'}).`);
      }
      addLine(`Microsoft VC++ ${installed} installed in this game’s Proton prefix.`);
    }
    if (gameOperation?.id === operationId) {
      gameOperation.status = 'complete';
      gameOperation.phase = 'VC++ is ready. Press Play.';
      gameOperation.finishedAt = new Date().toISOString();
    }
  } catch (error) {
    if (gameOperation?.id === operationId) {
      gameOperation.status = 'failed';
      gameOperation.error = (error as Error).message;
      gameOperation.phase = gameOperation.error;
      gameOperation.finishedAt = new Date().toISOString();
    }
    throw error;
  } finally {
    preparationControllers.delete(operationId);
    operations.delete(operationId);
    log.end();
    emitSnapshot();
  }
}

function currentMarket(): string {
  const configured = store.settings.market;
  return configured.toLowerCase() === 'neutral' ? app.getLocaleCountryCode() || 'US' : configured;
}

// Fetch real covers and wide art even when an installation has a small logo.
async function enrichDownloadCovers(tasks: readonly DownloadTask[], market: string): Promise<void> {
  const missing = tasks.filter(task => !task.coverUrl && ['queued', 'running', 'paused'].includes(task.status));
  if (!missing.length) return;
  const posters = await catalog.posters([...new Set(missing.map(task => task.productId))], market);
  let changed = false;
  for (const task of missing) {
    const current = store.downloads.find(entry => entry.id === task.id && entry.productId === task.productId);
    const coverUrl = posters.get(task.productId);
    if (!current || current.coverUrl || !coverUrl) continue;
    await store.updateDownload(task.id, { coverUrl });
    changed = true;
  }
  if (changed) emitSnapshot();
}

async function enrichLibraryCovers(): Promise<void> {
  const missing = store.games.filter((game) => game.storeId && (!game.coverUrl || !game.heroUrl));
  if (missing.length === 0) return;
  const artwork = await catalog.artwork(missing.map((game) => game.storeId!), currentMarket());
  for (const game of missing) {
    const images = artwork.get(game.storeId!.toUpperCase());
    if (images) await store.patchGame(game.id, {
      coverUrl: images.coverUrl ?? game.coverUrl, heroUrl: images.heroUrl ?? game.heroUrl,
    });
  }
}

async function loadDemoCovers(): Promise<void> {
  const ids = [...new Set([
    ...demoGames.flatMap((game) => (game.storeId ? [game.storeId] : [])),
    ...demoDownloads.flatMap((task) => (task.productId ? [task.productId] : [])),
    ...demoAccountProducts.map(product => product.productId),
  ])];
  for (const [id, images] of await catalog.artwork(ids, snapshot().settings.market)) demoArtwork.set(id, images);
}

// XODUS_DEMO=1 serves sample state without touching the real backend,
// runtime, account or installed games. Store pages deliberately keep using
// the live Microsoft Store catalog so demo screenshots show real data.
function registerDemoIpc(catalogMarket: () => string): void {
  ipcMain.handle('get-snapshot', () => snapshot());
  ipcMain.handle('backend-refresh', () => snapshot().backend);
  ipcMain.handle('backend-check-update', () => snapshot().backend);
  ipcMain.handle('backend-update', () => {});
  ipcMain.handle('backend-rebuild', () => {});
  ipcMain.handle('runtime-refresh', () => snapshot().runtime);
  ipcMain.handle('runtime-check-update', () => snapshot().runtime);
  ipcMain.handle('runtime-check-nexus', () => snapshot().runtime);
  ipcMain.handle('runtime-install', () => {});
  ipcMain.handle('runtime-install-nexus', () => {});
  ipcMain.handle('runtime-rollback-preview', () => {});
  ipcMain.handle('account-refresh', () => snapshot().auth);
  ipcMain.handle('keyring-check', () => ({ state: 'ready', gameMode: false, canStart: false, message: 'Sample system wallet is running and unlocked. No real keyring is accessed.' }));
  ipcMain.handle('keyring-start', () => ({ state: 'ready', gameMode: false, canStart: false, message: 'Demo mode does not start real services.' }));
  ipcMain.handle('keyring-create', () => ({ state: 'ready', gameMode: false, canStart: false, message: 'Demo mode does not create real wallets.' }));
  ipcMain.handle('check-launcher-update', () => snapshot().launcherUpdate);
  ipcMain.handle('install-launcher-update', () => {});
  ipcMain.handle('restart-launcher', () => {});
  ipcMain.handle('rollback-launcher-update', () => {});
  ipcMain.handle('check-game-updates', () => {});
  ipcMain.handle('read-diagnostic-log', () => ({ name: 'demo.log', content: 'Demo diagnostic log. No account data.', truncated: false }));
  ipcMain.handle('copy-diagnostic-log', () => clipboard.writeText('Demo diagnostic log. No account data.'));
  ipcMain.handle('reveal-diagnostic-log', () => undefined);
  ipcMain.handle('read-backend-diagnostic-log', () => ({ name: 'backend.log', content: 'Sample backend diagnostics. No account data.', truncated: false }));
  ipcMain.handle('create-diagnostic-report', () => ({ name: 'nexus-diagnostics-demo.txt', content: 'Xodus Nexus diagnostic report\nDemo data only.\nLauncher: ' + app.getVersion() }));
  ipcMain.handle('save-diagnostic-report', (_event, content: unknown) => saveReviewedReport(content));
  ipcMain.handle('login', () => {});
  ipcMain.handle('logout', () => {});
  ipcMain.handle('offline-permissions', () => ({ enabled: false, requestSuccess: true, remainingToggles: 2, maxToggles: 3, periodDays: 365, checkedAt: new Date().toISOString() }));
  ipcMain.handle('set-offline-permissions', (_event, enabled: boolean) => ({ enabled: Boolean(enabled), requestSuccess: true, remainingToggles: 1, maxToggles: 3, periodDays: 365, checkedAt: new Date().toISOString() }));
  ipcMain.handle('catalog-search', (_event, query: string, cursor?: string) => catalog.search(query, catalogMarket(), cursor));
  ipcMain.handle('catalog-featured', () => catalog.featured(catalogMarket()));
  ipcMain.handle('account-library', (_event, kind: 'all' | 'owned' | 'gamepass') => demoAccountLibrary(kind, demoArtwork));
  ipcMain.handle('stop-game-update-check', () => {});
  ipcMain.handle('start-install', () => 'demo-download');
  ipcMain.handle('install-plan', () => { throw Error('Package selection is unavailable in demo mode.'); });
  ipcMain.handle('game-content', (_event, id: string) => ({ gameId: id, checkedAt: new Date().toISOString(), items: [] }));
  ipcMain.handle('install-game-content', () => { throw Error('Content installation is unavailable in demo mode.'); });
  ipcMain.handle('update-installed-game', (_event, id: string) => id);
  ipcMain.handle('cancel-download', () => {});
  ipcMain.handle('download-cancel-options', () => ({ deleteFilesAllowed: false, reason: 'File deletion is unavailable in demo mode.' }));
  ipcMain.handle('remove-download', () => {});
  ipcMain.handle('clear-finished-downloads', () => {});
  ipcMain.handle('import-game', () => null);
  ipcMain.handle('game-locales', () => demoLocales);
  ipcMain.handle('update-game', (_event, id: string, patch: Partial<Game>) => {
    const game = demoGames.find((entry) => entry.id === id) ?? demoGames[0];
    return { ...game, ...patch };
  });
  ipcMain.handle('remove-game', () => {});
  ipcMain.handle('game-launch-options', () => demoLaunchOptions);
  ipcMain.handle('game-details', async (_event, id: unknown) => {
    const game = demoGames.find(game => game.id === id);
    const target=typeof id==='object'?gameDetailsTarget(id,[]):game?gameDetailsTarget(id,demoGames):undefined;
    return target?.productId ? catalog.gameDetails(target.productId, catalogMarket()) : undefined;
  });
  ipcMain.handle('game-activity', () => ({ status: 'unavailable' }));
  ipcMain.handle('game-achievements', () => ({ status: 'unavailable' }));
  ipcMain.handle('launch-game', () => {});
  ipcMain.handle('create-game-shortcut', () => { throw new Error('Shortcuts are unavailable in demo mode.'); });
  ipcMain.handle('add-to-steam', () => { throw new Error('Steam integration is unavailable in demo mode.'); });
  ipcMain.handle('install-game-vc-runtime', () => {});
  ipcMain.handle('cancel-game', () => {});
  ipcMain.handle('update-settings', (_event, patch: Partial<Settings>) => ({ ...snapshot().settings, ...patch }));
  ipcMain.handle('choose-directory', () => null);
  ipcMain.handle('choose-file', () => null);

 const voiceSender=(event:Electron.IpcMainInvokeEvent)=>{if(!voiceHost.owns(event))throw Error('Party media must use the shared Nexus audio host.');};
  ipcMain.handle('xbox-party-state',event=>{if(!voiceHost.owns(event))socialSender(event);return xboxParty.current;});
  ipcMain.handle('xbox-party-start',(event,offer:string,partyId?:string)=>{voiceSender(event);return xboxParty.start(offer,partyId);});
  ipcMain.handle('xbox-party-active',event=>{socialSender(event);return xboxParty.activeParties();});
  ipcMain.handle('xbox-party-leave-existing',(event,id:string)=>{socialSender(event);return xboxParty.leaveExisting(id);});
  ipcMain.handle('xbox-party-connected',(event,id:string)=>{voiceSender(event);xboxParty.connected(id);});
  ipcMain.handle('xbox-party-leave',event=>{voiceSender(event);return xboxParty.leave();});
  ipcMain.handle('xbox-party-invite',(event,xuid:string)=>{socialSender(event);return xboxParty.invite(xuid);});
  ipcMain.handle('xbox-party-voice-policy',(event,xuid:string)=>{voiceSender(event);return xboxParty.voiceAllowed(xuid);});
  ipcMain.handle('xbox-party-microphone',event=>{voiceSender(event);if(xboxParty.current.phase!=='connected')throw Error('Connect the Xbox party before enabling your microphone.');voiceHost.allowMicrophone();});
  ipcMain.handle('xbox-party-accept',acceptPartyInvite);
 ipcMain.handle('xbox-invites',async event=>{socialSender(event);return (await xboxInvites.list()).filter(invite=>invite.kind==='party');});
  ipcMain.handle('open-path', () => {});
}

function socialSender(event:Electron.IpcMainInvokeEvent):void{
 if(event.senderFrame!==event.sender.mainFrame||event.sender!==mainWindow?.webContents&&!nativeSocialSenders.some(owns=>owns(event)))throw Error('Social requests must come from Nexus.');
 if(!backend.current.capabilities.nativeSocial)throw Error('Update the backend to enable native Social.');
}
async function acceptPartyInvite(event:Electron.IpcMainInvokeEvent,offer:string,id:string){
 if(!voiceHost.owns(event))throw Error('Party media must use the shared Nexus audio host.');
 const context=nativeSocialConnection(),handle=await xboxInvites.partyHandle(id),current=nativeSocialConnection();
 if(!voiceHost.owns(event)||!context||!current||context.account!==current.account||context.binary!==current.binary)throw Error('Xbox party account changed. Select the invitation again.');
 return xboxParty.accept(offer,handle);
}
function registerIpc(): void {
  ipcMain.handle('show-touch-keyboard',event=>steamKeyboard.show(event,mainWindow));
  ipcMain.handle('xbox-overlay-recording',async(event,recording:unknown)=>{
    if(event.sender!==mainWindow?.webContents||event.senderFrame!==event.sender.mainFrame||typeof recording!=='boolean')throw Error('Invalid shortcut recording request.');
    if(recording&&!mainWindow?.isFocused())throw Error('Focus Nexus to record a shortcut.');
    await overlayShortcut?.record(store.settings,recording);
  });

  ipcMain.handle('open-xbox-player-profile',async(event,value:unknown)=>{
    socialSender(event);
    if(typeof value!=='string'||value!=='me'&&(!/^[1-9][0-9]{0,19}$/.test(value)||BigInt(value)>18446744073709551615n))throw Error('Invalid Xbox player profile.');
    desktopProfileRequest={id:randomUUID(),xuid:value};await showLauncher();
    mainWindow?.webContents.send('xbox-desktop-profile',desktopProfileRequest);
  });
  ipcMain.handle('xbox-desktop-profile',event=>{
    if(event.sender!==mainWindow?.webContents||event.senderFrame!==event.sender.mainFrame)throw Error('Read desktop profiles through Nexus.');
    return desktopProfileRequest;
  });

 ipcMain.handle('xbox-game-invite-availability',event=>{socialSender(event);return nativeInviteAvailability();});
 ipcMain.handle('xbox-game-invite-send',(event,xuid:string)=>{socialSender(event);const bridge=availableNativeInvite();if(!bridge)throw Error('Start an online game session to invite someone.');bridge.invite(xuid);});

 ipcMain.handle('pop-out-xbox-chat',(event,xuid:unknown)=>{socialSender(event);if(!nativeSocialConnection())throw Error('Sign in through Nexus to open this chat.');return chatWindows.show(xuid);});
 ipcMain.handle('close-xbox-chat',event=>{if(!chatWindows.owns(event))throw Error('Close the chat from its own window.');chatWindows.close(event.sender);});
 ipcMain.handle('xbox-chat-reads',event=>{
  socialSender(event);if(event.sender!==mainWindow?.webContents)throw Error('Read notifications through Nexus.');return chatReads.current();
 });
 ipcMain.handle('xbox-chat-viewed',(event,account:unknown,binary:unknown,peer:unknown,ids:unknown)=>{
  socialSender(event);
  const main=event.sender===mainWindow?.webContents&&mainWindow.isVisible()&&!mainWindow.isMinimized()&&mainWindow.isFocused();
  if(!main&&!chatWindows.canView(event,peer))throw Error('Read messages from the active chat window.');
  chatReads.viewed(account,binary,peer,ids);
 });
  ipcMain.handle('xbox-player-details',(event,xuid:string)=>{socialSender(event);return xboxNativeSocial.details(xuid);});
  ipcMain.handle('xbox-player-games',(event,xuid:string)=>{socialSender(event);return xboxNativeSocial.games(xuid);});
  ipcMain.handle('xbox-social-people',(event,list:Parameters<NativeXboxSocial['people']>[0],query?:string)=>{socialSender(event);return xboxNativeSocial.people(list,query);});
  ipcMain.handle('xbox-social-relationship',(event,xuid:string)=>{socialSender(event);return xboxNativeSocial.relationship(xuid);});
  ipcMain.handle('xbox-social-relationship-change',(event,account:string,xuid:string,action:Parameters<NativeXboxSocial['changeRelationship']>[2])=>{socialSender(event);return xboxNativeSocial.changeRelationship(account,xuid,action);});
  ipcMain.handle('xbox-social-friends', event => {socialSender(event);return xboxNativeSocial.friends();});
  ipcMain.handle('xbox-player-profile',(event,xuid:string)=>{socialSender(event);return xboxNativeSocial.profile(xuid);});
  ipcMain.handle('xbox-social-inbox', event => {socialSender(event);return xboxNativeSocial.inbox();});
  ipcMain.handle('xbox-social-conversation', (event,xuid: string) => {socialSender(event);return xboxNativeSocial.conversation(xuid);});
  ipcMain.handle('xbox-social-send', (event,account: string,xuid: string,text: string) => {socialSender(event);return xboxNativeSocial.send(account,xuid,text);});
  const catalogMarket = currentMarket;
  if (demoMode) {
    registerDemoIpc(catalogMarket);
    return;
  }
  ipcMain.handle('get-snapshot', () => snapshot());
  ipcMain.handle('backend-refresh', async () => { const value = await backend.refresh(); await refreshAccount(false); emitSnapshot(); return value; });
  ipcMain.handle('backend-check-update', async () => { const value = await backend.checkUpdate(); emitSnapshot(); return value; });
  ipcMain.handle('backend-update', async () => { await backend.update(emitSnapshot); await refreshAccount(); });
  ipcMain.handle('backend-rebuild', async () => { await backend.rebuild(emitSnapshot); await refreshAccount(); });
  ipcMain.handle('runtime-refresh', async () => { const value = await runtime.refresh(); await syncManagedWinePath(); await refreshAccount(false); emitSnapshot(); return value; });
  ipcMain.handle('runtime-check-update', async () => { const value = await runtime.check(); emitSnapshot(); return value; });
  ipcMain.handle('runtime-check-nexus', async () => { const value = await runtime.checkNexus(); emitSnapshot(); return value; });
  ipcMain.handle('runtime-install', async () => {
    ensureIdle();
    const winePath = await runtime.install(emitSnapshot);
    await store.setSettings({ winePath });
    await refreshAccount(false);
    emitSnapshot();
  });
  ipcMain.handle('runtime-install-nexus', async () => {
    ensureIdle();
    const winePath = await runtime.installNexus(emitSnapshot);
    await store.setSettings({ winePath });
    await refreshAccount(false);
    emitSnapshot();
  });
  ipcMain.handle('runtime-rollback-preview', async () => {
    ensureIdle();
    const winePath = await runtime.rollbackCloudSavePreview(emitSnapshot);
    await store.setSettings({ winePath });
    await refreshAccount(false);
    emitSnapshot();
  });
  ipcMain.handle('account-refresh', () => refreshAccount());
  const socialClient=(event:Electron.IpcMainInvokeEvent)=>{
    if(event.sender!==mainWindow?.webContents)throw Error('Unknown social window.');
    if(event.senderFrame!==event.sender.mainFrame)throw Error('Unknown social frame.');
    return xboxSocial.client(event.sender.id);
  };
  ipcMain.handle('xbox-friends', event => socialClient(event).friends());
  ipcMain.handle('xbox-conversation', (event, xuid: unknown) => socialClient(event).conversation(xuid));
  ipcMain.handle('xbox-send-message', (event, xuid: unknown, text: unknown) => socialClient(event).send(xuid, text));
  ipcMain.handle('xbox-social-close', event => socialClient(event).close());
  const invitation=(event:Electron.IpcMainInvokeEvent,id:unknown)=>{
    socialClient(event);if(typeof id!=='string'||id.length>160)throw Error('Invalid invitation.');
    const bridge=[...gameInviteBridges.values()].find(value=>id.startsWith(value.id+':'));
    if(!bridge)throw Error('The game is no longer running.');return {bridge,id};
  };
  ipcMain.handle('game-invite-choose',(event,id:unknown,xuid:unknown)=>{const value=invitation(event,id);value.bridge.choose(value.id,xuid);});
  ipcMain.handle('game-invite-cancel',(event,id:unknown)=>{const value=invitation(event,id);value.bridge.cancel(value.id);});
  ipcMain.handle('game-invite-accept',(event,id:unknown)=>{const value=invitation(event,id);value.bridge.accept(value.id);});
  ipcMain.handle('game-invite-friend',(event,id:unknown,xuid:unknown)=>{socialClient(event);if(typeof id!=='string'||id.length>100)throw Error('Invalid game.');const bridge=gameInviteBridges.get(id);if(!bridge)throw Error('The game is no longer running.');bridge.invite(xuid);});
  ipcMain.handle('keyring-check', () => keyringSupport.check());
  ipcMain.handle('keyring-start', async () => {
    ensureIdle();
    const result = await keyringSupport.start();
    if (result.state === 'ready') void refreshAccount().catch(() => { /* Explicit refresh remains available. */ });
    return result;
  });
  ipcMain.handle('keyring-create', async () => {
    ensureIdle();
    if (authState.running) throw new Error('Wait for sign-in to finish.');
    const result = await keyringSupport.createCollection();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('keyring-state', result);
    return result;
  });
  ipcMain.handle('check-launcher-update', async () => { await checkLauncherUpdate(); emitSnapshot(); return snapshot().launcherUpdate; });
  ipcMain.handle('install-launcher-update', async () => { ensureIdle(); if (authState.running) throw new Error('Wait for sign-in to finish.'); await launcherUpdater.install(); });
  ipcMain.handle('rollback-launcher-update', async () => { ensureIdle(); await launcherUpdater.rollback(); });
  ipcMain.handle('restart-launcher', () => {
    ensureIdle();
    if (!launcherUpdater.state.restartRequired || !launcherUpdater.targetPath) throw new Error('No launcher restart is pending.');
    // AppImage sets these again for the new mount. Do not reuse the old mount.
    for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete process.env[key];
    const externalEnvironment = externalLauncherEnvironment();
    for (const key of ['FONTCONFIG_FILE', 'GTK_IM_MODULE', 'XODUS_NEXUS_STEAM_IME']) {
      if (externalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = externalEnvironment[key];
    }
    app.relaunch({ execPath: launcherUpdater.targetPath, args: [] }); app.quit();
  });
  ipcMain.handle('stop-game-update-check', () => stopGameUpdateCheck());
  ipcMain.handle('check-game-updates', (_event, id?: string) => {
    if (gameUpdateJob) return gameUpdateJob;
    gameUpdateJob = checkGameUpdates(id).finally(() => { gameUpdateJob = undefined; });
    return gameUpdateJob;
  });
  ipcMain.handle('read-diagnostic-log', (_event, id: string) => {
    if (!gameOperation?.logPath || gameOperation.id !== id) throw new Error('This diagnostic log is no longer available.');
    return readDiagnosticTail(gameOperation.logPath, path.join(path.dirname(store.settings.runtimeRoot), 'logs'));
  });
  ipcMain.handle('reveal-diagnostic-log', async (_event, id: string) => {
    if (!gameOperation?.logPath || gameOperation.id !== id) throw new Error('This diagnostic log is no longer available.');
    const file = await diagnosticLogFile(gameOperation.logPath, path.join(path.dirname(store.settings.runtimeRoot), 'logs'));
    shell.showItemInFolder(file);
  });
  ipcMain.handle('copy-diagnostic-log', async (_event, id: string) => {
    if (!gameOperation?.logPath || gameOperation.id !== id) throw new Error('This diagnostic log is no longer available.');
    await copyDiagnosticFile(gameOperation.logPath, path.join(path.dirname(store.settings.runtimeRoot), 'logs'), text => clipboard.writeText(text));
  });
  ipcMain.handle('login', () => requestAuth('login'));
  ipcMain.handle('logout', () => requestAuth('logout'));
  ipcMain.handle('offline-permissions', async () => {
    if (offlinePermissionChanging) throw Error('Wait for the offline-permission change to finish.');
    if (authState.running || authState.stored !== true || !authState.username) throw Error('Sign in before changing offline permissions.');
    const root = offlineDataRoot(), account = authState.username;
    const binary = requireBackend('offlinePc');
    await prepareSystemWallet();
    assertOfflineScope(account, binary, root);
    const result = await readOfflinePermissions(backendRunner(binary), await offlineLicenseCache());
    const launchSupported = await offlineLaunchSupported();
    assertOfflineScope(account, binary, root);
    return { ...await settleOfflinePermissions(result, false), launchSupported };
  });
  ipcMain.handle('set-offline-permissions', async (_event, enabled: unknown) => {
    // The renderer confirms with the user first; Microsoft counts every change against a yearly limit.
    if (typeof enabled !== 'boolean') throw Error('Invalid offline-permission request.');
    ensureIdle();
    if (authState.running || authState.stored !== true || !authState.username) throw Error('Sign in before changing offline permissions.');
    offlinePermissionChanging = true;
    try {
    const root = offlineDataRoot(), account = authState.username;
    const binary = requireBackend('offlinePc');
    const launchSupported = await offlineLaunchSupported();
    if (enabled && !launchSupported) throw Error('Offline play requires a compatible Nexus backend and runtime. Update them in Settings while online.');
    await prepareSystemWallet();
    assertOfflineScope(account, binary, root);
    const result = await changeOfflinePermissions(backendRunner(binary), enabled, await offlineLicenseCache());
    assertOfflineScope(account, binary, root);
    accountRefresh.invalidate();
    // Either direction starts over, as in the Xbox app: licenses stored before
    // the change are never used again and each game needs one online launch.
    return { ...await settleOfflinePermissions(result, true), launchSupported };
    } finally { offlinePermissionChanging = false; }
  });
  ipcMain.handle('catalog-search', (_event, query: string, cursor?: string) => {
    return catalog.search(query, catalogMarket(), cursor);
  });
  ipcMain.handle('account-library', (_event, kind: 'all' | 'owned' | 'gamepass' | 'other', cursor?: string, refresh = false, sort?: 'recent-gamepass') => {
    if (authState.running || authState.stored !== true) throw Error('Finish signing in before loading account games.');
    accountLibrary.select(authState.username, backend.current.capabilities.library ? backend.current.binaryPath : undefined, currentMarket());
    return accountLibrary.get(kind, cursor, refresh, sort);
  });
  ipcMain.handle('read-backend-diagnostic-log', () => backendDiagnostics.read());
  ipcMain.handle('create-diagnostic-report', async (_event, gameId?: string) => {
    if (gameId !== undefined && (typeof gameId !== 'string' || !store.games.some(game => game.id === gameId))) throw Error('Game not found for diagnostics.');
    return createDiagnosticReport({
      snapshot: snapshot(), launcherVersion: app.getVersion(), systemInfo: await reportSystemInfo(),
      backendLog: () => backendDiagnostics.read(), logsRoot: path.join(path.dirname(store.settings.runtimeRoot), 'logs'), gameId,
      privateValues: [app.getPath('home'), os.userInfo().username],
    });
  });
  ipcMain.handle('save-diagnostic-report', (_event, content: unknown) => saveReviewedReport(content));
  ipcMain.handle('catalog-featured', () => catalog.featured(catalogMarket()));
  ipcMain.handle('start-install', (_event, request: InstallRequest) => startInstall(request));
  ipcMain.handle('install-plan', async (_event, raw: string, destination?: string) => {
    const binary = requireBackend('streaming');
    if (!backend.current.capabilities.packageSelection) throw Error('Update the Xodus backend in Settings to choose installation packages.');
    const productId = safeProductId(raw), market = currentMarket();
    const availableBytes = destination === undefined ? undefined : await availableInstallBytes(destination);
    const plan = await installPlans.get(binary, productId, market, Boolean(backend.current.capabilities.contentPackageSelection));
    if (binary !== backend.current.binaryPath || market !== currentMarket()) throw Error('Backend or Store market changed. Try again.');
    return { ...plan, availableBytes };
  });
  ipcMain.handle('game-content', async (_event, id: string) => (await gameContent(id)).plan);
  ipcMain.handle('install-game-content', (_event, id: string, productId: string) => installGameContent(id, productId));
  ipcMain.handle('update-installed-game', async (_event, id: string) => {
    const game = store.games.find((entry) => entry.id === id);
    if (!game) throw new Error('Game not found.');
    if (!game.storeId || !await refreshIncompleteUpdate(game) && (await inspectGameDirectory(game.path)).installState !== 'ready') throw new Error('This game has no verified Store ID or complete installation to update.');
    return startInstall({ productId: game.storeId, title: game.title, destination: game.path }, game);
  });
  ipcMain.handle('download-cancel-options', async (_event, id: string) => {
    const task = cancellableDownload(id), { locked, roots } = downloadCleanupProtection(task);
    return downloadCleanup.options(task, locked, roots);
  });
  ipcMain.handle('cancel-download', async (_event, id: string, mode?: 'keep' | 'delete-files') => cancelDownload(id, mode));
  ipcMain.handle('pause-download', (_event, id: string) => {
    if (downloadCancellations.has(id)) throw Error('This download is being cancelled.');
    const control = downloadControls.get(id);
    if (!control) throw new Error('Pause requires a backend with download controls. Update the Nexus backend in Settings.');
    return control(true);
  });
  ipcMain.handle('resume-download', (_event, id: string) => {
    if (downloadCancellations.has(id)) throw Error('This download is being cancelled.');
    const control = downloadControls.get(id);
    if (!control) {
      if (!backend.current.capabilities.streamingControls) throw new Error('Update the Nexus backend in Settings before resuming a saved download.');
      const task = store.downloads.find(entry => entry.id === id);
      if (!task || task.status !== 'paused' || operations.has(id)) throw new Error('This download cannot be resumed.');
      // Remove only the stale queue row, never files/checkpoints. The new backend
      // process validates package identity and resumes durable byte checkpoints.
      const resumed = structuredClone(task);
      task.status = 'cancelled';
      return (async () => {
        try {
          const game = task.kind === 'update' && task.gameId ? store.games.find(game => game.id === task.gameId) : undefined;
          if (task.kind === 'update' && !game) throw new Error('The installed game for this update is no longer in the library.');
          if (task.kind === 'content') {
            if (!task.gameId) throw Error('Content download has no parent game.');
            await installGameContent(task.gameId, task.productId);
          } else await startInstall({ productId: task.productId, title: task.title, destination: task.destination, selectedContentId: task.selectedContentId, selectionMarket: task.selectionMarket }, game, resumed);
          await store.removeDownload(id);
        } catch (error) { task.status = 'paused'; throw error; }
        finally { emitSnapshot(); }
      })();
    }
    return control(false);
  });
  ipcMain.handle('remove-download', async (_event, id: string) => { if (downloadCancellations.size) throw Error('Wait for cancellation cleanup.'); await store.removeDownload(id); emitSnapshot(); });
  ipcMain.handle('clear-finished-downloads', async () => { if (downloadCancellations.size) throw Error('Wait for cancellation cleanup.'); await store.clearFinishedDownloads(); emitSnapshot(); });
  ipcMain.handle('import-game', (_event, input?: string) => importGame(input));
  ipcMain.handle('game-locales', async (_event, id: string) => {
    const game = store.games.find((entry) => entry.id === id);
    if (!game) throw new Error('Game not found.');
    return gameLocales(game);
  });
  ipcMain.handle('update-game', async (_event, id: string, patch: Partial<Game>) => {
    const allowed: Partial<Game> = {};
    for (const key of ['title', 'executable', 'launchArgs'] as const) if (typeof patch[key] === 'string') allowed[key] = patch[key];
    if ('launchTools' in patch) allowed.launchTools = normalizeLaunchTools(patch.launchTools);
    if (typeof patch.locale === 'string') {
      const game = store.games.find((entry) => entry.id === id);
      if (!game) throw new Error('Game not found.');
      allowed.locale = supportedGameLocale(patch.locale) ?? '';
    }
    const game = await store.patchGame(id, allowed);
    emitSnapshot();
    return game;
  });
  ipcMain.handle('remove-game', async (_event, id: string, mode: 'library' | 'delete-files') => {
    if (mode !== 'library' && mode !== 'delete-files') throw new Error('Invalid removal option.');
    await stopGameUpdateCheck();
    ensureIdle('remove');
    const game = store.games.find((entry) => entry.id === id);
    if (!game) throw new Error('Game not found.');
    gameRemovalInProgress = true;
    try {
      const activeGame = gameOperation && ['preparing', 'running', 'stopping'].includes(gameOperation.status) ? gameOperation : undefined;
      const runningGame = activeGame ? store.games.find(entry => entry.id === activeGame.gameId) : undefined;
      if (activeGame && !runningGame) throw Error('Could not verify the active game. Close it before removing a game.');
      await assertGameRemovalAvailable(game, store.downloads, task => operations.has(task.id) || installQueue.has(task.id), runningGame);
      if (mode === 'delete-files') {
        const protectedPaths = ['/boot', '/dev', '/etc', '/proc', '/run', '/sys', '/usr', '/var', os.homedir(), app.getPath('userData'), store.settings.installRoot, store.settings.runtimeRoot, store.settings.externalXodusRoot, __dirname].filter(Boolean);
        const target = await validateGameDeleteTarget(game, store.games.filter((entry) => entry.id !== id), protectedPaths);
        await deleteGameDirectory(target);
      }
      await store.removeGame(id);
      await shortcuts.remove(id).catch((error) => console.error('Could not remove game shortcuts:', error));
      emitSnapshot();
    } finally {
      gameRemovalInProgress = false;
    }
  });
  ipcMain.handle('game-launch-options', (_event, id: string) => gameLaunchOptions(id));
  ipcMain.handle('game-details', async (_event, id: unknown) => {
    const target=gameDetailsTarget(id,store.games);
    if (!target.productId) return undefined;
    const market = currentMarket();
    const details = await catalog.gameDetails(target.productId, market);
    if (market !== currentMarket()) throw Error('Store market changed. Try again.');
    return details;
  });
  ipcMain.handle('game-activity', async (_event, id: unknown, refresh = false) => {
    if (typeof refresh !== 'boolean') throw Error('Invalid activity request.');
    const target=gameDetailsTarget(id,store.games),market=currentMarket();
    if (authState.running || authState.stored !== true || !authState.username) return { status: 'signed-out' };
    if (!backend.current.capabilities.gameActivity || !backend.current.binaryPath) return { status: 'unsupported' };
    const account = authState.username, binary = backend.current.binaryPath;
    gameActivities.select(account, binary);
    let title:string|undefined;
    try{title=target.game?await installedTitleId(target.game.path):await catalog.gameDetails(target.productId!,market).then(details=>details?.xboxTitleId);}
    catch{return {status:'error'};}
    if (!title) return { status: 'unavailable' };
    if (authState.running || authState.stored !== true || account !== authState.username || binary !== backend.current.binaryPath || !target.game&&market!==currentMarket()) return { status: 'error' };
    const activity = await gameActivities.get(title, refresh);
    if (authState.running || authState.stored !== true || account !== authState.username || binary !== backend.current.binaryPath || !target.game&&market!==currentMarket()) return { status: 'error' };
    return activity;
  });
  ipcMain.handle('game-achievements', async (_event, id: unknown, refresh = false) => {
    if (typeof refresh !== 'boolean') throw Error('Invalid achievements request.');
    const target=gameDetailsTarget(id,store.games),market=currentMarket();
    if (authState.running || authState.stored !== true || !authState.username) return { status: 'signed-out' };
    if (!backend.current.capabilities.achievements || !backend.current.binaryPath) return { status: 'unsupported' };
    const account = authState.username, binary = backend.current.binaryPath;
    gameAchievements.select(account, binary);
    let title:string|undefined;
    try{title=target.game?await installedTitleId(target.game.path):await catalog.gameDetails(target.productId!,market).then(details=>details?.xboxTitleId);}
    catch{return {status:'error'};}
    if (!title) return { status: 'unavailable' };
    if (authState.running || authState.stored !== true || account !== authState.username || binary !== backend.current.binaryPath || !target.game&&market!==currentMarket()) return { status: 'error' };
    const value = await gameAchievements.get(title, refresh);
    if (authState.running || authState.stored !== true || account !== authState.username || binary !== backend.current.binaryPath || !target.game&&market!==currentMarket()) return { status: 'error' };
    return value;
  });
  ipcMain.handle('launch-game', (_event, id: string) => launchGame(id));
  ipcMain.handle('add-to-steam', async (_event, id?: string) => {
    if (process.platform !== 'linux') throw Error('Steam integration is currently supported on Linux only.');
    if (id !== undefined && typeof id !== 'string') throw Error('Invalid game ID.');
    const game = id === undefined ? undefined : store.games.find(entry => entry.id === id);
    if (id !== undefined && (!game || game.installState !== 'ready')) throw Error('Only installed, ready games can be added to Steam.');
    let accounts = await steamAccounts(os.homedir());
    if (!accounts.length) throw Error('No Steam profile found. Open Steam, sign in, then try again.');
    const nativeAccounts = accounts.filter(account => !account.includes('/.var/app/com.valvesoftware.Steam/'));
    if (!nativeAccounts.length) {
      throw Error('Adding shortcuts currently requires native Linux Steam. Flatpak Steam is not yet supported.');
    }
    accounts = nativeAccounts;
    const normalize = (bytes: Buffer) => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return;
      const size = image.getSize();
      if (size.width < 1 || size.height < 1 || size.width * size.height > 16_777_216) return;
      const scale = Math.min(1, 1200 / Math.max(size.width, size.height));
      const result = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toPNG();
      return result.length <= 4 * 1024 * 1024 ? result : undefined;
    };
    const cover = game ? await loadShortcutIcon({ coverUrl: game.coverUrl }, normalize) ?? await loadShortcutIcon({ coverDataUrl: game.coverDataUrl }, normalize) : undefined;
    const { launch, file: desktop } = await shortcuts.steamDesktop(game, cover);
    const fallback = await fs.readFile(launch.icon);
    const wide = game?.heroUrl ? await loadShortcutIcon({ coverUrl: game.heroUrl }, normalize) : undefined;
    const artwork = game ? { cover: await gameSteamPortrait(cover ?? fallback).catch(() => cover ?? fallback), wide: wide ?? cover ?? fallback }
      : await nexusSteamArtwork(fallback).catch(() => ({ cover: fallback, wide: fallback }));
    if (await steamRunning()) return addLiveSteamShortcut(accounts, launch, desktop, artwork, undefined, undefined, async existing => {
      const choice = await dialog.showMessageBox(mainWindow!, { type: 'question', title: nativeText('Steam shortcut already exists'),
        message: nativeText('Reuse an existing shortcut, or ask Steam to add it for the currently signed-in account?'),
        detail: nativeText('Choose an existing profile to avoid creating a duplicate in that account.'),
        cancelId: existing.length + 1, defaultId: existing.length + 1,
        buttons: [...existing.map(account => nativeText(`Use Steam profile ${path.basename(path.dirname(account))}`)), nativeText('Add for signed-in account'), nativeText('Cancel')] });
      if (!Number.isInteger(choice.response) || choice.response < 0 || choice.response > existing.length) throw Error('Add to Steam cancelled.');
      return choice.response === existing.length ? undefined : existing[choice.response];
    });
    let selected = 0;
    if (accounts.length > 1) {
      const choice = await dialog.showMessageBox(mainWindow!, { type: 'question', title: nativeText('Choose Steam profile'),
        message: nativeText('Which Steam profile should receive this shortcut?'), cancelId: accounts.length, defaultId: accounts.length,
        buttons: [...accounts.map(account => nativeText(`Steam profile ${path.basename(path.dirname(account))}`)), nativeText('Cancel')] });
      selected = choice.response;
      if (selected >= accounts.length) throw Error('Add to Steam cancelled.');
    }
    return addSteamShortcut(accounts[selected], launch, artwork);
  });
  ipcMain.handle('create-game-shortcut', async (_event, id: string, destination: ShortcutDestination) => {
    const game = store.games.find(entry => entry.id === id);
    if (!game) throw new Error('Game not found.');
    if (destination !== 'desktop' && destination !== 'applications') throw new Error('Invalid shortcut destination.');
    const png = await loadShortcutIcon(game, bytes => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) return;
      const { width, height } = image.getSize();
      if (width < 1 || height < 1 || width * height > 16_777_216) return;
      const scale = Math.min(1, 256 / Math.max(width, height));
      return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }).toPNG();
    });
    return shortcuts.create(game, destination, png);
  });
  ipcMain.handle('install-game-vc-runtime', (_event, id: string) => installGameVcRuntime(id));
  ipcMain.handle('cancel-game', async () => {
    if (!gameOperation || !['preparing', 'running', 'stopping'].includes(gameOperation.status)) throw new Error('No game launch is currently active.');
    const child = operations.get(gameOperation.id);
    const gameProcess = gameProcesses.get(gameOperation.id);
    const controller = preparationControllers.get(gameOperation.id);
    if (!child && !controller) throw new Error('Xodus is still preparing; try stopping again in a moment.');
    if (child && gameOperation.kind === 'prerequisite') throw new Error('VC++ installation is running. Wait for it to finish; interrupting it could damage the Proton prefix.');
    gameOperation.status = 'stopping';
    gameOperation.phase = child ? 'Stopping Xodus and Wine…' : 'Cancelling prerequisite download…';
    controller?.abort();
    if (child && gameProcess) {
      const operationId = gameOperation.id;
      try { await gameProcess.stop(); }
      catch (error) { gameOperation.status = 'running'; emitSnapshot(); throw error; }
      const forceTimer = setTimeout(() => {
        if (gameProcesses.get(operationId) === gameProcess) void gameProcess.forceStop().catch((error) => console.error('Could not force-stop game:', error));
      }, 8_000);
      forceTimer.unref();
    } else if (child) {
      child.kill('SIGINT');
    }
    emitSnapshot();
  });
  ipcMain.handle('update-settings', async (_event, patch: Partial<Settings>) => {
    if (patch.shaderCacheLimitGiB !== undefined) shaderCacheLimits(patch.shaderCacheLimitGiB);
    if (patch.downloadLimitMiB !== undefined) {
      downloadLimitKiB(patch.downloadLimitMiB);
      downloadLimitArgs(patch.downloadLimitMiB, backend.current.capabilities);
    }
    if ((['market', 'winePath', 'externalXodusRoot', 'runtimeRoot'] as const).some(key => patch[key] !== undefined && patch[key] !== store.settings[key])) ensureIdle();
    const allowed: Partial<Settings> = {};
    Object.assign(allowed,xboxOverlayPatch(patch));
    if (patch.interfaceLanguage !== undefined) {
      if (interfaceLanguagePreference(patch.interfaceLanguage) !== patch.interfaceLanguage) throw Error('Invalid interface language.');
      allowed.interfaceLanguage = patch.interfaceLanguage;
    }
    if (patch.shaderCacheLimitGiB !== undefined) allowed.shaderCacheLimitGiB = patch.shaderCacheLimitGiB;
    if (patch.downloadLimitMiB !== undefined) allowed.downloadLimitMiB = patch.downloadLimitMiB;
    if (typeof patch.installRoot === 'string') allowed.installRoot = path.resolve(patch.installRoot);
    if (typeof patch.market === 'string' && /^[A-Za-z-]{2,20}$/.test(patch.market)) allowed.market = patch.market;
    if (typeof patch.parallelDownloads === 'number') allowed.parallelDownloads = Math.max(1, Math.min(16, Math.round(patch.parallelDownloads)));
    if (typeof patch.winePath === 'string') allowed.winePath = patch.winePath;
    if (typeof patch.externalXodusRoot === 'string') allowed.externalXodusRoot = patch.externalXodusRoot.trim() ? path.resolve(patch.externalXodusRoot) : '';
    if (typeof patch.runtimeRoot === 'string') allowed.runtimeRoot = path.resolve(patch.runtimeRoot);
    if (typeof patch.verboseLogs === 'boolean') allowed.verboseLogs = patch.verboseLogs;
    if (patch.closeToTray !== undefined) {if(typeof patch.closeToTray !== 'boolean')throw Error('Invalid close-to-tray setting.');allowed.closeToTray=patch.closeToTray;}
    if (typeof patch.firstRunCompleted === 'boolean') allowed.firstRunCompleted = patch.firstRunCompleted;
    const previous = store.settings;
    const settings = await store.setSettings(allowed);
    if(patch.closeToTray!==undefined){
      if(!launcherTray.configure(settings.closeToTray===true)){
        await store.setSettings({closeToTray:previous.closeToTray===true});emitSnapshot();
        throw Error('The system tray is unavailable. Use a desktop session with a system tray.');
      }
      if(!settings.closeToTray&&mainWindow&&!mainWindow.isVisible())await showLauncher();
      if(Object.keys(patch).every(key=>key==='closeToTray')){emitSnapshot();return settings;}
    }
    if(Object.keys(xboxOverlayPatch(patch)).length){
      await overlayShortcut?.configure(settings);gameGuide?.publish('overlay',xboxOverlaySettings(settings));
      if(!xboxOverlaySettings(settings).overlayEnabled)gameGuide?.reset();
      if(Object.keys(patch).every(key=>['overlayEnabled','overlayShortcut','overlaySide'].includes(key))){emitSnapshot();return settings;}
    }
    if (patch.downloadLimitMiB !== undefined) {
      try { await downloadLimitControls.apply(settings.downloadLimitMiB ?? 0); }
      catch { emitSnapshot(); throw Error('The speed limit was saved, but could not be sent to the active download. Retry the installation to apply it.'); }
    }
    // A bandwidth-only change must not restart authentication or refresh devices.
    if (isBandwidthOnlyPatch(patch)) { emitSnapshot(); return settings; }
    if (isShaderCacheOnlyPatch(patch)) { emitSnapshot(); return settings; }
    // Cosmetic/storage preferences do not change the selected components or
    // account scope, including a full unchanged Settings form saved by the UI.
    if ((['market', 'winePath', 'externalXodusRoot', 'runtimeRoot'] as const)
      .every(key => settings[key] === previous[key])) { emitSnapshot(); return settings; }
    backend.setExternalRoot(settings.externalXodusRoot);
    runtime.setRoot(settings.runtimeRoot);
    await backend.refresh();
    await refreshAccount(false);
    await runtime.refresh();
    emitSnapshot();
    return settings;
  });
  ipcMain.handle('choose-directory', async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'], defaultPath });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('choose-file', async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], defaultPath });
    return result.canceled ? null : result.filePaths[0];
  });

 const voiceSender=(event:Electron.IpcMainInvokeEvent)=>{if(!voiceHost.owns(event))throw Error('Party media must use the shared Nexus audio host.');};
  ipcMain.handle('xbox-party-state',event=>{if(!voiceHost.owns(event))socialSender(event);return xboxParty.current;});
  ipcMain.handle('xbox-party-start',(event,offer:string,partyId?:string)=>{voiceSender(event);return xboxParty.start(offer,partyId);});
  ipcMain.handle('xbox-party-active',event=>{socialSender(event);return xboxParty.activeParties();});
  ipcMain.handle('xbox-party-leave-existing',(event,id:string)=>{socialSender(event);return xboxParty.leaveExisting(id);});
  ipcMain.handle('xbox-party-connected',(event,id:string)=>{voiceSender(event);xboxParty.connected(id);});
  ipcMain.handle('xbox-party-leave',event=>{voiceSender(event);return xboxParty.leave();});
  ipcMain.handle('xbox-party-invite',(event,xuid:string)=>{socialSender(event);return xboxParty.invite(xuid);});
  ipcMain.handle('xbox-party-voice-policy',(event,xuid:string)=>{voiceSender(event);return xboxParty.voiceAllowed(xuid);});
  ipcMain.handle('xbox-party-microphone',event=>{voiceSender(event);if(xboxParty.current.phase!=='connected')throw Error('Connect the Xbox party before enabling your microphone.');voiceHost.allowMicrophone();});
  ipcMain.handle('xbox-party-accept',acceptPartyInvite);
 ipcMain.handle('xbox-invites',async event=>{socialSender(event);return (await xboxInvites.list()).filter(invite=>invite.kind==='party');});
  ipcMain.handle('open-path', async (_event, target: string) => {
    await fs.access(target);
    const error = await openDesktopTarget(target, () => shell.openPath(target));
    if (error) throw new Error(error);
  });
}

interface WindowState { x: number; y: number; width: number; height: number; maximized: boolean; }

function readWindowState(): WindowState | undefined {
  try {
    const state = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'window-state.json'), 'utf8')) as Partial<WindowState>;
    if (typeof state.x !== 'number' || typeof state.y !== 'number' || typeof state.width !== 'number'
      || typeof state.height !== 'number' || typeof state.maximized !== 'boolean') return undefined;
    return state as WindowState;
  } catch { /* No state yet, or unreadable; fall back to the default placement. */ }
}

function saveWindowState(window: BrowserWindow): void {
  if (window.isMinimized()) return;
  const bounds = window.getNormalBounds();
  try {
    writeFileSync(path.join(app.getPath('userData'), 'window-state.json'), JSON.stringify({
      x: Math.round(bounds.x), y: Math.round(bounds.y),
      width: Math.round(bounds.width), height: Math.round(bounds.height),
      maximized: window.isMaximized(),
    }));
  } catch { /* Placement is cosmetic; never block shutdown. */ }
}

function restoredBoundsOnScreen(state: WindowState): boolean {
  // A monitor that the state was saved on may be unplugged; check that the
  // restored point is still part of the desktop before applying it.
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return state.x >= area.x - 8 && state.y >= area.y - 8
      && state.x < area.x + area.width && state.y < area.y + area.height;
  });
}

async function prepareFirstRunBackend(): Promise<void> {
  await backend.checkUpdate();
  emitSnapshot();
  if (shutdownStarted || store.settings.firstRunCompleted || backend.current.available ||
      backend.current.updating || !backend.current.releaseAvailable || !backend.current.updateAvailable) return;
  try {
    // Uses the same checksum-verified managed installer and activity guards as Settings.
    await backend.update(emitSnapshot);
    if (!shutdownStarted && mainWindow?.isVisible()) void refreshInitialAccount().catch(() => {});
  } catch { /* Keep the installer error visible for an explicit retry in the wizard. */ }
  finally { emitSnapshot(); }
}

async function createWindow(): Promise<void> {
  const smokeScreenshot = process.env.XODUS_NEXUS_SMOKE_SCREENSHOT;
  const smokeStoreQuery = process.env.XODUS_NEXUS_SMOKE_STORE_QUERY;
  const smokeStore = process.env.XODUS_NEXUS_SMOKE_STORE === '1' || Boolean(smokeStoreQuery);
  const demoCaptureDir = process.env.XODUS_DEMO_CAPTURE_DIR;
  if (demoCaptureDir && !demoMode) throw new Error('Demo capture requires XODUS_DEMO=1; real account data must not be captured.');
  const hiddenCapture = Boolean(smokeScreenshot || demoCaptureDir);
  // The compositor places unpositioned windows, which under Xwayland often
  // means the wrong monitor (see issue #5). Restore the last user placement
  // when it is still on a connected display, otherwise center on the primary.
  const windowState = hiddenCapture ? undefined : readWindowState();
  const bounds = windowState && restoredBoundsOnScreen(windowState)
    ? windowState
    : { x: undefined as number | undefined, y: undefined as number | undefined,
        width: 1440, height: 900, maximized: false };
  // On small screens (for example a Steam Deck with 1280x800 pixels),
  // a window as large as the work area is still too tall: the window manager
  // adds its title bar, and on Wayland the work area often includes the
  // panel. Maximize instead, so that the window manager fits it.
  const area = bounds.x === undefined || bounds.y === undefined
    ? screen.getPrimaryDisplay().workArea
    : screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }).workArea;
  const tooLarge = bounds.width >= area.width || bounds.height >= area.height;
  if (bounds.x === undefined) {
    bounds.width = Math.min(bounds.width, area.width);
    bounds.height = Math.min(bounds.height, area.height);
    bounds.x = area.x + Math.floor((area.width - bounds.width) / 2);
    bounds.y = area.y + Math.floor((area.height - bounds.height) / 2);
  }
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: Math.min(800, area.width),
    minHeight: Math.min(600, area.height),
    backgroundColor: '#080a0c',
    title: 'Xodus Nexus',
    icon: fileURLToPath(new URL('../../assets/icon.png', import.meta.url)),
    autoHideMenuBar: true,
    show: !hiddenCapture,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: hiddenCapture,
    },
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => console.error('Renderer load failed', code, description));
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error('Renderer process exited', details.reason));
  if (smokeScreenshot) mainWindow.webContents.on('console-message', (_event, level, message) => console.error(`Renderer console [${level}]`, message));
  if (!hiddenCapture) mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (!hiddenCapture) {
    if (windowState?.maximized || tooLarge) mainWindow.maximize();
    mainWindow.on('close', () => { if (mainWindow) saveWindowState(mainWindow); });
  }
  const restoreOverlayShortcut=()=>{void overlayShortcut?.record(store.settings,false).catch(()=>console.error('Could not restore the Overlay shortcut.'));};
  mainWindow.on('blur',restoreOverlayShortcut);
  mainWindow.on('closed',restoreOverlayShortcut);
  mainWindow.webContents.on('render-process-gone',restoreOverlayShortcut);
  mainWindow.on('close',event=>{if(mainWindow)launcherTray.close(event,()=>mainWindow?.hide());});
  mainWindow.on('closed', () => { mainWindow = null; finishShortcutSession(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void openDesktopTarget(url, () => shell.openExternal(url))
      .catch(() => console.warn('Could not open the external browser.'));
    return { action: 'deny' };
  });
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}${smokeStore ? '#store' : ''}`);
  else await mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), smokeStore ? { hash: 'store' } : undefined);
  if (demoCaptureDir) {
    // Navigate explicitly so slow image requests cannot move a capture onto
    // the next tour page. Only sample state and public Store data are used.
    await fs.mkdir(demoCaptureDir, { recursive: true });
    await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        if (document.querySelectorAll('.sidebar .nav-item').length >= 4 && document.querySelector('.sidebar .queue-summary')) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Demo navigation did not load')); }
      }, 50);
    })`);
    const artworkUrls = [...new Set([...demoArtwork.values()].flatMap(images => [images.coverUrl, images.heroUrl]).filter(Boolean))];
    await mainWindow.webContents.executeJavaScript(`Promise.all(${JSON.stringify(artworkUrls)}.map(url => {
      const image = new Image(); image.src = url; return image.decode();
    }))`);
    const pages = ['home', 'library', 'store', 'downloads', 'settings'];
    const labels = ['Home', 'My Library', 'Store', 'Install Queue', 'Settings'];
    for (let index = 0; index < pages.length; index++) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        const button = ${JSON.stringify(pages[index])} === 'downloads' ? document.querySelector('.sidebar .queue-summary')
          : [...document.querySelectorAll('.sidebar .nav-item')].find(button => button.querySelector('span')?.textContent === ${JSON.stringify(labels[index])});
        if (!button) throw new Error('Demo navigation is not ready');
        button.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await mainWindow.webContents.executeJavaScript(`(async () => {
        await document.fonts.ready;
        await Promise.race([
          Promise.all([...document.images].map(image => image.decode().catch(() => {}))),
          new Promise(resolve => setTimeout(resolve, 5000))
        ]);
        const broken = [...document.images].filter(image => !image.complete || image.naturalWidth === 0);
        if (broken.length) throw new Error('Demo artwork did not finish loading');
      })()`);
      const image = await mainWindow.webContents.capturePage();
      await fs.writeFile(path.join(demoCaptureDir, `demo-${pages[index]}.png`), image.toPNG());
    }
    app.quit();
    return;
  }
  if (smokeScreenshot) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (smokeStoreQuery) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.topbar .search-box input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(smokeStoreQuery)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 50);
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else if (smokeStore) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    const renderedText = await mainWindow.webContents.executeJavaScript('document.body.innerText.slice(0, 500)');
    console.error('Smoke renderer text:', renderedText.replace(/\n/g, ' | '));
    const image = await mainWindow.webContents.capturePage();
    await fs.writeFile(smokeScreenshot, image.toPNG());
    app.quit();
  }
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  if (startupError) { dialog.showErrorBox(nativeText('Invalid Nexus shortcut'), startupError.message); app.quit(); return; }
  xboxNativeSocial=new NativeXboxSocial(nativeSocialConnection);
  nativeSocialResets.push(clearDesktopProfile);
  nativeSocialResets.push(()=>chatReads.clear());
  chatWindows=new XboxChatWindows(__dirname,finishShortcutSession);
  nativeSocialSenders.push(event=>chatWindows.owns(event));
  nativeSocialResets.push(()=>chatWindows.shutdown());
  nativeSocialShutdown.push(async()=>{chatWindows.shutdown();});
  nativeSocialKeepAlive.push(()=>chatWindows.hasWindow);
  nativeSocialSnapshots.push(()=>{for(const contents of chatWindows.contents)contents.send('snapshot',snapshot());});
  if (!demoMode) {
    backendDiagnostics = new BackendDiagnostics(app.getPath('userData'), () => ({
      launcher: app.getVersion(), backend: backend?.current.version, source: backend?.current.source,
    }));
    setBackendDiagnostics(backendDiagnostics);
  }
  shortcutOnly = Boolean(startupRequest.gameId) && !demoMode;
  store = new StateStore(app.getPath('userData'));
  await store.load();
  launcherTray.configure(store.settings.closeToTray === true);
  xboxParty=new XboxParty(nativeSocialConnection);
  xboxInvites=new XboxInvites(nativeSocialConnection);
  voiceHost=new XboxVoiceHost(__dirname,{
   authorizeControl:event=>event.sender===mainWindow?.webContents&&event.senderFrame===event.sender.mainFrame&&Boolean(nativeSocialConnection()),
   stateChanged:state=>{mainWindow?.webContents.send('xbox-voice-state',state);app.emit('nexus-voice-state',state);},
   leave:()=>xboxParty.leave(),settled:finishShortcutSession,canConnect:()=>!xboxParty.active&&!xboxParty.current.id,
  });
  nativeSocialBeforeAuth.push(async()=>{await voiceHost.control({type:'leave'});await xboxParty.leave();});
  nativeSocialResets.push(()=>{void voiceHost.reset();xboxParty.suspend();xboxInvites.clear();currentXboxInvites=[];mainWindow?.webContents.send('xbox-invites',[]);});
  nativeSocialKeepAlive.push(()=>voiceHost.busy||xboxParty.active||Boolean(xboxParty.current.id));
  xboxParty.on('state',state=>{mainWindow?.webContents.send('xbox-party-state',state);voiceHost.contents?.send('xbox-party-state',state);app.emit('nexus-party-state',state);if(state.phase==='idle')finishShortcutSession();});
  xboxInvites.on('change',invites=>{currentXboxInvites=invites.filter((invite:XboxInvite)=>invite.kind==='party');mainWindow?.webContents.send('xbox-invites',currentXboxInvites);app.emit('nexus-party-invites',currentXboxInvites);});
  const partyInvitesTimer=setInterval(()=>{if(nativeSocialConnection())void xboxInvites.list().catch(()=>{});},30000);partyInvitesTimer.unref();
  nativeSocialShutdown.push(async()=>{clearInterval(partyInvitesTimer);await voiceHost.shutdown();});

  downloadCleanup = new DownloadCleanup(app.getPath('userData'));
  accountProfile = new AccountProfile(app.getPath('userData'), scheduleSnapshot, dataUrl => {
    try {
      const picture = nativeImage.createFromDataURL(dataUrl);
      if (picture.isEmpty()) return;
      const { width, height } = picture.getSize();
      if (width < 1 || height < 1 || width * height > 16_777_216) return;
      const scale = Math.min(1, 256 / Math.max(width, height));
      return picture.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }).toDataURL();
    } catch { return undefined; }
  });
  launcherUpdater = new LauncherUpdater(app.getVersion(), app.isPackaged ? process.env.APPIMAGE : undefined, app.getPath('userData'), scheduleSnapshot);
  await launcherUpdater.initialize();
  const dataHome = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  const appImage = app.isPackaged ? process.env.APPIMAGE : undefined;
  const persistentBinary = app.isPackaged && !process.env.APPDIR && !process.execPath.includes('/.mount_')
    ? (path.basename(process.execPath) === 'xodus-nexus.bin' ? path.join(path.dirname(process.execPath), 'xodus-nexus') : process.execPath) : undefined;
  shortcuts = new GameShortcuts({ userData: app.getPath('userData'), desktop: app.getPath('desktop'),
    applications: path.join(dataHome, 'applications'), launcher: appImage ? await shortcutLauncherPath(appImage,process.env.ARGV0) : persistentBinary,
    icon: fileURLToPath(new URL('../../assets/icon.png', import.meta.url)) });
  if (!demoMode) await shortcuts.initialize().catch((error) => console.error('Game shortcut integration unavailable:', error));
  if (demoMode) {
    // Demo mode: no backend build, no runtime, no account access. Library
    // covers are fetched from the live Store; Store pages are live too.
    // Start the cover fetch before createWindow because a demo capture
    // keeps createWindow busy until the tour finishes.
    registerIpc();
    if (process.env.XODUS_DEMO_CAPTURE_DIR) {
      await loadDemoCovers();
      if (!snapshot().games[0]?.heroUrl) throw new Error('Wide demo artwork is unavailable; capture cancelled.');
    }
    else void loadDemoCovers().then(() => emitSnapshot(), () => { /* Covers are optional. */ });
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
    return;
  }
  for (const game of [...store.games]) {
    try {
      const inspected = await inspectGameDirectory(game.path);
      await store.patchGame(game.id, {
        installState: inspected.installState,
        installMessage: inspected.installMessage,
        updateIncomplete: inspected.updateIncomplete,
        executable: inspected.executable,
        antiCheat: inspected.antiCheat,
        vcRedistEncrypted: inspected.vcRedistEncrypted,
        coverDataUrl: inspected.coverDataUrl,
        storeId: inspected.storeId ?? game.storeId,
        installedVersion: inspected.installedVersion,
        packageName: inspected.packageName,
      });
    } catch {
      await refreshIncompleteUpdate(game).catch(() => {});
      // Keep unavailable entries visible, without clearing any update barrier.
    }
  }
  runtime = new RuntimeManager(store.settings.runtimeRoot, emitLog, () => downloadCancellations.size > 0 || operations.size > 0 || installQueue.size > 0 || preparingInstall || backend?.current.updating === true);
  backend = new BackendManager(app.getPath('userData'), store.settings.externalXodusRoot, emitLog, () => keyringSupport.busy || downloadCancellations.size > 0 || operations.size > 0 || installQueue.size > 0 || preparingInstall || runtime?.current.updating === true);
  await backend.refresh();
  await runtime.refresh();
  if (!demoMode) {
    // Reachability of Microsoft's sign-in hosts, kept current for the header
    // and consulted before a launch so offline play starts without waiting
    // for the backend's and the runtime's own connect timeouts. Each return
    // to online re-checks the offline designation.
    connectivity = new ConnectivityMonitor({ interfaceOnline: () => net.isOnline(), onChange: () => {
      scheduleSnapshot();
      if (connectivity?.current.state === 'online') verifyOfflineDesignation();
    } });
    connectivity.start();
  }
  void prepareFirstRunBackend().catch(() => emitSnapshot());
  void runtime.checkNexus().then(() => emitSnapshot(), () => { /* Nexus runtime is optional. */ });
  await syncManagedWinePath();
  void enrichLibraryCovers().then(() => emitSnapshot(), () => { /* Covers are optional. */ });
  void enrichDownloadCovers(store.downloads, currentMarket()).catch(() => { /* Covers are optional. */ });
  void checkLauncherUpdate().then(() => emitSnapshot());
  registerIpc();

  const guideInitial=()=>({auth:guideAuth(),party:xboxParty.current,voice:voiceHost.state,invites:currentXboxInvites,profile:gameGuide?.profileRequest,overlay:xboxOverlaySettings(store.settings),language:store.settings.interfaceLanguage,runtimeInvites:combinedInviteState(gameInviteBridges.values())});
  const guideParty=new XboxGuideParty({party:xboxParty,invites:xboxInvites,voice:voiceHost,interactive:()=>gameGuide?.interactive===true});
  const guideHelper=app.isPackaged?path.join(process.resourcesPath,'overlay','xbox_guide.py'):path.join(__dirname,'..','..','assets','overlay','xbox_guide.py');
  gameGuide=new XboxGameGuide({directory:path.join(__dirname,'..','..','dist'),helper:guideHelper,
   account:()=>{const context=nativeSocialConnection();return context?JSON.stringify(context):undefined;},initial:guideInitial,
   enabled:()=>xboxOverlaySettings(store.settings).overlayEnabled,
   // Only a single-display/legacy fallback. The host locates the game's window
   // by its launch process group, never the unsupported Wayland cursor position.
   monitor:()=>screen.getPrimaryDisplay().bounds,
   problem:message=>{if(Notification.isSupported())new Notification({title:nativeText('Nexus Overlay'),body:nativeText(message)}).show();},
   invoke:async(method,args)=>{
    if(guideParty.handles(method))return guideParty.invoke(method,args);
    const text=(index:number)=>{const value=args[index];if(typeof value!=='string')throw Error('Invalid Guide request.');return value;};
    switch(method){
     case 'getXboxPlayerDetails':return xboxNativeSocial.details(text(0));
     case 'getXboxPlayerGames':return xboxNativeSocial.games(text(0));
     case 'getXboxPeople':return xboxNativeSocial.people(text(0) as Parameters<NativeXboxSocial['people']>[0],args[1]===undefined||args[1]===null?undefined:text(1));
     case 'getXboxRelationship':return xboxNativeSocial.relationship(text(0));
     case 'changeXboxRelationship':if(text(0)!=='current')throw Error('Xbox account changed.');return xboxNativeSocial.changeRelationship(nativeSocialConnection()!.account,text(1),text(2) as Parameters<NativeXboxSocial['changeRelationship']>[2]);
     case 'getXboxPlayerProfile':return xboxNativeSocial.profile(text(0));
     case 'getXboxFriends':return xboxNativeSocial.friends();
     case 'getXboxInbox':return xboxNativeSocial.inbox();
     case 'getXboxConversation':return xboxNativeSocial.conversation(text(0));
     case 'sendXboxMessage':if(text(0)!=='current')throw Error('Xbox account changed.');return xboxNativeSocial.send(nativeSocialConnection()!.account,text(1),text(2));
     case 'getXboxGameInviteAvailability':return nativeInviteAvailability();
     case 'sendXboxGameInvite':{const bridge=availableNativeInvite();if(!bridge)throw Error('Start an online game session to invite someone.');return bridge.invite(text(0));}
     case 'chooseGameInviteRecipient':{const value=runtimeInvitation(text(0));return value.bridge.choose(value.id,text(1));}
     case 'cancelGameInvite':{const value=runtimeInvitation(text(0));return value.bridge.cancel(value.id);}
     case 'acceptGameInvite':{const value=runtimeInvitation(text(0));return value.bridge.accept(value.id);}
     default:throw Error('Unsupported Guide action.');
    }
   },
  });
  xboxParty.on('state',state=>gameGuide.publish('party',state));
  (app as import('node:events').EventEmitter).on('nexus-voice-state',(state:unknown)=>gameGuide.publish('voice',state));
  xboxInvites.on('change',()=>gameGuide.publish('invites',currentXboxInvites));
  nativeSocialResets.push(()=>gameGuide.reset());
  nativeSocialSnapshots.push(()=>{gameGuide.publish('auth',guideAuth());gameGuide.publish('language',store.settings.interfaceLanguage);gameGuide.publish('runtimeInvites',combinedInviteState(gameInviteBridges.values()));});
  nativeSocialShutdown.push(async()=>{await overlayShortcut?.shutdown();await gameGuide.shutdown();});
  if(!demoMode){
   overlayShortcut=new XboxOverlayShortcut(globalShortcut,()=>gameGuide.toggle(),emitSnapshot,{prepare:async()=>{
    await checkGuideHost(guideHelper);
    if(app.isPackaged&&process.env.APPIMAGE)await ensureOverlayDesktopEntry(process.env.APPIMAGE);
   }});
   await overlayShortcut.configure(store.settings);
  }
  // No external toggle socket or compositor scripts are installed automatically.
  if (startupRequest.gameId) {
    await prepareSystemWallet();
    await refreshAccount(false);
    // Only now: the account refresh resets the party, whose idle event would
    // otherwise end a shortcut session before its launch is registered.
    launchReady = true;
    receiveLaunchRequest(startupRequest.gameId);
  } else {
    launchReady = true;
    await showBeforeAccountCheck(showLauncher, refreshInitialAccount, () => {
      if (shutdownStarted || authState.running || authState.lastResult === 'success') return;
      authState = { ...authState, note: 'Account status is unavailable. Check the system keyring in Settings, then refresh.' };
      emitSnapshot();
    });
  }
  for (const id of pendingRequests.splice(0)) receiveLaunchRequest(id);
  for (const error of pendingShortcutErrors.splice(0)) void shortcutError(error);
  app.on('activate', () => { void showLauncher(); });
}).catch((error) => {
  console.error(error);
  if (startupRequest.gameId && primaryInstance) dialog.showErrorBox(nativeText('Unable to start Nexus'), error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !shortcutOnly) app.quit();
});

app.on('will-quit', () => {gameDisplay.stop();});

app.on('before-quit', (event) => {
  launcherTray.quit();
  connectivity?.stop();
  xboxSocial.close();
  walletUnlocker.cancel();
  installQueue.stop();
  installQueue.stop();
  accountLibrary.reset();
  accountProfile?.cancel();
  accountRefresh.invalidate();
  if (shutdownStarted || (!xboxNativeSocial && nativeSocialShutdown.length===0 && !xboxSocial.busy && !walletUnlocker.busy && !backendDiagnostics?.pendingWrites && !authJob && !preparingInstall && downloadCancellations.size === 0 && installQueue.size === 0 && operations.size === 0 && serviceSessions.size === 0 && gameInviteBridges.size === 0 && !checkingGameUpdates && !launcherUpdater?.state.updating)) return;
  event.preventDefault();
  shutdownStarted = true;
  void (async () => {
    await Promise.allSettled(nativeSocialShutdown.map(stop=>stop()));
    resetNativeSocial();
    await xboxSocial.settled();
    await walletUnlocker.stop();
    gameUpdateController?.abort();
    await gameUpdateJob?.catch(() => {});
    launcherUpdater?.cancel();
    // Let the atomic replacement transaction finish or safely fail before exit.
    while (launcherUpdater?.state.updating) await new Promise(resolve => setTimeout(resolve, 100));
    // Persist queue ownership before terminating downloads. Partial files are
    // restored only from the backend's validated durable checkpoints next time.
    for (const [id] of operations) {
      const task = store.downloads.find(entry => entry.id === id);
      if (task && backend.current.capabilities.streamingControls) Object.assign(task, {
        status: 'paused', canPause: true, controlPending: false, transferRate: undefined,
        phase: 'Paused — resume to restore saved download checkpoints',
      });
    }
    await store.save();
    for (const [id, child] of operations) if (!gameProcesses.has(id)) child.kill('SIGINT');
    await Promise.allSettled([...downloadCancellations.values()]);
    await authJob?.catch(() => {});
    const runningGames = [...gameProcesses.values()];
    await Promise.all(runningGames.map((process) => process.stop().catch((error) => console.error('Could not stop game on exit:', error))));
    await Promise.race([
      Promise.all(runningGames.map((process) => process.result.catch(() => undefined))),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
    await Promise.all([...gameProcesses.values()].map((process) => process.forceStop().catch((error) => console.error('Could not force-stop game on exit:', error))));
    await Promise.all([...gameInviteBridges.values()].map(bridge=>bridge.stop().catch(()=>{})));
    await Promise.all([...serviceSessions.values()].map((session) => session.stop().catch((error) => console.error('Account service cleanup failed on exit:', error))));
  })().catch((error) => console.error('Launcher shutdown cleanup failed:', error)).finally(async () => {
    await backendDiagnostics?.flush();
    app.quit();
  });
});
