import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSnapshot } from '../shared/demo-data';
import { LibraryPage } from './App';

const render = (data = demoSnapshot(), open = false) => renderToStaticMarkup(<LibraryPage data={data} selection={open ? { id: data.games[0]?.id } : undefined} toast={() => {}} />);
const play = (html: string) => html.match(/<button\b[^>]*data-gamepad-play[^>]*>/)?.[0];

it('keeps the full-width library free of any persistent selected-game panel', () => {
  const html = render();
  expect(html.indexOf('class="library-filters"')).toBeLessThan(html.indexOf('class="account-games-results"'));
  expect(html).not.toContain('class="game-detail"');
  expect(html).not.toContain('data-gamepad-play');
  expect(html).toContain('data-gamepad-auto-select="focus"');
});

it('opens an explicitly requested game on its own page while keeping the library mounted and hidden', () => {
  const data = demoSnapshot();
  const html = render(data, true);
  expect(html.indexOf('class="account-games-results"')).toBeLessThan(html.indexOf('class="game-details-page"'));
  expect(html).toContain('<div hidden="">');
  expect(html).toContain('data-gamepad-detail-back="true"');
  expect(html).toContain(`data-gamepad-detail="${data.games[0].id}"`);
  expect(html).toContain('<summary>Installation details</summary>');
  expect(html).toContain('Browse game files');
  expect(html).toContain('Manage content');
  expect(play(html)).not.toContain('disabled');
});

it.each(['no-runtime', 'no-run', 'incomplete', 'running'] as const)('preserves the Play guard for %s', kind => {
  const data = demoSnapshot();
  if (kind === 'no-runtime') { data.settings.winePath = ''; data.runtime.winePath = undefined; }
  if (kind === 'no-run') data.backend.capabilities.run = false;
  if (kind === 'incomplete') data.games[0].installState = 'incomplete';
  if (kind === 'running') data.gameOperation = { id: 'sample-run', gameId: data.games[0].id, title: data.games[0].title, status: 'running', phase: 'Sample phase', log: [], startedAt: new Date().toISOString() };
  const html = render(data, true);
  expect(play(html)).toContain('disabled=""');
  if (kind === 'running') { expect(html).toContain('Stop'); expect(html).toContain('Working…'); }
});

it('keeps installation/update errors and operation phase outside collapsed metadata', () => {
  const data = demoSnapshot();
  data.games[0].installMessage = 'Sample installation warning';
  data.gameUpdates = { [data.games[0].id]: { checking: false, error: 'Sample update error' } };
  data.gameOperation = { id: 'sample-run', gameId: data.games[0].id, title: data.games[0].title, status: 'failed', phase: 'Sample failure phase', log: ['Sample log'], logPath: '/example/sample.log', startedAt: new Date().toISOString() };
  const html = render(data, true);
  expect(html.indexOf('Sample installation warning')).toBeLessThan(html.indexOf('class="gd-facts"'));
  expect(html.indexOf('Sample update error')).toBeLessThan(html.indexOf('class="gd-facts"'));
  expect(html).toMatch(/<details[^>]*class="game-operation failed"><summary><strong>Launch failed<\/strong><span>Sample failure phase<\/span><\/summary>/);
  expect(html).toContain('Open diagnostic log');
});

it('omits the selected-game panel for an empty library', () => {
  const data = demoSnapshot(); data.games = [];
  const html = render(data);
  expect(html).not.toContain('class="game-detail"');
  expect(html).not.toContain('data-gamepad-play');
  expect(html).toContain('class="library-filters"');
  expect(html).toContain('class="account-games-results"');
});

it('keeps incomplete imports identifiable even while their drawer is closed', () => {
  const data = demoSnapshot();
  data.games[0].installState = 'incomplete';
  data.games[0].installMessage = 'Sample incomplete installation';
  const html = render(data);
  expect(html).not.toContain('class="game-detail"');
  expect(html).toContain('title="Sample incomplete installation"');
  expect(html).toContain('Incomplete</span>');
});

it('keeps Play available during a background update check and offers a way to stop the check (#480)', () => {
  const data = demoSnapshot();
  data.gameUpdates = { [data.games[0].id]: { checking: true } };
  expect(render(data)).toContain('Stop checking updates');
  expect(play(render(data, true))).not.toContain('disabled');
});

it('allows an available game update to queue behind a different game download (#480)', () => {
  const data = demoSnapshot();
  data.gameUpdates = { [data.games[0].id]: { checking: false, available: true, latestVersion: '2.0.0.0' } };
  data.downloads = [{id:'other-download',gameId:'different-game',productId:'9AAAAAAAAAAA',title:'Other game',destination:'/other-game',status:'running',progress:0,phase:'',log:[],startedAt:''}];
  const button = render(data, true).match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?Update game<\/button>/)?.[0];
  expect(button).toBeDefined(); expect(button).not.toContain('disabled');
  data.downloads[0].gameId = data.games[0].id;
  const locked = render(data, true).match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?Update game<\/button>/)?.[0];
  expect(locked).toContain('disabled');
});
