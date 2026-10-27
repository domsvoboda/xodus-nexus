import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InstallPlan } from '../shared/types';
import { catalogInstallRequest, confirmedPackageInstall, PackageDialog } from './PackageInstall';

it('preserves the requested edition rather than silently replacing it with the base-package offer',()=>{
  expect(catalogInstallRequest({productId:'9AAAAAAAAAAA',installProductId:'9BBBBBBBBBBB',title:'Deluxe edition'},'/synthetic/deluxe'))
    .toEqual({productId:'9AAAAAAAAAAA',title:'Deluxe edition',destination:'/synthetic/deluxe'});
});

const sizedPlan = (): InstallPlan => ({schema:1,rootProductId:'9AAAAAAAAAAA',market:'US',status:'ready',availableBytes:1024**3,choices:[{
  productId:'9AAAAAAAAAAA',contentId:'11111111-1111-4111-8111-111111111111',title:'Synthetic game',platform:'Windows.Desktop',
  packageFormat:'MSIXVC',kind:'Game',supported:true,downloadBytes:2*1024**3,installBytes:4*1024**3,
}]});

it('shows known download and target-drive storage before a single ready package is confirmed', () => {
  const html=renderToStaticMarkup(<PackageDialog plan={sizedPlan()} destination={'/synthetic/<drive>/game'} choose={()=>{}} />);
  expect(html).toContain('>Install game</h2>');expect(html).toContain('checked=""');
  expect(html).toContain('Estimated download: 2.0 GiB');expect(html).toContain('4.0 GiB');expect(html).toContain('1.0 GiB');
  expect(html).toContain('estimate exceeds available space');expect(html).toContain('downloader checks the actual space required');
  expect(html).toContain('/synthetic/&lt;drive&gt;/game');expect(html).not.toContain('disabled=""');
});
it('does not invent sizes or an insufficient-space error when metadata or filesystem capacity is unknown', () => {
  const plan=sizedPlan();delete plan.availableBytes;delete plan.choices[0].downloadBytes;delete plan.choices[0].installBytes;
  const html=renderToStaticMarkup(<PackageDialog plan={plan} choose={()=>{}} />);
  expect(html.match(/Unavailable/g)).toHaveLength(3);expect(html).not.toContain('estimate exceeds');
  plan.availableBytes=0;
  expect(renderToStaticMarkup(<PackageDialog plan={plan} choose={()=>{}} />)).toContain('0 B');
});
it('never queues even a ready game until explicit confirmation and keeps the edition, destination and market binding', async () => {
  const plan=sizedPlan(),request={productId:plan.rootProductId,title:'Premium edition',destination:'/synthetic/game'};
  const api={getInstallPlan:vi.fn(async()=>plan),startInstall:vi.fn(async()=> 'queued')};
  let choose!:(id?:string)=>void;
  const confirm=vi.fn(()=>new Promise<string|undefined>(resolve=>{choose=resolve;}));
  const result=confirmedPackageInstall(request,api,confirm,()=>true);
  await vi.waitFor(()=>expect(confirm).toHaveBeenCalledOnce());expect(api.startInstall).not.toHaveBeenCalled();
  expect(api.getInstallPlan).toHaveBeenCalledWith(request.productId,request.destination);
  choose(plan.choices[0].contentId);expect(await result).toBe('queued');
  expect(api.startInstall).toHaveBeenCalledOnce();
  expect(api.startInstall).toHaveBeenCalledWith({...request,selectedContentId:plan.choices[0].contentId,selectionMarket:'US'});
});
it('does not queue a cancelled, unmounted or unavailable package and does not bypass the choice dialog', async () => {
  const plan=sizedPlan(),request={productId:plan.rootProductId,title:'Synthetic',destination:'/synthetic/game'};
  const api={getInstallPlan:vi.fn(async()=>plan),startInstall:vi.fn(async()=> 'queued')};
  const confirm=vi.fn(async()=>undefined);
  expect(await confirmedPackageInstall(request,api,confirm,()=>true)).toBeUndefined();expect(api.startInstall).not.toHaveBeenCalled();
  confirm.mockClear();await confirmedPackageInstall(request,api,confirm,()=>false);expect(confirm).not.toHaveBeenCalled();
  let mounted=true;
  await confirmedPackageInstall(request,api,async()=>{mounted=false;return plan.choices[0].contentId;},()=>mounted);
  expect(api.startInstall).not.toHaveBeenCalled();
  plan.status='unavailable';await expect(confirmedPackageInstall(request,api,confirm,()=>true)).rejects.toThrow('No supported');
  expect(api.startInstall).not.toHaveBeenCalled();
  plan.status='choice';await confirmedPackageInstall(request,api,confirm,()=>true);expect(confirm).toHaveBeenCalledOnce();
});

