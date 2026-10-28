import { ui } from './i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Clock3, Download, Gamepad2, Images, LoaderCircle, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import type { AppSnapshot, Game, GameActivity, GameStoreDetails } from '../shared/types';
import './game-details.css';
import { Achievements } from './Achievements';

export function formatMinutes(minutes?: number): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return ui("ui.unavailable_ca18449");
  if (minutes === 0) return ui('time.zero_minutes');
  if (minutes < 1) return ui('time.under_minute');
  const hours = Math.floor(minutes / 60), remainder = Math.floor(minutes % 60);
  return hours ? remainder ? ui('time.hours_minutes', { hours, minutes: remainder }) : ui('time.hours', { count: hours }) : ui('time.minutes', { count: remainder });
}

function activityNote(activity?: GameActivity): string {
  switch (activity?.status) {
    case 'signed-out': return ui("ui.sign_in_to_view_xbox_activity_8f133b5");
    case 'unsupported': return ui("ui.update_the_backend_to_read_xbox_activity_b0b750b");
    case 'error': return ui("ui.xbox_activity_could_not_be_loaded_try_refreshing_4198490");
    case 'unavailable': return ui("ui.xbox_has_no_activity_available_for_this_game_1316723");
    default: return activity?.partial ? ui("ui.some_xbox_activity_could_not_be_retrieved_2983ce6") : ui("ui.from_xbox_b4d7da3");
  }
}

function Artwork({ src, alt, ...props }: { src?: string; alt: string; className?: string; loading?: 'lazy' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img src={src} alt={alt} {...props} referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="gd-artwork-unavailable"><Gamepad2 /><span>{alt || ui("ui.artwork_unavailable_f4d58d3")}</span></span>;
}

export function Gallery({ title, images, initial, close }: { title: string; images: string[]; initial: number; close: () => void }) {
  const [index, setIndex] = useState(initial);
  const ref = useRef<HTMLElement>(null), onClose = useRef(close); onClose.current = close;
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    ref.current?.querySelector<HTMLButtonElement>('[data-gamepad-cancel]')?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose.current(); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setIndex(i => (i + (event.key === 'ArrowRight' ? 1 : images.length - 1)) % images.length); }
      if (event.key === 'Tab') {
        const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (origin?.isConnected) origin.focus({ preventScroll: true }); };
  }, [images.length]);
  return <div className="gd-lightbox-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={ref} className="gd-lightbox" role="dialog" aria-modal="true" aria-label={ui("ui.screenshots_25e204e", { game: title })} data-gamepad-gallery="">
      <header><span>{title}<small aria-live="polite">{index + 1} / {images.length}{' '}{ui("ui.microsoft_store_d4479a8")}</small></span><button className="secondary gd-gallery-close" data-gamepad-cancel aria-label={ui("ui.close_gallery_69e9e29")} onClick={close}><X />{ui("ui.close_7d9eb7a")}<span className="gd-controller-hint" aria-hidden="true">B</span></button></header>
      <div className="gd-lightbox-image"><Artwork src={images[index]} alt={ui("ui.screenshot_a41bf12", { game: title, index: index + 1 })} /></div>
      <footer><button className="secondary" data-gamepad-gallery-previous aria-label={ui("ui.previous_screenshot_af9be11")} onClick={() => setIndex(i => (i - 1 + images.length) % images.length)}><span className="gd-controller-hint" aria-hidden="true">L1</span><ChevronLeft />{ui("ui.previous_a57b08a")}</button><button className="secondary" data-gamepad-gallery-next aria-label={ui("ui.next_screenshot_fd250fd")} onClick={() => setIndex(i => (i + 1) % images.length)}>{ui("ui.next_1ff57a2")}<ChevronRight /><span className="gd-controller-hint" aria-hidden="true">R1</span></button></footer>
    </section>
  </div>;
}

interface PageProps {
  game: Pick<Game,'id'|'title'|'publisher'|'coverUrl'|'heroUrl'> & {installState?:Game['installState']};
  catalogProductId?: string;
  detailId?: string;
  back: () => void;
  backLabel?: string;
  play: ReactNode;
  manage?: ReactNode;
  notices?: ReactNode;
  technical?: ReactNode;
  achievements?: ReactNode;
}
interface ContentProps extends PageProps {
  details?: GameStoreDetails;
  activity?: GameActivity;
  metadataLoading?: boolean;
  activityLoading?: boolean;
  metadataError?: boolean;
  refresh: () => void;
}

