import {useComponentUpdates} from './ComponentUpdates';
import {ManagedRuntimeSettings} from './ManagedRuntimeSettings';
import {StatusDot} from './StatusDot';
import {useGameRuntimeReady} from './useGameRuntimeReady';
import {useStoreAccess} from './store-access';
import {GameRuntimeFields} from './GameRuntimeFields';
import {runtimeFamilyLabels,type InstalledRuntimeFamily,type GameRuntimeSelection} from '../shared/runtime-selection';
import { CloudSaveWarning } from './CloudSaveWarning';
import { CheckField } from './CheckField';
import { useDialogFocus } from './use-dialog-focus';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine, Check, ChevronRight, CircleAlert, CircleUserRound,
  Clock3, Cog, Download, FolderOpen, Gamepad2, HardDrive, Home, Library,
  LoaderCircle, LogIn, MoreHorizontal, PackageCheck, Pause, Play, Plus, RefreshCw, Rocket, Search, Settings2,
  Store, Terminal, Trash2, Copy, PanelLeft, X,
} from 'lucide-react';
import type { AccountLibraryPage, AppSnapshot, CatalogProduct, CatalogSearchResult, DiagnosticLog, Game, GameContentPlan, GameLaunchOptions, Page, Settings, XboxProfileRequest } from '../shared/types';
import {OverlayShortcutRecorder} from './OverlayShortcutRecorder';
import {reconcileSettingsDraft, storageSettingsPatch} from './settings-draft';
import {xboxOverlaySettings} from '../shared/xbox-overlay-settings';
import './xbox-desktop-social.css';
import { estimateTimeRemaining, isNewerVersion } from '../shared/utils';
import { subscriptionBadge } from '../shared/subscription';
import { defaultLaunchTools, normalizeLaunchTools } from '../shared/launch-tools';
import { DEFAULT_SHADER_CACHE_GIB, shaderCacheLimits } from '../shared/shader-cache';
import type { GameLaunchTools } from '../shared/types';
import { catalogInstallRequest, PackageInstallProvider, usePackageInstall } from './PackageInstall';
import { defaultLibraryFilters, loadLibraryFilters, saveLibraryFilters, libraryProductMatchesPlayState, rankLibraryRows, type LibraryFilters } from './library-preferences';
import { InstallQueueShortcut } from './InstallQueueShortcut';
import { GamepadNavigation } from './GamepadNavigation';
import { requestTextKeyboard } from './touch-keyboard';
import { ConfirmationProvider, useConfirmation } from './Confirmation';
import { GameRemovalContents } from './GameRemovalContents';
import { GameDetails } from './GameDetails';
import { CatalogGameDetails,catalogGameInstalled,publicStorePrice } from './CatalogGameDetails';
import { appendStoreProducts, storePageState, storeRequested, type StoreListPage } from './store-pagination';
import {HomeGamePassSection,useRecentGamePassShelf} from './HomeGamePass';
import {recentlyInstalledGames} from './home-shelves';
import { GameLanguage } from './GameLanguage';
import { DownloadCancelDialog } from './DownloadCancelDialog';
import { OfflinePermissionsCard } from './OfflinePermissions';
import { KeyringSetup } from './KeyringSetup';
import { DiagnosticReportButton } from './DiagnosticReport';
import { NotificationBell, useNotifications } from './Notifications';

import { ui, uiText, i18n, interfaceLanguages, useInterfaceLanguage } from './i18n';
import { localizedTimeRemaining } from './localized-time';
import type { DownloadCancelOptions } from '../shared/types';
export type { LibraryFilters } from './library-preferences';

const XboxSocial = lazy(() => import('./XboxSocial').then(module => ({ default: module.XboxSocial })));

function SocialLoading({close}:{close?:()=>void}) {
  return <div>
    {close?<button data-gamepad-social-close data-gamepad-cancel onClick={close} aria-label={ui("social.close_xbox_social_d9a718")}><X/></button>:null}
    <div role="status"><LoaderCircle className="spin" aria-label={ui("ui.loading_xodus_nexus_2e92cfd")}/></div>
  </div>;
}

const emptySnapshot: AppSnapshot = {
  backend: {
    available: false, source: 'none', updateAvailable: false, checking: false, updating: false,
    externalRoot: '',
    capabilities: { commands: [], account: false, login: false, logout: false, download: false, streaming: false, run: false },
  },
  runtime: {
    installed: false, checking: false, updating: false,
    runtimeRoot: '', artifactAvailable: false,
    prerequisites: { gh: false, authenticated: false, tar: false, sha512sum: false },
  },
  games: [], downloads: [],
  settings: {
    installRoot: '', market: 'neutral', parallelDownloads: 4, winePath: '',
    externalXodusRoot: '', runtimeRoot: '', verboseLogs: false,
  },
  auth: { running: false, stored: null, note: '' },
};

type Toast = { kind: 'success' | 'error' | 'info'; message: string };
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
/** React 18 has no `inert` prop, so apply it through a ref. */
const inertRef = (inert: boolean) => (element: HTMLElement | null) => { if (element) element.inert = inert; };
/** A newly opened detail starts on Play, or on Back when Play is unavailable. */
function focusDetailEntry(root: HTMLElement | null) {
  (root?.querySelector<HTMLElement>('[data-gamepad-play]:not(:disabled)') ?? root?.querySelector<HTMLElement>('[data-gamepad-detail-back]'))?.focus({ preventScroll: true });
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
}

export function GameTitle({ title }: { title: string }) {
  return <strong title={title}>{title}</strong>;
}

function NavItem({ active, icon, label, badge, onClick, autoSelect = false }: {
  active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void; autoSelect?: boolean;
}) {
  return <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} data-gamepad-auto-select={autoSelect ? '' : undefined} onClick={onClick}>
    {icon}<span>{label}</span>{badge ? <b>{badge}</b> : null}
  </button>;
}

export function Sidebar({ data, page, go, openGame, openProfile, notifications, inert = false }: { data: AppSnapshot; page: Page; go: (page: Page) => void; openGame?: (id: string) => void; openProfile?: () => void; notifications?: React.ReactNode; inert?: boolean }) {
  const account = data.auth.gamertag ?? data.auth.player ?? data.auth.username ?? (data.auth.stored === true ? ui("ui.microsoft_account_6c2b1f2") : ui("ui.sign_in_bfd402b"));
  return <aside className="sidebar" ref={inertRef(inert)}>
    <div className="account-header" data-gamepad-action-row><button className="account-summary" aria-label={account} onClick={() => openProfile ? openProfile() : go('settings')}><AccountAvatar auth={data.auth} /><span><strong>{account}</strong><AccountMembership auth={data.auth} /></span></button>{notifications}</div>
    <nav><NavItem autoSelect active={page === 'home'} icon={<Home />} label={ui("ui.home_3a78695")} onClick={() => go('home')} /><NavItem autoSelect active={page === 'library'} icon={<Library />} label={ui("ui.my_library_d931dba")} onClick={() => go('library')} /><NavItem autoSelect active={page === 'store'} icon={<Store />} label={ui("ui.store_ee7da93")} onClick={() => go('store')} /></nav>
    {data.games.length > 0 ? <div className="recents"><span>{ui("ui.most_recent_7459b86")}</span>{data.games.slice(0, 5).map(game => <button key={game.id} onClick={() => openGame ? openGame(game.id) : go('library')}><Cover game={game} /><GameTitle title={game.title} /></button>)}</div> : null}
    <div className="sidebar-bottom"><NavItem active={page === 'settings'} icon={<Cog />} label={ui("ui.settings_74a883a")} onClick={() => go('settings')} /><InstallQueueShortcut downloads={data.downloads} games={data.games} active={page === 'downloads'} openQueue={() => go('downloads')} /></div>
  </aside>;
}

function AccountMembership({ auth }: { auth: AppSnapshot['auth'] }) {
  const label = auth.stored === true ? subscriptionBadge(auth.subscription) : undefined;
  if (label) return <small className="account-membership" title={ui("ui.subscription_verified_a950738", { date: new Date(auth.subscription!.checkedAt).toLocaleString() })}>{label}</small>;
  return auth.stored === true ? null : <small>{auth.stored === false ? (auth.player ? ui("auth.store_signed_out") : ui("ui.not_signed_in_491fc91")) : ui("ui.status_unavailable_7eb5af9")}</small>;
}

function AccountAvatar({ auth, large = false, license = false }: { auth: AppSnapshot['auth']; large?: boolean; license?: boolean }) {
  const picture = license ? auth.licenseAvatarDataUrl : auth.avatarDataUrl;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [picture]);
  return <div className={`account-avatar${large ? ' large' : ''}`}>
    {picture && !failed ? <img src={picture} alt={ui("ui.xbox_profile_picture_f6ca315")} onError={() => setFailed(true)} /> : <CircleUserRound />}
  </div>;
}

/** The top bar only carries a real component-update (or restart) action. A
 * permanent readied/offline badge and a second global Settings shortcut would
 * duplicate the sidebar and the existing Settings, Home and launch surfaces.
 * Discovery only reads authoritative snapshot fields here: a managed family is
 * an update only when it is installed and its verified candidate differs, and
 * an uninstalled optional family is never advertised or checked on render. */
export function TopStatus({ data, go, openFriends }: { data: AppSnapshot; go: (page: Page) => void; openFriends?: () => void }) {
  const restart = data.launcherUpdate?.restartRequired;
  // Only managed family receipts are runtime updates. The legacy global
  // runtime is never advertised as a second, hidden family selector.
  const managed = (data.runtime.managedFamilies ?? []).filter(family =>
    Boolean(family.installed) && Boolean(family.available) && family.updateAvailable === true);
  const runtimeUpdates = new Map<string, string>();
  for (const family of managed) {
    const candidate = family.available;
    if (!candidate || runtimeUpdates.has(family.id)) continue;
    const version = candidate.version.replace(/^runtime-/, '').replace(/^cachyos-/, '');
    runtimeUpdates.set(family.id, ui('home.runtime_update', { version: `${runtimeFamilyLabels[family.id]} ${version}` }).trim());
  }
  const latest = data.launcherUpdate?.latestVersion;
  const updates = [
    latest && !restart && isNewerVersion(latest, data.launcherUpdate?.currentVersion ?? '') ? ui("ui.launcher_ba8971d", { version: latest }) : '',
    data.backend.releaseAvailable && data.backend.updateAvailable ? ui("ui.backend_35f8dc4", { version: data.backend.releaseVersion ?? '' }).trim() : '',
    ...runtimeUpdates.values(),
  ].filter(Boolean);
  const updateTitle = [restart ? ui('home.restart_update') : '', updates.length ? ui('home.available_updates', { updates: updates.join(', ') }) : ''].filter(Boolean).join(' ');
  if (!restart && !updates.length) return null;
  return <div className="top-status">
    <button className="update-notice" title={updateTitle} aria-label={updateTitle} onClick={() => go('settings')}><ArrowDownToLine /><strong>{restart ? ui("ui.restart_available_cad1527") : ui("ui.update_available_ff8b555")}</strong></button>
  </div>;
}

export function DiagnosticDialog({ log, close, revealFile, copyLog }: { log: DiagnosticLog; close: () => void; revealFile?: () => Promise<void>; copyLog?: () => Promise<void> }) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, close);
  const [copyStatus, setCopyStatus] = useState(ui("ui.copy_log_99d7297"));
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [fileError, setFileError] = useState(false);
  async function copy() {
    setCopying(true); setCopyError(''); setCopyStatus(ui("ui.copy_log_99d7297"));
    try {
      if (copyLog) await copyLog();
      else if (!log.truncated) await navigator.clipboard.writeText(log.content);
      else throw Error("The full log is no longer available.");
      setCopyStatus(ui("ui.copied_8d525e5"));
    } catch (error) {
      setCopyError(error instanceof Error && error.message.includes('too large for the clipboard')
        ? ui("ui.this_log_is_too_large_for_the_clipboard_use_show_97f6e93")
        : ui("ui.could_not_copy_the_complete_log_try_again_or_use_3195d2c"));
    } finally { setCopying(false); }
  }
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={dialogRef} className="game-dialog diagnostic-dialog" role="dialog" aria-modal="true" aria-label={ui("ui.diagnostic_log_c46c657")}><h2>{log.name}</h2><p>{ui("ui.private_diagnostic_log_review_before_sharing_22816a7")}{log.truncated ? ui("ui.preview_shows_the_most_recent_512_kib_copy_log_c_0e89f87") : ''}</p><pre>{log.content || ui("ui.the_log_is_empty_7261125")}</pre>{fileError ? <p role="alert">{ui("ui.the_log_file_is_no_longer_available_e454fa3")}</p> : null}{copyError ? <p role="alert">{copyError}</p> : null}<div className="dialog-actions">{revealFile ? <button className="secondary" onClick={() => { setFileError(false); void revealFile().catch(() => setFileError(true)); }}>{ui("ui.show_log_file_5ea7142")}</button> : null}<button className="secondary" disabled={copying} onClick={() => void copy()}>{copying ? ui("ui.copying_d250fad") : copyStatus}</button><button className="secondary" data-gamepad-cancel onClick={close}>{ui("ui.close_7d9eb7a")}</button></div></section></div>;
}

export function BackendLogButton({ toast }: { toast: (value: Toast) => void }) {
  const [log, setLog] = useState<DiagnosticLog>();
  const [loading, setLoading] = useState(false);
  return <>
    <button className="secondary" disabled={loading} onClick={async () => {
      setLoading(true);
      try { setLog(await window.launcher.readBackendDiagnosticLog()); }
      catch { toast({ kind: 'error', message: ui("ui.backend_diagnostics_could_not_be_opened_safely_8da774e") }); }
      finally { setLoading(false); }
    }}>{loading ? <LoaderCircle className="spin" /> : <Terminal />}{ui("ui.open_backend_diagnostic_log_deebd52")}</button>
    {log ? <DiagnosticDialog log={log} close={() => setLog(undefined)} /> : null}
  </>;
}

export function Cover({ game, className = '', variant = "cover" }: { game: Game; className?: string; variant?: 'cover' | 'hero' }) {
  const sources = [...new Set([variant === 'hero' ? game.heroUrl : undefined, game.coverUrl, game.coverDataUrl].filter((url): url is string => Boolean(url)))];
  const key = sources.join('\n');
  const [failure, setFailure] = useState({ key: '', index: 0 });
  const index = failure.key === key ? failure.index : 0;
  const art = sources[index];
  if (art) return <img className={`game-cover ${art === game.coverDataUrl ? 'cover-local' : 'cover-store'} ${className}`} src={art} alt={ui("ui.artwork_1bf7d06", { game: game.title })} onError={() => setFailure({ key, index: index + 1 })} />;
  return <div className={`cover-placeholder ${className}`}><Gamepad2 /></div>;
}

function StatePill({ game }: { game: Game }) {
  const label = game.installState === 'ready' ? ui("ui.ready_5fa7aac") : game.installState === 'incomplete' ? ui("ui.incomplete_75f33cd") : ui("ui.imported_321f179");
  return <span className={`state-pill ${game.installState}`}>
    {game.installState === 'ready' ? <Check /> : <CircleAlert />}{label}
  </span>;
}

function SectionTitle({ title, action, onClick }: { title: string; action?: string; onClick?: () => void }) {
  return <div className="section-title"><h2>{title}</h2>{action && onClick ? <button onClick={onClick}>{action}<ChevronRight /></button> : null}</div>;
}

function useGameLaunchOptions(game: Game | undefined, data: AppSnapshot): GameLaunchOptions | undefined {
  const [options, setOptions] = useState<GameLaunchOptions>();
  useEffect(() => {
    setOptions(undefined);
    if (!game) return;
    let cancelled = false;
    window.launcher.getGameLaunchOptions(game.id)
      .then((value) => { if (!cancelled) setOptions(value); })
      .catch((error) => { if (!cancelled) setOptions({ cloudSaves: false, cloudReason: errorMessage(error), vcInstall: false, vcReason: errorMessage(error) }); });
    return () => { cancelled = true; };
  }, [game?.id, game?.runtime, game?.runtimeSeparatePrefix, game?.runtimePrefixIdentity, game?.runtimeBuild?.buildId, game?.runtimeBuild?.manifestSha256, JSON.stringify(game?.runtimePrefixes), data.runtime.variants?.map(item=>item.id+':'+item.buildId).join(','), data.settings.winePath, data.settings.runtimeRoot, data.runtime.winePath, data.backend.binaryPath, data.backend.commit, data.backend.available]);
  return options;
}

