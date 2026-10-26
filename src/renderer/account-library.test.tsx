import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { AccountGames, Cover, GameLaunchToolFields, GameTitle, HomePage, LibraryPagination, LibraryProductCard, StoreProductCard, Sidebar, SettingsPage, type LibraryFilters } from './App';
import { defaultLaunchTools } from '../shared/launch-tools';
import { demoSnapshot } from '../shared/demo-data';
import type { AccountLibraryPage } from '../shared/types';

it('offers the explicit recent PC Game Pass order only within the Game Pass access filter',()=>{
 const data=demoSnapshot();
 const filters:LibraryFilters={kind:'gamepass',playState:'all',query:'',sort:'recent-gamepass'};
 const html=renderToStaticMarkup(<AccountGames data={data} toast={()=>{}} filters={filters} />);
 expect(html).toContain('aria-label="Library order"');expect(html).toContain('Recently added to Game Pass');
 expect(html).toContain('PC Game Pass recently added collection');
 for(const kind of ['all','owned','other'] as const)
  expect(renderToStaticMarkup(<AccountGames data={data} toast={()=>{}} filters={{...filters,kind}} />)).not.toContain('aria-label="Library order"');
});

it('offers a configurable four-GiB driver shader cache limit with a separate save action',()=>{
  const data=demoSnapshot();let html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}} />);
  expect(html).toContain('Driver cache limit (GiB)');expect(html).toContain('Default: 4 GiB');expect(html).toContain('Save cache limit');expect(html).toContain('next game launch');
  data.settings.shaderCacheLimitGiB=8.5;html=renderToStaticMarkup(<SettingsPage data={data} toast={()=>{}} />);expect(html).toContain('value="8.5"');
});

it('keeps unknown-source counts in diagnostics instead of rendering a technical library banner', () => {
  const source = readFileSync('src/renderer/App.tsx', 'utf8');
  const library = source.slice(source.indexOf('export function AccountGames('), source.indexOf('function AccountGamesForUser('));
  expect(library).not.toContain('unclassifiedEntitlements');
  expect(library).not.toContain('Some active licenses have an unrecognized source');
  // Actual failures and incomplete results still need a visible way to debug.
  expect(library).toContain('visible?.skippedEntitlements || visible?.excludedEntitlements');
  expect(library).toContain('ui.some_license_records_could_not_be_verified_and_w_8d3b7e0');
  expect(library).toContain('{error ?');
  expect(library).toContain('<BackendLogButton toast={toast} />');
  const settings = renderToStaticMarkup(<SettingsPage data={demoSnapshot()} toast={() => {}} />);
  expect(settings).toContain('Open backend diagnostic log');
});

