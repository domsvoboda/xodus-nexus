import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentList, LibraryPage } from './App';
import { contentSelection } from './ContentSelection';
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
  const html = renderToStaticMarkup(<ContentList plan={plan} disabled={false} selected={[]} change={() => {}} />);
  expect(html).toContain('Owned campaign content'); expect(html).toContain('Owned'); expect(html).toContain('Game Pass'); expect(html).toContain('10.0 MiB');
  expect(html).toMatch(/aria-label="Unlicensed expansion"[^>]*disabled=""/);
  expect(html).toContain('Select all'); expect(html).toContain('License not verified');
});
it('blocks downloads while busy or after a license expires, even if files remain installed', () => {
  const html = renderToStaticMarkup(<ContentList plan={plan} disabled selected={[]} change={() => {}} />);
  expect(html.match(/disabled=""/g)).toHaveLength(4);
  const stale = { ...plan, items: [{ ...plan.items[1], access: undefined }] };
  expect(contentSelection(stale, ['GP'], 'repair')).toEqual([]);
  expect(contentSelection(stale, ['GP'], 'remove')).toEqual(['GP']);
});

it('shows package-free licenses and bundles without pretending that there are files to install',()=>{
  const html=renderToStaticMarkup(<ContentList plan={{...plan,items:[
    {productId:'ONE',title:'Bonus',access:'owned',status:'license-only',note:'The runtime must verify this license.'},
    {productId:'TWO',title:'Pass',access:'other',status:'bundle',note:'Its add-ons are listed separately.'},
  ]}} disabled={false} selected={[]} change={()=>{throw Error('must not install');}}/>);
  expect(html).toContain('No download required');expect(html).toContain('Content bundle');expect(html).toContain('Other access');
  expect(html).not.toContain('<button');expect(html).not.toContain('Unsupported package');
});

it('keeps verify-only source offers selectable without treating bundles or license-only content as downloads', () => {
  const value: GameContentPlan = { ...plan, items: [
    { productId: 'VERIFY', title: 'Included add-on', status: 'verify', note: 'Must verify at download.' },
    { productId: 'LICENSE', title: 'License-only bonus', status: 'license-only', access: 'owned', note: 'No download.' },
    { productId: 'BUNDLE', title: 'Content bundle', status: 'bundle', access: 'other', note: 'Children listed separately.' },
  ] };
  const html = renderToStaticMarkup(<ContentList plan={value} disabled={false} selected={['VERIFY']} change={() => {}} />);
  expect(html).toContain('License check required'); expect(html).toContain('1 / 1');
  expect(contentSelection(value, ['VERIFY', 'LICENSE', 'BUNDLE'], 'install')).toEqual(['VERIFY']);
  expect(contentSelection(value, ['VERIFY'], 'repair')).toEqual([]);
  expect(contentSelection(value, ['VERIFY'], 'remove')).toEqual([]);
});

it('repairs or removes validated installed files that still require a license check, without offering a second install', () => {
  const value: GameContentPlan = { ...plan, items: [{ productId: 'VERIFY', title: 'Installed add-on', status: 'verify', installedFiles: true, note: 'Verify license on repair.' }] };
  expect(contentSelection(value, ['VERIFY'], 'install')).toEqual([]);
  expect(contentSelection(value, ['VERIFY'], 'repair')).toEqual(['VERIFY']);
  expect(contentSelection(value, ['VERIFY'], 'remove')).toEqual(['VERIFY']);
  expect(renderToStaticMarkup(<ContentList plan={value} disabled={false} selected={['VERIFY']} change={() => {}} />)).toContain('Installed files; license check required');
});
