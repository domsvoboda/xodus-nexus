import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSnapshot } from '../shared/demo-data';
import { LibraryPage } from './App';

it('offers Resume update without a new update check while preventing Play for interrupted games', () => {
  const data = demoSnapshot();
  Object.assign(data.games[0], { installState: 'incomplete', updateIncomplete: true,
    installMessage: 'An update was interrupted. Resume the update before playing.' });
  data.gameUpdates = {};
  data.downloads = [];
  const html = renderToStaticMarkup(<LibraryPage data={data} selection={{ id: data.games[0].id }} toast={() => {}} />);
  expect(html).toContain('Resume update');
  expect(html).toContain('Resume the update before playing.');
  expect(html).toMatch(/<button[^>]*data-gamepad-play[^>]*disabled=""/);
  const resume = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*Resume update<\/button>/)?.[0];
  expect(resume).toBeDefined();
  expect(resume).not.toContain('disabled');
});
