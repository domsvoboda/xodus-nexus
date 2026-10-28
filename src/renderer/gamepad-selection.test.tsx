import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoAccountLibrary, demoSnapshot } from '../shared/demo-data';
import { LibraryPage, Sidebar, LibraryProductCard, StoreProductCard } from './App';
const queuedProduct = demoAccountLibrary('all', new Map()).products.find(p => p.productId === '9NPKGVXPFRSX')!;

it('only the three main sidebar pages select automatically, not recents/settings/queue/account', () => {
  const html = renderToStaticMarkup(<Sidebar data={demoSnapshot()} page="home" go={() => {}} />);
  const auto = [...html.matchAll(/<button\b[^>]*data-gamepad-auto-select=""[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  expect(auto).toHaveLength(3);
  for (const name of ['Home', 'My Library', 'Store']) expect(auto.some(button => button.includes(`<span>${name}</span>`))).toBe(true);
  for (const name of ['Settings', 'Most recent', 'queue-summary', 'account-summary']) expect(auto.some(button => button.includes(name))).toBe(false);
});

it.each(['queued','preparing','unsupported'] as const)('keeps the %s product details navigable without enabling installation', kind => {
  const html=renderToStaticMarkup(<LibraryProductCard product={queuedProduct} present={false} downloading={kind==='queued'} installing={kind==='preparing'?'another-title':undefined} canInstall={kind!=='unsupported'} install={()=>{}} />);
  const details=html.match(/<button[^>]*class="catalog-card-main"[^>]*>/)?.[0];
  expect(details).toContain('data-gamepad-detail-target=');expect(details).not.toContain('disabled=');
  expect(html).toMatch(/<button[^>]*disabled=""/); expect(html).not.toContain('data-gamepad-auto-select');
});
it('keeps an available product action explicitly selectable, without an extra card tab stop', () => {
  const html=renderToStaticMarkup(<LibraryProductCard product={queuedProduct} present={false} downloading={false} canInstall={true} install={()=>{}} />);
  expect(html).not.toMatch(/<article[^>]*tabindex/); expect(html).not.toContain('disabled=');expect(html).toContain('data-gamepad-detail-target=');
});

it('only installed card selectors auto-select in the library, never Play/update/content/folder/menu actions', () => {
  const data = demoSnapshot();
  const html = renderToStaticMarkup(<LibraryPage data={data} toast={() => {}} />);
  const auto = [...html.matchAll(/<button\b[^>]*data-gamepad-auto-select="[^"]*"[^>]*>/g)].map(match => match[0]);
  expect(auto).toHaveLength(data.games.length);
  for (const button of auto) {
    expect(button).toContain('data-gamepad-detail-target=');
    expect(button).toContain('data-gamepad-auto-select="focus"');
  }
  expect(html).not.toMatch(/<button\b[^>]*data-gamepad-auto-select[^>]*data-gamepad-play/);
});

it('includes explicit library header actions without automatic activation', () => {
  const html = renderToStaticMarkup(<LibraryPage data={demoSnapshot()} toast={() => {}} />);
  const header = html.match(/<header[^>]*data-gamepad-library-header[^>]*>[\s\S]*?<\/header>/)?.[0];
  expect(header).toContain('Check game updates');
  expect(header).toContain('Import game');
  expect(header).not.toContain('data-gamepad-auto-select');
});

it.each([false, true])('Store card focus only selects, activation opens details and installation stays guarded (disabled=%s)', disabled => {
  const html = renderToStaticMarkup(<StoreProductCard product={queuedProduct} selected disabled={disabled} label={disabled ? 'In Install Queue' : 'Install'} select={() => {}} install={() => {}} />);
  expect(html).toContain('class="catalog-card selected" data-gamepad-card');
  expect(html).toMatch(/<button[^>]*data-gamepad-auto-select="focus"[^>]*data-gamepad-detail-target/);
  expect(html).not.toContain('data-gamepad-card-activate');
  const action = html.match(/<button[^>]*data-gamepad-card-action[^>]*>/)?.[0];
  expect(action).toContain('data-gamepad-skip');
  expect(action?.includes('disabled=""')).toBe(disabled);
});
