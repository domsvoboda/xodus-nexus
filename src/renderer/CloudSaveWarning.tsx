import type { GameOperation } from '../shared/types';
import { ui, uiText } from './i18n';

export function CloudSaveWarning({ operation, openGame }: {
  operation?: GameOperation;
  openGame(id: string): void;
}) {
  if (!operation?.cloudSaveWarning || operation.kind === 'prerequisite') return null;
  return <section className="cloud-save-warning" role="alert">
    <div><strong>{ui('cloud.warning_title')}: {operation.title}</strong>
      <p>{uiText(operation.cloudSaveWarning)}</p></div>
    <button className="secondary" onClick={() => openGame(operation.gameId)}>{ui('cloud.view_game')}</button>
  </section>;
}
