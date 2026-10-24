import { contextBridge, ipcRenderer } from 'electron';
import type { Game, InstallRequest, LauncherApi, Settings } from '../shared/types.js';

// Demo fixtures live in the main process (src/shared/demo-data.ts) and are
// served over these same IPC channels when XODUS_DEMO=1, so the sandboxed
// preload stays a thin passthrough. Store pages always use the live
// Microsoft Store catalog. No real credentials, tokens or account data.
const api: LauncherApi = {
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  refreshBackend: () => ipcRenderer.invoke('backend-refresh'),
  checkBackendUpdate: () => ipcRenderer.invoke('backend-check-update'),
  updateBackend: () => ipcRenderer.invoke('backend-update'),
  rebuildBackend: () => ipcRenderer.invoke('backend-rebuild'),
  refreshRuntime: () => ipcRenderer.invoke('runtime-refresh'),
  checkRuntimeUpdate: () => ipcRenderer.invoke('runtime-check-update'),
  checkNexusRuntime: () => ipcRenderer.invoke('runtime-check-nexus'),
  installRuntime: () => ipcRenderer.invoke('runtime-install'),
  installNexusRuntime: () => ipcRenderer.invoke('runtime-install-nexus'),
  rollbackRuntimePreview: () => ipcRenderer.invoke('runtime-rollback-preview'),
  refreshAccount: () => ipcRenderer.invoke('account-refresh'),
  checkKeyring: () => ipcRenderer.invoke('keyring-check'),
  startKeyring: () => ipcRenderer.invoke('keyring-start'),
  createKeyringCollection: () => ipcRenderer.invoke('keyring-create'),
  onKeyringStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status);
    ipcRenderer.on('keyring-state', listener);
    return () => ipcRenderer.removeListener('keyring-state', listener);
  },
  checkLauncherUpdate: () => ipcRenderer.invoke('check-launcher-update'),
  installLauncherUpdate: () => ipcRenderer.invoke('install-launcher-update'),
  restartLauncher: () => ipcRenderer.invoke('restart-launcher'),
  rollbackLauncherUpdate: () => ipcRenderer.invoke('rollback-launcher-update'),
  checkGameUpdates: (id?: string) => ipcRenderer.invoke('check-game-updates', id),
  readDiagnosticLog: (id: string) => ipcRenderer.invoke('read-diagnostic-log', id),
  copyDiagnosticLog: (id: string) => ipcRenderer.invoke('copy-diagnostic-log', id),
  revealDiagnosticLog: (id: string) => ipcRenderer.invoke('reveal-diagnostic-log', id),
  readBackendDiagnosticLog: () => ipcRenderer.invoke('read-backend-diagnostic-log'),
  createDiagnosticReport: gameId => ipcRenderer.invoke('create-diagnostic-report', gameId),
  saveDiagnosticReport: content => ipcRenderer.invoke('save-diagnostic-report', content),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  offlinePermissions: () => ipcRenderer.invoke('offline-permissions'),
  setOfflinePermissions: (enabled: boolean) => ipcRenderer.invoke('set-offline-permissions', enabled),
  searchCatalog: (query: string, cursor?: string) => ipcRenderer.invoke('catalog-search', query, cursor),
  getFeaturedCatalog: () => ipcRenderer.invoke('catalog-featured'),
  getAccountLibrary: (kind, cursor, refresh) => ipcRenderer.invoke('account-library', kind, cursor, refresh),
  startInstall: (request: InstallRequest) => ipcRenderer.invoke('start-install', request),
  getInstallPlan: (productId: string) => ipcRenderer.invoke('install-plan', productId),
  getGameContent: id => ipcRenderer.invoke('game-content', id),
  installGameContent: (id, productId) => ipcRenderer.invoke('install-game-content', id, productId),
  updateInstalledGame: (id: string) => ipcRenderer.invoke('update-installed-game', id),
  getDownloadCancelOptions: (id: string) => ipcRenderer.invoke('download-cancel-options', id),
  cancelDownload: (id: string, mode?: 'keep' | 'delete-files') => ipcRenderer.invoke('cancel-download', id, mode),
  pauseDownload: (id: string) => ipcRenderer.invoke('pause-download', id),
  resumeDownload: (id: string) => ipcRenderer.invoke('resume-download', id),
  removeDownload: (id: string) => ipcRenderer.invoke('remove-download', id),
  clearFinishedDownloads: () => ipcRenderer.invoke('clear-finished-downloads'),
  importGame: (path?: string) => ipcRenderer.invoke('import-game', path),
  updateGame: (id: string, patch: Partial<Pick<Game, 'title' | 'executable' | 'launchArgs' | 'locale' | 'launchTools'>>) => ipcRenderer.invoke('update-game', id, patch),
  getGameLocales: (id: string) => ipcRenderer.invoke('game-locales', id),
  removeGame: (id: string, mode: 'library' | 'delete-files') => ipcRenderer.invoke('remove-game', id, mode),
  getGameLaunchOptions: (id: string) => ipcRenderer.invoke('game-launch-options', id),
  getGameDetails: (id: string) => ipcRenderer.invoke('game-details', id),
  getGameActivity: (id: string, refresh?: boolean) => ipcRenderer.invoke('game-activity', id, refresh),
  getGameAchievements: (id: string, refresh?: boolean) => ipcRenderer.invoke('game-achievements', id, refresh),
  launchGame: (id: string) => ipcRenderer.invoke('launch-game', id),
  createGameShortcut: (id, destination) => ipcRenderer.invoke('create-game-shortcut', id, destination),
  addToSteam: id => ipcRenderer.invoke('add-to-steam', id),
  installGameVcRuntime: (id: string) => ipcRenderer.invoke('install-game-vc-runtime', id),
  cancelGame: () => ipcRenderer.invoke('cancel-game'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('update-settings', patch),
  chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke('choose-directory', defaultPath),
  chooseFile: (defaultPath?: string) => ipcRenderer.invoke('choose-file', defaultPath),
  openPath: (target: string) => ipcRenderer.invoke('open-path', target),
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value);
    ipcRenderer.on('snapshot', listener);
    return () => ipcRenderer.removeListener('snapshot', listener);
  },
  onOperationLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof callback>[0]) => callback(value);
    ipcRenderer.on('operation-log', listener);
    return () => ipcRenderer.removeListener('operation-log', listener);
  },
  isDemoTour: () => process.env.XODUS_DEMO_TOUR === '1' && !process.env.XODUS_DEMO_CAPTURE_DIR,
};

contextBridge.exposeInMainWorld('launcher', api);
