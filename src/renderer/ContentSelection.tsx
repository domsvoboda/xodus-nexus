import { useEffect, useRef } from 'react';
import type { GameContentItem, GameContentPlan } from '../shared/types';
import { installByteLabel } from '../shared/install-storage';
import { ui, uiText } from './i18n';

export function selectableContent(item: GameContentItem): boolean {
  return item.status === 'installed' || Boolean(item.access) && item.status === 'available' || item.status === 'verify';
}
export function contentSelection(plan: GameContentPlan | undefined, selected: string[], action: 'install' | 'repair' | 'remove'): string[] {
  return (plan?.items ?? []).filter(item => selected.includes(item.productId)
    && (action === 'install' ? Boolean(item.access) && item.status === 'available' || item.status === 'verify' && !item.installedFiles
      : (item.status === 'installed' || item.installedFiles) && (action === 'remove' || Boolean(item.access) || item.status === 'verify'))).map(item => item.productId);
}
export function ContentList({ plan, disabled, selected, change }: { plan: GameContentPlan; disabled: boolean; selected: string[]; change: (ids: string[]) => void }) {
  const eligible = plan.items.filter(selectableContent);
  const checked = eligible.filter(item => selected.includes(item.productId)).length;
  const all = useRef<HTMLInputElement>(null);
  useEffect(() => { if (all.current) all.current.indeterminate = checked > 0 && checked < eligible.length; }, [checked, eligible.length]);
  return <div className="content-list">
    {eligible.length ? <label className="content-select-all"><input ref={all} type="checkbox" checked={checked === eligible.length} disabled={disabled} aria-checked={checked > 0 && checked < eligible.length ? 'mixed' : checked === eligible.length} onChange={event => change(event.target.checked ? eligible.map(item => item.productId) : [])} /><strong>{ui('dlc.select_all')}</strong><span>{ui('dlc.selection_count', { selected: checked, total: eligible.length })}</span></label> : null}
    {plan.items.length ? plan.items.map(item => <article key={item.productId}>
      <label className="content-choice"><input type="checkbox" aria-label={item.title} checked={selected.includes(item.productId)} disabled={disabled || !selectableContent(item)} onChange={event => change(event.target.checked ? [...selected, item.productId] : selected.filter(id => id !== item.productId))} />
        <span><strong title={item.title} dir="auto">{item.title}</strong><small>{item.access === 'owned' ? ui('ui.owned_17b760c') : item.access === 'gamepass' ? ui('ui.game_pass_5c83b40') : item.access === 'other' ? ui('ui.other_access_542b2ae') : ui('ui.license_not_verified_b4ac386')}{' · '}{item.status === 'installed' ? ui('ui.installed_f8b32f4') : item.status === 'verify' ? item.installedFiles ? ui('dlc.installed_verify') : ui('ui.license_check_required_cb65e96') : item.status === 'available' ? ui('ui.not_installed_d177cdc') : item.status === 'license-only' ? ui('ui.no_download_required_56d8478') : item.status === 'bundle' ? ui('ui.content_bundle_ccfe4f2') : item.status === 'unsupported' ? ui('ui.unsupported_package_d72ac5f') : ui('ui.unavailable_ca18449')}</small>
          {item.downloadBytes ? <small>{ui('package.estimate', { size: installByteLabel(item.downloadBytes) })}</small> : null}<small>{uiText(item.note)}</small></span>
      </label>
    </article>) : <p>{ui('ui.no_related_add_ons_were_found_for_this_game_37fb940')}</p>}
  </div>;
}
