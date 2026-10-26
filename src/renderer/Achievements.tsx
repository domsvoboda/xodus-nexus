import { ui } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Eye, LoaderCircle, LockKeyhole, RefreshCw, Trophy, X } from 'lucide-react';
import type { AppSnapshot, GameAchievement, GameAchievements } from '../shared/types';
import './achievements.css';

export type AchievementFilter = 'all' | 'unlocked' | 'locked';
export function achievementList(items: GameAchievement[], filter: AchievementFilter): GameAchievement[] {
  return items.filter(item => filter === 'all' || (filter === 'unlocked' ? item.state === 'unlocked' : item.state !== 'unlocked'))
    .sort((a, b) => Number(b.state === 'unlocked') - Number(a.state === 'unlocked')
      || (b.unlockedAt ? Date.parse(b.unlockedAt) : 0) - (a.unlockedAt ? Date.parse(a.unlockedAt) : 0)
      || a.name.localeCompare(b.name));
}
export function achievementSummary(items: GameAchievement[]) {
  const unlocked = items.filter(item => item.state === 'unlocked');
  return { earned: unlocked.length, count: items.length,
    score: items.length && items.every(item => item.gamerscore !== undefined)
      ? `${unlocked.reduce((sum, item) => sum + item.gamerscore!, 0)} / ${items.reduce((sum, item) => sum + item.gamerscore!, 0)} G` : undefined };
}

export function AchievementCard({ item }: { item: GameAchievement }) {
  const [revealed, setRevealed] = useState(false), [failed, setFailed] = useState(false);
  const hidden = item.secret && item.state !== 'unlocked' && !revealed;
  const date = item.unlockedAt ? new Date(item.unlockedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : undefined;
  return <li className={`achievement-card ${item.state}`} data-gamepad-card tabIndex={hidden ? -1 : 0}>
    <div className="achievement-icon">{!hidden && item.iconUrl && !failed ? <img src={item.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Trophy />}</div>
    <div className="achievement-copy"><div className="achievement-title"><h3>{hidden ? ui("ui.secret_achievement_92cc1bc") : item.name}</h3>{item.gamerscore !== undefined ? <span>{item.gamerscore} G</span> : null}</div>
      <p>{hidden ? ui("ui.reveal_the_details_only_if_you_want_to_see_spoil_bed0858") : item.description}</p>
      <small>{item.state === 'unlocked' ? <><Check />{ui("ui.unlocked_531c7b2")}{date ? ` · ${date}` : ''}</> : <><LockKeyhole />{item.revoked ? ui("ui.revoked_f6f738d") : item.state === 'in-progress' ? ui("ui.in_progress_c1f88e9") : ui("ui.locked_a424e33")}</>}</small>
      {!hidden && item.progress !== undefined && item.state !== 'unlocked' ? <div className="achievement-progress"><progress max={100} value={item.progress} aria-label={ui("ui.achievement_progress_437de55")} /><span>{Math.floor(item.progress)}%</span></div> : null}
      {hidden ? <button className="gd-text-button" onClick={() => setRevealed(true)}><Eye />{ui("ui.reveal_details_e929755")}</button> : null}
    </div>
  </li>;
}

export function AchievementsDialog({ title, value, close }: { title: string; value: GameAchievements; close: () => void }) {
  const [filter, setFilter] = useState<AchievementFilter>('all');
  const ref = useRef<HTMLElement>(null), onClose = useRef(close); onClose.current = close;
  const items = achievementList(value.items ?? [], filter);
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    ref.current?.querySelector<HTMLElement>('[data-gamepad-cancel]')?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose.current(); }
      if (event.key === 'Tab') {
        const buttons = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled),select,[tabindex="0"]')];
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (origin?.isConnected) origin.focus({ preventScroll: true }); };
  }, []);
  return <div className="achievements-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={ref} className="achievements-dialog" role="dialog" aria-modal="true" aria-labelledby="achievements-title">
      <header><div><h2 id="achievements-title">{ui("ui.achievements_74cf2bc")}</h2><p>{title}</p></div><button className="secondary" data-gamepad-cancel onClick={close}><X />{ui("ui.close_7d9eb7a")}<span className="gd-controller-hint" aria-hidden="true">B</span></button></header>
      <label className="achievements-filter">{ui("ui.show_0df6f1c")}<select aria-label={ui("ui.filter_achievements_af8fe94")} value={filter} onChange={event => setFilter(event.target.value as AchievementFilter)}><option value="all">{ui("ui.all_achievements_e2adb0c")}</option><option value="unlocked">{ui("ui.unlocked_531c7b2")}</option><option value="locked">{ui("ui.locked_a424e33")}</option></select></label>
      {value.partial ? <p className="achievements-warning">{ui("ui.only_part_of_the_achievement_list_is_available_c_676ba89")}</p> : null}
      <ul className="achievements-list" aria-label={ui("ui.achievements_74cf2bc")}>{items.map(item => <AchievementCard key={item.id} item={item} />)}</ul>
      {!items.length ? <p className="achievements-empty">{ui("ui.no_achievements_match_this_filter_311c982")}</p> : null}
    </section>
  </div>;
}

