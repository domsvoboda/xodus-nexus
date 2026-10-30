import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine, Check, ChevronRight, CircleAlert, CircleUserRound,
  Clock3, Cog, Download, FolderOpen, Gamepad2, Github, HardDrive, Home, Library,
  LoaderCircle, LogIn, MoreHorizontal, PackageCheck, Pause, Play, Plus, RefreshCw, Rocket, Search, Settings2,
  Store, Terminal, Trash2, UsersRound, PanelLeft, X,
} from 'lucide-react';
import type { AccountLibraryPage, AppSnapshot, CatalogProduct, CatalogSearchResult, DiagnosticLog, Game, GameContentPlan, GameLaunchOptions, Page, Settings, XboxProfileRequest } from '../shared/types';
import {OverlayShortcutRecorder} from './OverlayShortcutRecorder';
import {reconcileSettingsDraft} from './settings-draft';
import {xboxOverlaySettings} from '../shared/xbox-overlay-settings';
import { XboxSocial } from './XboxSocial';
import './xbox-desktop-social.css';
import { estimateTimeRemaining } from '../shared/utils';
import { nexusRuntimeUpdateAvailable, runtimeDisplay } from '../shared/runtime-display';
import { subscriptionBadge } from '../shared/subscription';
import { defaultLaunchTools, normalizeLaunchTools } from '../shared/launch-tools';
import { DEFAULT_SHADER_CACHE_GIB, shaderCacheLimits } from '../shared/shader-cache';
import type { GameLaunchTools } from '../shared/types';
import { catalogInstallRequest, PackageInstallProvider, usePackageInstall } from './PackageInstall';
import { defaultLibraryFilters, loadLibraryFilters, saveLibraryFilters, libraryProductMatchesPlayState, rankLibraryRows, type LibraryFilters } from './library-preferences';
import { InstallQueueShortcut } from './InstallQueueShortcut';
import { GamepadNavigation } from './GamepadNavigation';
import { ConfirmationProvider, useConfirmation } from './Confirmation';
import { GameRemovalContents } from './GameRemovalContents';
import { GameDetails } from './GameDetails';
import {CatalogGameDetails,catalogGameInstalled} from './CatalogGameDetails';
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

const emptySnapshot: AppSnapshot = {
  backend: {
    available: false, source: 'none', updateAvailable: false, checking: false, updating: false,
    externalRoot: '',
    capabilities: { commands: [], account: false, login: false, logout: false, download: false, streaming: false, run: false },
    prerequisites: { git: false, cargo: false, rustc: false, protoc: false },
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

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
}

function StatusDot({ tone = 'green' }: { tone?: 'green' | 'amber' | 'red' }) {
  return <span className={`status-dot ${tone}`} />;
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

export function Sidebar({ data, page, go, openGame, notifications }: { data: AppSnapshot; page: Page; go: (page: Page) => void; openGame?: (id: string) => void; notifications?: React.ReactNode }) {
  const account = data.auth.gamertag ?? data.auth.username ?? (data.auth.stored === true ? ui("ui.microsoft_account_6c2b1f2") : ui("ui.sign_in_bfd402b"));
  return <aside className="sidebar">
    <div className="account-header"><button className="account-summary" onClick={() => go('settings')}><AccountAvatar auth={data.auth} /><span><strong>{account}</strong><AccountMembership auth={data.auth} /></span></button>{notifications}</div>
    <nav><NavItem autoSelect active={page === 'home'} icon={<Home />} label={ui("ui.home_3a78695")} onClick={() => go('home')} /><NavItem autoSelect active={page === 'library'} icon={<Library />} label={ui("ui.my_library_d931dba")} onClick={() => go('library')} /><NavItem autoSelect active={page === 'store'} icon={<Store />} label={ui("ui.store_ee7da93")} onClick={() => go('store')} /></nav>
    {data.games.length > 0 ? <div className="recents"><span>{ui("ui.most_recent_7459b86")}</span>{data.games.slice(0, 5).map(game => <button key={game.id} onClick={() => openGame ? openGame(game.id) : go('library')}><Cover game={game} /><GameTitle title={game.title} /></button>)}</div> : null}
    <div className="sidebar-bottom"><NavItem active={page === 'settings'} icon={<Cog />} label={ui("ui.settings_74a883a")} onClick={() => go('settings')} /><InstallQueueShortcut downloads={data.downloads} games={data.games} active={page === 'downloads'} openQueue={() => go('downloads')} /></div>
  </aside>;
}

function AccountMembership({ auth }: { auth: AppSnapshot['auth'] }) {
  const label = auth.stored === true ? subscriptionBadge(auth.subscription) : undefined;
  if (label) return <small className="account-membership" title={ui("ui.subscription_verified_a950738", { date: new Date(auth.subscription!.checkedAt).toLocaleString() })}>{label}</small>;
  return auth.stored === true ? null : <small>{auth.stored === false ? ui("ui.not_signed_in_491fc91") : ui("ui.status_unavailable_7eb5af9")}</small>;
}

function AccountAvatar({ auth, large = false }: { auth: AppSnapshot['auth']; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [auth.avatarDataUrl]);
  return <div className={`account-avatar${large ? ' large' : ''}`}>
    {auth.avatarDataUrl && !failed ? <img src={auth.avatarDataUrl} alt={ui("ui.xbox_profile_picture_f6ca315")} onError={() => setFailed(true)} /> : <CircleUserRound />}
  </div>;
}

export function TopStatus({ data, go, openFriends }: { data: AppSnapshot; go: (page: Page) => void; openFriends?: () => void }) {
  const restart = data.launcherUpdate?.restartRequired;
  const updates = [
    data.launcherUpdate?.latestVersion && !restart ? ui("ui.launcher_ba8971d", { version: data.launcherUpdate.latestVersion }) : '',
    data.backend.releaseAvailable && data.backend.updateAvailable ? ui("ui.backend_35f8dc4", { version: data.backend.releaseVersion ?? '' }).trim() : '',
    nexusRuntimeUpdateAvailable(data.runtime) ? ui('home.runtime_update', { version: data.runtime.nexusVersion?.replace(/^runtime-/, '') ?? '' }).trim() : '',
  ].filter(Boolean);
  const updateTitle = [restart ? ui('home.restart_update') : '', updates.length ? ui('home.available_updates', { updates: updates.join(', ') }) : ''].filter(Boolean).join(' ');
  const offline = data.backend.available && data.connectivity?.state === 'offline';
  return <div className="top-status">
    {updates.length || restart ? <button className="update-notice" title={updateTitle} aria-label={updateTitle} onClick={() => go('settings')}><ArrowDownToLine /><strong>{restart ? ui("ui.restart_available_cad1527") : ui("ui.update_available_ff8b555")}</strong></button> : null}
    <StatusDot tone={!data.backend.available ? 'red' : offline ? 'amber' : 'green'} />
    <span title={offline ? `${uiText(data.connectivity?.reason) ?? ui('offline.unreachable')} ${ui('offline.header_hint')}` : undefined}>
      {!data.backend.available ? ui("ui.backend_offline_5904a63") : offline ? ui('offline.header') : ui("ui.xodus_ready_b131015")}
    </span><button title={ui("ui.settings_74a883a")} onClick={() => go('settings')}><Settings2 /></button>
  </div>;
}

export function DiagnosticDialog({ log, close, revealFile, copyLog }: { log: DiagnosticLog; close: () => void; revealFile?: () => Promise<void>; copyLog?: () => Promise<void> }) {
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
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section className="game-dialog diagnostic-dialog" role="dialog" aria-modal="true" aria-label={ui("ui.diagnostic_log_c46c657")}><h2>{log.name}</h2><p>{ui("ui.private_diagnostic_log_review_before_sharing_22816a7")}{log.truncated ? ui("ui.preview_shows_the_most_recent_512_kib_copy_log_c_0e89f87") : ''}</p><pre>{log.content || ui("ui.the_log_is_empty_7261125")}</pre>{fileError ? <p role="alert">{ui("ui.the_log_file_is_no_longer_available_e454fa3")}</p> : null}{copyError ? <p role="alert">{copyError}</p> : null}<div className="dialog-actions">{revealFile ? <button className="secondary" onClick={() => { setFileError(false); void revealFile().catch(() => setFileError(true)); }}>{ui("ui.show_log_file_5ea7142")}</button> : null}<button className="secondary" disabled={copying} onClick={() => void copy()}>{copying ? ui("ui.copying_d250fad") : copyStatus}</button><button className="secondary" data-gamepad-cancel onClick={close}>{ui("ui.close_7d9eb7a")}</button></div></section></div>;
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
  }, [game?.id, data.settings.winePath, data.settings.runtimeRoot, data.runtime.winePath, data.backend.binaryPath, data.backend.commit, data.backend.available]);
  return options;
}

