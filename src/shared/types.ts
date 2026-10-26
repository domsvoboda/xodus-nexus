export type Page = 'home' | 'store' | 'library' | 'downloads' | 'settings';

export interface BackendCapabilities {
  commands: string[];
  account: boolean;
  profile?: boolean;
  gameActivity?: boolean;
  achievements?: boolean;
  library?: boolean;
  login: boolean;
  externalAuth?: boolean;
  logout: boolean;
  download: boolean;
  streaming: boolean;
  streamingProgressJson?: boolean;
  /** `run --license-cache` and `offline-pc --license-cache`: device-bound offline
   * licenses that the backend validates against their lease on every load and
   * removes on every known revocation. Older caches are never handed a path. */
  licenseCache?: boolean;
  /** `offline-pc`: show or change the account's designated offline PC. */
  offlinePc?: boolean;
  /** `run --offline`: skip Microsoft entirely and launch on the stored offline license. */
  offlineLaunch?: boolean;
  /** `run --materialize-all --view-dir`: a full private launch view that needs no Wine file maps. */
  fullView?: boolean;
  /** `run --playfab-adapter`: stages the PlayFab Game Saves adapter in a full launch view. */
  playfabAdapter?: boolean;
  streamingControls?: boolean;
  streamingBandwidthLimit?: boolean;
  packageSelection?: boolean;
  contentPackageSelection?: boolean;
  run: boolean;
  version?: string;
}

export interface AuthStatus {
  running: boolean;
  stored: boolean | null;
  username?: string;
  gamertag?: string;
  avatarDataUrl?: string;
  subscription?: GamePassSubscription;
  lastResult?: 'success' | 'failed';
  lastAction?: 'login' | 'logout';
  note: string;
}

export interface GamePassSubscription {
  status: 'active' | 'none' | 'unknown';
  productIds: string[];
  checkedAt: string;
}

export interface BackendStatus {
  available: boolean;
  source: 'external' | 'managed' | 'none';
  binaryPath?: string;
  commit?: string;
  upstreamCommit?: string;
  updateAvailable: boolean;
  checking: boolean;
  updating: boolean;
  externalRoot: string;
  capabilities: BackendCapabilities;
  prerequisites: { git: boolean; cargo: boolean; rustc: boolean; protoc: boolean };
  blockReason?: string;
  linuxRunPatch?: string;
  version?: string;
  delivery?: 'release' | 'local';
  releaseAvailable?: boolean;
  releaseVersion?: string;
  phase?: string;
}

export interface RuntimeStatus {
  installed: boolean;
  checking: boolean;
  updating: boolean;
  runtimeRoot: string;
  name?: string;
  winePath?: string;
  commit?: string;
  upstreamCommit?: string;
  artifactName?: string;
  artifactExpiresAt?: string;
  artifactAvailable: boolean;
  // Prebuilt runtime with the Nexus xgameruntime patches, published on the
  // Xodus Nexus GitHub releases. Preferred over the official snapshot.
  nexusAvailable?: boolean;
  nexusName?: string;
  nexusVersion?: string;
  nexusChecking?: boolean;
  nexusError?: string;
  prerequisites: { gh: boolean; authenticated: boolean; tar: boolean; sha512sum: boolean };
  phase?: string;
  error?: string;
}

export interface GameLaunchTools {
  dualSenseCompatibility?: boolean;
  mangoHud: boolean;
  gamescope: boolean;
  gamescopeArgs: string;
  launchOptions: string;
}

export interface Game {
  id: string;
  title: string;
  path: string;
  storeId?: string;
  offerProductId?: string; // Requested Store edition, not a license or replacement for the base identity.
  publisher?: string;
  installedVersion?: string;
  packageName?: string;
  executable?: string;
  winePath?: string; // Legacy saved field; ignored for launch. The runtime is global.
  launchArgs?: string;
  launchTools?: GameLaunchTools;
  locale?: string;
  coverDataUrl?: string;
  coverUrl?: string; // Store box art, preferred over the installation's small logo.
  heroUrl?: string; // Wide Store artwork for the game detail panel.
  installState: 'ready' | 'incomplete' | 'imported';
  installMessage?: string;
  vcRedistEncrypted?: boolean;
  antiCheat?: {
    provider: 'Easy Anti-Cheat';
    executable?: string;
    encryptedTarget: boolean;
  };
  addedAt: string;
}