it('shows verified package names, IDs, platform and disabled unsupported choices without auto-selection', () => {
  const plan: InstallPlan = { schema: 1, rootProductId: '9AAAAAAAAAAA', market: 'US', status: 'choice', choices: [
    { productId: '9BBBBBBBBBBB', contentId: '11111111-1111-4111-8111-111111111111', title: 'PC base game', platform: 'Windows.Desktop', packageFormat: 'MSIXVC', kind: 'Game', supported: true },
    { productId: '9CCCCCCCCCCC', contentId: '22222222-2222-4222-8222-222222222222', title: '<Console game>', platform: 'Xbox.One', packageFormat: 'XVC', kind: 'Game', supported: false },
  ] };
  const html = renderToStaticMarkup(<PackageDialog plan={plan} choose={() => {}} />);
  expect(html).toContain('PC base game'); expect(html).toContain('Windows.Desktop'); expect(html).toContain('9BBBBBBBBBBB');
  expect(html).toContain('&lt;Console game&gt;'); expect(html).toContain('Unsupported');
  expect(html.match(/disabled=""/g)).toHaveLength(2); expect(html).not.toContain('checked=""');
  expect(html).toContain('Cancel'); expect(html).toContain('checks your license');
});

it('keeps the requested edition and target-storage confirmation before collecting DLC selections', async () => {
  const plan = sizedPlan(), request = { productId: plan.rootProductId, title: 'Premium edition', destination: '/synthetic/game' };
  const api = { getInstallPlan: vi.fn(async () => plan), startInstall: vi.fn(async () => 'queued') };
  const events: string[] = [];
  const select = vi.fn(async () => { events.push('dlc'); expect(api.startInstall).not.toHaveBeenCalled(); return ['9BBBBBBBBBBB']; });
  expect(await confirmedPackageInstall(request, api, async () => { events.push('storage'); return plan.choices[0].contentId; }, () => true, select)).toBe('queued');
  expect(events).toEqual(['storage', 'dlc']);
  expect(api.startInstall).toHaveBeenCalledWith({ ...request, selectedContentId: plan.choices[0].contentId, selectionMarket: plan.market, contentProductIds: ['9BBBBBBBBBBB'] });
});
it('does not start a game after the DLC dialog is cancelled or an invalid package is supplied', async () => {
  const plan = sizedPlan(), request = { productId: plan.rootProductId, title: 'Game', destination: '/synthetic/game' };
  const api = { getInstallPlan: vi.fn(async () => plan), startInstall: vi.fn(async () => 'queued') };
  expect(await confirmedPackageInstall(request, api, async () => plan.choices[0].contentId, () => true, async () => undefined)).toBeUndefined();
  expect(api.startInstall).not.toHaveBeenCalled();
  const select = vi.fn(async () => []);
  await expect(confirmedPackageInstall(request, api, async () => 'invalid-content', () => true, select)).rejects.toThrow('Invalid installation package');
  expect(select).not.toHaveBeenCalled(); expect(api.startInstall).not.toHaveBeenCalled();
});