export function HomePage({ data, go, action, openGame, returnFocusKey, toast }: {
  data: AppSnapshot; go: (page: Page) => void; action: (fn: () => Promise<unknown>, success?: string) => void; openGame?: (id: string, returnKey: string) => void; returnFocusKey?: string; toast?: (value: Toast) => void;
}) {
  const featured = data.games[0];
  const featuredRuntimeReady=useGameRuntimeReady(featured,data);
  const canPlay = Boolean(featured?.installState === 'ready' && data.backend.capabilities.run && featuredRuntimeReady);
  const launchOptions = useGameLaunchOptions(featured, data);
  const spotlightArt = featured?.heroUrl ?? featured?.coverUrl;
  const home = useRef<HTMLElement>(null);
  const initialFocusKey = useRef(returnFocusKey);
  const recentInstalled = recentlyInstalledGames(data.games, data.downloads);
  const gamePass = useRecentGamePassShelf();
  const [gamePassProduct, setGamePassProduct] = useState<CatalogProduct>();
  const [gamePassOpen, setGamePassOpen] = useState(false);
  const gamePassAccess = useStoreAccess(data, gamePassOpen);
  const homeScroll = useRef(0);
  const gamePassWasOpen = useRef(false);
  useBrowserLayoutEffect(() => {
    if (document.activeElement?.closest('.sidebar')) return;
    const returnTarget = [...home.current?.querySelectorAll<HTMLElement>('[data-gamepad-key]') ?? []].find(element => element.dataset.gamepadKey === initialFocusKey.current);
    (returnTarget ?? home.current?.querySelector<HTMLElement>('[data-gamepad-home-primary]'))?.focus({ preventScroll: true });
  }, []);
  useBrowserLayoutEffect(() => {
    const scroll = home.current?.closest('.page-scroll');
    if (gamePassOpen && gamePassProduct) {
      if (scroll) scroll.scrollTop = 0;
      focusDetailEntry(home.current);
    } else if (gamePassWasOpen.current) {
      if (scroll) scroll.scrollTop = homeScroll.current;
      [...home.current?.querySelectorAll<HTMLElement>('[data-gamepad-key]') ?? []]
        .find(element => element.dataset.gamepadKey === `home-gamepass:${gamePassProduct?.productId}`)?.focus({ preventScroll: true });
    }
    gamePassWasOpen.current = gamePassOpen && Boolean(gamePassProduct);
  }, [gamePassOpen, gamePassProduct?.productId]);

  function openGamePass(product: CatalogProduct) {
    homeScroll.current = home.current?.closest('.page-scroll')?.scrollTop ?? 0;
    setGamePassProduct(product);
    setGamePassOpen(true);
  }

  if (gamePassOpen && gamePassProduct) return <main ref={home} className="page home-page library-detail-open">
    <CatalogGameDetails key={`${gamePassProduct.productId}:${data.auth.username}:${data.auth.player}:${data.auth.stored}:${data.auth.running}:${data.backend.binaryPath}:${data.settings.market}`}
      product={gamePassProduct} data={data} storeMode storeAccess={gamePassAccess}
      back={() => setGamePassOpen(false)} backLabel={ui('game.back_to_home')} toast={toast ?? (() => {})}/>
  </main>;

  return <main ref={home} className="page home-page">
    <div className={`home-highlights${data.games.length>1?' has-secondary':''}`}>
    <section className={`spotlight ${spotlightArt ? 'has-art' : ''}`} style={spotlightArt ? { '--spotlight-art': `url(${spotlightArt})` } as React.CSSProperties : undefined}>
      <div className="spotlight-copy">
        <span className="overline">{featured ? ui("ui.continue_playing_86c00e5") : 'NEXUS LAUNCHER'}</span>
        <h1>{featured?.title ?? ui("ui.your_pc_games_brought_together_354f2fc")}</h1>
        <p>{uiText(featured
          ? featured.installMessage ?? ui("ui.ready_in_your_library_ac8a64f", { publisher: featured.publisher ?? ui('home.local_installation') })
          : ui("ui.import_an_existing_xodus_installation_or_install_a7f793f"))}</p>
        <div className="button-row">
          {featured && canPlay
            ? <button className="primary" data-gamepad-home-primary data-gamepad-key="home-play" onClick={() => action(() => window.launcher.launchGame(featured.id))}><Play fill="currentColor" />{ui("ui.play_436e610")}</button>
            : <button className="primary" data-gamepad-home-primary data-gamepad-key="home-setup" onClick={() => go(featured ? 'settings' : 'library')}><ChevronRight />{featured ? ui("ui.finish_setup_bc01ae7") : ui("ui.import_a_game_54c0a6d")}</button>}
          <button className="secondary" onClick={() => go('library')}><Library />{ui("ui.view_library_108eb25")}</button>
        </div>
      </div>
      {featured ? <div className="spotlight-meta"><StatePill game={featured} />{launchOptions?.cloudSaves ? <span>{ui("ui.cloud_saves_4c54136")}</span> : null}</div> : null}
    </section>
    {data.games.length>1?<div className="home-secondary">{data.games.slice(1,3).map(game=><button key={game.id} className="home-feature-card" data-gamepad-key={`home-feature:${game.id}`} onClick={()=>openGame ? openGame(game.id, `home-feature:${game.id}`) : go('library')}>
      <Cover game={game} variant="hero" /><span><strong>{game.title}</strong><small>{game.publisher??ui("ui.in_your_library_b9da1b7")}</small></span>
    </button>)}</div>:null}
    </div>

    <SectionTitle title={ui("ui.recently_installed_d12be06")} action={ui("ui.see_all_d7a8c44")} onClick={() => go('library')} />
    {recentInstalled.length > 0 ? <div className="poster-row">
      {recentInstalled.slice(0, 6).map((game) => <button className="poster-card" key={game.id} data-gamepad-key={`home-poster:${game.id}`} onClick={() => openGame ? openGame(game.id, `home-poster:${game.id}`) : go('library')}>
        <Cover game={game} /><GameTitle title={game.title} /><span>{game.publisher ?? (game.storeId ? ui("ui.microsoft_store_installation_99bfa99") : ui("ui.local_installation_e5d8322"))}</span>
      </button>)}
    </div> : data.games.length === 0 ? <div className="empty-strip"><Gamepad2 /><div><strong>{ui("ui.no_games_imported_0bbcb51")}</strong><span>{ui("ui.your_library_is_built_only_from_real_local_manif_1513d78")}</span></div><button className="secondary" onClick={() => go('library')}>{ui("ui.import_folder_b849e38")}</button></div>
      : <div className="empty-strip"><Gamepad2 /><div><strong>{ui("ui.no_completed_installations_yet_c0d583a")}</strong><span>{ui("ui.your_library_is_built_only_from_real_local_manif_1513d78")}</span></div><button className="secondary" onClick={() => go('library')}>{ui("ui.view_library_108eb25")}</button></div>}

    <HomeGamePassSection {...gamePass} open={openGamePass}/>
  </main>;
}

function CatalogSupportBadge({ product }: { product: CatalogProduct }) {
  return <span className={`catalog-support ${product.installability}`} title={uiText(product.supportNote)}
    aria-label={product.installability === 'unknown' ? ui("ui.package_support_unknown_12fe897") : undefined}>{product.installability === 'supported' ? 'PC' : product.installability === 'unknown' ? '?' : ui("ui.unsupported_5432465")}</span>;
}

export function StoreProductCard({ product, selected, disabled, label, select, install, licensed = false }: {
  product: CatalogProduct; selected: boolean; disabled: boolean; label: string; licensed?: boolean;
  select: (product: CatalogProduct,openDetails?:boolean) => void; install: (product: CatalogProduct) => void;
}) {
  const price=publicStorePrice(product);
  return <article className={`catalog-card ${selected ? 'selected' : ''}`} data-gamepad-card>
    <button className="catalog-card-main" data-gamepad-auto-select="focus" data-gamepad-detail-target={product.productId}
      onFocus={() => select(product,false)} onClick={() => select(product,true)}>
      {product.posterUrl ? <img src={product.posterUrl} alt={ui("ui.cover_47bbe4b", { game: product.title })} /> : <div className="catalog-cover-placeholder"><Gamepad2 /></div>}
      <CatalogSupportBadge product={product} />
      <div><GameTitle title={product.title} /><small>{product.publisher ?? product.productId}</small><span title={price ? ui('store.us_price_context') : undefined}>{product.purchasePrice ?? ui("ui.price_unavailable_6a9e657")}{price ? ` · ${ui('store.us_price_short')}` : ''}{product.includedWith ? ` · ${product.includedWith}` : ''}</span></div>
    </button>
    {licensed ? <button className="catalog-card-install" data-gamepad-skip data-gamepad-card-action disabled={disabled} onClick={() => install(product)}>
      {label === 'Preparing…' ? <LoaderCircle className="spin" /> : label === 'Installed' ? <Check /> : <Download />}{label}
    </button> : <button className="catalog-card-install" data-gamepad-skip data-gamepad-card-action onClick={() => window.open(product.storeUrl ?? `https://www.xbox.com/games/store/p/${product.productId}`, '_blank')}>{ui("ui.store_page_9c667df")}</button>}
  </article>;
}

export function StorePagination({ page, loading, error, load }: { page?: StoreListPage; loading: boolean; error?: string; load: () => void }) {
  if (!page && !error) return null;
  if (page && !loading && !page.hasMore && !page.stalled && !error) return null;
  return <div className="load-more store-pagination" data-gamepad-library-footer>
    {error ? <div className="alert amber" role="alert"><CircleAlert /><span>{uiText(error)}</span><button className="secondary" data-gamepad-skip disabled={loading} onClick={load}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui("ui.try_again_d8b839")}</button></div> : null}
    {page?.stalled && !error ? <p className="account-library-note" role="status">{ui('store.no_more_pages')}</p> : null}
    {page?.hasMore ? <button className="secondary" aria-disabled={loading} aria-busy={loading} onClick={() => { if (!loading) load(); }}>{loading ? <LoaderCircle className="spin" /> : <Plus />}{ui("ui.load_more_results_e03f1e4")}</button> : null}
    {loading && !page?.hasMore ? <span className="library-loading" role="status"><LoaderCircle className="spin" />{ui("ui.loading_live_store_collection_20763b0")}</span> : null}
  </div>;
}

