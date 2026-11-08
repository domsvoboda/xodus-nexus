import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentList, LibraryPage } from './App';
import { demoSnapshot } from '../shared/demo-data';
import type { GameContentPlan } from '../shared/types';
const plan: GameContentPlan = { gameId: 'sample', checkedAt: '', items: [
  { productId: 'OWN', title: 'Owned campaign content', access: 'owned', status: 'available', note: 'Checked again at install.', downloadBytes: 10 * 1024 ** 2 },
  { productId: 'GP', title: 'Subscription content', access: 'gamepass', status: 'installed', note: 'Runtime checks the license.' },
  { productId: 'PAID', title: 'Unlicensed expansion', status: 'unlicensed', note: 'No active license.' },
] };
it('offers generic content management on installed game details', () => {
  const data = demoSnapshot();
  expect(renderToStaticMarkup(<LibraryPage data={data} selection={{ id: data.games[0].id }} toast={() => {}} />)).toContain('Manage content');
});
it('distinguishes subscription, ownership, installation and missing licenses without hiding full titles', () => {
  const html = renderToStaticMarkup(<ContentList plan={plan} disabled={false} install={() => {}} />);
  expect(html).toContain('Owned campaign content'); expect(html).toContain('Owned'); expect(html).toContain('Game Pass'); expect(html).toContain('10.0 MiB');
  expect(html).toMatch(/Unlicensed expansion[\s\S]*?<button[^>]*disabled=""/);
  expect(html).toContain('Repair'); expect(html).toContain('License not verified');
});
it('blocks downloads while busy or after a license expires, even if files remain installed', () => {
  const html = renderToStaticMarkup(<ContentList plan={plan} disabled install={() => {}} />);
  expect(html.match(/disabled=""/g)).toHaveLength(3);
  const stale = { ...plan, items: [{ ...plan.items[1], access: undefined }] };
  expect(renderToStaticMarkup(<ContentList plan={stale} disabled={false} install={() => {}} />)).toContain('disabled=""');
});

it('shows package-free licenses and bundles without pretending that there are files to install',()=>{
  const html=renderToStaticMarkup(<ContentList plan={{...plan,items:[
    {productId:'ONE',title:'Bonus',access:'owned',status:'license-only',note:'The runtime must verify this license.'},
    {productId:'TWO',title:'Pass',access:'other',status:'bundle',note:'Its add-ons are listed separately.'},
  ]}} disabled={false} install={()=>{throw Error('must not install');}}/>);
  expect(html).toContain('No download required');expect(html).toContain('Content bundle');expect(html).toContain('Other access');
  expect(html).not.toContain('<button');expect(html).not.toContain('Unsupported package');
});

it('renders bundle-included license-only rows as unverified with no download, not owned or unavailable', () => {
  const html = renderToStaticMarkup(<ContentList plan={{ ...plan, items: [
    { productId: 'BUNDLE', title: 'Digital Deluxe add-on', status: 'bundle', note: 'Included in an active offer. Its related add-ons are listed separately.' },
    { productId: 'PASS', title: 'Season Pass', status: 'license-only', note: 'Included in an active offer. No download is required; the game must verify this license through the runtime.' },
  ] }} disabled={false} install={() => { throw Error('must not install'); }} />);
  expect(html.match(/License not verified/g)).toHaveLength(2);
  expect(html).toContain('Content bundle'); expect(html).toContain('No download required');
  expect(html).not.toContain('Owned'); expect(html).not.toContain('Unavailable'); expect(html).not.toContain('<button');
});
