import { useEffect, useState } from 'react';
import { CircleAlert, CloudOff, LoaderCircle, RefreshCw } from 'lucide-react';
import type { OfflinePermissions } from '../shared/types';
import { offlinePermissionLimitText } from '../shared/offline-permissions';
import { useConfirmation } from './Confirmation';

type Toast = { kind: 'success' | 'error'; message: string };

/** Confirmation wording for a change, mirroring the Xbox app's dialog. */
export function offlinePermissionConfirmation(status: OfflinePermissions, enable: boolean): { title: string; message: string; confirmLabel: string } {
  const remainingAfter = status.remainingToggles === undefined ? undefined : Math.max(0, status.remainingToggles - 1);
  const limit = status.maxToggles ? `Microsoft allows ${status.maxToggles} changes of this setting per ${status.periodDays && status.periodDays !== 365 ? `${status.periodDays} days` : 'year'}` : 'Microsoft limits how often this setting can change';
  const after = remainingAfter === undefined ? '' : remainingAfter === 0
    ? ' This is your last change for this period.'
    : ` After this change you will have ${remainingAfter} left.`;
  return enable
    ? { title: 'Use this device for offline play?', message: `Only one PC per account can play offline. Turning this on here removes offline play from any other PC on your account; games on this device need one launch while online afterwards. ${limit}.${after}`, confirmLabel: 'Turn on' }
    : { title: 'Turn off offline play on this device?', message: `Games on this device will need a connection to start, and stored offline licenses stop being renewed. ${limit}.${after}`, confirmLabel: 'Turn off' };
}

export function OfflinePermissionsView({ status, busy, error, onToggle, onRetry }: {
  status?: OfflinePermissions; busy: boolean; error?: string; onToggle: (enable: boolean) => void; onRetry: () => void;
}) {
  const exhausted = status?.remainingToggles === 0;
  // The Xbox app still lets a designated PC turn the setting off; only turning it on needs a change left.
  const locked = !status || busy || (exhausted && !status.enabled);
  return <section className="settings-card offline-permissions-card">
    <div className="settings-heading"><div className="settings-icon"><CloudOff /></div><div><span className="overline">OFFLINE PERMISSIONS</span><h2>Play games offline on this device</h2><p>Same setting as the Xbox app: one PC per account can play installed games without a connection.</p></div>
      {status ? <span className={`status-label ${status.enabled ? 'ready' : 'off'}`}>{status.enabled ? 'ON' : 'OFF'}</span> : null}</div>
    {error ? <div className="alert amber"><CircleAlert /><span>{error}</span></div> : null}
    {!status && !error ? <p className="offline-permissions-note"><LoaderCircle className="spin" /> Checking offline permissions with Microsoft…</p> : null}
    {status ? <>
      <label className="tool-checkbox offline-permissions-toggle" data-testid="offline-permissions-toggle">
        <input type="checkbox" checked={status.enabled} disabled={locked} onChange={event => onToggle(event.target.checked)} />
        <span>Use this device to play games offline</span>
      </label>
      <p className="offline-permissions-note">{status.enabled
        ? 'This is your offline device. Games started once while online can be played without a connection for up to 30 days, as long as they do not require online services.'
        : 'Offline play is off on this device. Installed games need a connection to start.'}</p>
      <p className={`offline-permissions-limit${exhausted ? ' exhausted' : ''}`}>{offlinePermissionLimitText(status)}</p>
    </> : null}
    <div className="button-row"><button className="secondary" disabled={busy} onClick={onRetry}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}Refresh</button></div>
  </section>;
}

export function OfflinePermissionsCard({ toast, signedIn }: { toast: (value: Toast) => void; signedIn: boolean }) {
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
    if (!await confirm(offlinePermissionConfirmation(status, enable))) return;
    setBusy(true); setError(undefined);
    try {
      const next = await window.launcher.setOfflinePermissions(enable);
      setStatus(next);
      const remaining = next.remainingToggles === undefined ? '' : ` ${offlinePermissionLimitText(next)}`;
      toast({ kind: 'success', message: `${enable ? 'Offline play is on for this device.' : 'Offline play is off for this device.'}${remaining}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRevision(value => value + 1);
    } finally { setBusy(false); }
  }

  return <OfflinePermissionsView status={status} busy={busy} error={error} onToggle={(enable) => void toggle(enable)} onRetry={() => setRevision(value => value + 1)} />;
}