function statusText(value?: GameAchievements): string {
  switch (value?.status) {
    case 'signed-out': return ui("ui.sign_in_to_view_your_xbox_achievements_970a464");
    case 'unsupported': return ui("ui.update_the_backend_to_read_xbox_achievements_f17f4e8");
    case 'error': return ui("ui.xbox_achievements_could_not_be_loaded_try_refres_4abc110");
    default: return ui("ui.no_xbox_achievements_are_available_for_this_game_9615682");
  }
}

export function AchievementsContent({ title, value, loading, refresh }: { title: string; value?: GameAchievements; loading: boolean; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (value?.status !== 'available') setOpen(false); }, [value?.status]);
  const items = value?.status === 'available' ? value.items ?? [] : [];
  const summary = achievementSummary(items);
  return <section className="game-achievements" aria-label={ui("ui.xbox_achievements_883e15c")} aria-busy={loading}>
    <header><div><h2><Trophy />{ui("ui.achievements_74cf2bc")}</h2>{items.length ? <p>{value?.partial ? ui("ui.unlocked_in_loaded_7f6b13b", { earned: summary.earned, total: summary.count }) : ui("ui.unlocked_39d0a88", { earned: summary.earned, total: summary.count })}{summary.score ? ` · ${summary.score}` : ''}</p> : null}</div><div className="button-row"><button className="gd-text-button" disabled={loading} onClick={refresh} aria-label={ui("ui.refresh_xbox_achievements_b633cfe")}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui("ui.refresh_0e91610")}</button>{items.length ? <button className="secondary" onClick={() => setOpen(true)}>{ui('common.view_all', { count: items.length })}</button> : null}</div></header>
    {loading && !value ? <p className="achievements-empty">{ui("ui.loading_xbox_achievements_cb468cf")}</p> : !items.length ? <p className="achievements-empty">{value?.partial ? ui("ui.the_achievement_list_is_incomplete_try_refreshin_876bc80") : statusText(value)}</p> : <>
      {value?.partial ? <p className="achievements-warning">{ui("ui.incomplete_list_counts_and_gamerscore_describe_l_87878b8")}</p> : null}
      <ul className="achievements-preview" aria-label={ui("ui.recent_achievements_5e17b64")}>{achievementList(items, 'all').slice(0, 3).map(item => <AchievementCard key={item.id} item={item} />)}</ul>
    </>}
    <p className="achievements-footnote">{ui("ui.from_xbox_availability_and_progress_may_vary_by_e4913f8")}</p>
    {open && value?.status === 'available' ? <AchievementsDialog title={title} value={value} close={() => setOpen(false)} /> : null}
  </section>;
}

export function Achievements({ gameId, title, data }: { gameId: string; title: string; data: AppSnapshot }) {
  const [value, setValue] = useState<GameAchievements>(), [loading, setLoading] = useState(true);
  const request = useRef(0);
  const load = useCallback((refresh = false) => {
    const id = ++request.current; setLoading(true);
    void window.launcher.getGameAchievements(gameId, refresh).then(value => { if (request.current === id) setValue(value); })
      .catch(() => { if (request.current === id) setValue({ status: 'error' }); })
      .finally(() => { if (request.current === id) setLoading(false); });
  }, [gameId, data.auth.username, data.auth.stored, data.auth.running, data.backend.binaryPath, data.backend.capabilities.achievements]);
  useEffect(() => { setValue(undefined); load(); return () => { request.current++; }; }, [load]);
  return <AchievementsContent title={title} value={value} loading={loading} refresh={() => load(true)} />;
}
