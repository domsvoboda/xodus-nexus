import { ui } from './i18n';
import { Trash2 } from 'lucide-react';
import type { Game } from '../shared/types';

export function GameRemovalContents({ game, busy, close, remove }: {
  game: Game; busy: boolean; close: () => void; remove: (mode: 'library' | 'delete-files') => void;
}) {
  return <><h2>{ui('common.remove_game', { game: game.title })}</h2>
    <p>{ui("ui.keep_the_files_or_permanently_delete_this_instal_7cf3a6a")}</p>
    <code className="remove-path">{game.path}</code>
    <div className="dialog-actions"><button className="secondary" disabled={busy} data-gamepad-cancel onClick={close}>{ui("ui.cancel_19766ed")}</button>
      <button className="secondary" disabled={busy} onClick={() => remove('library')}>{ui("ui.keep_files_fad3259")}</button>
      <button className="secondary danger" disabled={busy} onClick={() => remove('delete-files')}><Trash2 />{ui("ui.delete_files_permanently_aaeaa97")}</button></div>
  </>;
}
