import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CloudOff, LoaderCircle, RefreshCw } from 'lucide-react';
import type { OfflinePermissions } from '../shared/types';
import { offlinePermissionLimitText } from '../shared/offline-permissions';
import { useConfirmation } from './Confirmation';
import { ui, uiText } from './i18n';

type Toast = { kind: 'success' | 'error'; message: string };

/** Confirmation wording for a change, mirroring the Xbox app's dialog. */
export function offlinePermissionConfirmation(status: OfflinePermissions, enable: boolean): { title: string; message: string; confirmLabel: string } {
  const remainingAfter = status.remainingToggles === undefined ? undefined : Math.max(0, status.remainingToggles - 1);
  const limit = !status.maxToggles ? ui('offline.limit_unknown')
    : status.periodDays && status.periodDays !== 365 ? ui('offline.limit_days', { count: status.maxToggles, days: status.periodDays })
      : ui('offline.limit_year', { count: status.maxToggles });
  const after = remainingAfter === undefined ? '' : remainingAfter === 0 ? ` ${ui('offline.last_change')}` : ` ${ui('offline.changes_left', { count: remainingAfter })}`;
  return enable
    ? { title: ui('offline.enable_title'), message: `${ui('offline.enable_message')} ${limit}${after}`, confirmLabel: ui('offline.turn_on') }
    : { title: ui('offline.disable_title'), message: `${ui('offline.disable_message')} ${limit}${after}`, confirmLabel: ui('offline.turn_off') };
}

export function OfflinePermissionsView({ status, busy, error, onToggle, onRetry }: {
  status?: OfflinePermissions; busy: boolean; error?: string; onToggle: (enable: boolean) => void; onRetry: () => void;
}) {
  const exhausted = status?.remainingToggles === 0;
  // The Xbox app still lets a designated PC turn the setting off; only turning it on needs a change left.
  const locked = !status || busy || ((exhausted || status.launchSupported === false) && !status.enabled);
  return <section className="settings-card offline-permissions-card">
    <div className="settings-heading"><div className="settings-icon"><CloudOff /></div><div><span className="overline">{ui('offline.overline')}</span><h2>{ui('offline.heading')}</h2><p>{ui('offline.description')}</p></div>
      {status ? <span className={`status-label ${status.enabled ? 'ready' : 'off'}`}>{status.enabled ? ui('offline.on') : ui('offline.off')}</span> : null}</div>
    {error ? <div className="alert amber"><CircleAlert /><span>{uiText(error)}</span></div> : null}
    {!status && !error ? <p className="offline-permissions-note"><LoaderCircle className="spin" /> {ui('offline.checking')}</p> : null}
    {status ? <>
      {status.launchSupported === false ? <div className="alert amber"><CircleAlert /><span>{ui('offline.compatible_components_required')}</span></div> : null}
      <label className="tool-checkbox offline-permissions-toggle" data-testid="offline-permissions-toggle">
        <input type="checkbox" checked={status.enabled} disabled={locked} onChange={event => onToggle(event.target.checked)} />
        <span>{ui('offline.toggle')}</span>
      </label>
      <p className="offline-permissions-note">{status.enabled ? ui('offline.enabled_note') : ui('offline.disabled_note')}</p>
      <p className={`offline-permissions-limit${exhausted ? ' exhausted' : ''}`}>{uiText(offlinePermissionLimitText(status))}</p>
    </> : null}
    <div className="button-row"><button className="secondary" disabled={busy} onClick={onRetry}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}{ui('offline.refresh')}</button></div>
  </section>;
}

export function OfflinePermissionsCard({ toast, signedIn }: { toast: (value: Toast) => void; signedIn: boolean }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const confirm = useConfirmation();
  const [status, setStatus] = useState<OfflinePermissions>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    setBusy(true); setError(undefined);
    window.launcher.offlinePermissions()
      .then(value => { if (!cancelled) setStatus(value); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [signedIn, revision]);
  if (!signedIn) return null;

  async function toggle(enable: boolean) {
    if (!status || busy) return;
    if (!await confirm(offlinePermissionConfirmation(status, enable)) || !mounted.current) return;
    setBusy(true); setError(undefined);
    try {
      const next = await window.launcher.setOfflinePermissions(enable);
      if (!mounted.current) return;
      setStatus(next);
      const remaining = next.remainingToggles === undefined ? '' : ` ${uiText(offlinePermissionLimitText(next))}`;
      toast({ kind: 'success', message: `${enable ? ui('offline.enabled_toast') : ui('offline.disabled_toast')}${remaining}` });
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setRevision(value => value + 1);
    } finally { if (mounted.current) setBusy(false); }
  }

  return <OfflinePermissionsView status={status} busy={busy} error={error} onToggle={(enable) => void toggle(enable)} onRetry={() => setRevision(value => value + 1)} />;
}