export function StorePage({ data, toast, go, initialQuery }: { data: AppSnapshot; toast: (value: Toast) => void; go: (page: Page) => void; initialQuery: string }) {
  const startPackageInstall = usePackageInstall();
  const access = useStoreAccess(data);
  // The Store shows one paged list at a time: public search results, or the
  // featured landing page continued by the same collection feed.
  const [search, setSearch] = useState<(StoreListPage & { query: string })>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [searchPageError, setSearchPageError] = useState<string>();
  const [searchPageLoading, setSearchPageLoading] = useState(false);
  // A page request belongs to the search generation that started it. A newer
  // query owns its own in-flight marker and busy state, so a late answer from
  // an older generation can neither block nor clear the visible one.
  const searchGeneration = useRef(0), searchPageInFlight = useRef<number>();
  const [browseAvailable] = useState(() => typeof window !== 'undefined' && typeof window.launcher?.browseCatalog === 'function');
  const [browse, setBrowse] = useState<StoreListPage>(() => ({ products: [], hasMore: false, stalled: false, requested: [] }));
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string>();
  const browseInFlight = useRef(false);
  const [featured, setFeatured] = useState<CatalogSearchResult>();
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [featuredError, setFeaturedError] = useState<string>();
  const [featuredRevision, setFeaturedRevision] = useState(0);
  const [selected, setSelected] = useState<CatalogProduct>();
  const [detailOpen,setDetailOpen]=useState(false);
  const pageRef=useRef<HTMLElement>(null),savedScroll=useRef(0),wasOpen=useRef(false),sentinel=useRef<HTMLDivElement>(null);
  useBrowserLayoutEffect(()=>{
    const scroll=pageRef.current?.closest('.page-scroll');
    if(detailOpen&&selected){if(scroll)scroll.scrollTop=0;focusDetailEntry(pageRef.current);}
    else if(wasOpen.current){if(scroll)scroll.scrollTop=savedScroll.current;[...pageRef.current?.querySelectorAll<HTMLElement>('[data-gamepad-detail-target]')??[]].find(card=>card.getAttribute('data-gamepad-detail-target')===selected?.productId)?.focus({preventScroll:true});}
    wasOpen.current=detailOpen&&Boolean(selected);
  },[detailOpen,selected?.productId]);
  const [busy, setBusy] = useState<string>();

  /** Drops every page-scoped search value instead of leaving it to a stale
   * request, so a later feed never inherits the previous query's state. */
  function resetSearchState() {
    searchGeneration.current += 1;
    searchPageInFlight.current = undefined;
    setSearch(undefined); setSearchError(undefined); setSearching(false);
    setSearchPageError(undefined); setSearchPageLoading(false);
  }
  // First page of a public search. A newer query always invalidates the older
  // request so a slow answer can never replace the visible results.
  async function runSearch(query: string) {
    const generation = ++searchGeneration.current;
    searchPageInFlight.current = undefined;
    setSearch(undefined); setSearching(true); setSearchError(undefined);
    setSearchPageError(undefined); setSearchPageLoading(false);
    try {
      const next = await window.launcher.searchCatalog(query);
      if (generation !== searchGeneration.current) return;
      setSearch({ ...storePageState([], next, []), query: next.query });
      setSelected(undefined);
    } catch (error) {
      if (generation === searchGeneration.current) setSearchError(errorMessage(error));
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  }
  useEffect(() => {
    const query = initialQuery.trim();
    if (query.length < 2) { resetSearchState(); return; }
    void runSearch(query);
    return () => { searchGeneration.current += 1; };
  }, [initialQuery]);
  useEffect(() => {
    let cancelled = false;
    window.launcher.getFeaturedCatalog()
      .then((result) => {
        if (cancelled) return;
        setFeatured(result); setFeaturedError(undefined);
        // The landing continuation is the exact next page of the read that
        // really happened, never an assumed page number.
        setBrowse(current => current.products.length ? current : { products: [], cursor: result.cursor, hasMore: Boolean(result.hasMore && result.cursor && browseAvailable), stalled: false, requested: [] });
      })
      .catch((error) => {
        if (cancelled) return;
        setFeaturedError(errorMessage(error));
        // A failed landing is not a dead end: the first paid page is an honest
        // recovery path with the same public policy.
        setBrowse(current => current.products.length ? current : { products: [], cursor: undefined, hasMore: browseAvailable, stalled: false, requested: [] });
      })
      .finally(() => { if (!cancelled) setFeaturedLoading(false); });
    return () => { cancelled = true; };
  }, [featuredRevision]);

  function installDestination(product: CatalogProduct): string {
    const folder = product.title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || product.productId;
    return `${data.settings.installRoot.replace(/\/+$/, '')}/${folder}`;
  }

  function selectProduct(product: CatalogProduct,openDetails=true) {
    setSelected(product);
    if(openDetails){savedScroll.current=pageRef.current?.closest('.page-scroll')?.scrollTop??0;setDetailOpen(true);}
  }

  async function loadMoreSearch() {
    const cursor = search?.cursor;
    const generation = searchGeneration.current;
    if (!search || !cursor || !search.hasMore) return;
    if (searchPageInFlight.current === generation) return;
    searchPageInFlight.current = generation; setSearchPageError(undefined); setSearchPageLoading(true);
    try {
      const next = await window.launcher.searchCatalog(search.query, cursor);
      if (generation !== searchGeneration.current) return;
      setSearch(current => {
        if (!current || current.query !== search.query) return current;
        return { ...storePageState(current.products, next, storeRequested(current, cursor)), query: current.query };
      });
    } catch (error) {
      if (generation === searchGeneration.current) setSearchPageError(errorMessage(error));
    } finally {
      // Only the generation that owns the marker may release it or clear the
      // busy state, so a late finish never clobbers a newer page request.
      if (searchPageInFlight.current === generation) searchPageInFlight.current = undefined;
      if (generation === searchGeneration.current) setSearchPageLoading(false);
    }
  }

  async function loadMoreBrowse() {
    if (!browse.hasMore || browseInFlight.current) return;
    const cursor = browse.cursor;
    browseInFlight.current = true; setBrowseLoading(true); setBrowseError(undefined);
    try {
      const next = await window.launcher.browseCatalog(cursor);
      setBrowse(current => storePageState(current.products, next, storeRequested(current, cursor)));
    } catch (error) {
      setBrowseError(errorMessage(error));
    } finally {
      browseInFlight.current = false; setBrowseLoading(false);
    }
  }

  function retryFeatured() { setFeaturedRevision(value => value + 1); }

  // The landing grid and the paged collection are one list; the featured cards
  // stay first and every later page appends after them.
  const landingProducts = appendStoreProducts(featured?.products.slice(3) ?? [], browse.products);
  const featuredRail = featured?.products.slice(0, 3) ?? [];
  // Scrolling near the end of the real scroll container continues the list. A
  // failure is never retried automatically; the visible control retries.
  // Only the feed that is actually displayed gates auto-load: an old search
  // error or a browse failure must never block the other feed.
  const autoLoad = useRef<() => void>(() => {});
  autoLoad.current = () => {
    if (search) {
      if (searchPageError || searchPageLoading || !search.hasMore) return;
      void loadMoreSearch();
      return;
    }
    if (browseError || browseLoading || !browse.hasMore) return;
    void loadMoreBrowse();
  };
  const autoKey = search
    ? `search:${search.cursor ?? ''}:${search.hasMore}:${searchPageError ?? ''}:${searchPageLoading}`
    : `browse:${browse.cursor ?? ''}:${browse.hasMore}:${browseError ?? ''}:${browseLoading}`;
  // The sentinel only exists once a list is on screen, so its arrival must
  // re-create the observer even when the cursor did not change.
  const listOnScreen = Boolean(search) || Boolean(featured?.products.length) || Boolean(featuredError);
  useEffect(() => {
    const node = sentinel.current, root = pageRef.current?.closest('.page-scroll');
    if (!node || !root || typeof IntersectionObserver !== 'function') return;
    if (!(search ?? browse).hasMore) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some(entry => entry.isIntersecting)) autoLoad.current(); }, { root, rootMargin: '400px 0px' });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [autoKey, listOnScreen, detailOpen]);

  async function install(product: CatalogProduct, target = installDestination(product)) {
    if (!access.canInstall(product)) return;
    setBusy(product.productId);
    try {
      const request={...catalogInstallRequest(product,target),source:'store' as const};
      if (!await startPackageInstall(request, () => access.canInstall(product))) return;
      toast({ kind: 'success', message: ui("ui.xodus_is_checking_the_license_and_installing_be774b2", { game: product.title }) });
      go('downloads');
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setBusy(undefined); }
  }

  const installedIds = new Set(data.games.flatMap((game) => game.storeId?.toUpperCase() ?? []));
  const isInstalled = (product: CatalogProduct) => installedIds.has(product.productId) || Boolean(product.installProductId && installedIds.has(product.installProductId));
  const queuedIds = new Set(data.downloads.filter(task => ['running', 'queued', 'paused'].includes(task.status)).map(task => task.productId.toUpperCase()));
  const isQueued = (product: CatalogProduct) => queuedIds.has(product.productId) || Boolean(product.installProductId && queuedIds.has(product.installProductId));
  const productGrid = (products: CatalogProduct[]) => <div className="catalog-grid" data-gamepad-grid>{products.map((product) => {
    const installed = isInstalled(product);
    return <StoreProductCard key={product.productId} product={product} selected={selected?.productId === product.productId}
      licensed={access.canInstall(product)}
      disabled={product.installability !== 'supported' || Boolean(busy) || !data.backend.capabilities.streaming || installed || isQueued(product)}
      label={installed ? ui("ui.installed_f8b32f4") : isQueued(product) ? ui("ui.in_install_queue_7c818f2") : busy === product.productId ? ui("ui.preparing_5d1fa38") : ui("ui.install_569ca49")}
      select={selectProduct} install={install} />;
  })}</div>;
  if(detailOpen&&selected)return <main ref={pageRef} className="page store-page library-detail-open"><CatalogGameDetails key={`${selected.productId}:${data.auth.username}:${data.auth.player}:${data.auth.stored}:${data.auth.running}:${data.backend.binaryPath}:${data.settings.market}`} product={selected} data={data} storeMode storeAccess={access} back={()=>setDetailOpen(false)} backLabel={ui('game.back_to_store')} toast={toast}/></main>;
  // Only the product grid renders a price. The first three featured tiles are
  // artwork-only, and all catalog results render in the price-bearing grid.
  return <main ref={pageRef} className="page store-page">
    <header className="page-header"><div><h1>{ui("ui.store_ee7da93")}</h1></div><span className="catalog-source"><StatusDot />Microsoft Store</span></header>
    {!search && !searching && !searchError ? <section className="featured-catalog"><SectionTitle title={ui("ui.featured_c533caf")} />
      {featuredLoading ? <div className="catalog-loading"><LoaderCircle className="spin" /><span>{ui("ui.loading_live_store_collection_20763b0")}</span></div> : <>
        {featuredError && landingProducts.length ? <div className="empty-strip"><CircleAlert /><div><strong>{ui("ui.featured_games_are_temporarily_unavailable_3901a69")}</strong><span>{uiText(featuredError)}</span></div><button className="secondary" onClick={retryFeatured}><RefreshCw />{ui("ui.try_again_d8b839")}</button></div> : null}
        {featuredRail.length ? <div className="featured-rail">{featuredRail.map((product) => <button className="featured-tile" key={product.productId} data-gamepad-detail-target={product.productId} onClick={() => selectProduct(product)}>{product.heroUrl || product.posterUrl ? <img src={product.heroUrl ?? product.posterUrl} alt="" /> : <div className="featured-tile-placeholder"><Gamepad2 /></div>}<span className="featured-tile-copy"><GameTitle title={product.title} /><small>{product.publisher ?? 'Microsoft Store'} · {product.installability === 'supported' ? ui('store.verified_pc') : ui("ui.check_package_support_79592da")}</small></span></button>)}</div> : null}
        {landingProducts.length ? <><SectionTitle title={ui("ui.top_paid_games_8040f77")} />{productGrid(landingProducts)}</> : null}
        {featuredError && !landingProducts.length ? <div className="catalog-empty"><Store /><h2>{ui("ui.featured_games_are_temporarily_unavailable_3901a69")}</h2><p>{uiText(featuredError)}</p><button className="secondary" onClick={retryFeatured}><RefreshCw />{ui("ui.try_again_d8b839")}</button></div> : null}
        {!featuredError && !landingProducts.length ? <div className="catalog-empty"><Store /><h2>{ui("ui.featured_games_are_temporarily_unavailable_3901a69")}</h2><p>{ui("ui.search_still_works_with_live_microsoft_store_dat_b3eeb72")}</p></div> : null}
      </>}
    </section> : null}

    {search || searching || searchError ? <><SectionTitle title={search ? ui("ui.results_for_343a212", { query: search.query }) : ui("ui.results_for_343a212", { query: initialQuery.trim() })} />
      {searchError ? <div className="alert amber" role="alert"><CircleAlert /><span>{uiText(searchError)}</span><button className="secondary" disabled={searching} onClick={() => void runSearch(initialQuery.trim())}><RefreshCw />{ui("ui.try_again_d8b839")}</button></div> : null}
      {searching && !search ? <div className="catalog-loading"><LoaderCircle className="spin" /><span>{ui("ui.loading_live_store_collection_20763b0")}</span></div> : null}
      {search ? productGrid(search.products) : null}
      {search && search.products.length === 0 && !search.hasMore ? <div className="empty-state compact"><div><Search /></div><h2>{ui("ui.no_games_found_6da4c04")}</h2><p>{ui("ui.try_a_different_title_or_a_microsoft_store_produ_326af8c")}</p></div> : null}
      {search ? <div ref={sentinel} /> : null}
      <StorePagination page={search} loading={searchPageLoading} error={searchPageError} load={() => void loadMoreSearch()} />
    </> : null}

    {!search && !searching && !searchError && !featuredLoading ? <><div ref={sentinel} /><StorePagination page={browse} loading={browseLoading} error={browseError} load={() => void loadMoreBrowse()} /></> : null}

  </main>;
}

interface GameMenuActionsProps {
  game: Game; options?: GameLaunchOptions; busy: boolean;
  onBrowse: () => void; onSettings: () => void; onInstallVc: () => void; onRemove: () => void;
  onShortcut?: (destination: 'desktop' | 'applications' | 'steam') => void;
  onUpdate?: () => void; updateDisabled?: boolean; updateLabel?: string;
  onContent?: () => void; contentDisabled?: boolean;
}

export function GameMenuActions({ game, options, busy, onBrowse, onSettings, onInstallVc, onRemove, onShortcut, onUpdate, updateDisabled, updateLabel, onContent, contentDisabled }: GameMenuActionsProps) {
  return <>
    {onUpdate ? <button role="menuitem" disabled={busy || updateDisabled} onClick={onUpdate}><RefreshCw />{updateLabel ?? ui("ui.check_for_updates_f26f327")}</button> : null}
    <button role="menuitem" onClick={onBrowse}><FolderOpen />{ui("ui.browse_game_files_3df9898")}</button>
    {onContent ? <button role="menuitem" disabled={busy || contentDisabled} onClick={onContent}><PackageCheck />{ui("ui.manage_content_459a3de")}</button> : null}
    <button role="menuitem" onClick={onSettings}><Settings2 />{ui("ui.game_settings_fece860")}</button>
    <button role="menuitem" disabled={!onShortcut || game.installState !== 'ready'} onClick={() => onShortcut?.('desktop')}><Plus />{ui("ui.create_desktop_shortcut_bf2f4ab")}</button>
    <button role="menuitem" disabled={!onShortcut || game.installState !== 'ready'} onClick={() => onShortcut?.('applications')}><Plus />{ui("ui.add_to_applications_menu_0c0294f")}</button>
    <button role="menuitem" disabled={!onShortcut || game.installState !== 'ready'} title={ui("ui.add_a_shortcut_with_available_artwork_including_dcb0616")} onClick={() => onShortcut?.('steam')}><Plus />{ui("ui.add_to_steam_de2e912")}</button>
    <button role="menuitem" disabled={busy || game.installState !== 'ready' || !options?.vcInstall} title={uiText(options?.vcReason)} onClick={onInstallVc}><Download />{ui("ui.install_update_vc_79a9f19")}</button>
    <button role="menuitem" className="danger" disabled={busy} onClick={onRemove}><Trash2 />{ui("ui.remove_game_7d93c8f")}</button>
  </>;
}

export function GameContextMenu({ x, y, ...actions }: GameMenuActionsProps & { x: number; y: number }) {
  return <div className="game-context-menu" data-game-menu role="menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}><GameMenuActions {...actions} /></div>;
}

interface AccountGamesProps {
  data: AppSnapshot; toast: (value: Toast) => void; selectedId?: string;
  select?: (game: Game, openDetails?: boolean) => void; menu?: (game: Game, x: number, y: number) => void;
  openProduct?: (product:CatalogProduct)=>void;
  filters?: LibraryFilters; onFiltersChange?: (filters: LibraryFilters) => void;
}

export function LibraryPagination({ loading, hasMore, load, searching = false }: { loading: boolean; hasMore: boolean; load: () => void; searching?: boolean }) {
  if (searching) return <div className="library-pagination"><span className="library-loading" role="status"><LoaderCircle className="spin" />{ui("ui.searching_all_library_games_69f22cc")}</span></div>;
  if (!loading && !hasMore) return null;
  return <div className="library-pagination">
    {hasMore ? <button className="secondary" aria-disabled={loading} aria-busy={loading} onClick={() => { if (!loading) load(); }}>
      {loading ? <><LoaderCircle className="spin" />{ui("ui.loading_games_578df84")}</> : ui("ui.load_more_games_e0e4528")}
    </button> : <span className="library-loading" role="status"><LoaderCircle className="spin" />{ui("ui.loading_account_games_feaf422")}</span>}
  </div>;
}

export function LibraryProductCard({ product, present, downloading, installing, canInstall, install,open }: {
  product: AccountLibraryPage['products'][number]; present: boolean; downloading: boolean; installing?: string; canInstall: boolean; install: (product: CatalogProduct) => void;
  open?: (product:CatalogProduct)=>void;
}) {
  const disabled = present || downloading || Boolean(installing) || !canInstall || product.installability !== 'supported';
  const label = present ? ui("ui.installed_f8b32f4") : downloading ? ui("ui.in_install_queue_7c818f2") : installing === product.productId ? ui("ui.preparing_5d1fa38") : ui("ui.install_569ca49");
  return <article className="catalog-card" data-gamepad-card>
    <button className="catalog-card-main" data-gamepad-detail-target={product.productId} aria-label={ui('game.view_details',{game:product.title})} onClick={()=>open?.(product)}>{product.posterUrl ? <img src={product.posterUrl} alt={ui("ui.cover_47bbe4b", { game: product.title })} loading="lazy" /> : <div className="catalog-cover-placeholder"><Gamepad2 /></div>}<CatalogSupportBadge product={product} /><div><GameTitle title={product.title} /><small>{product.publisher ?? product.productId}</small><span>{product.access === 'owned' ? ui("ui.owned_17b760c") : product.access === 'gamepass' ? ui("ui.game_pass_5c83b40") : ui("ui.other_access_542b2ae")}</span></div></button>
    <button className="catalog-card-install" data-gamepad-skip data-gamepad-card-action disabled={disabled} onClick={() => { if (!disabled) install(product); }}>{present ? <Check /> : <Download />}{label}</button>
  </article>;
}

