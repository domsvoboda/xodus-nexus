import { ui, uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import type { KeyringStatus } from '../shared/types';

export function KeyringSetup({ disabled = false, compact = false }: { disabled?: boolean; compact?: boolean }) {
  const [status, setStatus] = useState<KeyringStatus>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  async function check(start = false, create = false) {
    const id = ++generation.current;
    setBusy(true); setFailed(false);
    try {
      const result = await (create ? window.launcher.createKeyringCollection() : start ? window.launcher.startKeyring() : window.launcher.checkKeyring());
      if (id === generation.current) setStatus(result);
    } catch {
      if (id === generation.current) setFailed(true);
    } finally { if (id === generation.current) setBusy(false); }
  }
  useEffect(() => { void check(); return () => { generation.current++; }; }, []);
  useEffect(() => window.launcher.onKeyringStatus?.(result => {
    generation.current++;
    setStatus(result); setFailed(false); setBusy(false);
  }), []);
  const message = failed
    ? ui("ui.keyring_status_could_not_be_checked_open_your_de_bc61d4b")
    : status?.message ?? ui("ui.checking_the_system_wallet_without_reading_saved_7f5a5c1");
  const actions = <div className="button-row">
    {status?.state === 'needs-setup' && status.canCreate ? <button className="secondary" aria-label={ui("ui.create_wallet_40a49ea")} title={ui("ui.open_the_system_wallet_dialog_choose_your_passwo_2b7c296")} disabled={busy || disabled} onClick={() => void check(false, true)}>{ui("ui.create_wallet_40a49ea")}</button> : null}
    {status?.canStart || status?.canUnlock ? <button className="secondary" aria-label={status.canUnlock ? ui("ui.unlock_wallet_5cb728c") : ui("ui.start_keyring_service_6420935")} title={ui("ui.start_or_unlock_the_installed_wallet_using_its_o_ab8be21")} disabled={busy || disabled} onClick={() => void check(true)}>{status.canUnlock ? ui("ui.unlock_wallet_5cb728c") : compact ? ui("ui.start_service_c5686e2") : ui("ui.start_keyring_service_6420935")}</button> : null}
    <button className="secondary" aria-label={ui("ui.check_keyring_072a382")} title={ui("ui.check_keyring_072a382")} disabled={busy || disabled} onClick={() => void check()}><RefreshCw />{compact ? null : ui("ui.check_keyring_072a382")}</button>
  </div>;
  const icon = busy ? <LoaderCircle className="spin" /> : status?.state === 'ready' ? <Check /> : <CircleAlert />;
  const safety = ui("ui.your_wallet_provider_handles_its_password_window_eb886e1");
  const gameModeHelp = ui("ui.use_start_service_or_unlock_wallet_for_this_sess_de70f4d");
  if (compact) {
    const problem = failed || Boolean(status && !['ready', 'stopped'].includes(status.state));
    const label = busy ? ui("ui.checking_ec963ff") : failed ? ui("ui.unavailable_ca18449") : status ? {
      ready: ui("ui.ready_5fa7aac"), stopped: ui("ui.not_running_9e3856e"), locked: ui("ui.locked_a424e33"), disabled: ui("ui.disabled_75081b5"),
      missing: ui("ui.not_installed_d177cdc"), 'needs-setup': ui("ui.setup_needed_3b19dc5"), unavailable: ui("ui.unavailable_ca18449"),
    }[status.state] : ui("ui.checking_ec963ff");
    return <section className="keyring-setup keyring-compact" aria-label={ui("ui.system_keyring_945024c")}>
      <div className="keyring-compact-row"><div className="keyring-status" role="status" aria-live="polite">{icon}<div><strong>{ui("ui.system_keyring_945024c")}</strong><small>{label}</small></div></div>{actions}</div>
      {problem ? <>
        <p className="keyring-problem">{uiText(message)}</p>
        <details className="keyring-help"><summary>{ui("ui.help_b79cac9")}</summary>{status?.gameMode ? <p className="fine-print">{gameModeHelp}</p> : null}<p className="fine-print">{safety}</p></details>
      </> : null}
    </section>;
  }
  return <section className="keyring-setup" aria-label={ui("ui.system_keyring_945024c")}>
    <div className="keyring-status" role="status" aria-live="polite">
      {icon}
      <div><strong>{ui("ui.system_keyring_945024c")}</strong><p>{uiText(message)}</p></div>
    </div>
    {status?.gameMode && status.state !== 'ready' ? <p className="fine-print">{gameModeHelp}</p> : null}
    {actions}
    <p className="fine-print">{safety}</p>
  </section>;
}