export function HomePage({ data, go, action }: {
  data: AppSnapshot; go: (page: Page) => void; action: (fn: () => Promise<unknown>, success?: string) => void;
}) {
  const featured = data.games[0];
  const canPlay = Boolean(featured?.installState === 'ready' && data.backend.capabilities.run && (data.settings.winePath || data.runtime.winePath));
  const launchOptions = useGameLaunchOptions(featured, data);
  const spotlightArt = featured?.heroUrl ?? featured?.coverUrl;

  return <main className="page home-page">
    <div className={`home-highlights${data.games.length>1?' has-secondary':''}`}>
    <section className={`spotlight ${spotlightArt ? 'has-art' : ''}`} style={spotlightArt ? { '--spotlight-art': `url(${spotlightArt})` } as React.CSSProperties : undefined}>
      <div className="spotlight-copy">
        <span className="overline">{featured ? ui("ui.continue_playing_86c00e5") : 'XODUS NEXUS'}</span>
        <h1>{featured?.title ?? ui("ui.your_pc_games_brought_together_354f2fc")}</h1>
        <p>{uiText(featured
          ? featured.installMessage ?? ui("ui.ready_in_your_library_ac8a64f", { publisher: featured.publisher ?? ui('home.local_installation') })
          : ui("ui.import_an_existing_xodus_installation_or_install_a7f793f"))}</p>
        <div className="button-row">
          {featured && canPlay
            ? <button className="primary" onClick={() => action(() => window.launcher.launchGame(featured.id))}><Play fill="currentColor" />{ui("ui.play_436e610")}</button>
            : <button className="primary" onClick={() => go(featured ? 'settings' : 'library')}><ChevronRight />{featured ? ui("ui.finish_setup_bc01ae7") : ui("ui.import_a_game_54c0a6d")}</button>}
          <button className="secondary" onClick={() => go('library')}><Library />{ui("ui.view_library_108eb25")}</button>
        </div>
      </div>
      {featured ? <div className="spotlight-meta"><StatePill game={featured} />{launchOptions?.cloudSaves ? <span>{ui("ui.cloud_saves_4c54136")}</span> : null}<span>{featured.storeId ? ui("ui.store_id_884e198", { name: featured.storeId }) : ui("ui.local_import_c7e8b68")}</span></div> : null}
    </section>
    {data.games.length>1?<div className="home-secondary">{data.games.slice(1,3).map(game=><button key={game.id} className="home-feature-card" onClick={()=>go('library')}>
      <Cover game={game} variant="hero" /><span><strong>{game.title}</strong><small>{game.publisher??ui("ui.in_your_library_b9da1b7")}</small></span>
    </button>)}</div>:null}
    </div>

    <SectionTitle title={ui("ui.recently_added_96ec5d3")} action={ui("ui.see_all_d7a8c44")} onClick={() => go('library')} />
    {data.games.length > 0 ? <div className="poster-row">
      {data.games.slice(0, 6).map((game) => <button className="poster-card" key={game.id} onClick={() => go('library')}>
        <Cover game={game} /><GameTitle title={game.title} /><span>{game.publisher ?? (game.storeId ? ui("ui.microsoft_store_installation_99bfa99") : ui("ui.local_installation_e5d8322"))}</span>
      </button>)}
    </div> : <div className="empty-strip"><Gamepad2 /><div><strong>{ui("ui.no_games_imported_0bbcb51")}</strong><span>{ui("ui.your_library_is_built_only_from_real_local_manif_1513d78")}</span></div><button className="secondary" onClick={() => go('library')}>{ui("ui.import_folder_b849e38")}</button></div>}

    <div className="support-bar"><CircleAlert /><div><strong>{ui("ui.compatibility_status_65cfaa2")}</strong><span>{ui("ui.package_ownership_and_installation_do_not_guaran_af576d1")}</span></div></div>
  </main>;
}

function CatalogSupportBadge({ product }: { product: CatalogProduct }) {
  return <span className={`catalog-support ${product.installability}`} title={uiText(product.supportNote)}
    aria-label={product.installability === 'unknown' ? ui("ui.package_support_unknown_12fe897") : undefined}>{product.installability === 'supported' ? 'PC' : product.installability === 'unknown' ? '?' : ui("ui.unsupported_5432465")}</span>;
}

export function StoreProductCard({ product, selected, disabled, label, select, install }: {
  product: CatalogProduct; selected: boolean; disabled: boolean; label: string;
  select: (product: CatalogProduct,openDetails?:boolean) => void; install: (product: CatalogProduct) => void;
}) {
  return <article className={`catalog-card ${selected ? 'selected' : ''}`} data-gamepad-card>
    <button className="catalog-card-main" data-gamepad-auto-select="focus" data-gamepad-detail-target={product.productId}
      onFocus={() => select(product,false)} onClick={() => select(product,true)}>
      {product.posterUrl ? <img src={product.posterUrl} alt={ui("ui.cover_47bbe4b", { game: product.title })} /> : <div className="catalog-cover-placeholder"><Gamepad2 /></div>}
      <CatalogSupportBadge product={product} />
      <div><GameTitle title={product.title} /><small>{product.publisher ?? product.productId}</small><span>{product.purchasePrice ?? ui("ui.price_unavailable_6a9e657")}{product.includedWith ? ` · ${product.includedWith}` : ''}</span></div>
    </button>
    <button className="catalog-card-install" data-gamepad-skip data-gamepad-card-action disabled={disabled} onClick={() => install(product)}>
      {label === 'Preparing…' ? <LoaderCircle className="spin" /> : label === 'Installed' ? <Check /> : <Download />}{label}
    </button>
  </article>;
}