export interface GameLaunchOptions {
  cloudSaves: boolean;
  cloudReason?: string;
  vcInstall: boolean;
  vcReason?: string;
}

export interface DownloadTask {
  id: string;
  kind?: 'install' | 'update' | 'content';
  gameId?: string;
  title: string;
  productId: string;
  selectedContentId?: string;
  selectionMarket?: string;
  destination: string;
  status: 'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled';
  canPause?: boolean;
  controlPending?: boolean;
  cancelling?: boolean;
  progress: number | null;
  downloadedBytes?: number;
  totalBytes?: number;
  transferRate?: string;
  coverUrl?: string; // Store box art for the queued product, for the queue list.
  phase: string;
  log: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface DownloadCancelOptions { deleteFilesAllowed: boolean; reason?: string }

export interface GameOperation {
  id: string;
  gameId: string;
  title: string;
  kind?: 'launch' | 'prerequisite';
  status: 'preparing' | 'running' | 'stopping' | 'complete' | 'failed';
  phase: string;
  log: string[];
  logPath?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface Settings {
  interfaceLanguage?: string;
  installRoot: string;
  market: string;
  parallelDownloads: number;
  downloadLimitMiB?: number;
  shaderCacheLimitGiB?: number;
  winePath: string;
  externalXodusRoot: string;
  runtimeRoot: string;
  verboseLogs: boolean;
  firstRunCompleted?: boolean;
  /** Run the game daemon as a systemd user service so Steam shortcuts start fast and saves finish syncing. */
  backgroundDaemon?: boolean;
}

export interface LauncherUpdate {
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checking: boolean;
  checkedAt?: string;
  updating?: boolean;
  progress?: number;
  phase?: string;
  error?: string;
  canInstall?: boolean;
  restartRequired?: boolean;
  canRollback?: boolean;
}

export interface GameUpdate {
  checking: boolean;
  available?: boolean;
  latestVersion?: string;
  checkedAt?: string;
  error?: string;
}

export interface DiagnosticLog { name: string; content: string; truncated: boolean }
export interface DiagnosticReport { name: string; content: string }

export interface KeyringStatus {
  canCreate?: boolean;
  canUnlock?: boolean;
  state: 'ready' | 'locked' | 'stopped' | 'disabled' | 'missing' | 'needs-setup' | 'unavailable';
  gameMode: boolean;
  canStart: boolean;
  message: string;
}

/** The Xbox app's "Offline permissions" setting for this device, as Microsoft reports it. */
export interface OfflinePermissions {
  enabled: boolean;
  /** For a change: whether Microsoft applied it. */
  requestSuccess: boolean;
  remainingToggles?: number;
  maxToggles?: number;
  periodDays?: number;
  /** When the next change becomes possible once none remain. */
  nextChangeAt?: string;
  checkedAt: string;
}

/** Reachability of Microsoft's sign-in hosts, probed by the launcher. */
export interface ConnectivityStatus {
  state: 'online' | 'offline' | 'unknown';
  checkedAt?: string;
  /** Why the launcher considers Microsoft unreachable. */
  reason?: string;
}

export interface AppSnapshot {
  social?: import('./game-invites.js').GameInviteState;
  backend: BackendStatus;
  runtime: RuntimeStatus;
  connectivity?: ConnectivityStatus;
  games: Game[];
  downloads: DownloadTask[];
  settings: Settings;
  auth: AuthStatus;
  launcherUpdate?: LauncherUpdate;
  gameOperation?: GameOperation;
  gameUpdates?: Record<string, GameUpdate>;
  downloadProgressSupported?: boolean;
  daemon?: DaemonStatus;
}

export interface DaemonStatus {
  /** systemd user units can be written on this system. */
  supported: boolean;
  installed: boolean;
  /** The launcher is talking to the daemon right now. */
  connected?: boolean;
  /** The daemon keeps a signed-in account service ready. */
  warm?: boolean;
  reason?: string;
  error?: string;
}

export interface InstallRequest {
  productId: string;
  title: string;
  destination: string;
  selectedContentId?: string;
  selectionMarket?: string;
}

export interface InstallChoice {
  productId: string;
  contentId: string;
  title: string;
  platform: string;
  packageFormat: string;
  kind: string;
  supported: boolean;
  parentProductId?: string;
  mainPackageFamilyName?: string;
  downloadBytes?: number;
  installBytes?: number;
}

export interface InstallPlan {
  schema: 1;
  rootProductId: string;
  market: string;
  status: 'ready' | 'choice' | 'unavailable';
  choices: InstallChoice[];
  availableBytes?: number;
}

export interface GameContentItem {
  productId: string;
  title: string;
  access?: LibraryAccess;
  status: 'installed' | 'available' | 'verify' | 'unlicensed' | 'unsupported' | 'bundle' | 'license-only';
  downloadBytes?: number;
  note: string;
}

export interface GameContentPlan {
  gameId: string;
  checkedAt: string;
  runtimeSupported?: boolean;
  items: GameContentItem[];
}

export interface CatalogProduct {
  productId: string;
  installProductId?: string;
  title: string;
  description: string;
  publisher?: string;
  posterUrl?: string;
  heroUrl?: string;
  storeUrl?: string;
  categories: string[];
  purchasePrice?: string;
  includedWith?: string;
  releaseDate?: string;
  averageRating?: number;
  installability: 'supported' | 'unsupported' | 'unknown';
  packageFormat?: string;
  supportNote: string;
}

/** Public catalog data only, never an ownership/installation decision. */
export interface GameStoreDetails {
  productId: string;
  title: string;
  description: string;
  publisher?: string;
  heroUrl?: string;
  categories: string[];
  screenshots: string[];
  releaseDate?: string;
}

export interface GameActivity {
  status: 'available' | 'unavailable' | 'unsupported' | 'signed-out' | 'error';
  minutesPlayed?: number;
  lastPlayed?: string;
  partial?: boolean;
}

export interface GameAchievement {
  id: string;
  name: string;
  description: string;
  state: 'unlocked' | 'in-progress' | 'locked';
  secret: boolean;
  revoked: boolean;
  gamerscore?: number;
  iconUrl?: string;
  unlockedAt?: string;
  progress?: number;
}

export interface GameAchievements {
  status: 'available' | 'unavailable' | 'unsupported' | 'signed-out' | 'error';
  items?: GameAchievement[];
  partial?: boolean;
}

export interface CatalogSearchResult {
  query: string;
  market: string;
  products: CatalogProduct[];
  cursor?: string;
  hasMore: boolean;
  fetchedAt: string;
  source: 'Microsoft Store';
}

export type LibraryAccess = 'owned' | 'gamepass' | 'other';
export interface AccountLibraryPage {
  kind: 'all' | LibraryAccess;
  sort?: 'recent-gamepass';
  recentProductIds?: string[];
  products: (CatalogProduct & { access: LibraryAccess })[];
  accessByProductId: Record<string, LibraryAccess>;
  unclassifiedEntitlements?: number;
  excludedEntitlements?: number;
  cursor?: string;
  checkedAt: string;
  skippedEntitlements?: number;
}

export interface LauncherApi {
  inviteXboxFriend(gameId:string,xuid:string):Promise<void>;
  chooseGameInviteRecipient(id: string, xuid: string): Promise<void>;
  cancelGameInvite(id: string): Promise<void>;
  acceptGameInvite(id: string): Promise<void>;
  onOpenFriends(callback: () => void): () => void;
  getXboxFriends(): Promise<import('./social.js').XboxFriend[]>;
  getXboxConversation(xuid: string): Promise<import('./social.js').XboxConversation>;
  sendXboxMessage(xuid: string, text: string): Promise<import('./social.js').XboxMessageReceipt>;
  closeXboxSocial(): Promise<void>;
  getSnapshot(): Promise<AppSnapshot>;
  refreshBackend(): Promise<BackendStatus>;
  checkBackendUpdate(): Promise<BackendStatus>;
  updateBackend(): Promise<void>;
  rebuildBackend(): Promise<void>;
  refreshRuntime(): Promise<RuntimeStatus>;
  checkRuntimeUpdate(): Promise<RuntimeStatus>;
  checkNexusRuntime(): Promise<RuntimeStatus>;
  installRuntime(): Promise<void>;
  installNexusRuntime(): Promise<void>;
  rollbackRuntimePreview(): Promise<void>;
  refreshAccount(): Promise<AuthStatus>;
  checkKeyring(): Promise<KeyringStatus>;
  startKeyring(): Promise<KeyringStatus>;
  createKeyringCollection(): Promise<KeyringStatus>;
  onKeyringStatus(callback: (status: KeyringStatus) => void): () => void;
  checkLauncherUpdate(): Promise<LauncherUpdate | undefined>;
  installLauncherUpdate(): Promise<void>;
  restartLauncher(): Promise<void>;
  rollbackLauncherUpdate(): Promise<void>;
  checkGameUpdates(id?: string): Promise<void>;
  readDiagnosticLog(operationId: string): Promise<DiagnosticLog>;
  copyDiagnosticLog(operationId: string): Promise<void>;
  revealDiagnosticLog(operationId: string): Promise<void>;
  readBackendDiagnosticLog(): Promise<DiagnosticLog>;
  createDiagnosticReport(gameId?: string): Promise<DiagnosticReport>;
  saveDiagnosticReport(content: string): Promise<boolean>;
  login(): Promise<void>;
  logout(): Promise<void>;
  offlinePermissions(): Promise<OfflinePermissions>;
  setOfflinePermissions(enabled: boolean): Promise<OfflinePermissions>;
  searchCatalog(query: string, cursor?: string): Promise<CatalogSearchResult>;
  getFeaturedCatalog(): Promise<CatalogSearchResult>;
  getAccountLibrary(kind: AccountLibraryPage['kind'], cursor?: string, refresh?: boolean, sort?: AccountLibraryPage['sort']): Promise<AccountLibraryPage>;
  startInstall(request: InstallRequest): Promise<string>;
  getInstallPlan(productId: string, destination?: string): Promise<InstallPlan>;
  getGameContent(id: string): Promise<GameContentPlan>;
  installGameContent(id: string, productId: string): Promise<string>;
  updateInstalledGame(id: string): Promise<string>;
  getDownloadCancelOptions(id: string): Promise<DownloadCancelOptions>;
  cancelDownload(id: string, mode?: 'keep' | 'delete-files'): Promise<void>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  removeDownload(id: string): Promise<void>;
  clearFinishedDownloads(): Promise<void>;
  importGame(path?: string): Promise<Game | null>;
  updateGame(id: string, patch: Partial<Pick<Game, 'title' | 'executable' | 'launchArgs' | 'locale' | 'launchTools'>>): Promise<Game>;
  getGameLocales(id: string): Promise<string[]>;
  removeGame(id: string, mode: 'library' | 'delete-files'): Promise<void>;
  getGameLaunchOptions(id: string): Promise<GameLaunchOptions>;
  getGameDetails(id: string): Promise<GameStoreDetails | undefined>;
  getGameActivity(id: string, refresh?: boolean): Promise<GameActivity>;
  getGameAchievements(id: string, refresh?: boolean): Promise<GameAchievements>;
  launchGame(id: string): Promise<void>;
  createGameShortcut(id: string, destination: 'desktop' | 'applications'): Promise<string>;
  addToSteam(id?: string): Promise<string>;
  installGameVcRuntime(id: string): Promise<void>;
  cancelGame(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  chooseDirectory(defaultPath?: string): Promise<string | null>;
  chooseFile(defaultPath?: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
  onOperationLog(callback: (entry: { scope: string; line: string }) => void): () => void;
  isDemoTour(): boolean;
}
