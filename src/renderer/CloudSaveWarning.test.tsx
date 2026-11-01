import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GameOperation } from '../shared/types';
import { CloudSaveWarning } from './CloudSaveWarning';

const operation: GameOperation = { id: 'game-fixture', gameId: 'fixture', title: 'Fixture <script>',
  status: 'complete', phase: 'The game has exited.', startedAt: '', log: [],
  cloudSaveWarning: 'Cloud sync is unavailable for this session. Progress may only be saved on this device. Keep your local saves.' };

it.each(['running', 'complete', 'failed'] as const)('keeps the warning outside collapsed logs after %s', status => {
  const html = renderToStaticMarkup(<CloudSaveWarning operation={{ ...operation, status }} openGame={() => {}} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain('Keep your local saves');
  expect(html).toContain('View game');
  expect(html).toContain('Fixture &lt;script&gt;');
  expect(html).not.toContain('<details');
});
it('omits the warning for prerequisites and sessions with no detected cloud failure', () => {
  for (const op of [undefined, { ...operation, cloudSaveWarning: undefined }, { ...operation, kind: 'prerequisite' as const }])
    expect(renderToStaticMarkup(<CloudSaveWarning operation={op} openGame={() => {}} />)).toBe('');
});

it('keeps the save warning visible but blocks background navigation while Social is modal', () => {
  const html = renderToStaticMarkup(<CloudSaveWarning operation={operation} openGame={() => {}} disabled />);
  expect(html).toContain('role="alert"');
  expect(html).toContain('Keep your local saves');
  expect(html).toMatch(/<button[^>]*disabled=""/);
});
