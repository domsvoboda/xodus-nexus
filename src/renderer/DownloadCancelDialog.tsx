import { ui, uiText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { DownloadCancelOptions, DownloadTask } from '../shared/types';

export function DownloadCancelDialog({ task, options, loading, busy, error, close, choose }: {
  task: DownloadTask; options?: DownloadCancelOptions; loading: boolean; busy: boolean; error?: string;
  close: () => void; choose: (mode: 'keep' | 'delete-files') => void;
}) {
  const [confirmed, setConfirmed] = useState(false), dialog = useRef<HTMLElement>(null);
  const state = useRef({ busy, close }); state.current = { busy, close };
  const active = ['running', 'paused', 'queued'].includes(task.status);
  const canDelete = task.kind === 'install' && !task.gameId && options?.deleteFilesAllowed === true;
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLElement>('[data-gamepad-initial]')?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!state.current.busy) state.current.close(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];
        if (!dialog.current?.contains(document.activeElement) || event.shiftKey && document.activeElement === controls[0] || !event.shiftKey && document.activeElement === controls.at(-1)) {
          event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); if (origin?.isConnected) origin.focus({ preventScroll: true }); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={event => { if (!busy && event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className="game-dialog download-cancel-dialog" role="dialog" aria-modal="true" aria-label={ui("ui.cancel_download_de5b23e")} aria-busy={busy}>
      <h2>{ui('common.cancel_game', { game: task.title })}</h2>
      <p>{ui("ui.keep_the_downloaded_files_for_a_later_retry_or_d_d5003b6")}</p>
      <code className="remove-path">{task.destination}</code>
      <p>{loading ? ui("ui.checking_whether_files_can_be_deleted_safely_9e24229") : task.kind !== 'install' || task.gameId
        ? ui("ui.updates_and_dlc_keep_their_files_to_protect_the_22f35d6") : options?.reason ?? ui("ui.only_this_new_installation_folder_will_be_delete_8a2e43b")}</p>
      {canDelete ? <label className="download-delete-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{ui("ui.permanently_delete_this_new_installation_folder_c3adf8e")}</label> : null}
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