export function AccountGames({ data, toast, selectedId, select, menu, openProduct,filters, onFiltersChange }: AccountGamesProps) {
  const startPackageInstall = usePackageInstall();
  const [localFilters, setLocalFilters] = useState<LibraryFilters>(defaultLibraryFilters);
  const selectedFilters = filters ?? localFilters;
  const { kind, playState, query } = selectedFilters;
  const sort = kind === 'gamepass' ? selectedFilters.sort : undefined;
  const updateFilters = (patch: Partial<LibraryFilters>) => (onFiltersChange ?? setLocalFilters)({ ...selectedFilters, ...patch });
  const setKind = (kind: LibraryFilters['kind']) => updateFilters({ kind, sort:kind === 'gamepass' ? sort : undefined });
  const setPlayState = (playState: LibraryFilters['playState']) => updateFilters({ playState });
  const setQuery = (query: string) => updateFilters({ query });
  const [result, setResult] = useState<AccountLibraryPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [installing, setInstalling] = useState<string>();
  const [searchTerm, setSearchTerm] = useState('');
  const accountGames = useRef<HTMLElement>(null);
  const lastGridFocus = useRef<HTMLElement>();
  const paginationReturn = useRef<HTMLElement>();
  useBrowserLayoutEffect(() => {
    if (busy || !paginationReturn.current) return;
    const target = paginationReturn.current;
    paginationReturn.current = undefined;
    const active = document.activeElement;
    // Restore the old bottom-row game before Down enters the newly loaded
    // rows. Do not steal focus if the user moved away while loading.
    if (target.isConnected && document.hasFocus() && (active === document.body || active?.closest('[data-gamepad-library-footer]'))) target.focus();
  }, [busy]);
  useEffect(() => {
    if (!query.trim()) { setSearchTerm(''); return; }
    const timer = window.setTimeout(() => setSearchTerm(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  const identity = `${data.auth.stored}:${data.auth.username}:${data.auth.running}:${data.settings.market}:${data.backend.binaryPath}:${kind}:${sort ?? 'default'}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [loadedIdentity, setLoadedIdentity] = useState(identity);
  const available = data.auth.stored === true && !data.auth.running && data.backend.capabilities.library;
  useEffect(() => {
    let cancelled = false;
    setResult(undefined); setLoadedIdentity(identity); setError(undefined);
    if (!available) { setBusy(false); return; }
    setBusy(true);
    window.launcher.getAccountLibrary(kind,undefined,false,sort).then(value => { if (!cancelled) setResult(value); })
      .catch(error => { if (!cancelled) setError(errorMessage(error)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [identity, available]);
  // Never display the previous account's cards while the identity effect settles.
  const visible = loadedIdentity === identity ? result : undefined;
  // Installed games are already in the snapshot. Account searches must also
  // resolve every remaining licensed page before reporting no matches.
  const searching = available && playState !== 'installed' && Boolean(query.trim()) && !error && (busy || Boolean(visible?.cursor));
  useEffect(() => {
    if (!searching || busy || !visible?.cursor || searchTerm !== query.trim()) return;
    void load();
  }, [identity, searching, busy, visible?.cursor, searchTerm, query]);
  const installed = new Set(data.games.flatMap(game => game.storeId?.toUpperCase() ?? []));
  const queued = new Set(data.downloads.filter(task => ['running', 'queued', 'paused'].includes(task.status)).map(task => task.productId.toUpperCase()));
  const products = (visible?.products ?? []).filter(product => !installed.has(product.productId) && !installed.has(product.installProductId ?? ''));
  const access = (game: Game) => game.storeId ? visible?.accessByProductId[game.storeId.toUpperCase()] : undefined;
  const rows = rankLibraryRows([
    ...data.games.filter(game => playState !== 'installable' && (kind === 'all' || access(game) === kind)).sort((a, b) => a.title.localeCompare(b.title))
      .map(game => ({ id: game.id, title: game.title, game, product: undefined })),
    ...products.filter(product => libraryProductMatchesPlayState(product, playState)).map(product => ({ id: product.productId, title: product.title, product, game: undefined })),
  ].filter(row => row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
    sort ? visible?.recentProductIds : undefined, row => row.product?.productId ?? row.game?.storeId?.toUpperCase());
  async function load(refresh = false) {
    if (!refresh && document.documentElement.hasAttribute('data-gamepad-navigation') && accountGames.current?.contains(document.activeElement)
      && document.activeElement?.closest('[data-gamepad-library-footer]')) {
      paginationReturn.current = lastGridFocus.current ?? [...accountGames.current.querySelectorAll<HTMLElement>('[data-gamepad-grid] [data-gamepad-detail-target]')].at(-1);
    }
    setBusy(true); setError(undefined);
    try {
      const next = await window.launcher.getAccountLibrary(kind, refresh ? undefined : visible?.cursor, refresh, sort);
      if (currentIdentity.current !== identity) return;
      if (!refresh && visible?.cursor && next.cursor === visible.cursor) throw Error("Library pagination did not advance. Refresh the library to try again.");
      // This instance is remounted on identity changes, so pending callbacks
      // cannot publish another account's products into the active component.
      setResult(old => ({ ...next, products: refresh ? next.products : [...(old?.products ?? []), ...next.products.filter(p => !old?.products.some(old => old.productId === p.productId))] }));
    } catch (error) { if (currentIdentity.current === identity) { paginationReturn.current = undefined; setError(errorMessage(error)); } }
    finally { if (currentIdentity.current === identity) setBusy(false); }
  }
  async function install(product: CatalogProduct) {
    if (product.installability !== 'supported') { toast({ kind: 'error', message: product.supportNote }); return; }
    setInstalling(product.productId);
    try {
      const folder = product.title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || product.productId;
      if (!await startPackageInstall(catalogInstallRequest(product, `${data.settings.installRoot.replace(/\/+$/, '')}/${folder}`))) return;
      toast({ kind: 'success', message: ui("ui.added_to_install_queue_c755bb7", { game: product.title }) });
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setInstalling(undefined); }
  }
  return <section ref={accountGames} className="account-games" onFocusCapture={event => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-gamepad-grid]') && target.hasAttribute('data-gamepad-detail-target')) lastGridFocus.current = target;
  }}>
    <div className="library-filters" data-gamepad-filters>
      <label>{ui("ui.access_ec5ba0a")}<select aria-label={ui("ui.access_ec5ba0a")} value={kind} onChange={event => setKind(event.target.value as AccountLibraryPage['kind'])}><option value="all">{ui("ui.all_games_cf2bf15")}</option><option value="owned">{ui("ui.owned_17b760c")}</option><option value="gamepass">{ui("ui.in_game_pass_69c8edf")}</option><option value="other">{ui("ui.other_access_542b2ae")}</option></select></label>
      <label>{ui("ui.play_state_6f423d1")}<select aria-label={ui("ui.play_state_6f423d1")} value={playState} onChange={event => setPlayState(event.target.value as typeof playState)}><option value="all">{ui("ui.all_states_f189411")}</option><option value="installed">{ui("ui.installed_f8b32f4")}</option><option value="installable">{ui("ui.ready_to_install_bda18b9")}</option></select></label>
      {kind === 'gamepass' ? <label>{ui("ui.sort_bec6903")}<select aria-label={ui("ui.library_order_4dbb747")} value={sort ?? 'default'} onChange={event => updateFilters({sort:event.target.value === 'recent-gamepass' ? 'recent-gamepass' : undefined})}><option value="default">{ui("ui.default_order_f44484d")}</option><option value="recent-gamepass">{ui("ui.recently_added_to_game_pass_0c69d8c")}</option></select></label> : null}
      <label className="library-filter-search">{ui("ui.search_49c266b")}<input aria-label={ui("ui.search_library_21a933a")} placeholder={ui("ui.search_your_games_17caf33")} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button className="secondary library-refresh" aria-label={ui("ui.refresh_library_c628c56")} title={ui("ui.refresh_library_c628c56")} disabled={!available || busy} onClick={() => load(true)}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}</button>
    </div>
    <div className="account-games-results">
    {!available ? <p>{data.auth.stored !== true ? ui("ui.sign_in_to_load_your_account_games_installed_gam_580df7e") : !data.backend.capabilities.library ? ui("ui.update_the_xodus_backend_to_load_account_license_570a2f1") : ui("ui.wait_for_sign_in_to_finish_621aaa0")}</p> : null}
      {error ? <div className="alert amber"><CircleAlert /><span>{uiText(error)}</span><BackendLogButton toast={toast} /></div> : null}
      {visible?.skippedEntitlements || visible?.excludedEntitlements ? <div className="alert amber"><CircleAlert /><span>{ui("ui.some_license_records_could_not_be_verified_and_w_8d3b7e0")}</span><BackendLogButton toast={toast} /></div> : null}
      <div className="catalog-grid" data-gamepad-grid>{rows.map(row => {
        if (row.game) {
          const game = row.game;
          const license = access(game);
          return <div className={`library-card-wrap catalog-card ${selectedId === game.id ? 'selected' : ''}`} data-gamepad-card key={game.id} onContextMenu={event => { event.preventDefault(); menu?.(game, event.clientX, event.clientY); }}>
            <button className="library-card catalog-card-main" data-gamepad-auto-select="focus" data-gamepad-detail-target={game.id} onFocus={() => select?.(game, false)} onClick={() => select?.(game, true)} onKeyDown={event => { if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); menu?.(game, rect.left + 16, rect.top + 16); } }}><Cover game={game} /><div><GameTitle title={game.title} /><small>{game.publisher ?? ui("ui.local_installation_e5d8322")}</small><span>{license === 'owned' ? ui("ui.owned_17b760c") : license === 'gamepass' ? ui("ui.game_pass_5c83b40") : license === 'other' ? ui("ui.other_access_542b2ae") : ui("ui.local_installation_e5d8322")}</span></div></button>
            <span className="catalog-card-status" title={uiText(game.installMessage)}>{game.installState === 'incomplete' ? <><CircleAlert />{ui("ui.incomplete_75f33cd")}</> : game.installState === 'imported' ? <><FolderOpen />{ui("ui.imported_321f179")}</> : <><Check />{data.gameUpdates?.[game.id]?.available ? ui("ui.update_available_ff8b555") : ui("ui.installed_f8b32f4")}</>}</span>
            <button className="library-card-menu-button" data-game-menu-trigger data-gamepad-skip aria-label={ui("ui.options_for_e196873", { game: game.title })} aria-haspopup="menu" title={ui("ui.options_for_e196873", { game: game.title })} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); menu?.(game, rect.right, rect.bottom); }}><MoreHorizontal /></button>
          </div>;
        }
        const product = row.product!;
        const present = installed.has(product.productId) || installed.has(product.installProductId ?? '');
        const downloading = queued.has(product.productId) || queued.has(product.installProductId ?? '');
        return <LibraryProductCard key={product.productId} product={product} present={present} downloading={downloading} installing={installing} canInstall={data.backend.capabilities.streaming} install={install} open={openProduct} />;
      })}</div>
      {!busy && !searching && !error && !rows.length ? <p>{visible?.cursor && playState !== 'installed' ? ui("ui.no_games_match_these_filters_in_the_loaded_resul_10d7834") : ui("ui.no_games_match_these_filters_e0e0d54")}</p> : null}
      <div data-gamepad-library-footer><LibraryPagination loading={busy} hasMore={Boolean(visible?.cursor)} searching={searching} load={() => { void load(); }} />
      <p className="account-library-note">{ui("ui.licensed_games_are_listed_regardless_of_package_e204851")}</p></div>
      {sort ? <p className="account-library-note">{ui("ui.microsoft_s_pc_game_pass_recently_added_collecti_75fb3d3")}</p> : null}
    </div>
  </section>;
}

function AccountGamesForUser(props: AccountGamesProps) {
  const { data } = props;
  return <AccountGames key={`${data.auth.username}:${data.auth.stored}:${data.auth.running}:${data.settings.market}:${data.backend.binaryPath}`} {...props} />;
}

export function ContentList({ plan, disabled, pending, install }: { plan: GameContentPlan; disabled: boolean; pending?: string; install: (id: string) => void }) {
  return <div className="content-list">{plan.items.length ? plan.items.map(item => <article key={item.productId}>
    <div><strong title={item.title}>{item.title}</strong><small>{item.access === 'owned' ? ui("ui.owned_17b760c") : item.access === 'gamepass' ? ui("ui.game_pass_5c83b40") : item.access === 'other' ? ui("ui.other_access_542b2ae") : ui("ui.license_not_verified_b4ac386")} · {item.status === 'installed' ? ui("ui.installed_f8b32f4") : item.status === 'verify' ? ui("ui.license_check_required_cb65e96") : item.status === 'available' ? ui("ui.not_installed_d177cdc") : item.status === 'license-only' ? ui("ui.no_download_required_56d8478") : item.status === 'bundle' ? ui("ui.content_bundle_ccfe4f2") : item.status === 'unsupported' ? ui("ui.unsupported_package_d72ac5f") : ui("ui.unavailable_ca18449")}</small>
      {item.downloadBytes ? <small>{ui("ui.download_7502fd3")}{' '}{(item.downloadBytes / 1024 ** 2).toFixed(1)}{' '}{ui("ui.mib_dea6cb8")}</small> : null}<small>{uiText(item.note)}</small></div>
    {['license-only', 'bundle'].includes(item.status) ? null : <button className="secondary" disabled={disabled || Boolean(pending) || (!item.access && item.status !== 'verify') || !['available', 'installed', 'verify'].includes(item.status)} onClick={() => install(item.productId)}><Download />{pending === item.productId ? ui("ui.preparing_5d1fa38") : item.status === 'verify' ? ui("ui.verify_and_install_27d773b") : item.status === 'installed' ? ui("ui.repair_1196b6c") : ui("ui.install_569ca49")}</button>}
  </article>) : <p>{ui("ui.no_related_add_ons_were_found_for_this_game_37fb940")}</p>}</div>;
}

function GameContentDialog({ game, data, close, toast }: { game: Game; data: AppSnapshot; close: () => void; toast: (value: Toast) => void }) {
  const confirm = useConfirmation();
  const [plan, setPlan] = useState<GameContentPlan>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string>();
  const [revision, setRevision] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, close, true, Boolean(pending));
  const queue = data.downloads.filter(task => task.kind === 'content' && task.gameId === game.id);
  const queueState = queue.map(task => task.id + ':' + task.status).join(',');
  const busy = data.downloads.some(task => ['running', 'paused', 'queued'].includes(task.status)) || Boolean(data.gameOperation && ['preparing', 'running', 'stopping'].includes(data.gameOperation.status));
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(undefined); setPlan(undefined);
    window.launcher.getGameContent(game.id).then(value => { if (!cancelled) setPlan(value); })
      .catch(error => { if (!cancelled) setError(errorMessage(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [game.id, data.auth.username, data.auth.stored, data.auth.running, data.backend.binaryPath, data.settings.market, revision, queueState]);
  async function install(id: string) {
    const item = plan?.items.find(item => item.productId === id);
    if (!item || !await confirm({ title: `${item.status === 'installed' ? ui("ui.repair_1196b6c") : ui("ui.install_569ca49")} ${item.title}?`, message: ui("ui.this_downloads_licensed_content_into_a_separate_393e175"), confirmLabel: item.status === 'installed' ? ui("ui.repair_1196b6c") : ui("ui.install_569ca49") })) return;
    setPending(id); setError(undefined);
    try { await window.launcher.installGameContent(game.id, id); toast({ kind: 'success', message: ui("ui.content_added_to_install_queue_fc638a9") }); }
    catch (error) { setError(errorMessage(error)); }
    finally { setPending(undefined); }
  }
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending) close(); }}><section ref={dialogRef} className="game-dialog content-dialog" role="dialog" aria-modal="true" aria-label={ui("ui.content_for_73287b5", { game: game.title })}>
    <h2>{ui("ui.manage_content_459a3de")}</h2><p>{game.title}</p><p>{ui("ui.only_verified_licensed_pc_content_can_be_install_dfb3a32")}</p>
    {loading ? <p role="status"><LoaderCircle className="spin" />{ui("ui.checking_account_licenses_and_packages_1ace530")}</p> : null}
    {error ? <p role="alert" className="error-text">{uiText(error)}</p> : null}
    {plan?.runtimeSupported === false ? <p className="error-text">{ui("ui.update_the_nexus_runtime_in_settings_before_inst_ace6eca")}</p> : null}
    {plan && !loading ? <ContentList plan={plan} disabled={busy || !data.backend.capabilities.streaming || plan.runtimeSupported === false} pending={pending} install={id => { void install(id); }} /> : null}
    {queue.some(task => ['running', 'paused', 'queued'].includes(task.status)) ? <p>{ui("ui.content_download_is_in_install_queue_pause_resum_69c2b12")}</p> : null}
    <div className="dialog-actions"><button className="secondary" disabled={loading || Boolean(pending)} onClick={() => setRevision(value => value + 1)}><RefreshCw />{ui("ui.refresh_0e91610")}</button><button className="secondary" disabled={Boolean(pending)} data-gamepad-cancel onClick={close}>{ui("ui.close_7d9eb7a")}</button></div>
  </section></div>;
}

export function GameLaunchToolFields({ value, change }: { value: GameLaunchTools; change: (value: GameLaunchTools) => void }) {
  const update = (patch: Partial<GameLaunchTools>) => change({ ...value, ...patch });
  return <fieldset className="game-launch-tools"><legend>{ui("ui.launch_tools_c1a69e7")}</legend>
    <CheckField className="tool-checkbox" checked={value.dualSenseCompatibility === true} onChange={event => update({ dualSenseCompatibility: event.target.checked })} label={ui("ui.dualsense_compatibility_mode_666f577")} description={ui("ui.try_this_if_a_standard_dualsense_controller_is_n_114e408")} />
    <CheckField className="tool-checkbox" checked={value.dualShock4Compatibility === true} onChange={event => update({ dualShock4Compatibility: event.target.checked })} label={ui("controllers.dualshock4_compatibility")} description={ui("controllers.dualshock4_help")} />
    <CheckField className="tool-checkbox" checked={value.mangoHud} onChange={event => update({ mangoHud: event.target.checked })} label={ui("ui.enable_mangohud_dcae6c8")} />
    <CheckField className="tool-checkbox" checked={value.gamescope} onChange={event => update({ gamescope: event.target.checked })} label={ui("ui.run_in_gamescope_58f2d35")} />
    {value.gamescope ? <label>{ui("ui.gamescope_options_cb81326")}<input value={value.gamescopeArgs} maxLength={2048} placeholder="-W 1920 -H 1080 -f" onChange={event => update({ gamescopeArgs: event.target.value })} /><small>{ui("ui.only_options_nexus_adds_the_game_command_mangohu_c4b6ad8")}</small></label> : null}
    <label>{ui("ui.launch_options_5dfe538")}<textarea rows={3} value={value.launchOptions} maxLength={2048} placeholder="PROTON_ENABLE_WAYLAND=1 gamemoderun %command% --launcher-skip" onChange={event => update({ launchOptions: event.target.value })} /><small>{ui("ui.name_value_and_wrappers_before_command_game_argu_930be12")}</small></label>
    <small>{ui("ui.tools_must_already_be_installed_applies_to_this_956d794")}</small>
  </fieldset>;
}

type LibrarySelection = { id: string; returnHomeKey?: string };

export function LibraryPage({ data, toast, filters, onFiltersChange, selection, onSelectionHandled, returnHome }: Pick<AccountGamesProps, 'data' | 'toast' | 'filters' | 'onFiltersChange'> & { selection?: LibrarySelection; onSelectionHandled?: (request: LibrarySelection) => void; returnHome?: (key: string) => void }) {
  const confirm = useConfirmation();
  const [selectedId, setSelectedId] = useState<string | undefined>(selection?.id);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [dialogGame, setDialogGame] = useState<{ id: string; kind: 'settings' | 'remove' }>();
  const [editTitle, setEditTitle] = useState('');
  const [editLocale, setEditLocale] = useState('');
  const [editRuntime,setEditRuntime]=useState<GameRuntimeSelection>('default');
  const [runtimeChoices,setRuntimeChoices]=useState<InstalledRuntimeFamily[]>(data.runtime.variants??[]);
  const runtimeChoicesKey=JSON.stringify(data.runtime.variants??[]);
  useEffect(()=>setRuntimeChoices(data.runtime.variants??[]),[runtimeChoicesKey]);
  const [editTools, setEditTools] = useState<GameLaunchTools>({ ...defaultLaunchTools });
  const [localeOptions, setLocaleOptions] = useState<string[]>([]);
  const localeRequest = useRef(0);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [diagnosticLog, setDiagnosticLog] = useState<{ log: DiagnosticLog; operationId: string }>();
  const [contentGameId, setContentGameId] = useState<string>();
  const [detailOpen, setDetailOpen] = useState(Boolean(selection));
  const catalogScope=JSON.stringify([data.auth.username,data.auth.player,data.auth.stored,data.auth.running,data.backend.binaryPath,data.settings.market]);
  const [catalogSelection,setCatalogSelection]=useState<{product:CatalogProduct;scope:string}>();
  const catalogProduct=catalogSelection?.scope===catalogScope?catalogSelection.product:undefined;
  const previousCatalogScope=useRef(catalogScope);
  useEffect(()=>{if(previousCatalogScope.current!==catalogScope&&catalogSelection){setCatalogSelection(undefined);setDetailOpen(false);}previousCatalogScope.current=catalogScope;},[catalogScope,catalogSelection]);
  const pageRef = useRef<HTMLElement>(null);
  const savedScroll = useRef(0);
  const wasOpen = useRef(false);
  const returnHomeKey = useRef(selection?.returnHomeKey);
  function closeDetails() {
    setDetailOpen(false);
    if (returnHomeKey.current) { const key = returnHomeKey.current; returnHomeKey.current = undefined; returnHome?.(key); }
  }
  const selected = data.games.find((game) => game.id === selectedId) ?? data.games[0];
  const detailVisible=detailOpen&&Boolean(catalogSelection?catalogProduct:selected);
  const returnTarget=catalogProduct?(catalogGameInstalled(catalogProduct,data)?.id??catalogProduct.productId):selected?.id;
  function selectProductDetails(product:CatalogProduct){
    returnHomeKey.current = undefined;
    savedScroll.current=pageRef.current?.closest('.page-scroll')?.scrollTop??0;
    setCatalogSelection({product,scope:catalogScope});setDetailOpen(true);
  }
  function selectGame(game: Game, openDetails = false) {
    if (openDetails) returnHomeKey.current = undefined;
    setSelectedId(game.id);
    if (openDetails) { setCatalogSelection(undefined);savedScroll.current = pageRef.current?.closest('.page-scroll')?.scrollTop ?? 0; setDetailOpen(true); }
  }
  useBrowserLayoutEffect(() => {
    const scroll = pageRef.current?.closest('.page-scroll');
    if (detailVisible) {
      if (scroll) scroll.scrollTop = 0;
      focusDetailEntry(pageRef.current);
    } else if (wasOpen.current) {
      if (scroll) scroll.scrollTop = savedScroll.current;
      [...pageRef.current?.querySelectorAll<HTMLElement>('[data-gamepad-detail-target]') ?? []].find(card => card.getAttribute('data-gamepad-detail-target') === returnTarget)?.focus({ preventScroll: true });
    }
    wasOpen.current = detailVisible;
  }, [detailVisible, returnTarget]);
  useEffect(() => { if (!selectedId && data.games[0]) setSelectedId(data.games[0].id); }, [data.games, selectedId]);
  useEffect(() => {
    if (!selection || !data.games.some(game => game.id === selection.id)) return;
    if (!detailOpen) savedScroll.current = pageRef.current?.closest('.page-scroll')?.scrollTop ?? 0;
    setSelectedId(selection.id);
    setCatalogSelection(undefined);
    setMenu(undefined);
    setDetailOpen(true);
    returnHomeKey.current = selection.returnHomeKey;
    onSelectionHandled?.(selection);
  }, [selection]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-game-menu], [data-game-menu-trigger]')) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', escape); };
  }, [menu]);

  function openMenu(game: Game, x: number, y: number) {
    setSelectedId(game.id);
    setMenu({ id: game.id, x: Math.max(8, Math.min(x, window.innerWidth - 230)), y: Math.max(8, Math.min(y, window.innerHeight - 380)) });
  }

  function openDialog(game: Game, kind: 'settings' | 'remove') {
    setMenu(undefined);
    setEditTitle(game.title);
    setEditLocale(game.locale ?? '');
    setEditRuntime(game.runtime ?? 'default');
    setEditTools({ ...defaultLaunchTools, ...game.launchTools });
    setLocaleOptions([]);
    const request = ++localeRequest.current;
    if(kind==='settings')void window.launcher.getRuntimeFamilies().then(families=>{if(request===localeRequest.current){setRuntimeChoices(families);}}).catch(error=>{if(request===localeRequest.current){setRuntimeChoices([]);toast({kind:'error',message:errorMessage(error)});}});
    if (kind === 'settings') void window.launcher.getGameLocales(game.id).then(locales => {
      if (request === localeRequest.current) setLocaleOptions(locales);
    }).catch((error) => { if (request === localeRequest.current) toast({ kind: 'error', message: errorMessage(error) }); });
    setDialogGame({ id: game.id, kind });
  }

  async function saveGameSettings(event: FormEvent) {
    event.preventDefault();
    if (!dialogGame) return;
    setDialogBusy(true);
    try {
      await window.launcher.updateGame(dialogGame.id, { title: editTitle.trim(), locale: editLocale, launchTools: normalizeLaunchTools(editTools), runtime:editRuntime });
      toast({ kind: 'success', message: ui("ui.game_settings_saved_7f466a5") });
      setDialogGame(undefined);
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setDialogBusy(false); }
  }

  async function removeGame(mode: 'library' | 'delete-files') {
    if (!dialogGame) return;
    setDialogBusy(true);
    try {
      await window.launcher.removeGame(dialogGame.id, mode);
      setSelectedId(undefined);
      setDialogGame(undefined);
      toast({ kind: 'success', message: mode === 'library' ? ui("ui.removed_from_library_game_files_were_kept_b10c04d") : ui("ui.game_files_permanently_deleted_4ec9b74") });
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setDialogBusy(false); }
  }

  async function importGame() {
    try {
      const game = await window.launcher.importGame();
      if (game) { setSelectedId(game.id); toast({ kind: 'success', message: ui("ui.imported_c53ba2c", { game: game.title }) }); }
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }

  async function play() {
    if (!selected) return;
    try { await window.launcher.launchGame(selected.id); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }

  async function stopGame() {
    try { await window.launcher.cancelGame(); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }

  async function installVc(game: Game) {
    try {
      await window.launcher.installGameVcRuntime(game.id);
      toast({ kind: 'success', message: ui("ui.microsoft_vc_is_ready_in_this_game_s_proton_pref_9cbdc2b") });
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }

  async function updateInstalledGame(game = selected) {
    if (!game || !await confirm({ title: ui("ui.update_2d9a578", { game: game.title }), message: ui("ui.xodus_may_replace_changed_game_files_in_place_do_499b40f"), confirmLabel: ui("ui.update_game_60a47ea") })) return;
    try {
      await window.launcher.updateInstalledGame(game.id);
      toast({ kind: 'success', message: ui("ui.update_started_for_see_install_queue_65bfe0f", { game: game.title }) });
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }

  async function checkUpdates(id?: string) {
    try { await window.launcher.checkGameUpdates(id); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }
  async function openDiagnosticLog(id: string) {
    try { setDiagnosticLog({ log: await window.launcher.readDiagnosticLog(id), operationId: id }); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }

  const selectedOperation = selected && data.gameOperation?.gameId === selected.id ? data.gameOperation : undefined;
  const gameBusy = Boolean(selectedOperation && ['preparing', 'running', 'stopping'].includes(selectedOperation.status));
  const selectedRuntimeReady=useGameRuntimeReady(selected,data);
  const launchOptions = useGameLaunchOptions(selected, data);
  const menuGame = data.games.find((game) => game.id === menu?.id);
  const modalGame = data.games.find((game) => game.id === dialogGame?.id);
  const modalRef = useRef<HTMLElement>(null);
  useDialogFocus(modalRef, () => setDialogGame(undefined), Boolean(dialogGame && modalGame), dialogBusy);
  const managementProps = (game: Game): GameMenuActionsProps => ({
    game, options: launchOptions, busy: gameBusy,
    onBrowse: () => { setMenu(undefined); void window.launcher.openPath(game.path).catch(error => toast({ kind: 'error', message: errorMessage(error) })); },
    onSettings: () => openDialog(game, 'settings'),
    onInstallVc: () => { setMenu(undefined); void installVc(game); },
    onRemove: () => openDialog(game, 'remove'),
    onShortcut: destination => {
      setMenu(undefined);
      void (destination === 'steam' ? window.launcher.addToSteam(game.id) : window.launcher.createGameShortcut(game.id, destination))
        .then(() => toast({ kind: 'success', message: destination === 'steam' ? ui("ui.game_added_to_steam_with_available_artwork_10de13f") : destination === 'desktop' ? ui("ui.desktop_shortcut_created_your_desktop_may_ask_yo_0940fc6") : ui("ui.game_added_to_applications_menu_5179a1d") }))
        .catch(error => toast({ kind: 'error', message: errorMessage(error) }));
    },
    onUpdate: () => { setMenu(undefined); if (game.updateIncomplete || data.gameUpdates?.[game.id]?.available) void updateInstalledGame(game); else void checkUpdates(game.id); },
    updateLabel: game.updateIncomplete ? ui('downloads.resume_update') : data.gameUpdates?.[game.id]?.checking ? ui("ui.checking_ec963ff") : data.gameUpdates?.[game.id]?.available ? ui("ui.update_game_60a47ea") : ui("ui.check_for_updates_f26f327"),
    updateDisabled: Boolean(data.gameUpdates?.[game.id]?.checking || !game.storeId || game.installState !== 'ready' && !game.updateIncomplete || !data.backend.capabilities.streaming || data.downloads.some(task => ['running', 'queued', 'paused'].includes(task.status) && (task.gameId === game.id))),
    onContent: () => { setMenu(undefined); setContentGameId(game.id); },
    contentDisabled: !game.storeId || data.auth.stored !== true || !data.backend.capabilities.library,
  });
  const selectedPanel = catalogProduct&&detailVisible?<CatalogGameDetails key={catalogProduct.productId+catalogScope} product={catalogProduct} data={data} back={closeDetails} toast={toast}/>:!catalogSelection&&selected&&detailVisible ? <GameDetails key={`${selected.id}:${data.auth.username}:${data.auth.player}:${data.auth.stored}:${data.auth.running}:${data.backend.binaryPath}:${data.settings.market}`} game={selected} data={data} back={closeDetails} backLabel={returnHomeKey.current ? ui('game.back_to_home') : undefined} play={<>
          <button className="primary" data-gamepad-play disabled={gameBusy || selected.installState !== 'ready' || !data.backend.capabilities.run || !selectedRuntimeReady} onClick={() => play()}>{gameBusy ? <LoaderCircle className="spin" /> : <Play fill="currentColor" />}{gameBusy ? ui("ui.working_5474eef") : ui("ui.play_436e610")}</button>
          {gameBusy && !(selectedOperation?.kind === 'prerequisite' && selectedOperation.status === 'running') ? <button className="secondary danger" onClick={stopGame}><X />{ui("ui.stop_cae7d57")}</button> : null}
        </>} manage={<GameMenuActions {...managementProps(selected)} />} technical={<dl><div><dt>{ui("ui.store_id_4a3eac6")}</dt><dd>{selected.storeId ?? ui("ui.not_found_e3ebaa1")}</dd></div><div><dt>{ui("ui.executable_72cd8a6")}</dt><dd>{selected.executable ?? ui("ui.not_found_e3ebaa1")}</dd></div><div><dt>{ui("ui.location_15b6197")}</dt><dd>{selected.path}</dd></div></dl>} notices={<>
      {selected.installMessage ? <div className="alert amber"><CircleAlert /><span>{uiText(selected.installMessage)}</span></div> : null}
      <div className="game-update-status">{data.gameUpdates?.[selected.id]?.available ? <p className="success-text">{ui("ui.update_available_0ed88ac")}{' '}{selected.installedVersion ?? ui('game.installed_version')} → {data.gameUpdates[selected.id].latestVersion}</p> : data.gameUpdates?.[selected.id]?.available === false ? <p>{ui("ui.up_to_date_0aa8a28")}{' '}{data.gameUpdates[selected.id].latestVersion}</p> : null}{data.gameUpdates?.[selected.id]?.error ? <p className="error-text">{uiText(data.gameUpdates[selected.id].error)}</p> : null}</div>
      {selectedOperation ? <details key={selectedOperation.id} className={`game-operation ${selectedOperation.status}`}><summary><strong>{selectedOperation.kind === 'prerequisite' ? selectedOperation.status === 'failed' ? ui("ui.prerequisite_failed_6280cb4") : selectedOperation.status === 'complete' ? ui("ui.prerequisite_ready_69e19bb") : ui("ui.installing_prerequisite_5a71466") : selectedOperation.status === 'failed' ? ui("ui.launch_failed_1755d50") : selectedOperation.status === 'complete' ? ui("ui.game_exited_f7bab8a") : ui("ui.launching_game_1f36888")}</strong><span>{uiText(selectedOperation.phase)}</span></summary>{selectedOperation.log.length > 0 ? <pre>{selectedOperation.log.slice(-12).join('\n')}</pre> : null}{selectedOperation.logPath ? <button className="secondary" onClick={() => openDiagnosticLog(selectedOperation.id)}><FolderOpen />{ui("ui.open_diagnostic_log_56966bb")}</button> : null}</details> : null}
    </>} /> : null;
  return <main ref={pageRef} className={`page library-page${detailVisible ? ' library-detail-open' : ''}`}>
    <div hidden={detailVisible}>
    <header className="page-header" data-gamepad-library-header><div><h1>{ui("ui.my_library_d931dba")}</h1><p>{ui("ui.your_owned_games_game_pass_games_and_local_insta_ebb2bf4")}</p></div><div className="button-row"><button className="secondary" disabled={data.auth.stored !== true || gameBusy || Object.values(data.gameUpdates ?? {}).some(update => update.checking)} onClick={() => checkUpdates()}><RefreshCw />{ui("ui.check_game_updates_11270a1")}</button>{Object.values(data.gameUpdates ?? {}).some(update => update.checking) ? <button className="secondary" onClick={() => void window.launcher.stopGameUpdateCheck().catch(error => toast({ kind: 'error', message: errorMessage(error) }))}><X />{ui('library.stop_update_check')}</button> : null}<button className="secondary" onClick={importGame}><Plus />{ui("ui.import_game_692bcb8")}</button></div></header>
    <div className="library-layout">
      <AccountGamesForUser data={data} toast={toast} filters={filters} onFiltersChange={onFiltersChange} selectedId={selected?.id} select={selectGame} menu={openMenu} openProduct={selectProductDetails} />
    </div>
    </div>
    {selectedPanel}
    {menu && menuGame ? <GameContextMenu x={menu.x} y={menu.y} {...managementProps(menuGame)} /> : null}
{diagnosticLog ? <DiagnosticDialog log={diagnosticLog.log} close={() => setDiagnosticLog(undefined)} revealFile={() => window.launcher.revealDiagnosticLog(diagnosticLog.operationId)} copyLog={() => window.launcher.copyDiagnosticLog(diagnosticLog.operationId)} /> : null}
    {contentGameId && data.games.find(game => game.id === contentGameId) ? <GameContentDialog key={`${contentGameId}:${data.auth.username}:${data.auth.stored}`} game={data.games.find(game => game.id === contentGameId)!} data={data} close={() => setContentGameId(undefined)} toast={toast} /> : null}
    {dialogGame && modalGame ? <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !dialogBusy) setDialogGame(undefined); }}><section ref={modalRef} className="game-dialog" role="dialog" aria-modal="true" aria-label={dialogGame.kind === 'remove' ? ui("ui.remove_d2f6b9b", { name: modalGame.title }) : ui("ui.settings_for_9d9bd70", { game: modalGame.title })}>
      {dialogGame.kind === 'remove' ? <GameRemovalContents game={modalGame} busy={dialogBusy} close={() => setDialogGame(undefined)} remove={mode => { void removeGame(mode); }} /> : <form onSubmit={saveGameSettings}>
        <h2>{ui("ui.game_settings_fece860")}</h2>
        <label>{ui("ui.display_name_2b7f6a8")}<input data-gamepad-initial required value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>
        <GameLanguage value={editLocale} locales={localeOptions} onChange={setEditLocale} />
        <GameRuntimeFields value={editRuntime} installed={runtimeChoices} change={setEditRuntime}/>
        <GameLaunchToolFields value={editTools} change={setEditTools} />
        <div className="dialog-actions"><button type="button" className="secondary" disabled={dialogBusy} data-gamepad-cancel onClick={() => setDialogGame(undefined)}>{ui("ui.cancel_19766ed")}</button><button className="primary" disabled={dialogBusy || !editTitle.trim()}><Check />{ui("ui.save_1509f56")}</button></div>
      </form>}
    </section></div> : null}
  </main>;
}

export function DownloadsPage({ data, toast }: { data: AppSnapshot; toast: (value: Toast) => void }) {
  const startPackageInstall = usePackageInstall();
  const [expanded, setExpanded] = useState<string>();
  const [retrying, setRetrying] = useState<string>();
  const [cancelId, setCancelId] = useState<string>(), [cancelOptions, setCancelOptions] = useState<DownloadCancelOptions>();
  const [checkingCancel, setCheckingCancel] = useState(false), [cancelling, setCancelling] = useState(false), [cancelError, setCancelError] = useState<string>();
  const cancelTask = data.downloads.find(task => task.id === cancelId);
  useEffect(() => {
    if (!cancelId) return;
    let current = true; setCancelOptions(undefined); setCheckingCancel(true); setCancelError(undefined);
    void window.launcher.getDownloadCancelOptions(cancelId).then(options => { if (current) setCancelOptions(options); })
      .catch(() => { if (current) setCancelOptions({ deleteFilesAllowed: false, reason: ui("ui.file_ownership_could_not_be_verified_you_can_sti_068f796") }); })
      .finally(() => { if (current) setCheckingCancel(false); });
    return () => { current = false; };
  }, [cancelId]);
  async function cancel(mode: 'keep' | 'delete-files') {
    if (!cancelId || cancelling) return;
    setCancelling(true); setCancelError(undefined);
    try { await window.launcher.cancelDownload(cancelId, mode); setCancelId(undefined); toast({ kind: 'success', message: mode === 'delete-files' ? ui("ui.download_cancelled_downloaded_files_were_deleted_f3814b8") : ui("ui.download_cancelled_files_were_kept_a322a2b") }); }
    catch (error) { setCancelError(errorMessage(error)); }
    finally { setCancelling(false); }
  }
  async function pauseOrResume(task: AppSnapshot['downloads'][number]) {
    try {
      if (task.status === 'paused') await window.launcher.resumeDownload(task.id);
      else await window.launcher.pauseDownload(task.id);
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }
  async function remove(id: string) {
    try { await window.launcher.removeDownload(id); if (expanded === id) setExpanded(undefined); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }
  async function clearFinished() {
    try { await window.launcher.clearFinishedDownloads(); setExpanded(undefined); toast({ kind: 'success', message: ui("ui.finished_queue_entries_cleared_game_files_were_k_230b4d1") }); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }
  async function retry(task: AppSnapshot['downloads'][number]) {
    setRetrying(task.id);
    try {
      if (task.kind === 'update' && task.gameId) await window.launcher.updateInstalledGame(task.gameId);
      else if (task.kind === 'content') {
        if (!task.gameId) throw Error("This content download has no parent game.");
        await window.launcher.installGameContent(task.gameId, task.productId);
      }
      else if (!await startPackageInstall({ productId: task.productId, title: task.title, destination: task.destination })) return;
      toast({ kind: 'success', message: ui("ui.retrying_with_xodus_a30763a", { game: task.title }) });
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setRetrying(undefined); }
  }

  const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
  const finishedCount = data.downloads.filter((task) => !['running', 'paused', 'queued'].includes(task.status)).length;
  const ordered = [
    ...data.downloads.filter(task => task.status === 'running' || task.status === 'paused'),
    ...data.downloads.filter(task => task.status === 'queued').reverse(),
    ...data.downloads.filter(task => !['running', 'paused', 'queued'].includes(task.status)),
  ];
  return <main className="page downloads-page">
    <header className="page-header"><div><h1>{ui("ui.install_queue_128d2c9")}</h1></div>{finishedCount ? <button className="secondary" disabled={data.downloads.some(task => task.cancelling)} onClick={clearFinished}><Trash2 />{ui("ui.clear_finished_2a16b4f")}</button> : null}</header>
    {data.downloadProgressSupported === false ? <div className="alert amber"><CircleAlert /><span>{ui("ui.update_the_nexus_backend_in_settings_for_numeric_0385fd0")}</span></div> : null}
    {data.downloads.length === 0 ? <div className="empty-state"><div><Download /></div><h2>{ui("ui.nothing_in_the_queue_ef2b1ef")}</h2><p>{ui("ui.installations_started_from_store_will_appear_her_a8638da")}</p></div> : <div className="download-list">{ordered.map((task) => {
      const running = task.status === 'running'; const paused = task.status === 'paused'; const queued = task.status === 'queued'; const active = running || paused || queued; const failed = task.status === 'failed';
      return <article className={`download-item ${task.status}`} key={task.id}>
        <div className="download-status">{task.coverUrl ? <img className="download-cover" src={task.coverUrl} alt={ui("ui.artwork_1bf7d06", { game: task.title })} /> : running ? <LoaderCircle className="spin" /> : queued ? <Clock3 /> : paused ? <Pause /> : failed ? <CircleAlert /> : task.status === 'complete' ? <PackageCheck /> : <X />}{task.coverUrl && (running || failed) ? <span className={`download-badge ${failed ? 'failed' : ''}`}>{running ? <LoaderCircle className="spin" /> : <CircleAlert />}</span> : null}</div>
        <div className="download-main"><div className="download-heading"><div><h3>{task.kind === 'update' ? ui("ui.update_dfb8b4a", { game: task.title }) : task.title}</h3><span>{task.productId} · {task.destination}</span></div><strong>{task.progress === null ? (running ? ui("ui.active_9234069") : task.status) : `${Math.round(task.progress)}%`}</strong></div><div className={`progress-track ${task.progress === null && running ? 'indeterminate' : ''}`}><i style={task.progress !== null ? { width: `${task.progress}%` } : undefined} /></div><p className={failed ? 'error-text' : ''}>{uiText(task.error ?? task.phase)}{task.totalBytes ? ` · ${size(task.downloadedBytes ?? 0)} / ${size(task.totalBytes)}` : ''}{task.reusedBytes !== undefined ? ` · ${ui('downloads.reused_and_network',{reused:size(task.reusedBytes),network:size(task.networkBytes??0)})}` : ''}{task.transferRate ? ` · ${task.transferRate}` : ''}{running && estimateTimeRemaining(task.transferRate, task.downloadedBytes, task.totalBytes) ? ` · ${localizedTimeRemaining(estimateTimeRemaining(task.transferRate, task.downloadedBytes, task.totalBytes))}` : ''}</p>{expanded === task.id ? <pre className="task-log">{task.log.length ? task.log.join('\n') : ui("ui.xodus_has_not_emitted_text_output_yet_31c3664")}</pre> : null}</div>
        <div className="download-actions">{active ? <>{!queued ? <button disabled={task.cancelling || !task.canPause || task.controlPending} onClick={() => pauseOrResume(task)} title={paused ? ui("ui.resume_download_808463a") : task.canPause ? ui("ui.pause_download_13bbded") : ui("ui.pause_is_available_while_downloading_game_files_04c9c46")}>{task.controlPending ? <LoaderCircle className="spin" /> : paused ? <Play /> : <Pause />}</button> : null}<button disabled={task.cancelling} onClick={() => setCancelId(task.id)} title={ui("ui.cancel_download_de5b23e")}>{task.cancelling ? <LoaderCircle className="spin" /> : <X />}</button></> : null}{failed || task.status === 'cancelled' ? <button disabled={task.cancelling || Boolean(retrying) || (task.kind === 'update' || task.kind === 'content') && data.downloads.some((entry) => ['running', 'paused', 'queued'].includes(entry.status))} onClick={() => retry(task)} title={ui("ui.retry_installation_c427806")}><RefreshCw className={retrying === task.id ? 'spin' : ''} /></button> : null}<button onClick={() => setExpanded(expanded === task.id ? undefined : task.id)} title={ui("ui.show_log_34b6683")}><Terminal /></button><button onClick={() => window.launcher.openPath(task.destination)} title={ui("ui.open_folder_6a90840")}><FolderOpen /></button>{!active ? <button disabled={task.cancelling} onClick={() => remove(task.id)} title={ui("ui.remove_from_queue_c0b9d9e")}><Trash2 /></button> : null}</div>
      </article>;
    })}</div>}
    {cancelTask ? <DownloadCancelDialog task={cancelTask} options={cancelOptions} loading={checkingCancel} busy={cancelling || Boolean(cancelTask.cancelling)} error={cancelError} close={() => setCancelId(undefined)} choose={mode => { void cancel(mode); }} /> : null}
  </main>;
}

export function SettingsPage({ data, toast }: { data: AppSnapshot; toast: (value: Toast) => void }) {
  const confirm = useConfirmation();
  const [form, setForm] = useState<Settings>(data.settings);
  const previousSettings = useRef(data.settings);
  const [busy, setBusy] = useState<string>();
  const [accountManagement, setAccountManagement] = useState(data.settings.multiAccountEnabled === true);
  useEffect(() => setAccountManagement(data.settings.multiAccountEnabled === true), [data.settings.multiAccountEnabled]);
  const managingAccounts = accountManagement && data.auth.savedAccountsEnabled === true;
  const componentUpdatesDisabled = Boolean(busy)||data.auth.running||data.backend.updating||data.runtime.updating||Boolean(data.launcherUpdate?.updating)||Boolean(data.gameOperation&&['preparing','running','stopping'].includes(data.gameOperation.status))||data.downloads.some(task=>['queued','running','paused'].includes(task.status))||data.componentUpdates?.running===true;
  const componentUpdates = useComponentUpdates({
    data,
    disabled: componentUpdatesDisabled,
    onBusyChange: value=>setBusy(value?'component-updates':undefined),
    confirm,
  });
  async function showAccountManagement(enabled: boolean) {
    await window.launcher.updateSettings({ multiAccountEnabled: enabled });
    setAccountManagement(enabled);
    setForm(current => ({ ...current, multiAccountEnabled: enabled }));
  }
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = data.settings;
    setForm(current => reconcileSettingsDraft(current, previous, data.settings));
  }, [data.settings]);

  async function invoke(name: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(name);
    try { await fn(); if (success) toast({ kind: 'success', message: success }); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setBusy(undefined); }
  }
  async function importBackendArchive() {
    const directory = await window.launcher.chooseDirectory();
    if (!directory) return;
    await invoke('backend-import', () => window.launcher.importBackend(directory), ui('backend.local_installed'));
  }

  async function pick(kind: 'install' | 'runtime' | 'wine') {
    const selected = kind === 'wine'
      ? await window.launcher.chooseFile(form.winePath)
      : await window.launcher.chooseDirectory(kind === 'install' ? form.installRoot : form.runtimeRoot);
    if (selected) setForm((current) => ({ ...current, [kind === 'install' ? "installRoot" : kind === 'runtime' ? "runtimeRoot" : "winePath"]: selected }));
  }

  const caps = data.backend.capabilities;
  let cacheLimitValid = true;
  try { shaderCacheLimits(form.shaderCacheLimitGiB ?? DEFAULT_SHADER_CACHE_GIB); } catch { cacheLimitValid = false; }
  const overlay=xboxOverlaySettings(form);
  const savedOverlay=xboxOverlaySettings(data.settings);
  const overlayDirty=overlay.overlayEnabled!==savedOverlay.overlayEnabled||overlay.overlaySide!==savedOverlay.overlaySide||(form.overlayShortcut??savedOverlay.overlayShortcut)!==savedOverlay.overlayShortcut;
  const shortcutState=data.overlayShortcut?.state;
  const shortcutStatus=!savedOverlay.overlayEnabled?ui('settings.guide_shortcut_disabled'):shortcutState==='registered'?ui('settings.guide_shortcut_ready'):shortcutState==='unavailable'?data.overlayShortcut?.message??ui('settings.guide_shortcut_unavailable'):ui('settings.guide_shortcut_requested');
  return <main className="page settings-page">
    <header className="page-header"><div><h1>{ui("ui.settings_74a883a")}</h1></div></header>

    <section className="settings-card compact settings-language">
      <label>{ui('settings.interface_language')}<select value={form.interfaceLanguage ?? 'system'} onChange={event => setForm({ ...form, interfaceLanguage: event.target.value })}>
        <option value="system">{ui('settings.system_language')}</option>
        {interfaceLanguages.map(language => <option key={language} value={language}>{new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language}</option>)}
      </select></label>
      <div className="save-row"><button className="primary" disabled={Boolean(busy)} onClick={() => invoke('save-language', () => window.launcher.updateSettings({ interfaceLanguage: form.interfaceLanguage ?? 'system' }), ui('settings.language_saved'))}>{ui('settings.save_language')}</button></div>
    </section>

    <section className="settings-card compact tray-settings">
      <CheckField className="tray-toggle" role="switch" label={ui('settings.close_to_tray')} description={ui('settings.close_to_tray_help')} checked={form.closeToTray===true} disabled={Boolean(busy)} onChange={event=>{const closeToTray=event.target.checked;setForm({...form,closeToTray});void invoke('close-to-tray',()=>window.launcher.updateSettings({closeToTray}),ui('settings.tray_saved'));}}/>
    </section>

    <section className="settings-card compact launcher-card">
      {data.launcherUpdate?.phase ? <p>{uiText(data.launcherUpdate.phase)}</p> : null}
      {data.launcherUpdate?.updating ? <div className="progress-track"><i style={{ width: `${data.launcherUpdate.progress ?? 0}%` }} /></div> : null}
      {data.launcherUpdate?.error ? <div className="alert amber"><CircleAlert /><span>{uiText(data.launcherUpdate.error)}</span></div> : null}
      <div className="settings-heading"><div className="settings-icon"><Rocket /></div><div><span className="overline">NEXUS LAUNCHER</span><h2>{data.launcherUpdate?.currentVersion ?? ui("ui.development_build_63d499e")}</h2>{data.launcherUpdate?.latestVersion ? <p>{ui("ui.version_is_available_cc7c84d", { version: data.launcherUpdate.latestVersion })}</p> : null}</div></div>
      <div className="button-row">
        {data.launcherUpdate?.latestVersion && data.launcherUpdate.canInstall && !data.launcherUpdate.restartRequired ? <button className="primary" disabled={data.launcherUpdate.updating || Boolean(busy)} onClick={async () => { if (await confirm({ title: ui("ui.install_launcher_update_15498d2"), message: ui("ui.the_current_appimage_will_be_backed_up_games_and_8e8c5e5"), confirmLabel: ui("ui.install_update_cada421") })) void invoke('launcher-install', () => window.launcher.installLauncherUpdate()); }}><ArrowDownToLine />{data.launcherUpdate.updating ? ui("ui.updating_dfe40ef") : ui("ui.install_launcher_update_d1988d9")}</button> : null}
        {data.launcherUpdate?.releaseUrl && !data.launcherUpdate.canInstall ? <a className="primary" href={data.launcherUpdate.releaseUrl} target="_blank" rel="noreferrer"><ArrowDownToLine />{ui("ui.download_update_4f494b2")}</a> : null}
        {data.launcherUpdate?.restartRequired ? <button className="primary" disabled={Boolean(busy)||data.componentUpdates?.running} onClick={() => invoke('launcher-restart', () => window.launcher.restartLauncher())}><RefreshCw />{ui("ui.restart_launcher_b076da9")}</button> : null}
        {data.launcherUpdate?.canRollback ? <button className="secondary" disabled={data.launcherUpdate.updating || Boolean(busy)} onClick={async () => { if (await confirm({ title: ui("ui.restore_previous_launcher_ab5c227"), message: ui("ui.your_settings_and_games_will_not_change_3e99619"), confirmLabel: ui("ui.restore_launcher_a0520ac") })) void invoke('launcher-rollback', () => window.launcher.rollbackLauncherUpdate()); }}>{ui("ui.restore_previous_launcher_9b5f101")}</button> : null}
        <button className="secondary" disabled={componentUpdatesDisabled || data.launcherUpdate?.checking || data.launcherUpdate?.updating || data.launcherUpdate?.restartRequired} onClick={async () => {
          // The component plan already runs the launcher release discovery. A
          // blocked or stale discovery is not a failure and must not start a
          // second launcher-only check. Fall back once only when the real plan
          // failed or its launcher row is not covered.
          const discovery=await componentUpdates.discover();
          if(discovery.status==='blocked'||discovery.status==='stale')return;
          if(discovery.status==='plan'&&discovery.plan.items.some(item=>item.component==='launcher'&&(item.state==='ready'||item.state==='unchanged'))){
            toast({kind:'success',message:ui("ui.update_check_finished_3f30d8a")});
            return;
          }
          await invoke('update-check', () => window.launcher.checkLauncherUpdate(), ui("ui.update_check_finished_3f30d8a"));
        }}>{data.launcherUpdate?.checking ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui("ui.check_for_updates_f26f327")}</button>
        {componentUpdates.action}
        <button className="secondary" disabled={Boolean(busy)} title={ui("ui.add_nexus_with_artwork_including_while_steam_is_f7d03b8")} onClick={() => invoke('steam-launcher', () => window.launcher.addToSteam(), ui("ui.nexus_added_to_steam_2f6a699"))}><Plus />{ui("ui.add_nexus_to_steam_790c35e")}</button>
      </div>
      {componentUpdates.details}
    </section>

    <section className="settings-card account-card">
      <div className="settings-heading"><AccountAvatar auth={data.auth} large license={Boolean(data.auth.player)} /><div><span className="overline">{(managingAccounts || data.auth.player) && caps.playerAccount ? ui("auth.store_account") : ui("ui.microsoft_account_90f90f6")}</span><h2>{(data.auth.player ? data.auth.username : data.auth.gamertag ?? data.auth.username) ?? (data.auth.stored === false ? ui("ui.not_signed_in_491fc91") : ui("ui.account_status_unavailable_3b97a47"))}</h2><p>{data.auth.stored === true ? ui("ui.credentials_stored_by_xodus_bca3867") : ui("ui.authentication_uses_the_original_xodus_webview_cf2dcb9")}</p></div><span className={`status-label ${data.auth.stored === true ? 'ready' : data.auth.stored === false ? 'off' : 'unknown'}`}><StatusDot tone={data.auth.stored === true ? 'green' : data.auth.stored === false ? 'red' : 'amber'} />{data.auth.stored === true ? ui("ui.stored_1afc73e") : data.auth.stored === false ? ui("ui.signed_out_db8436b") : ui("ui.unknown_2375999")}</span></div>
      <div className="account-note"><CircleAlert /><span>{uiText(data.auth.note)}</span></div>
      <KeyringSetup compact disabled={data.auth.running} />
      <div className="button-row"><button className="primary" disabled={!caps.login || data.auth.running} onClick={() => invoke('login', () => window.launcher.login(), ui("ui.xodus_sign_in_completed_8240737"))}>{data.auth.running ? <LoaderCircle className="spin" /> : <LogIn />}{data.auth.stored ? ui("ui.sign_in_again_51fbe1d") : ui("ui.sign_in_with_xodus_252572f")}</button><button className="secondary" disabled={!caps.logout || data.auth.running || (data.auth.stored === false && !data.auth.player)} title={data.auth.savedAccountsEnabled === true ? ui("auth.sign_out_active_help") : caps.savedAccounts && data.auth.savedAccountsEnabled === undefined ? ui("auth.sign_out_unknown_help") : ui("ui.remove_saved_sign_in_credentials_and_local_devic_6485324")} onClick={() => invoke('logout', () => window.launcher.logout(), data.auth.savedAccountsEnabled === true ? ui("auth.active_signed_out") : caps.savedAccounts && data.auth.savedAccountsEnabled === undefined ? ui("auth.active_signed_out_unknown") : ui("ui.saved_sign_in_credentials_and_local_device_regis_c9738bd"))}>{data.auth.player ? ui("auth.sign_out_all") : ui("ui.sign_out_48f0d3d")}</button><button className="secondary" disabled={!caps.account || data.auth.running} onClick={() => invoke('account', () => window.launcher.refreshAccount())}><RefreshCw />{ui("ui.refresh_status_442c4b8")}</button></div>
      {!managingAccounts && data.auth.player ? <p className="fine-print account-player-summary">{ui("auth.active_player", { name: data.auth.player })}</p> : null}
      {managingAccounts || caps.savedAccounts ? <div className="button-row account-management-row"><button className="secondary" aria-expanded={managingAccounts} disabled={Boolean(busy) || data.auth.running} onClick={() => invoke('account-management', () => showAccountManagement(!managingAccounts))}>{managingAccounts ? ui("auth.hide_management") : ui("auth.manage_multiple")}</button></div> : null}
      {managingAccounts && (data.auth.saved?.length ?? 0) > 0 && caps.savedAccounts ? <div className="saved-accounts" role="list" aria-label={ui("ui.saved_store_accounts_a1c4e72")}>
      <span className="overline">{ui("ui.saved_store_accounts_a1c4e72")}</span>
      {data.auth.saved!.map(name => <div key={name} className="button-row" role="listitem">
        <strong title={name}>{name}</strong>
        {name === data.auth.username ? <span className="status-label ready">{ui("ui.account_in_use_5b09d3f")}</span>
          : <button className="secondary" disabled={data.auth.running} onClick={() => invoke('use-account', () => window.launcher.useAccount(name), ui("ui.account_switched_6a2e91c"))}>{ui("ui.use_this_account_e71c0a8")}</button>}
        <button className="secondary" disabled={data.auth.running || data.auth.stored === null} onClick={() => invoke('forget-account', () => window.launcher.forgetAccount(name), ui("ui.account_forgotten_c05d7e3"))}>{ui("ui.forget_account_3d8f6b1")}</button>
      </div>)}
      <small>{ui("ui.saved_store_accounts_help_94be2d0")}</small>
    </div> : null}
      <PasskeySignInNotice />
    </section>

    {managingAccounts && caps.playerAccount && (data.auth.stored === true || data.auth.player) ? <section className="settings-card account-card">
      <div className="settings-heading">{data.auth.player ? <AccountAvatar auth={data.auth} large /> : null}<div><span className="overline">{ui("ui.xbox_player_account_021c236")}</span><h2>{data.auth.player ? (data.auth.gamertag ? `${data.auth.gamertag} · ${data.auth.player}` : data.auth.player) : ui("ui.no_separate_player_account_44980b5")}</h2><p>{ui("ui.player_account_help_1d6f365")}</p></div></div>
      <div className="button-row">
        <button className="primary" disabled={data.auth.running} onClick={() => invoke('login-player', () => window.launcher.login(true), ui("ui.player_account_signed_in_ac36aa2"))}>{data.auth.player ? ui("auth.change_player_account") : ui("ui.sign_in_player_account_c15aa58")}</button>
        {data.auth.player ? <button className="secondary" disabled={data.auth.running} onClick={() => invoke('logout-player', () => window.launcher.logout(true), ui("ui.player_account_signed_out_6752e8f"))}>{ui("ui.sign_out_player_account_013bd34")}</button> : null}
      </div>
    </section> : null}

    {caps.offlinePc && !data.auth.running ? <OfflinePermissionsCard key={`${data.auth.username}:${data.auth.stored}:${data.backend.binaryPath}:${data.settings.runtimeRoot}`} toast={toast} signedIn={data.auth.stored === true} /> : null}

    <section className="settings-card">
      <div className="settings-heading"><div className="settings-icon"><Terminal /></div><div><h2>{ui("ui.xodus_backend_a99abd3")}</h2><p>{data.backend.version ? ui("ui.nexus_backend_909289e", { version: data.backend.version }) : data.backend.available ? ui("ui.backend_cli_02229de", { version: data.backend.capabilities.version ?? ui('settings.unknown_version') }) : ui("ui.install_the_prebuilt_nexus_backend_bd247cd")}{data.backend.delivery === 'local' ? ` · ${ui('backend.local_build')}` : ''}</p></div><span className={`status-label ${data.backend.available ? 'ready' : 'off'}`}><StatusDot tone={data.backend.available ? 'green' : 'red'} />{data.backend.available ? ui("ui.validated_3dac322") : ui("ui.offline_5c3ce8d")}</span></div>
      {data.backend.blockReason ? <div className="alert amber"><CircleAlert /><span>{uiText(data.backend.blockReason)}</span></div> : null}
      {data.backend.phase ? <p className="runtime-phase">{uiText(data.backend.phase)}</p> : null}
      <div className="backend-diagnostic-action"><BackendLogButton toast={toast} /><p className="fine-print">{ui("ui.local_operation_results_and_safe_error_codes_no_cd558f7")}</p></div>
      <div className="button-row end"><button className="secondary" disabled={Boolean(busy) || data.backend.checking || data.backend.updating} onClick={() => invoke('backend-check', () => window.launcher.checkBackendUpdate())}>{busy === 'backend-check' || data.backend.checking ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui("ui.check_for_updates_f26f327")}</button><button className="secondary" disabled={Boolean(busy) || data.backend.updating || data.backend.checking} onClick={() => void importBackendArchive()}>{busy === 'backend-import' ? <LoaderCircle className="spin" /> : <FolderOpen />}{ui('backend.install_from_archive')}</button>{data.backend.releaseAvailable && data.backend.updateAvailable ? <button className="primary" disabled={Boolean(busy) || data.backend.updating || data.backend.checking} onClick={() => invoke('backend-update', () => window.launcher.updateBackend(), ui("ui.the_nexus_backend_was_verified_installed_and_act_62d374e"))}>{busy === 'backend-update' || data.backend.updating ? <LoaderCircle className="spin" /> : <ArrowDownToLine />}{data.backend.available ? ui("ui.update_backend_bddcd8b") : ui("ui.install_backend_73e7239")}</button> : null}</div>
    </section>

    <ManagedRuntimeSettings data={data} disabled={componentUpdatesDisabled} onBusyChange={value=>setBusy(value?'managed-runtime':undefined)}/>

    <div className="settings-storage">
      <section className="settings-card compact">
        <div className="settings-heading"><div className="settings-icon"><HardDrive /></div><div><h2>{ui("ui.shader_cache_d7b5738")}</h2><p>{ui("ui.limit_mesa_and_nvidia_driver_caches_per_game_13f5b89")}</p></div></div>
        <div className="form-grid"><label>{ui("ui.driver_cache_limit_gib_acf77d9")}<input type="number" min="0.25" max="1024" step="0.25" aria-invalid={!cacheLimitValid} aria-describedby={!cacheLimitValid ? "cache-limit-error" : undefined} value={form.shaderCacheLimitGiB ?? DEFAULT_SHADER_CACHE_GIB} onChange={event=>setForm({...form,shaderCacheLimitGiB:Number(event.target.value)})} /></label></div>
        {!cacheLimitValid ? <p id="cache-limit-error" className="error-text" role="alert">{ui("settings.cache_limit_error")}</p> : null}<div className="save-row"><span>{ui("ui.default_4_gib_applies_on_the_next_game_launch_ex_d0a7298")}</span><button className="primary" disabled={Boolean(busy)||!cacheLimitValid} onClick={()=>invoke('save-shader-cache',()=>window.launcher.updateSettings({shaderCacheLimitGiB:form.shaderCacheLimitGiB ?? DEFAULT_SHADER_CACHE_GIB}),ui("ui.shader_cache_limit_saved_applies_on_the_next_gam_4ca411d"))}>{busy==='save-shader-cache'?<LoaderCircle className="spin" />:<Check />}{ui("ui.save_cache_limit_a1d0333")}</button></div>
      </section>
      <section className="settings-card compact">
        <div className="settings-heading"><div className="settings-icon"><Download /></div><div><h2>{ui("ui.downloads_d5fdc1a")}</h2><p>{ui("ui.limit_the_combined_game_download_speed_across_al_baea745")}</p></div></div>
        <div className="form-grid"><label>{ui("ui.download_speed_limit_mib_s_1b1cf51")}<input type="number" min="0" max="1024" step="0.1" value={form.downloadLimitMiB ?? 0} onChange={event => setForm({...form, downloadLimitMiB:Number(event.target.value)})} /></label></div>
        <div className="save-row"><span>{ui("ui.0_unlimited_applies_to_active_and_future_game_do_2374ba9")}</span><button className="primary" disabled={Boolean(busy) || Boolean((form.downloadLimitMiB ?? 0) > 0 && !data.backend.capabilities.streamingBandwidthLimit)} onClick={() => invoke('save-bandwidth', () => window.launcher.updateSettings({downloadLimitMiB:form.downloadLimitMiB ?? 0}), ui("ui.download_speed_limit_saved_8fd9160"))}>{busy === 'save-bandwidth' ? <LoaderCircle className="spin" /> : <Check />}{ui("ui.save_download_limit_8abf702")}</button></div>
      </section>
      <section className="settings-card compact"><div className="settings-heading"><div className="settings-icon"><HardDrive /></div><div><h2>{ui("ui.storage_and_launch_paths_d3c8c4d")}</h2></div></div><div className="form-grid"><label>{ui("ui.default_game_location_5e830cb")}<div className="input-action"><input value={form.installRoot} onChange={(event) => setForm({ ...form, installRoot: event.target.value })} /><button type="button" aria-label={ui('ui.browse_3227aa9')} onClick={() => pick('install')}><FolderOpen /></button></div></label><label>{ui("ui.market_5238d9b")}<input value={form.market} onChange={(event) => setForm({ ...form, market: event.target.value })} /></label><label>{ui("ui.parallel_streams_e81513c")}<input type="number" min="1" max="16" value={form.parallelDownloads} onChange={(event) => setForm({ ...form, parallelDownloads: Number(event.target.value) })} /></label><label>{ui("ui.versioned_runtime_directory_3764480")}<div className="input-action"><input value={form.runtimeRoot} onChange={(event) => setForm({ ...form, runtimeRoot: event.target.value })} /><button type="button" aria-label={ui('ui.browse_3227aa9')} onClick={() => pick('runtime')}><FolderOpen /></button></div></label><label>{ui("ui.wine_proton_binary_2b08a4a")}<div className="input-action"><input value={form.winePath} onChange={(event) => setForm({ ...form, winePath: event.target.value })} placeholder={ui("ui.selected_automatically_by_the_runtime_manager_0722211")} /><button type="button" aria-label={ui('ui.browse_3227aa9')} onClick={() => pick('wine')}><FolderOpen /></button></div></label></div><div className="save-row"><button className="primary" disabled={busy === 'save'} onClick={() => invoke('save', () => window.launcher.updateSettings(storageSettingsPatch(form)), ui("ui.settings_saved_ae493e2"))}>{busy === 'save' ? <LoaderCircle className="spin" /> : <Check />}{ui("ui.save_1509f56")}</button></div></section>
    </div>
    <details className="settings-card settings-guide" aria-label={ui('settings.guide_title')}>
      <summary><PanelLeft aria-hidden="true"/><span className="guide-summary-text"><strong>{ui('settings.guide_title')}</strong><small>{ui('settings.guide_summary')}</small></span><span className={`guide-state${savedOverlay.overlayEnabled?' on':''}`}>{savedOverlay.overlayEnabled?ui('settings.guide_on'):ui('settings.guide_off')}</span><ChevronRight aria-hidden="true"/></summary>
      <div className="guide-settings-content">
        <CheckField className="guide-enable" label={ui('settings.guide_enable')} description={ui('settings.guide_enable_help_short')} role="switch" checked={overlay.overlayEnabled} disabled={Boolean(busy)} onChange={event=>setForm({...form,overlayEnabled:event.target.checked})}/>
        <fieldset className="guide-settings-fields" disabled={!overlay.overlayEnabled||Boolean(busy)}>
          <legend className="social-sr-only">{ui('settings.guide_controls')}</legend>
          <label htmlFor="guide-shortcut"><span>{ui('settings.guide_shortcut')}</span><OverlayShortcutRecorder value={form.overlayShortcut??'Super+G'} onChange={overlayShortcut=>setForm(current=>({...current,overlayShortcut}))}/></label>
          <label htmlFor="guide-side"><span>{ui('settings.guide_side')}</span><select id="guide-side" value={overlay.overlaySide} onChange={event=>setForm({...form,overlaySide:event.target.value as 'left'|'right'})}><option value="left">{ui('settings.guide_left')}</option><option value="right">{ui('settings.guide_right')}</option></select><small>{ui('settings.guide_side_help')}</small></label>
        </fieldset>
        <div className="guide-settings-footer"><p role="status">{savedOverlay.overlayEnabled?<StatusDot tone={shortcutState==='registered'?'green':'amber'}/>:<span className="guide-disabled-dot" aria-hidden="true"/>}<span>{uiText(shortcutStatus)}</span></p><button className="secondary" disabled={Boolean(busy)||!overlayDirty} onClick={()=>invoke('save-overlay',()=>window.launcher.updateSettings({overlayEnabled:overlay.overlayEnabled,overlayShortcut:form.overlayShortcut??'Super+G',overlaySide:overlay.overlaySide}),ui('settings.guide_saved'))}>{busy==='save-overlay'?<LoaderCircle className="spin"/>:<Check/>}{ui('settings.guide_save')}</button></div>
      </div>
    </details>
    <details className="settings-card settings-diagnostics">
      <summary><Settings2 /><span>{ui("ui.advanced_diagnostics_2130ca1")}</span><ChevronRight /></summary>
      <div className="diagnostics-content">
        <DiagnosticReportButton games={data.games} />
        <section><h3>{ui("ui.game_logging_6cb644e")}</h3><div className="toggle-row"><CheckField className="toggle" label={ui("ui.verbose_game_logs_58e750b")} description={ui("ui.writes_full_wine_vkd3d_proton_and_xodus_diagnost_dfa1fa3")} checked={form.verboseLogs} onChange={(event) => setForm({ ...form, verboseLogs: event.target.checked })} /></div><div className="button-row"><button className="secondary" disabled={Boolean(busy)} onClick={() => invoke('save-diagnostics', () => window.launcher.updateSettings({ verboseLogs: form.verboseLogs }), ui("ui.logging_settings_saved_5a9dd67"))}>{ui("ui.save_diagnostics_52fe7bd")}</button></div></section>
      </div>
    </details>
  </main>;
}

function backendSetupHint(backend: AppSnapshot['backend']): string {
  if (backend.checking || backend.updating) return ui("ui.preparing_sign_in_cdca952");
  if (backend.blockReason) return backend.blockReason;
  return ui("ui.preparing_sign_in_cdca952");
}

function PasskeySignInNotice() {
  return <p className="passkey-sign-in-notice">{ui("ui.passkey_sign_in_requires_google_chrome_installed_f583e8a")}</p>;
}

export function FirstRunWizard({ data, toast }: { data: AppSnapshot; toast: (value: Toast) => void }) {
  const wizardRef = useRef<HTMLDivElement>(null);
  useDialogFocus(wizardRef, () => {}, true, true);
  const [installRoot, setInstallRoot] = useState(data.settings.installRoot);
  const [saving, setSaving] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [installingBackend, setInstallingBackend] = useState(false);

  async function retryBackend() {
    setInstallingBackend(true);
    try { await window.launcher.updateBackend(); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setInstallingBackend(false); }
  }

  async function browse() {
    try {
      const picked = await window.launcher.chooseDirectory(installRoot);
      if (picked) setInstallRoot(picked);
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
  }
  async function signIn() {
    setSigningIn(true);
    try { await window.launcher.login(); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setSigningIn(false); }
  }
  async function finish() {
    setSaving(true);
    try {
      await window.launcher.updateSettings({ installRoot, firstRunCompleted: true });
      toast({ kind: 'success', message: ui("ui.welcome_to_xodus_nexus_install_a_game_from_the_s_0988d7d") });
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setSaving(false); }
  }

  return <div className="wizard-overlay">
    <div ref={wizardRef} className="wizard" role="dialog" aria-modal="true" aria-label={ui("ui.set_up_xodus_nexus_e3954fb")}>
      <div><span className="overline">{ui("ui.welcome_26ded03")}</span><h1>{ui("ui.set_up_xodus_nexus_e3954fb")}</h1></div>
      <section className="wizard-disclaimer" role="note" aria-labelledby="wizard-disclaimer-title">
        <CircleAlert aria-hidden="true" />
        <div><h2 id="wizard-disclaimer-title">{ui("ui.independent_unofficial_project_4197cf7")}</h2>
          <p>{ui("ui.xodus_nexus_is_built_on_xodus_but_it_is_551be13")}{' '}<strong>{ui("ui.not_an_official_xodus_project_d61df4f")}</strong>{' '}{ui("ui.and_is_not_developed_or_maintained_by_the_upstre_af143ff")}</p>
          <p>{ui("ui.please_report_nexus_issues_only_in_the_c9de146")}{' '}<a href="https://github.com/domsvoboda/nexus-launcher/issues" target="_blank" rel="noopener noreferrer">{ui("ui.nexus_repository_068a220")}</a>{ui("ui.not_upstream_a_problem_in_nexus_may_not_exist_in_e123052")}</p>
        </div>
      </section>
      <p>{ui("ui.choose_where_games_install_everything_else_can_b_5cfa4a3")}</p>
      <label className="wizard-field">{ui("ui.games_folder_4253203")}<div className="input-action"><input data-gamepad-initial value={installRoot} onChange={(event) => setInstallRoot(event.target.value)} /><button onClick={() => void browse()} title={ui("ui.browse_3227aa9")}><FolderOpen /></button></div>
        <small>{ui("ui.new_games_download_and_extract_into_this_folder_a8af21b")}</small>
      </label>
      <KeyringSetup compact disabled={signingIn || data.auth.running || data.backend.updating || installingBackend} />
      <div className="wizard-account">
        <div><strong>{ui("ui.microsoft_account_6c2b1f2")}</strong><small>{data.backend.available ? (data.auth.stored === true ? ui("ui.signed_in_as_d7e6f22", { name: data.auth.username ?? ui('settings.stored_account') }) : data.auth.stored === false ? ui("ui.not_signed_in_yet_store_browsing_works_without_a_99f0bcc") : ui("ui.account_status_is_still_being_checked_3a41b4e")) : backendSetupHint(data.backend)}</small></div>
        {!data.backend.available&&data.backend.blockReason&&!data.backend.checking&&!data.backend.updating?<button className="secondary" disabled={installingBackend||signingIn||data.auth.running} onClick={()=>void retryBackend()}>{ui("ui.retry_setup_8e08720")}</button>:null}
        <button className="secondary" disabled={!data.backend.available || !data.backend.capabilities.login || data.backend.updating || installingBackend || signingIn || data.auth.running} onClick={() => void signIn()}>{signingIn ? <LoaderCircle className="spin" /> : <LogIn />}{data.auth.stored ? ui("ui.sign_in_again_51fbe1d") : ui("ui.sign_in_bfd402b")}</button>
      </div>
      <div className="wizard-actions">
        <PasskeySignInNotice />
        <span>{ui("ui.signing_in_can_also_be_done_later_from_settings_7753fd0")}</span>
        <button className="primary" disabled={saving} onClick={() => void finish()}>{saving ? <LoaderCircle className="spin" /> : <Check />}{ui("ui.start_using_xodus_nexus_0eef2be")}</button>
      </div>
    </div>
  </div>;
}

export function GlobalSearch({ games, page, query, change, submit, select }: {
  games: Game[]; page: Page; query: string; change: (value: string) => void;
  submit: (value: string) => void; select: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [page]);
  const term = query.trim().toLowerCase();
  const results = term ? games.filter(game => `${game.title} ${game.storeId ?? ''}`.toLowerCase().includes(term)) : [];
  const visible = open && page !== 'store' && (results.length > 0 || term.length >= 2);
  return <div className="search-box" onFocus={() => setOpen(true)} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); change(''); }
  }}><Search /><input value={query} onChange={event => { change(event.target.value); setOpen(true); }} onKeyDown={event => {
    if (event.key === 'Enter' && term.length >= 2) { setOpen(false); submit(query.trim()); }
  }} aria-expanded={visible} aria-controls={visible ? 'global-search-results' : undefined} placeholder={ui("ui.search_games_add_ons_and_your_library_55858e9")} />
    {query ? <button aria-label={ui("ui.clear_search_3b7ea51")} onClick={() => { change(''); setOpen(false); }}><X /></button> : null}
    {visible ? <div className="search-results" id="global-search-results">{results.map(game => <button key={game.id} onClick={() => { setOpen(false); change(''); select(game.id); }}><Cover game={game} /><span><GameTitle title={game.title} /><small>{game.storeId ?? game.path}</small></span></button>)}
      {term.length >= 2 ? <button className="search-all-results" onClick={() => { setOpen(false); submit(query.trim()); }}><Search aria-hidden="true"/><span>{ui('ui.search_49c266b')}</span></button> : null}
    </div> : null}
  </div>;
}

export default function App() {
  const [page, setPage] = useState<Page>(() => window.location.hash === '#store' ? 'store' : 'home');
  const [data, setData] = useState<AppSnapshot>(emptySnapshot);
  useInterfaceLanguage(data.settings.interfaceLanguage);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>();
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [socialOpen,setSocialOpen]=useState(false),[socialMounted,setSocialMounted]=useState(false);
  const [searchRequest, setSearchRequest] = useState(0);
  useBrowserLayoutEffect(() => {
    if (!searchRequest) return;
    const input = document.querySelector<HTMLInputElement>('.search-box input');
    if (!input) return;
    input.focus({ preventScroll: true });
    void requestTextKeyboard(window, input, field => window.launcher.showTouchKeyboard(field)).catch(() => {});
  }, [searchRequest]);
  const [socialChat,setSocialChat]=useState<{id:number;xuid:string;identity:string}>();
  const notifications=useNotifications(data);
  const [desktopProfile,setDesktopProfile]=useState<XboxProfileRequest>();
  // App stays mounted while pages change, unlike LibraryPage/AccountGames.
  const [libraryFilters, setLibraryFilters] = useState<LibraryFilters>(() => loadLibraryFilters());
  const [librarySelection, setLibrarySelection] = useState<LibrarySelection>();
  const [homeReturnKey, setHomeReturnKey] = useState<string>();
  useBrowserLayoutEffect(() => {
    if (page !== 'home' || !homeReturnKey) return;
    [...document.querySelectorAll<HTMLElement>('[data-gamepad-key]')].find(element => element.dataset.gamepadKey === homeReturnKey)?.focus({ preventScroll: true });
    setHomeReturnKey(undefined);
  }, [page, homeReturnKey]);
  useEffect(() => window.launcher.onOpenFriends(() => {setSocialMounted(true);setSocialOpen(true);}), []);
  useEffect(()=>window.launcher.onLauncherPage(next=>{if(['home','library','store','settings'].includes(next))go(next);}),[]);

  useEffect(() => {
    void window.launcher.getSnapshot().then((value) => { setData(value); setLoading(false); }).catch((error) => { setToast({ kind: 'error', message: errorMessage(error) }); setLoading(false); });
    return window.launcher.onSnapshot(setData);
  }, []);
  useEffect(()=>{
    if(window.location.hash==='#social-desktop')return;
    let alive=true,received=false;
    const accept=(request:XboxProfileRequest|undefined)=>{if(!alive)return;setDesktopProfile(request);if(request){setPage('social');setSocialOpen(false);}};
    const unsubscribe=window.launcher.onXboxDesktopProfile(request=>{received=true;accept(request);});
    void window.launcher.getXboxDesktopProfile().then(request=>{if(!received)accept(request);}).catch(()=>{});
    return()=>{alive=false;unsubscribe();};
  },[]);
  useEffect(()=>{
    if(!socialOpen)return;
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setSocialOpen(false);}};
    document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close);
  },[socialOpen]);
  function go(next:Page){
    if(next==='social'){setSocialMounted(true);setSocialOpen(open=>!open);return;}
    setLibrarySelection(undefined);setSocialOpen(false);setPage(next);
  }
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(undefined), 5000); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    // XODUS_DEMO_TOUR=1 cycles through the pages for screenshot capture.
    if (!window.launcher.isDemoTour()) return;
    const order: Page[] = ['home', 'library', 'store', 'downloads', 'settings'];
    let index = 0;
    const timer = window.setInterval(() => { index = (index + 1) % order.length; setPage(order[index]); }, 7000);
    return () => window.clearInterval(timer);
  }, []);


  function changeLibraryFilters(filters: LibraryFilters) {
    setLibraryFilters(filters);
    if (!saveLibraryFilters(filters)) setToast({ kind: 'error', message: ui("ui.library_filters_could_not_be_saved_they_may_rese_262002e") });
  }

  function openLibraryGame(id: string, returnHomeKey?: string) {
    if (!data.games.some(game => game.id === id)) return;
    setLibrarySelection({ id, returnHomeKey });
    setSearch('');
    changeLibraryFilters({ ...defaultLibraryFilters, playState: 'installed' });
    setSocialOpen(false);setPage('library');
  }

  function action(fn: () => Promise<unknown>, success?: string) { void fn().then(() => success && setToast({ kind: 'success', message: success })).catch((error) => setToast({ kind: 'error', message: errorMessage(error) })); }

  if (loading) return <div className="boot"><div className="brand-mark">X</div><LoaderCircle className="spin" /><span>{ui("ui.loading_xodus_nexus_2e92cfd")}</span></div>;
  return <ConfirmationProvider><PackageInstallProvider><div className="app-shell">
    {!data.settings.firstRunCompleted ? <FirstRunWizard data={data} toast={(value) => setToast(value)} /> : null}
    <Sidebar data={data} page={page} go={go} openGame={openLibraryGame} openProfile={() => (data.auth.player || data.auth.stored === true) && data.backend.capabilities.nativeSocial ? action(() => window.launcher.nativeSocial.openXboxPlayerProfile('me')) : go('settings')} inert={socialOpen} notifications={<NotificationBell key={JSON.stringify([data.auth.player??data.auth.username,data.backend.binaryPath])} notices={notifications.notices} failed={notifications.failed} unsupported={notifications.unsupported} onSelect={notice=>{
      notifications.acknowledge(notice);
      if(notice.kind==='update')openLibraryGame(notice.target);
      else{setSocialChat(previous=>({id:(previous?.id??0)+1,xuid:notice.target,identity:JSON.stringify([data.auth.player??data.auth.username,data.backend.binaryPath])}));setSocialMounted(true);setSocialOpen(true);}
    }}/>}/>

    <section className="content-shell">
      <header className="topbar" ref={inertRef(socialOpen)}><GlobalSearch games={data.games} page={page} query={search} change={setSearch} submit={value => { setSubmittedSearch(value); go('store'); }} select={openLibraryGame} /><TopStatus data={data} go={go} /></header>
      <CloudSaveWarning operation={data.gameOperation} openGame={openLibraryGame} disabled={socialOpen} />
      <div data-gamepad-page={page} ref={inertRef(socialOpen)} className={'page-scroll'+(page==='social'?' social-full-page':'')}>{page === 'home' ? <HomePage data={data} go={go} action={action} openGame={openLibraryGame} returnFocusKey={homeReturnKey} toast={setToast} /> : null}{page === 'store' ? <StorePage data={data} toast={setToast} go={go} initialQuery={submittedSearch} /> : null}{page === 'library' ? <LibraryPage data={data} toast={setToast} filters={libraryFilters} onFiltersChange={changeLibraryFilters} selection={librarySelection} onSelectionHandled={request => setLibrarySelection(current => current === request ? undefined : current)} returnHome={key => { setHomeReturnKey(key); go('home'); }} /> : null}{page === 'downloads' ? <DownloadsPage data={data} toast={setToast} /> : null}{page === 'settings' ? <SettingsPage data={data} toast={setToast} /> : null}{page === 'social' ? <div className="nexus-social-page"><Suspense fallback={<SocialLoading/>}><XboxSocial key={JSON.stringify([data.auth.player??data.auth.username,data.backend.binaryPath])} auth={data.auth} api={window.launcher.nativeSocial} voice={data.backend.available&&data.backend.capabilities.nativeSocial?window.launcher:undefined} runtimeInvites={data.social} runtimeApi={window.launcher} expanded active={!socialOpen} readKeys={notifications.readKeys} onViewed={notifications.viewed} showProfile={desktopProfile}/></Suspense></div> : null}</div>
      {socialOpen?<button className="nexus-social-scrim" aria-label={ui("social.close_social_shelf_09c6eb")} onClick={()=>setSocialOpen(false)}/>:null}
      <aside id="nexus-social-shelf" role="dialog" aria-modal={socialOpen || undefined} data-gamepad-layer data-gamepad-social-shelf className={'nexus-social-shelf'+(socialOpen?' is-open':'')} aria-label={ui("social.xbox_social_shelf_bb6aaf")} aria-hidden={!socialOpen}
        ref={inertRef(!socialOpen)}>
        {socialMounted?<Suspense fallback={<SocialLoading close={()=>setSocialOpen(false)}/>}><XboxSocial key={JSON.stringify([data.auth.player??data.auth.username,data.backend.binaryPath])} auth={data.auth} api={window.launcher.nativeSocial} voice={data.backend.available&&data.backend.capabilities.nativeSocial?window.launcher:undefined} runtimeInvites={data.social} runtimeApi={window.launcher} shelf active={socialOpen} openChat={socialChat?.identity===JSON.stringify([data.auth.player??data.auth.username,data.backend.binaryPath])?socialChat:undefined} readKeys={notifications.readKeys} onViewed={notifications.viewed} close={()=>setSocialOpen(false)}/></Suspense>:null}
      </aside>
    </section>
    <button data-gamepad-social-toggle data-gamepad-key="social-toggle" className={'nexus-social-toggle'+(socialOpen?' is-open':'')} aria-label={ui("social.xbox_social_9dd063")} aria-expanded={socialOpen} aria-controls="nexus-social-shelf" onClick={()=>go('social')}><Copy aria-hidden="true"/><span>{ui("social.social_f1b750")}</span><ChevronRight/></button>
    {toast ? <div className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check /> : toast.kind === 'error' ? <CircleAlert /> : <Terminal />}<span>{uiText(toast.message)}</span><button onClick={() => setToast(undefined)}><X /></button></div> : null}
  </div><GamepadNavigation back={() => go('home')} social={() => go('social')} search={() => { setSocialOpen(false); setSearchRequest(value => value + 1); }} page={delta => {
    const pages: Page[] = ['home', 'library', 'store'];
    const index = pages.indexOf(page);
    go(index === -1 ? pages[delta > 0 ? 0 : pages.length - 1] : pages[(index + delta + pages.length) % pages.length]);
  }} /></PackageInstallProvider></ConfirmationProvider>;
}
