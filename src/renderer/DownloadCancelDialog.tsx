import { CheckField } from './CheckField';
import { useDialogFocus } from './use-dialog-focus';
import { ui, uiText } from './i18n';
import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { DownloadCancelOptions, DownloadTask } from '../shared/types';

export function DownloadCancelDialog({ task, options, loading, busy, error, close, choose }: {
  task: DownloadTask; options?: DownloadCancelOptions; loading: boolean; busy: boolean; error?: string;
  close: () => void; choose: (mode: 'keep' | 'delete-files') => void;
}) {
  const [confirmed, setConfirmed] = useState(false), dialog = useRef<HTMLElement>(null);
  const active = ['running', 'paused', 'queued'].includes(task.status);
  const canDelete = task.kind === 'install' && !task.gameId && options?.deleteFilesAllowed === true;
  useDialogFocus(dialog, close, true, busy);
  return <div className="dialog-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className="game-dialog download-cancel-dialog" role="dialog" aria-modal="true" aria-label={ui("ui.cancel_download_de5b23e")} aria-busy={busy}>
      <h2>{ui('common.cancel_game', { game: task.title })}</h2>
      <p>{ui("ui.keep_the_downloaded_files_for_a_later_retry_or_d_d5003b6")}</p>
      <code className="remove-path">{task.destination}</code>
      <p>{loading ? ui("ui.checking_whether_files_can_be_deleted_safely_9e24229") : task.kind !== 'install' || task.gameId
        ? ui("ui.updates_and_dlc_keep_their_files_to_protect_the_22f35d6") : options?.reason ?? ui("ui.only_this_new_installation_folder_will_be_delete_8a2e43b")}</p>
      {canDelete ? <CheckField className="download-delete-confirm" label={ui("ui.permanently_delete_this_new_installation_folder_c3adf8e")} checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /> : null}
      {!active && !busy ? <p role="status">{ui("ui.this_download_has_already_ended_a8cdae1")}</p> : null}
      {busy ? <p role="status">{ui("ui.stopping_the_download_files_will_not_be_removed_b89d63d")}</p> : null}
      {error ? <p className="error-text" role="alert">{uiText(error)}</p> : null}
      <div className="dialog-actions">
        <button className="secondary" data-gamepad-cancel disabled={busy} onClick={close}>{ui("ui.go_back_6aadac2")}</button>
        <button className="secondary" data-gamepad-initial disabled={busy || !active} onClick={() => choose('keep')}>{ui("ui.cancel_and_keep_files_85a1bb9")}</button>
        <button className="secondary danger" disabled={busy || !active || loading || !canDelete || !confirmed} onClick={() => choose('delete-files')}><Trash2 />{ui("ui.cancel_and_delete_files_57f80d5")}</button>
      </div>
    </section>
  </div>;
}