/** Descriptive data never gates Play or changes package/licensing decisions. */
export function GameDetailsContent({ game, detailId,back, backLabel, play, manage, notices, technical, achievements, details, activity, metadataLoading, activityLoading, metadataError, refresh }: ContentProps) {
  const [gallery, setGallery] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  const manageRef = useRef<HTMLDetailsElement>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const closeManage = (restoreFocus = true) => {
    if (manageRef.current) manageRef.current.open = false;
    setManageOpen(false);
    if (restoreFocus) manageRef.current?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
  };
  const images = details?.screenshots ?? [];
  const description = details?.description ?? '';
  const shortDescription = description.split(/\r?\n\s*\r?\n/)[0];
  const release = details?.releaseDate && Number.isFinite(Date.parse(details.releaseDate)) ? new Date(details.releaseDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : undefined;
  const lastPlayed = activity?.lastPlayed && Number.isFinite(Date.parse(activity.lastPlayed)) ? new Date(activity.lastPlayed).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ui("ui.unavailable_ca18449");
  useEffect(() => {
    if (!manageOpen) return;
    const fit = () => {
      const summary = manageRef.current?.querySelector('summary');
      const menu = manageRef.current?.querySelector<HTMLElement>('[role="menu"]');
      if (!summary || !menu) return;
      const rect = summary.getBoundingClientRect();
      const top = Math.max(8, (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 8);
      const above = rect.top - top - 6, below = window.innerHeight - rect.bottom - 14;
      const upwards = below < 240 && above > below;
      menu.style.top = upwards ? 'auto' : 'calc(100% + 6px)';
      menu.style.bottom = upwards ? 'calc(100% + 6px)' : 'auto';
      menu.style.maxHeight = `${Math.max(40, Math.min(380, upwards ? above : below))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    return () => { window.removeEventListener('resize', fit); window.removeEventListener('scroll', fit, true); };
  }, [manageOpen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (manageRef.current?.open) { event.preventDefault(); closeManage(); return; }
      if (!document.querySelector('[data-game-menu]')) { event.preventDefault(); back(); }
    };
    const outside = (event: PointerEvent) => { if (manageRef.current?.open && event.target instanceof Node && !manageRef.current.contains(event.target)) closeManage(false); };
    window.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
  }, [back]);
  return <section className="game-details-page" data-gamepad-detail={detailId??game.id}>
    <div className="gd-back-row"><button className="gd-back" data-gamepad-detail-back onClick={back}><ArrowLeft />{backLabel??ui("ui.back_to_library_008e42d")}<span className="gd-back-hint" aria-hidden="true">B</span></button></div>
    <section className="gd-hero">
      <Artwork className="gd-hero-art" src={details?.heroUrl ?? game.heroUrl ?? game.coverUrl} alt="" />
      <div className="gd-hero-shade" />
      <div className="gd-hero-copy"><span className={`gd-ready ${game.installState??'not-installed'}`}>{game.installState?<Check />:<Download />}{game.installState === 'ready' ? ui("ui.installed_f8b32f4") : game.installState === 'incomplete' ? ui("ui.incomplete_75f33cd") : game.installState === 'imported'?ui("ui.imported_321f179"):ui('ui.not_installed_d177cdc')}</span><h1>{game.title}</h1><p>{details?.publisher ?? game.publisher ?? ui("ui.publisher_not_provided_356ad2b")}</p><div className="gd-tags">{details?.categories.map(category => <span key={category}>{category}</span>)}</div></div>
    </section>
    <div className="gd-page-content">
      <section className="gd-play-row" data-gamepad-action-row aria-label={ui("ui.game_actions_and_activity_e9f3793")}>
        <div className="button-row gd-play-controls">{play}</div>
        <div className="gd-stat"><Clock3 /><div><span>{ui("ui.xbox_time_played_1e875b7")}{' '}<button className="gd-refresh" aria-label={ui("ui.refresh_xbox_activity_084d9ee")} disabled={activityLoading} onClick={refresh}>{activityLoading ? <LoaderCircle className="spin" /> : <RefreshCw />}</button></span><strong>{activityLoading && !activity ? ui("ui.loading_ba3bbbe") : formatMinutes(activity?.minutesPlayed)}</strong><small>{activityLoading ? ui("ui.reading_xbox_activity_9d52eb6") : activityNote(activity)}</small></div></div>
        <div className="gd-stat gd-last-played"><div><span>{ui("ui.last_played_63abe4e")}</span><strong>{activityLoading && !activity ? ui("ui.loading_ba3bbbe") : lastPlayed}</strong></div></div>
        {manage?<details ref={manageRef} className="gd-actions" data-game-menu={manageOpen ? '' : undefined} onToggle={event => setManageOpen(event.currentTarget.open)}><summary aria-label={ui("ui.more_game_actions_4cc8fdf")}><MoreHorizontal /><span>{ui("ui.manage_5a23444")}</span></summary><div role="menu" aria-label={ui("ui.manage_game_549ca46")} onClick={event => { if ((event.target as HTMLElement).closest('button:not(:disabled)')) closeManage(); }}>{manage}</div></details>:null}
      </section>
      {notices}
      {achievements}
      <div className="gd-detail-columns">
        <div className="gd-description-column">
          <section className="gd-about"><h2>{ui("ui.about_the_game_e2a1493")}</h2><p>{metadataLoading ? ui("ui.loading_game_information_e1d47a6") : description ? expanded ? description : shortDescription : metadataError ? ui('game.details_unavailable') : ui("ui.microsoft_store_did_not_provide_a_description_fo_6834c95")}</p>{description !== shortDescription ? <button className="gd-text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? ui("ui.show_less_94ea9b1") : ui("ui.read_more_83b7941")}<ChevronRight /></button> : null}</section>
          <section className="gd-gallery"><header><h2>{ui("ui.screenshots_067348c")}</h2>{images.length ? <button className="gd-text-button" onClick={() => setGallery(0)}><Images />{ui('common.view_all', { count: images.length })}</button> : null}</header><div>{images.slice(0, 4).map((url, index) => <button key={url} aria-label={ui("ui.open_screenshot_e0b47e2", { index: index + 1 })} onClick={() => setGallery(index)}><Artwork loading="lazy" src={url} alt={ui("ui.screenshot_a41bf12", { game: game.title, index: index + 1 })} /></button>)}</div>{!images.length ? <p className="gd-empty">{metadataLoading ? ui("ui.loading_screenshots_e06f723") : ui("ui.no_screenshots_available_284d07a")}</p> : null}</section>
        </div>
        <aside className="gd-facts"><h2>{ui("ui.game_information_978fa44")}</h2><dl><div><dt>{ui("ui.publisher_2137854")}</dt><dd>{details?.publisher ?? game.publisher ?? ui("ui.unavailable_ca18449")}</dd></div><div><dt>{ui("ui.release_date_bd84924")}</dt><dd>{release ?? ui("ui.unavailable_ca18449")}</dd></div><div><dt>{ui("ui.categories_b8b1d89")}</dt><dd>{details?.categories.length ? details.categories.join(' · ') : ui("ui.unavailable_ca18449")}</dd></div>{details ? <div><dt>{ui("ui.metadata_source_7be21e8")}</dt><dd>Microsoft Store</dd></div> : null}</dl>{technical?<details><summary>{ui("ui.installation_details_7ee3b59")}</summary>{technical}</details>:null}</aside>
      </div>
      <p className="gd-disclaimer">{ui("ui.xbox_activity_may_be_delayed_or_unavailable_for_c15dd35")}</p>
    </div>
    {gallery !== undefined && images.length ? <Gallery title={game.title} images={images} initial={gallery} close={() => setGallery(undefined)} /> : null}
  </section>;
}

export function GameDetails(props: PageProps & { data: AppSnapshot }) {
  const { game, data } = props;
  const target=useMemo(()=>props.catalogProductId?{productId:props.catalogProductId}:game.id,[game.id,props.catalogProductId]);
  const [details, setDetails] = useState<GameStoreDetails>();
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [metadataError, setMetadataError] = useState(false);
  const [activity, setActivity] = useState<GameActivity>();
  const [activityLoading, setActivityLoading] = useState(true);
  const request = useRef(0);
  useEffect(() => {
    let live = true; setDetails(undefined); setMetadataLoading(true); setMetadataError(false);
    window.launcher.getGameDetails(target).then(value => { if (live) setDetails(value); }).catch(() => { if (live) setMetadataError(true); }).finally(() => { if (live) setMetadataLoading(false); });
    return () => { live = false; };
  }, [target, data.settings.market]);
  const loadActivity = useCallback((refresh = false) => {
    const id = ++request.current; setActivityLoading(true);
    void window.launcher.getGameActivity(target, refresh).then(value => { if (request.current === id) setActivity(value); }).catch(() => { if (request.current === id) setActivity({ status: 'error' }); }).finally(() => { if (request.current === id) setActivityLoading(false); });
  }, [target, data.auth.username, data.auth.stored, data.auth.running, data.backend.binaryPath, data.backend.capabilities.gameActivity, data.settings.market]);
  useEffect(() => { setActivity(undefined); loadActivity(); return () => { request.current++; }; }, [loadActivity]);
  return <GameDetailsContent {...props} details={details} activity={activity} metadataLoading={metadataLoading} metadataError={metadataError} activityLoading={activityLoading} refresh={() => loadActivity(true)} achievements={<Achievements gameId={game.id} target={target} title={game.title} data={data} />} />;
}