function StorePage({ data, toast, go, initialQuery }: { data: AppSnapshot; toast: (value: Toast) => void; go: (page: Page) => void; initialQuery: string }) {
  const startPackageInstall = usePackageInstall();
  const [catalog, setCatalog] = useState<CatalogSearchResult>();
  const [featured, setFeatured] = useState<CatalogSearchResult>();
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [featuredError, setFeaturedError] = useState<string>();
  const [selected, setSelected] = useState<CatalogProduct>();
  const [detailOpen,setDetailOpen]=useState(false);
  const pageRef=useRef<HTMLElement>(null),savedScroll=useRef(0),wasOpen=useRef(false);
  useBrowserLayoutEffect(()=>{
    const scroll=pageRef.current?.closest('.page-scroll');
    if(detailOpen&&selected){if(scroll)scroll.scrollTop=0;pageRef.current?.querySelector<HTMLElement>('[data-gamepad-play]:not(:disabled),[data-gamepad-detail-back]')?.focus({preventScroll:true});}
    else if(wasOpen.current){if(scroll)scroll.scrollTop=savedScroll.current;[...pageRef.current?.querySelectorAll<HTMLElement>('[data-gamepad-detail-target]')??[]].find(card=>card.getAttribute('data-gamepad-detail-target')===selected?.productId)?.focus({preventScroll:true});}
    wasOpen.current=detailOpen&&Boolean(selected);
  },[detailOpen,selected?.productId]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [manualProductId, setManualProductId] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [destination, setDestination] = useState(data.settings.installRoot);
  const [busy, setBusy] = useState<string>();
  useEffect(() => { if (!selected) setDestination(data.settings.installRoot); }, [data.settings.installRoot, selected]);
  useEffect(() => {
    if (initialQuery.trim().length < 2) return;
    let cancelled = false;
    window.launcher.searchCatalog(initialQuery).then((result) => {
      if (!cancelled) { setCatalog(result); setSelected(undefined); }
    }).catch((error) => { if (!cancelled) toast({ kind: 'error', message: errorMessage(error) }); });
    return () => { cancelled = true; };
  }, [initialQuery]);
  useEffect(() => {
    let cancelled = false;
    window.launcher.getFeaturedCatalog()
      .then((result) => { if (!cancelled) setFeatured(result); })
      .catch((error) => { if (!cancelled) setFeaturedError(errorMessage(error)); })
      .finally(() => { if (!cancelled) setFeaturedLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function installDestination(product: CatalogProduct): string {
    const folder = product.title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || product.productId;
    return `${data.settings.installRoot.replace(/\/+$/, '')}/${folder}`;
  }

  function selectProduct(product: CatalogProduct,openDetails=true) {
    setSelected(product);
    setDestination(installDestination(product));
    if(openDetails){savedScroll.current=pageRef.current?.closest('.page-scroll')?.scrollTop??0;setDetailOpen(true);}
  }

  async function loadMore() {
    if (!catalog?.cursor) return;
    setLoadingMore(true);
    try {
      const next = await window.launcher.searchCatalog(catalog.query, catalog.cursor);
      setCatalog({ ...next, products: [...catalog.products, ...next.products] });
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setLoadingMore(false); }
  }

  async function install(product: CatalogProduct, target = installDestination(product)) {
    setBusy(product.productId);
    try {
      if (!await startPackageInstall(catalogInstallRequest(product, target))) return;
      toast({ kind: 'success', message: ui("ui.xodus_is_checking_the_license_and_installing_be774b2", { game: product.title }) });
      go('downloads');
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setBusy(undefined); }
  }

  async function manualInstall(event: FormEvent) {
    event.preventDefault(); setBusy('manual');
    try {
      if (!await startPackageInstall({ productId: manualProductId, title: manualTitle, destination })) return;
      toast({ kind: 'success', message: ui("ui.xodus_streaming_started_af5ad62") }); go('downloads');
    } catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setBusy(undefined); }
  }

  async function chooseDestination() {
    const selected = await window.launcher.chooseDirectory(destination);
    if (selected) setDestination(selected);
  }

  const installedIds = new Set(data.games.flatMap((game) => game.storeId?.toUpperCase() ?? []));
  const isInstalled = (product: CatalogProduct) => installedIds.has(product.productId) || Boolean(product.installProductId && installedIds.has(product.installProductId));
  const queuedIds = new Set(data.downloads.filter(task => ['running', 'queued', 'paused'].includes(task.status)).map(task => task.productId.toUpperCase()));
  const isQueued = (product: CatalogProduct) => queuedIds.has(product.productId) || Boolean(product.installProductId && queuedIds.has(product.installProductId));
  const productGrid = (products: CatalogProduct[]) => <div className="catalog-grid" data-gamepad-grid>{products.map((product) => {
    const installed = isInstalled(product);
    return <StoreProductCard key={product.productId} product={product} selected={selected?.productId === product.productId}
      disabled={product.installability !== 'supported' || Boolean(busy) || !data.backend.capabilities.streaming || installed || isQueued(product)}
      label={installed ? ui("ui.installed_f8b32f4") : isQueued(product) ? ui("ui.in_install_queue_7c818f2") : busy === product.productId ? ui("ui.preparing_5d1fa38") : ui("ui.install_569ca49")}
      select={selectProduct} install={install} />;
  })}</div>;
  if(detailOpen&&selected)return <main ref={pageRef} className="page store-page library-detail-open"><CatalogGameDetails key={`${selected.productId}:${data.auth.username}:${data.auth.stored}:${data.auth.running}:${data.backend.binaryPath}:${data.settings.market}`} product={selected} data={data} back={()=>setDetailOpen(false)} backLabel={ui('game.back_to_store')} toast={toast}/></main>;
  return <main ref={pageRef} className="page store-page">
    <header className="page-header"><div><h1>{ui("ui.store_ee7da93")}</h1></div><span className="catalog-source"><StatusDot />Microsoft Store</span></header>
    {!catalog ? <section className="featured-catalog"><SectionTitle title={ui("ui.featured_c533caf")} />{featuredLoading ? <div className="catalog-loading"><LoaderCircle className="spin" /><span>{ui("ui.loading_live_store_collection_20763b0")}</span></div> : featured?.products.length ? <><div className="featured-rail">{featured.products.slice(0, 3).map((product) => <button className="featured-tile" key={product.productId} data-gamepad-detail-target={product.productId} onClick={() => selectProduct(product)}>{product.heroUrl || product.posterUrl ? <img src={product.heroUrl ?? product.posterUrl} alt="" /> : <div className="featured-tile-placeholder"><Gamepad2 /></div>}<span className="featured-tile-copy"><GameTitle title={product.title} /><small>{product.publisher ?? 'Microsoft Store'} · {product.installability === 'supported' ? ui('store.verified_pc') : ui("ui.check_package_support_79592da")}</small></span></button>)}</div><SectionTitle title={ui("ui.trending_pc_games_2025848")} />{productGrid(featured.products.slice(3))}</> : <div className="catalog-empty"><Store /><h2>{ui("ui.featured_games_are_temporarily_unavailable_3901a69")}</h2><p>{featuredError ?? ui("ui.search_still_works_with_live_microsoft_store_dat_b3eeb72")}</p></div>}</section> : null}

    {catalog ? <><SectionTitle title={ui("ui.results_for_343a212", { query: catalog.query })} />{productGrid(catalog.products)}{catalog.products.length === 0 ? <div className="empty-state compact"><div><Search /></div><h2>{ui("ui.no_games_found_6da4c04")}</h2><p>{ui("ui.try_a_different_title_or_a_microsoft_store_produ_326af8c")}</p></div> : null}{catalog.hasMore ? <div className="load-more"><button className="secondary" disabled={loadingMore} onClick={loadMore}>{loadingMore ? <LoaderCircle className="spin" /> : <Plus />}{ui("ui.load_more_results_e03f1e4")}</button></div> : null}</> : null}

    <SectionTitle title={ui("ui.install_by_product_id_d863edd")} />
    <form className="manual-install" onSubmit={manualInstall}><label>{ui("ui.product_id_c76c9e7")}<input value={manualProductId} onChange={(event) => setManualProductId(event.target.value)} placeholder={ui("ui.for_example_9n4pt8hgcdhq_b6119c7")} required /></label><label>{ui("ui.queue_name_5cb7293")}{' '}<em>{ui("ui.optional_59be713")}</em><input value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} /></label><label>{ui("ui.install_location_af47896")}<div className="input-action"><input value={destination} onChange={(event) => setDestination(event.target.value)} required /><button type="button" onClick={chooseDestination}><FolderOpen /></button></div></label><button className="secondary" disabled={Boolean(busy) || !data.backend.capabilities.streaming}>{busy === 'manual' ? <LoaderCircle className="spin" /> : <Terminal />}{ui("ui.install_unlisted_id_1b85f63")}</button></form>
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
    {hasMore ? <button className="secondary" disabled={loading} onClick={load}>
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
    setBusy(true); setError(undefined);
    try {
      const next = await window.launcher.getAccountLibrary(kind, refresh ? undefined : visible?.cursor, refresh, sort);
      if (currentIdentity.current !== identity) return;
      if (!refresh && visible?.cursor && next.cursor === visible.cursor) throw Error("Library pagination did not advance. Refresh the library to try again.");
      // This instance is remounted on identity changes, so pending callbacks
      // cannot publish another account's products into the active component.
      setResult(old => ({ ...next, products: refresh ? next.products : [...(old?.products ?? []), ...next.products.filter(p => !old?.products.some(old => old.productId === p.productId))] }));
    } catch (error) { if (currentIdentity.current === identity) setError(errorMessage(error)); }
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
  return <section className="account-games">
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
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending) close(); }}><section className="game-dialog content-dialog" role="dialog" aria-modal="true" aria-label={ui("ui.content_for_73287b5", { game: game.title })}>
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
    <label className="tool-checkbox"><input type="checkbox" checked={value.dualSenseCompatibility === true} onChange={event => update({ dualSenseCompatibility: event.target.checked })} /><span>{ui("ui.dualsense_compatibility_mode_666f577")}</span></label>
    <small>{ui("ui.try_this_if_a_standard_dualsense_controller_is_n_114e408")}</small>
    <label className="tool-checkbox"><input type="checkbox" checked={value.dualShock4Compatibility === true} onChange={event => update({ dualShock4Compatibility: event.target.checked })} /><span>{ui("controllers.dualshock4_compatibility")}</span></label>
    <small>{ui("controllers.dualshock4_help")}</small>
    <label className="tool-checkbox"><input type="checkbox" checked={value.mangoHud} onChange={event => update({ mangoHud: event.target.checked })} /><span>{ui("ui.enable_mangohud_dcae6c8")}</span></label>
    <label className="tool-checkbox"><input type="checkbox" checked={value.gamescope} onChange={event => update({ gamescope: event.target.checked })} /><span>{ui("ui.run_in_gamescope_58f2d35")}</span></label>
    {value.gamescope ? <label>{ui("ui.gamescope_options_cb81326")}<input value={value.gamescopeArgs} maxLength={2048} placeholder="-W 1920 -H 1080 -f" onChange={event => update({ gamescopeArgs: event.target.value })} /><small>{ui("ui.only_options_nexus_adds_the_game_command_mangohu_c4b6ad8")}</small></label> : null}
    <label>{ui("ui.launch_options_5dfe538")}<textarea rows={3} value={value.launchOptions} maxLength={2048} placeholder="PROTON_ENABLE_WAYLAND=1 gamemoderun %command% --launcher-skip" onChange={event => update({ launchOptions: event.target.value })} /><small>{ui("ui.name_value_and_wrappers_before_command_game_argu_930be12")}</small></label>
    <small>{ui("ui.tools_must_already_be_installed_applies_to_this_956d794")}</small>
  </fieldset>;
}

export function LibraryPage({ data, toast, filters, onFiltersChange, selection }: Pick<AccountGamesProps, 'data' | 'toast' | 'filters' | 'onFiltersChange'> & { selection?: { id: string } }) {
  const confirm = useConfirmation();
  const [selectedId, setSelectedId] = useState<string | undefined>(selection?.id);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [dialogGame, setDialogGame] = useState<{ id: string; kind: 'settings' | 'remove' }>();
  const [editTitle, setEditTitle] = useState('');
  const [editLocale, setEditLocale] = useState('');
  const [editTools, setEditTools] = useState<GameLaunchTools>({ ...defaultLaunchTools });
  const [localeOptions, setLocaleOptions] = useState<string[]>([]);
  const localeRequest = useRef(0);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [diagnosticLog, setDiagnosticLog] = useState<{ log: DiagnosticLog; operationId: string }>();
  const [contentGameId, setContentGameId] = useState<string>();
  const [detailOpen, setDetailOpen] = useState(Boolean(selection));
  const catalogScope=JSON.stringify([data.auth.username,data.auth.stored,data.auth.running,data.backend.binaryPath,data.settings.market]);
  const [catalogSelection,setCatalogSelection]=useState<{product:CatalogProduct;scope:string}>();
  const catalogProduct=catalogSelection?.scope===catalogScope?catalogSelection.product:undefined;
  const previousCatalogScope=useRef(catalogScope);
  useEffect(()=>{if(previousCatalogScope.current!==catalogScope&&catalogSelection){setCatalogSelection(undefined);setDetailOpen(false);}previousCatalogScope.current=catalogScope;},[catalogScope,catalogSelection]);
  const pageRef = useRef<HTMLElement>(null);
  const savedScroll = useRef(0);
  const wasOpen = useRef(false);
  const selected = data.games.find((game) => game.id === selectedId) ?? data.games[0];
  const detailVisible=detailOpen&&Boolean(catalogSelection?catalogProduct:selected);
  const returnTarget=catalogProduct?(catalogGameInstalled(catalogProduct,data)?.id??catalogProduct.productId):selected?.id;
  function selectProductDetails(product:CatalogProduct){
    savedScroll.current=pageRef.current?.closest('.page-scroll')?.scrollTop??0;
    setCatalogSelection({product,scope:catalogScope});setDetailOpen(true);
  }
  function selectGame(game: Game, openDetails = false) {
    setSelectedId(game.id);
    if (openDetails) { setCatalogSelection(undefined);savedScroll.current = pageRef.current?.closest('.page-scroll')?.scrollTop ?? 0; setDetailOpen(true); }
  }
  useBrowserLayoutEffect(() => {
    const scroll = pageRef.current?.closest('.page-scroll');
    if (detailVisible) {
      if (scroll) scroll.scrollTop = 0;
      pageRef.current?.querySelector<HTMLElement>('[data-gamepad-play]:not(:disabled),[data-gamepad-detail-back]')?.focus({ preventScroll: true });
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
    setEditTools({ ...defaultLaunchTools, ...game.launchTools });
    setLocaleOptions([]);
    const request = ++localeRequest.current;
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
      await window.launcher.updateGame(dialogGame.id, { title: editTitle.trim(), locale: editLocale, launchTools: normalizeLaunchTools(editTools) });
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
  const launchOptions = useGameLaunchOptions(selected, data);
  const menuGame = data.games.find((game) => game.id === menu?.id);
  const modalGame = data.games.find((game) => game.id === dialogGame?.id);
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
  const selectedPanel = catalogProduct&&detailVisible?<CatalogGameDetails key={catalogProduct.productId+catalogScope} product={catalogProduct} data={data} back={()=>setDetailOpen(false)} toast={toast}/>:!catalogSelection&&selected&&detailVisible ? <GameDetails key={`${selected.id}:${data.auth.username}:${data.auth.stored}:${data.auth.running}:${data.backend.binaryPath}:${data.settings.market}`} game={selected} data={data} back={() => setDetailOpen(false)} play={<>
          <button className="primary" data-gamepad-play disabled={gameBusy || selected.installState !== 'ready' || !data.backend.capabilities.run || !(data.settings.winePath || data.runtime.winePath)} onClick={() => play()}>{gameBusy ? <LoaderCircle className="spin" /> : <Play fill="currentColor" />}{gameBusy ? ui("ui.working_5474eef") : ui("ui.play_436e610")}</button>
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
    {dialogGame && modalGame ? <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !dialogBusy) setDialogGame(undefined); }}><section className="game-dialog" role="dialog" aria-modal="true" aria-label={dialogGame.kind === 'remove' ? ui("ui.remove_d2f6b9b", { name: modalGame.title }) : ui("ui.settings_for_9d9bd70", { game: modalGame.title })}>
      {dialogGame.kind === 'remove' ? <GameRemovalContents game={modalGame} busy={dialogBusy} close={() => setDialogGame(undefined)} remove={mode => { void removeGame(mode); }} /> : <form onSubmit={saveGameSettings}>
        <h2>{ui("ui.game_settings_fece860")}</h2>
        <label>{ui("ui.display_name_2b7f6a8")}<input required value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label>
        <GameLanguage value={editLocale} locales={localeOptions} onChange={setEditLocale} />
        <p>{ui("ui.all_games_use_the_active_runtime_b931ef4")}</p>
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

function ToggleStatus({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`dependency ${ok ? 'ok' : ''}`}>{ok ? <Check /> : <X />}{label}</span>;
}

export function SettingsPage({ data, toast }: { data: AppSnapshot; toast: (value: Toast) => void }) {
  const confirm = useConfirmation();
  const [form, setForm] = useState<Settings>(data.settings);
  const previousSettings = useRef(data.settings);
  const [busy, setBusy] = useState<string>();
  const [logs, setLogs] = useState<string[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([]);
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = data.settings;
    setForm(current => reconcileSettingsDraft(current, previous, data.settings));
  }, [data.settings]);
  useEffect(() => window.launcher.onOperationLog(({ scope, line }) => {
    if (scope === 'backend') setLogs((items) => [...items.slice(-199), line]);
    if (scope === 'runtime') setRuntimeLogs((items) => [...items.slice(-199), line]);
  }), []);

  async function invoke(name: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(name);
    try { await fn(); if (success) toast({ kind: 'success', message: success }); }
    catch (error) { toast({ kind: 'error', message: errorMessage(error) }); }
    finally { setBusy(undefined); }
  }

  async function pick(kind: 'install' | 'backend' | 'runtime' | 'wine') {
    const selected = kind === 'wine'
      ? await window.launcher.chooseFile(form.winePath)
      : await window.launcher.chooseDirectory(kind === 'install' ? form.installRoot : kind === 'backend' ? form.externalXodusRoot : form.runtimeRoot);
    if (selected) setForm((current) => ({ ...current, [kind === 'install' ? "installRoot" : kind === 'backend' ? "externalXodusRoot" : kind === 'runtime' ? "runtimeRoot" : "winePath"]: selected }));
  }

  const caps = data.backend.capabilities;
  let cacheLimitValid = true;
  try { shaderCacheLimits(form.shaderCacheLimitGiB ?? DEFAULT_SHADER_CACHE_GIB); } catch { cacheLimitValid = false; }
  const runtimeInfo = runtimeDisplay(data.runtime);
  const overlay=xboxOverlaySettings(form);
  const savedOverlay=xboxOverlaySettings(data.settings);
  const overlayDirty=overlay.overlayEnabled!==savedOverlay.overlayEnabled||overlay.overlaySide!==savedOverlay.overlaySide||(form.overlayShortcut??savedOverlay.overlayShortcut)!==savedOverlay.overlayShortcut;
  const shortcutState=data.overlayShortcut?.state;
  const shortcutStatus=!savedOverlay.overlayEnabled?ui('settings.guide_shortcut_disabled'):shortcutState==='registered'?ui('settings.guide_shortcut_ready'):shortcutState==='unavailable'?data.overlayShortcut?.message??ui('settings.guide_shortcut_unavailable'):ui('settings.guide_shortcut_requested');
  return <main className="page settings-page">
    <header className="page-header"><div><h1>{ui("ui.settings_74a883a")}</h1><p>{ui("ui.account_backend_runtime_and_storage_11bda06")}</p></div></header>

    <section className="settings-card compact settings-language">
      <label>{ui('settings.interface_language')}<select value={form.interfaceLanguage ?? 'system'} onChange={event => setForm({ ...form, interfaceLanguage: event.target.value })}>
        <option value="system">{ui('settings.system_language')}</option>
        {interfaceLanguages.map(language => <option key={language} value={language}>{new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language}</option>)}
      </select></label>
      <div className="save-row"><span>{ui('settings.language_help')}</span><button className="primary" disabled={Boolean(busy)} onClick={() => invoke('save-language', () => window.launcher.updateSettings({ interfaceLanguage: form.interfaceLanguage ?? 'system' }), ui('settings.language_saved'))}>{ui('settings.save_language')}</button></div>
    </section>

    <section className="settings-card compact tray-settings">
      <label className="tray-toggle"><input type="checkbox" checked={form.closeToTray===true} disabled={Boolean(busy)} onChange={event=>{const closeToTray=event.target.checked;setForm({...form,closeToTray});void invoke('close-to-tray',()=>window.launcher.updateSettings({closeToTray}),ui('settings.tray_saved'));}}/><span>{ui('settings.close_to_tray')}</span></label>
      <small>{ui('settings.close_to_tray_help')}</small>
    </section>

    <section className="settings-card compact launcher-card">
      {data.launcherUpdate?.phase ? <p>{uiText(data.launcherUpdate.phase)}</p> : null}
      {data.launcherUpdate?.updating ? <div className="progress-track"><i style={{ width: `${data.launcherUpdate.progress ?? 0}%` }} /></div> : null}
      {data.launcherUpdate?.error ? <div className="alert amber"><CircleAlert /><span>{uiText(data.launcherUpdate.error)}</span></div> : null}
      <div className="settings-heading"><div className="settings-icon"><Rocket /></div><div><span className="overline">XODUS NEXUS</span><h2>{data.launcherUpdate?.currentVersion ?? ui("ui.development_build_63d499e")}</h2><p>{data.launcherUpdate?.latestVersion ? ui("ui.version_is_available_cc7c84d", { version: data.launcherUpdate.latestVersion }) : ui("ui.check_github_for_launcher_updates_6fa32b9")}</p></div></div>
      <div className="button-row">
        {data.launcherUpdate?.latestVersion && data.launcherUpdate.canInstall && !data.launcherUpdate.restartRequired ? <button className="primary" disabled={data.launcherUpdate.updating || Boolean(busy)} onClick={async () => { if (await confirm({ title: ui("ui.install_launcher_update_15498d2"), message: ui("ui.the_current_appimage_will_be_backed_up_games_and_8e8c5e5"), confirmLabel: ui("ui.install_update_cada421") })) void invoke('launcher-install', () => window.launcher.installLauncherUpdate()); }}><ArrowDownToLine />{data.launcherUpdate.updating ? ui("ui.updating_dfe40ef") : ui("ui.install_launcher_update_d1988d9")}</button> : null}
        {data.launcherUpdate?.releaseUrl && !data.launcherUpdate.canInstall ? <a className="primary" href={data.launcherUpdate.releaseUrl} target="_blank" rel="noreferrer"><ArrowDownToLine />{ui("ui.download_update_4f494b2")}</a> : null}
        {data.launcherUpdate?.restartRequired ? <button className="primary" onClick={() => invoke('launcher-restart', () => window.launcher.restartLauncher())}><RefreshCw />{ui("ui.restart_launcher_b076da9")}</button> : null}
        {data.launcherUpdate?.canRollback ? <button className="secondary" disabled={data.launcherUpdate.updating || Boolean(busy)} onClick={async () => { if (await confirm({ title: ui("ui.restore_previous_launcher_ab5c227"), message: ui("ui.your_settings_and_games_will_not_change_3e99619"), confirmLabel: ui("ui.restore_launcher_a0520ac") })) void invoke('launcher-rollback', () => window.launcher.rollbackLauncherUpdate()); }}>{ui("ui.restore_previous_launcher_9b5f101")}</button> : null}
        <button className="secondary" disabled={data.launcherUpdate?.checking || data.launcherUpdate?.updating || data.launcherUpdate?.restartRequired} onClick={() => invoke('update-check', () => window.launcher.checkLauncherUpdate(), ui("ui.update_check_finished_3f30d8a"))}>{data.launcherUpdate?.checking ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui("ui.check_for_updates_f26f327")}</button>
        <button className="secondary" disabled={Boolean(busy)} title={ui("ui.add_nexus_with_artwork_including_while_steam_is_f7d03b8")} onClick={() => invoke('steam-launcher', () => window.launcher.addToSteam(), ui("ui.nexus_added_to_steam_2f6a699"))}><Plus />{ui("ui.add_nexus_to_steam_790c35e")}</button>
      </div>
    </section>

    <section className="settings-card account-card">
      <div className="settings-heading"><AccountAvatar auth={data.auth} large /><div><span className="overline">{ui("ui.microsoft_account_90f90f6")}</span><h2>{data.auth.gamertag ?? data.auth.username ?? (data.auth.stored === false ? ui("ui.not_signed_in_491fc91") : ui("ui.account_status_unavailable_3b97a47"))}</h2><p>{data.auth.stored === true ? ui("ui.credentials_stored_by_xodus_bca3867") : ui("ui.authentication_uses_the_original_xodus_webview_cf2dcb9")}</p></div><span className={`status-label ${data.auth.stored === true ? 'ready' : data.auth.stored === false ? 'off' : 'unknown'}`}><StatusDot tone={data.auth.stored === true ? 'green' : data.auth.stored === false ? 'red' : 'amber'} />{data.auth.stored === true ? ui("ui.stored_1afc73e") : data.auth.stored === false ? ui("ui.signed_out_db8436b") : ui("ui.unknown_2375999")}</span></div>
      <div className="account-note"><CircleAlert /><span>{uiText(data.auth.note)}</span></div>
      <KeyringSetup compact disabled={data.auth.running} />
      <div className="button-row"><button className="primary" disabled={!caps.login || data.auth.running} onClick={() => invoke('login', () => window.launcher.login(), ui("ui.xodus_sign_in_completed_8240737"))}>{data.auth.running ? <LoaderCircle className="spin" /> : <LogIn />}{data.auth.stored ? ui("ui.sign_in_again_51fbe1d") : ui("ui.sign_in_with_xodus_252572f")}</button><button className="secondary" disabled={!caps.logout || data.auth.running || data.auth.stored === false} title={ui("ui.remove_saved_sign_in_credentials_and_local_devic_6485324")} onClick={() => invoke('logout', () => window.launcher.logout(), ui("ui.saved_sign_in_credentials_and_local_device_regis_c9738bd"))}>{ui("ui.sign_out_48f0d3d")}</button><button className="secondary" disabled={!caps.account || data.auth.running} onClick={() => invoke('account', () => window.launcher.refreshAccount())}><RefreshCw />{ui("ui.refresh_status_442c4b8")}</button></div>
      <PasskeySignInNotice />
    </section>

    {caps.offlinePc && !data.auth.running ? <OfflinePermissionsCard key={`${data.auth.username}:${data.auth.stored}:${data.backend.binaryPath}:${data.settings.runtimeRoot}`} toast={toast} signedIn={data.auth.stored === true} /> : null}

    <section className="settings-card">
      <div className="settings-heading"><div className="settings-icon"><Terminal /></div><div><h2>{ui("ui.xodus_backend_a99abd3")}</h2><p>{data.backend.version ? ui("ui.nexus_backend_909289e", { version: data.backend.version }) : data.backend.available ? ui("ui.backend_cli_02229de", { version: data.backend.capabilities.version ?? ui('settings.unknown_version') }) : ui("ui.install_the_prebuilt_nexus_backend_bd247cd")}</p></div><span className={`status-label ${data.backend.available ? 'ready' : 'off'}`}><StatusDot tone={data.backend.available ? 'green' : 'red'} />{data.backend.available ? ui("ui.validated_3dac322") : ui("ui.offline_5c3ce8d")}</span></div>
      {data.backend.blockReason ? <div className="alert amber"><CircleAlert /><span>{uiText(data.backend.blockReason)}</span></div> : null}
      {data.backend.phase ? <p className="runtime-phase">{uiText(data.backend.phase)}</p> : null}
      <div className="backend-diagnostic-action"><BackendLogButton toast={toast} /><p className="fine-print">{ui("ui.local_operation_results_and_safe_error_codes_no_cd558f7")}</p></div>
      <div className="button-row end"><button className="secondary" disabled={Boolean(busy) || data.backend.checking || data.backend.updating} onClick={() => invoke('backend-check', () => window.launcher.checkBackendUpdate())}>{busy === 'backend-check' || data.backend.checking ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui("ui.check_for_updates_f26f327")}</button>{data.backend.releaseAvailable && data.backend.updateAvailable ? <button className="primary" disabled={Boolean(busy) || data.backend.updating || data.backend.checking} onClick={() => invoke('backend-update', () => window.launcher.updateBackend(), ui("ui.the_nexus_backend_was_verified_installed_and_act_62d374e"))}>{busy === 'backend-update' || data.backend.updating ? <LoaderCircle className="spin" /> : <ArrowDownToLine />}{data.backend.available ? ui("ui.update_backend_bddcd8b") : ui("ui.install_backend_73e7239")}</button> : null}</div>
    </section>

    <section className="settings-card">
      <div className="settings-heading"><div className="settings-icon"><Gamepad2 /></div><div><h2>{ui("ui.nexus_runtime_9578a00")}</h2><p>{data.runtime.installed ? ui("ui.active_ae2c40a", { runtime: runtimeInfo.title, version: runtimeInfo.version }) : ui("ui.no_runtime_selected_b8e7445")}</p></div><span className={`status-label ${data.runtime.installed && runtimeInfo.source === 'Nexus runtime' ? 'ready' : 'unknown'}`}><StatusDot tone={data.runtime.installed && runtimeInfo.source === 'Nexus runtime' ? 'green' : 'amber'} />{!data.runtime.installed ? ui("ui.missing_8af1d32") : runtimeInfo.source === 'Nexus runtime' ? ui("ui.ready_c2e3ac4") : ui("ui.other_runtime_ce6adfb")}</span></div>
      {data.runtime.nexusError ? <div className="alert amber"><CircleAlert /><span>{data.runtime.nexusError}</span></div> : null}
      {data.runtime.error ? <div className="alert amber"><CircleAlert /><span>{uiText(data.runtime.error)}</span></div> : null}{data.runtime.phase ? <div className="runtime-phase"><LoaderCircle className={data.runtime.updating ? 'spin' : ''} /><span>{uiText(data.runtime.phase)}</span></div> : null}
      <div className="button-row end">
        <button className="secondary" disabled={Boolean(busy) || data.runtime.nexusChecking} onClick={() => invoke('runtime-check', () => window.launcher.checkNexusRuntime())}>{busy === 'runtime-check' || data.runtime.nexusChecking ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui("ui.check_for_updates_f26f327")}</button>
        {nexusRuntimeUpdateAvailable(data.runtime) ? <button className="primary" disabled={Boolean(busy) || data.runtime.updating} onClick={() => invoke('runtime-install-nexus', () => window.launcher.installNexusRuntime(), ui("ui.nexus_runtime_was_verified_installed_and_selecte_51b0ff1"))}>{busy === 'runtime-install-nexus' || data.runtime.updating ? <LoaderCircle className="spin" /> : <ArrowDownToLine />}{ui("ui.install_nexus_runtime_2cf3608")}{data.runtime.nexusVersion ? ` ${data.runtime.nexusVersion.replace(/^runtime-/, '')}` : ''}</button> : null}
      </div>
      {data.runtime.updating || runtimeLogs.length > 0 ? <pre className="build-log">{runtimeLogs.join('\n') || ui("ui.waiting_for_output_f05fefe")}</pre> : null}
    </section>

    <div className="settings-storage">
      <section className="settings-card compact">
        <div className="settings-heading"><div className="settings-icon"><HardDrive /></div><div><h2>{ui("ui.shader_cache_d7b5738")}</h2><p>{ui("ui.limit_mesa_and_nvidia_driver_caches_per_game_13f5b89")}</p></div></div>
        <div className="form-grid"><label>{ui("ui.driver_cache_limit_gib_acf77d9")}<input type="number" min="0.25" max="1024" step="0.25" value={form.shaderCacheLimitGiB ?? DEFAULT_SHADER_CACHE_GIB} onChange={event=>setForm({...form,shaderCacheLimitGiB:Number(event.target.value)})} /></label></div>
        <div className="save-row"><span>{ui("ui.default_4_gib_applies_on_the_next_game_launch_ex_d0a7298")}</span><button className="primary" disabled={Boolean(busy)||!cacheLimitValid} onClick={()=>invoke('save-shader-cache',()=>window.launcher.updateSettings({shaderCacheLimitGiB:form.shaderCacheLimitGiB ?? DEFAULT_SHADER_CACHE_GIB}),ui("ui.shader_cache_limit_saved_applies_on_the_next_gam_4ca411d"))}>{busy==='save-shader-cache'?<LoaderCircle className="spin" />:<Check />}{ui("ui.save_cache_limit_a1d0333")}</button></div>
      </section>
      <section className="settings-card compact">
        <div className="settings-heading"><div className="settings-icon"><Download /></div><div><h2>{ui("ui.downloads_d5fdc1a")}</h2><p>{ui("ui.limit_the_combined_game_download_speed_across_al_baea745")}</p></div></div>
        <div className="form-grid"><label>{ui("ui.download_speed_limit_mib_s_1b1cf51")}<input type="number" min="0" max="1024" step="0.1" value={form.downloadLimitMiB ?? 0} onChange={event => setForm({...form, downloadLimitMiB:Number(event.target.value)})} /></label></div>
        <div className="save-row"><span>{ui("ui.0_unlimited_applies_to_active_and_future_game_do_2374ba9")}</span><button className="primary" disabled={Boolean(busy) || Boolean((form.downloadLimitMiB ?? 0) > 0 && !data.backend.capabilities.streamingBandwidthLimit)} onClick={() => invoke('save-bandwidth', () => window.launcher.updateSettings({downloadLimitMiB:form.downloadLimitMiB ?? 0}), ui("ui.download_speed_limit_saved_8fd9160"))}>{busy === 'save-bandwidth' ? <LoaderCircle className="spin" /> : <Check />}{ui("ui.save_download_limit_8abf702")}</button></div>
      </section>
      <section className="settings-card compact"><div className="settings-heading"><div className="settings-icon"><HardDrive /></div><div><h2>{ui("ui.storage_and_launch_paths_d3c8c4d")}</h2><p>{ui("ui.the_external_xodus_checkout_is_never_modified_b63317f")}</p></div></div><div className="form-grid"><label>{ui("ui.default_game_location_5e830cb")}<div className="input-action"><input value={form.installRoot} onChange={(event) => setForm({ ...form, installRoot: event.target.value })} /><button onClick={() => pick('install')}><FolderOpen /></button></div></label><label>{ui("ui.market_5238d9b")}<input value={form.market} onChange={(event) => setForm({ ...form, market: event.target.value })} /></label><label>{ui("ui.parallel_streams_e81513c")}<input type="number" min="1" max="16" value={form.parallelDownloads} onChange={(event) => setForm({ ...form, parallelDownloads: Number(event.target.value) })} /></label><label>{ui("ui.external_xodus_source_ef00493")}<div className="input-action"><input value={form.externalXodusRoot} onChange={(event) => setForm({ ...form, externalXodusRoot: event.target.value })} /><button onClick={() => pick('backend')}><FolderOpen /></button></div></label><label>{ui("ui.versioned_runtime_directory_3764480")}<div className="input-action"><input value={form.runtimeRoot} onChange={(event) => setForm({ ...form, runtimeRoot: event.target.value })} /><button onClick={() => pick('runtime')}><FolderOpen /></button></div></label><label>{ui("ui.wine_proton_binary_2b08a4a")}<div className="input-action"><input value={form.winePath} onChange={(event) => setForm({ ...form, winePath: event.target.value })} placeholder={ui("ui.selected_automatically_by_the_runtime_manager_0722211")} /><button onClick={() => pick('wine')}><FolderOpen /></button></div></label></div><div className="save-row"><span>{ui("ui.settings_are_stored_locally_in_electron_userdata_5ff2a49")}</span><button className="primary" disabled={busy === 'save'} onClick={() => invoke('save', () => window.launcher.updateSettings(form), ui("ui.settings_saved_ae493e2"))}>{busy === 'save' ? <LoaderCircle className="spin" /> : <Check />}{ui("ui.save_1509f56")}</button></div></section>
    </div>
    <details className="settings-card settings-guide" aria-label={ui('settings.guide_title')}>
      <summary><PanelLeft aria-hidden="true"/><span className="guide-summary-text"><strong>{ui('settings.guide_title')}</strong><small>{ui('settings.guide_summary')}</small></span><span className={`guide-state${savedOverlay.overlayEnabled?' on':''}`}>{savedOverlay.overlayEnabled?ui('settings.guide_on'):ui('settings.guide_off')}</span><ChevronRight aria-hidden="true"/></summary>
      <div className="guide-settings-content">
        <label className="guide-enable"><span><strong>{ui('settings.guide_enable')}</strong><small>{ui('settings.guide_enable_help')}</small></span><input type="checkbox" role="switch" checked={overlay.overlayEnabled} disabled={Boolean(busy)} onChange={event=>setForm({...form,overlayEnabled:event.target.checked})}/></label>
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
        <section><h3>{ui("ui.game_logging_6cb644e")}</h3><div className="toggle-row"><label className="toggle"><input type="checkbox" checked={form.verboseLogs} onChange={(event) => setForm({ ...form, verboseLogs: event.target.checked })} /><span>{ui("ui.verbose_game_logs_58e750b")}</span></label><p>{ui("ui.writes_full_wine_vkd3d_proton_and_xodus_diagnost_dfa1fa3")}</p></div><div className="button-row"><button className="secondary" disabled={Boolean(busy)} onClick={() => invoke('save-diagnostics', () => window.launcher.updateSettings({ verboseLogs: form.verboseLogs }), ui("ui.logging_settings_saved_5a9dd67"))}>{ui("ui.save_diagnostics_52fe7bd")}</button></div></section>
        <section><h3>{ui("ui.backend_details_522061f")}</h3><p className="diagnostic-path mono">{data.backend.binaryPath ?? ui("ui.no_backend_selected_e322189")}</p><div className="meta-grid"><div><span>{ui("ui.source_56ccd01")}</span><strong>{data.backend.source === 'external' ? ui("ui.external_installation_read_only_9cedb28") : data.backend.delivery === 'release' ? ui("ui.nexus_github_release_44f7ae9") : data.backend.source === 'managed' ? ui("ui.local_versioned_build_284259d") : '—'}</strong></div><div><span>{ui("ui.commit_79663c1")}</span><strong className="mono">{data.backend.commit?.slice(0, 12) ?? '—'}</strong></div></div><div className="button-row"><button className="secondary" disabled={Boolean(busy) || data.backend.updating || data.backend.checking} onClick={() => invoke('backend-rebuild', () => window.launcher.rebuildBackend(), ui("ui.pinned_backend_source_was_built_and_activated_70c1519"))}><Github />{ui("ui.build_backend_from_source_e654dac")}</button></div>{data.backend.updating || logs.length > 0 ? <pre className="build-log">{logs.join('\n') || ui("ui.waiting_for_backend_output_1ad8939")}</pre> : null}</section>
        <section><h3>{ui("ui.runtime_details_77fa868")}</h3><p className="diagnostic-path mono">{data.runtime.winePath ?? ui("ui.no_runtime_selected_b8e7445")}</p><div className="meta-grid"><div><span>{ui("ui.source_56ccd01")}</span><strong>{runtimeInfo.source}</strong></div><div><span>{ui("ui.build_3053677")}</span><strong className="mono">{data.runtime.commit ?? '—'}</strong></div></div></section>
        <section><h3>{ui("ui.build_dependencies_8926e84")}</h3><div className="dependency-grid"><ToggleStatus ok={data.backend.prerequisites.git} label="Git" /><ToggleStatus ok={data.backend.prerequisites.cargo} label="Cargo" /><ToggleStatus ok={data.backend.prerequisites.rustc} label="Rust 1.99" /><ToggleStatus ok={data.backend.prerequisites.protoc} label="protoc" /></div><p className="fine-print">{ui("ui.building_xodus_also_requires_a_c_c_toolchain_cma_a847b06")}</p></section>
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
    <div className="wizard" role="dialog" aria-modal="true" aria-label={ui("ui.set_up_xodus_nexus_e3954fb")}>
      <div><span className="overline">{ui("ui.welcome_26ded03")}</span><h1>{ui("ui.set_up_xodus_nexus_e3954fb")}</h1></div>
      <section className="wizard-disclaimer" role="note" aria-labelledby="wizard-disclaimer-title">
        <CircleAlert aria-hidden="true" />
        <div><h2 id="wizard-disclaimer-title">{ui("ui.independent_unofficial_project_4197cf7")}</h2>
          <p>{ui("ui.xodus_nexus_is_built_on_xodus_but_it_is_551be13")}{' '}<strong>{ui("ui.not_an_official_xodus_project_d61df4f")}</strong>{' '}{ui("ui.and_is_not_developed_or_maintained_by_the_upstre_af143ff")}</p>
          <p>{ui("ui.please_report_nexus_issues_only_in_the_c9de146")}{' '}<a href="https://github.com/domsvoboda/xodus-nexus/issues" target="_blank" rel="noopener noreferrer">{ui("ui.nexus_repository_068a220")}</a>{ui("ui.not_upstream_a_problem_in_nexus_may_not_exist_in_e123052")}</p>
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
  const visible = open && page !== 'store' && results.length > 0;
  return <div className="search-box" onFocus={() => setOpen(true)} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}><Search /><input value={query} onChange={event => { change(event.target.value); setOpen(true); }} onKeyDown={event => {
    if (event.key === 'Escape') setOpen(false);
    if (event.key === 'Enter' && term.length >= 2) { setOpen(false); submit(query.trim()); }
  }} aria-expanded={visible} aria-controls={visible ? 'global-search-results' : undefined} placeholder={ui("ui.search_games_add_ons_and_your_library_55858e9")} />
    {query ? <button aria-label={ui("ui.clear_search_3b7ea51")} onClick={() => { change(''); setOpen(false); }}><X /></button> : null}
    {visible ? <div className="search-results" id="global-search-results">{results.map(game => <button key={game.id} onClick={() => { setOpen(false); change(''); select(game.id); }}><Cover game={game} /><span><GameTitle title={game.title} /><small>{game.storeId ?? game.path}</small></span></button>)}</div> : null}
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
  const [socialChat,setSocialChat]=useState<{id:number;xuid:string;identity:string}>();
  const notifications=useNotifications(data);
  const [desktopProfile,setDesktopProfile]=useState<XboxProfileRequest>();
  // App stays mounted while pages change, unlike LibraryPage/AccountGames.
  const [libraryFilters, setLibraryFilters] = useState<LibraryFilters>(() => loadLibraryFilters());
  const [librarySelection, setLibrarySelection] = useState<{ id: string }>();
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
    setSocialOpen(false);setPage(next);
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

  function openLibraryGame(id: string) {
    if (!data.games.some(game => game.id === id)) return;
    setLibrarySelection({ id });
    setSearch('');
    changeLibraryFilters({ ...defaultLibraryFilters, playState: 'installed' });
    setSocialOpen(false);setPage('library');
  }

  function action(fn: () => Promise<unknown>, success?: string) { void fn().then(() => success && setToast({ kind: 'success', message: success })).catch((error) => setToast({ kind: 'error', message: errorMessage(error) })); }

  if (loading) return <div className="boot"><div className="brand-mark">X</div><LoaderCircle className="spin" /><span>{ui("ui.loading_xodus_nexus_2e92cfd")}</span></div>;
  return <ConfirmationProvider><PackageInstallProvider><div className="app-shell">
    {!data.settings.firstRunCompleted ? <FirstRunWizard data={data} toast={(value) => setToast(value)} /> : null}
    <Sidebar data={data} page={page} go={go} openGame={openLibraryGame} notifications={<NotificationBell key={JSON.stringify([data.auth.username,data.backend.binaryPath])} notices={notifications.notices} failed={notifications.failed} unsupported={notifications.unsupported} onSelect={notice=>{
      notifications.acknowledge(notice);
      if(notice.kind==='update')openLibraryGame(notice.target);
      else{setSocialChat(previous=>({id:(previous?.id??0)+1,xuid:notice.target,identity:JSON.stringify([data.auth.username,data.backend.binaryPath])}));setSocialMounted(true);setSocialOpen(true);}
    }}/>}/>

    <section className="content-shell">
      <header className="topbar"><GlobalSearch games={data.games} page={page} query={search} change={setSearch} submit={value => { setSubmittedSearch(value); go('store'); }} select={openLibraryGame} /><TopStatus data={data} go={go} /></header>
      <div className={'page-scroll'+(page==='social'?' social-full-page':'')}>{page === 'home' ? <HomePage data={data} go={go} action={action} /> : null}{page === 'store' ? <StorePage data={data} toast={setToast} go={go} initialQuery={submittedSearch} /> : null}{page === 'library' ? <LibraryPage data={data} toast={setToast} filters={libraryFilters} onFiltersChange={changeLibraryFilters} selection={librarySelection} /> : null}{page === 'downloads' ? <DownloadsPage data={data} toast={setToast} /> : null}{page === 'settings' ? <SettingsPage data={data} toast={setToast} /> : null}{page === 'social' ? <div className="nexus-social-page"><XboxSocial key={JSON.stringify([data.auth.username,data.backend.binaryPath])} auth={data.auth} api={window.launcher.nativeSocial} voice={data.backend.available&&data.backend.capabilities.nativeSocial?window.launcher:undefined} runtimeInvites={data.social} runtimeApi={window.launcher} expanded active={!socialOpen} readKeys={notifications.readKeys} onViewed={notifications.viewed} showProfile={desktopProfile}/></div> : null}</div>
      {socialOpen?<button className="nexus-social-scrim" aria-label={ui("social.close_social_shelf_09c6eb")} onClick={()=>setSocialOpen(false)}/>:null}
      <aside id="nexus-social-shelf" className={'nexus-social-shelf'+(socialOpen?' is-open':'')} aria-label={ui("social.xbox_social_shelf_bb6aaf")} aria-hidden={!socialOpen}
        ref={element=>{if(element)element.inert=!socialOpen;}}>
        {socialMounted?<XboxSocial key={JSON.stringify([data.auth.username,data.backend.binaryPath])} auth={data.auth} api={window.launcher.nativeSocial} voice={data.backend.available&&data.backend.capabilities.nativeSocial?window.launcher:undefined} runtimeInvites={data.social} runtimeApi={window.launcher} shelf active={socialOpen} openChat={socialChat?.identity===JSON.stringify([data.auth.username,data.backend.binaryPath])?socialChat:undefined} readKeys={notifications.readKeys} onViewed={notifications.viewed} close={()=>setSocialOpen(false)}/>:null}
      </aside>
    </section>
    <button className={'nexus-social-toggle'+(socialOpen?' is-open':'')} aria-label={ui("social.xbox_social_9dd063")} aria-expanded={socialOpen} aria-controls="nexus-social-shelf" onClick={()=>go('social')}><UsersRound/><span>{ui("social.social_f1b750")}</span><ChevronRight/></button>
    {toast ? <div className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check /> : toast.kind === 'error' ? <CircleAlert /> : <Terminal />}<span>{uiText(toast.message)}</span><button onClick={() => setToast(undefined)}><X /></button></div> : null}
  </div><GamepadNavigation back={() => setPage('home')} page={delta => setPage(current => {
    const pages: Page[] = ['home', 'library', 'store'];
    const index = pages.indexOf(current);
    return index === -1 ? pages[delta > 0 ? 0 : pages.length - 1] : pages[(index + delta + pages.length) % pages.length];
  })} /></PackageInstallProvider></ConfirmationProvider>;
}