it.each(['supported', 'unsupported', 'unknown'] as const)('uses the Store %s badge in Owned without enabling unsupported installs', installability => {
  const product: AccountLibraryPage['products'][number] = { productId: '9AAAAAAAAAAA', title: 'Owned & game', access: 'owned',
    description: '', categories: [], installability, supportNote: 'Package <reason>' };
  const html = renderToStaticMarkup(<LibraryProductCard product={product} present={false} downloading={false} canInstall install={() => {}} />);
  const store = renderToStaticMarkup(<StoreProductCard product={product} selected={false} disabled={installability !== 'supported'} label="Install" select={() => {}} install={() => {}} />);
  const badge = (text: string) => text.match(/<span class="catalog-support[^>]*>[\s\S]*?<\/span>/)?.[0];
  expect(badge(html)).toBe(badge(store));
  expect(html).toContain('<span>Owned</span>');
  expect(html.includes('disabled=""')).toBe(installability !== 'supported');
  expect(html).toContain('title="Package &lt;reason&gt;"');
  if (installability === 'unsupported') expect(html).toContain('>Unsupported</span>');
  if (installability !== 'supported') { expect(html).toContain('tabindex="0"'); expect(html).toContain('Action unavailable'); }
});

it('keeps one My Library and Store navigation, no separate Game Pass page',()=>{
  const html=renderToStaticMarkup(<Sidebar data={demoSnapshot()} page="library" go={()=>{}} />);
  expect(html).toContain('My Library'); expect(html).toContain('Store');
  expect(html).not.toContain('<span>Game Pass</span>');
});

it('labels other active access honestly and offers it alongside All games', () => {
  const product: AccountLibraryPage['products'][number] = { productId: '9AAAAAAAAAAA', title: 'Other game', access: 'other', description: '', categories: [], installability: 'supported', supportNote: '' };
  const card = renderToStaticMarkup(<LibraryProductCard product={product} present={false} downloading={false} canInstall install={() => {}} />);
  expect(card).toContain('<span>Other access</span>');
  expect(card).not.toContain('<span>Owned</span>'); expect(card).not.toContain('<span>Game Pass</span>');
  expect(card).not.toContain('disabled=""');
  const all = renderToStaticMarkup(<AccountGames data={demoSnapshot()} toast={() => {}} />);
  expect(all).toContain('<option value="all" selected="">All games</option>');
  expect(all).toContain('<option value="other">Other access</option>');
});

it('counts waiting installations in the queue shortcut while a game is running', () => {
  const data = demoSnapshot();
  data.downloads = [{ ...data.downloads[0], status: 'running' }, { ...data.downloads[0], id: 'waiting', status: 'queued' }];
  const html = renderToStaticMarkup(<Sidebar data={data} page="library" go={() => {}} />);
  expect(html).toContain('Downloading (1/2)');
  expect(html).toContain('2 active installations');
});
it('restores the parent-owned filters after the library is recreated',()=>{
  const filters: LibraryFilters = { kind: 'owned', playState: 'installed', query: 'Edition' };
  const data=demoSnapshot(); data.auth={running:false,stored:false,note:''};
  const library=()=>renderToStaticMarkup(<AccountGames data={data} toast={()=>{}} filters={filters} onFiltersChange={()=>{}} />);
  for(const html of [library(),library()]) {
    expect(html).toContain('<option value="owned" selected="">');
    expect(html).toContain('<option value="installed" selected="">');
    expect(html).toContain('value="Edition"');
    expect(html).not.toContain('<option value="all" selected="">');
  }
});
it('offers Access and Play state filters without cloud streaming, preserving installed games offline',()=>{
  const data=demoSnapshot(); data.auth={running:false,stored:false,note:''};
  const html=renderToStaticMarkup(<AccountGames data={data} toast={()=>{}} />);
  expect(html).toContain('aria-label="Access"'); expect(html).toContain('In Game Pass'); expect(html).toContain('Owned');
  expect(html).toContain('aria-label="Play state"'); expect(html).toContain('Ready to install');
  expect(html).not.toContain('Cloud playable'); expect(html).toContain('Installed games remain available');
  expect(html).toContain(data.games[0].title);
  expect(html).not.toContain('Owned · Installed');
  expect(html).toContain(`title="${data.games[0].title}"`);
});

it('preserves full edition names in native hover tooltips and escapes special characters',()=>{
  const html=renderToStaticMarkup(<GameTitle title={'A Long Game Name: "Complete" & Deluxe Edition (PC)'} />);
  expect(html).toContain('title="A Long Game Name: &quot;Complete&quot; &amp; Deluxe Edition (PC)"');
});

it('uses Store box art instead of a package logo and wide artwork for details',()=>{
  const game={ ...demoSnapshot().games[0], coverDataUrl:'data:image/png;base64,AAAA', coverUrl:'https://store-images.s-microsoft.com/box', heroUrl:'https://store-images.s-microsoft.com/hero' };
  expect(renderToStaticMarkup(<Cover game={game} />)).toContain('src="https://store-images.s-microsoft.com/box"');
  expect(renderToStaticMarkup(<Cover game={game} variant="hero" />)).toContain('src="https://store-images.s-microsoft.com/hero"');
  expect(renderToStaticMarkup(<Cover game={{...game, coverUrl:undefined, heroUrl:undefined}} />)).toContain('cover-local');
});

it('uses wide Store art for the Home banner and never stretches a small package logo',()=>{
  const data=demoSnapshot();
  data.games=[{...data.games[0],coverDataUrl:'data:image/png;base64,SMALLLOGO',coverUrl:'https://store-images.s-microsoft.com/box',heroUrl:'https://store-images.s-microsoft.com/hero'}];
  const banner=()=>{const html=renderToStaticMarkup(<HomePage data={data} go={()=>{}} action={()=>{}} />);return html.slice(html.indexOf('<section class="spotlight'),html.indexOf('<div class="spotlight-copy"'));};
  expect(banner()).toContain('url(https://store-images.s-microsoft.com/hero)');
  expect(banner()).not.toContain('SMALLLOGO');
  data.games[0].heroUrl=undefined;
  expect(banner()).toContain('url(https://store-images.s-microsoft.com/box)');
  data.games[0].coverUrl=undefined;
  expect(banner()).not.toContain('--spotlight-art');
});

it('gives installed cards a separate status footer and an accessible compact refresh control',()=>{
  const html=renderToStaticMarkup(<AccountGames data={demoSnapshot()} toast={()=>{}} />);
  expect(html).toContain('class="catalog-card-status"');
  expect(html).toContain('aria-label="Refresh library"');
  expect(html).toContain('class="account-games-results"');
  expect(html).not.toContain('class="library-license"');
});

it('keeps pagination loading inside the button, without the oversized Store loading panel',()=>{
  const more=renderToStaticMarkup(<LibraryPagination loading={true} hasMore={true} load={()=>{}} />);
  expect(more).toContain('disabled'); expect(more).toContain('Loading games');
  expect(more).not.toContain('catalog-loading'); expect(more).not.toContain('library-loading');
  const initial=renderToStaticMarkup(<LibraryPagination loading={true} hasMore={false} load={()=>{}} />);
  expect(initial).toContain('role="status"'); expect(initial).not.toContain('catalog-loading');
  expect(renderToStaticMarkup(<LibraryPagination loading={false} hasMore={false} load={()=>{}} />)).toBe('');
});

it('shows account-wide search progress instead of asking to load more pages', () => {
  for (const loading of [false, true]) {
    const html = renderToStaticMarkup(<LibraryPagination loading={loading} hasMore searching load={() => {}} />);
    expect(html).toContain('Searching all library games');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Load more games');
  }
});

it('keeps installed-only and offline searches local and immediately available', () => {
  const data = demoSnapshot(); data.auth = { running: false, stored: false, note: '' };
  const html = renderToStaticMarkup(<AccountGames data={data} toast={() => {}}
    filters={{ kind: 'all', playState: 'installed', query: data.games[0].title }} />);
  expect(html).toContain(data.games[0].title);
  expect(html).not.toContain('Searching all library games');
  expect(html).not.toContain('No games match');
});

it('offers saved per-game overlay options and Steam-style environment and arguments',()=>{
  const html=renderToStaticMarkup(<GameLaunchToolFields value={{...defaultLaunchTools,mangoHud:true,gamescope:true,launchOptions:'PROTON_ENABLE_WAYLAND=1 %command% --launcher-skip'}} change={()=>{}} />);
  expect(html).toContain('Enable MangoHud'); expect(html).toContain('Run in gamescope');
  expect(html).toContain('Gamescope options'); expect(html).toContain('requires mangoapp');
  expect(html).toContain('Launch options'); expect(html).toContain('PROTON_ENABLE_WAYLAND=1 %command% --launcher-skip');
  expect(html).toContain('checked');
});

it('offers DualSense compatibility per game, off by default and with feature limitations', () => {
  const render = (enabled: boolean) => renderToStaticMarkup(<GameLaunchToolFields value={{ ...defaultLaunchTools, dualSenseCompatibility:enabled }} change={() => {}} />);
  const off = render(false), on = render(true);
  expect(off).toContain('DualSense compatibility mode');
  expect(off).not.toContain('checked');
  expect(on).toContain('checked');
  expect(on).toContain('for this game only');
  expect(on).toContain('Does not change Xbox controller settings');
  expect(on).toContain('adaptive triggers may be unavailable');
});
