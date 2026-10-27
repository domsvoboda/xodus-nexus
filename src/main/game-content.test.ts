import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccountLibrary } from './account-library.js';
import { GameContent, contentManifest, contentOffers } from './game-content.js';
import { parsePackageXml } from './package-xml.js';
import type { Game } from '../shared/types.js';

const BASE = '9AAAAAAAAAAA', OWN = '9BBBBBBBBBBB', GP = '9CCCCCCCCCCC', PAID = '9DDDDDDDDDDD';
const GUID = '01234567-89ab-cdef-0123-456789abcdef';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const identity = (name = 'Example.Base', version = '1.0.0.0', publisher = 'CN=Example') => `<Identity Name="${name}" Version="${version}" Publisher="${publisher}"/>`;
const config = (id = BASE, extra = '') => `<Game>${identity()}<StoreId>${id}</StoreId>${extra}</Game>`;
const baseXml = config(BASE, `<RelatedProducts>${[OWN, GP, PAID].map(id => `<RelatedProduct>${id}</RelatedProduct>`).join('')}</RelatedProducts>`);
const childXml = (id = OWN) => `<Game>${identity('Example.Content')}<StoreId>${id}</StoreId><AllowedProducts><AllowedProduct>${BASE}</AllowedProduct></AllowedProducts><DesktopRegistration><MainPackageDependency Name="Example.Base"/></DesktopRegistration></Game>`;
const appxXml = `<Package xmlns:uap4="example">${identity('Example.Content')}<Dependencies><uap4:MainPackageDependency Name="Example.Base"/></Dependencies></Package>`;
const layoutXml = '<Package><Chunk><FileGroup SourcePath="." Include="MicrosoftGame.config"/><FileGroup SourcePath="." Include="*.png"/></Chunk></Package>';
const pkg = (family = 'Example.Content_hash') => ({ ContentId: GUID, PackageFamilyName: family, MainPackageFamilyNameForDlc: 'Example.Base_hash', PackageFormat: 'MSIXVC', Architectures: ['x64'], PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }], MaxDownloadSizeInBytes: 1024 });
const sku = (packages: unknown[]) => ({ Sku: { Properties: { IsTrial: false, Packages: packages } } });
const product = (id: string, type = 'Durable') => ({ ProductId: id, ProductType: type, LocalizedProperties: [{ ProductTitle: 'Sample ' + id }], DisplaySkuAvailabilities: [sku([pkg()])] });
const catalog = () => ({ Products: [
  { ...product(BASE, 'Game'), DisplaySkuAvailabilities: [sku([{ ...pkg('Example.Base_hash'), MainPackageFamilyNameForDlc: '' }])] },
  product(OWN), product(GP), product(PAID),
] });
const access = async () => ({ checkedAt: new Date().toISOString(), accessByProductId: { [OWN]: 'owned' as const, [GP]: 'gamepass' as const } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-content-test-')); roots.push(root);
  const base = path.join(root, 'base'), data = path.join(root, 'data');
  await fs.mkdir(base); await fs.mkdir(data);
  await fs.writeFile(path.join(base, 'MicrosoftGame.Config'), baseXml);
  const game: Game = { id: 'arbitrary-game', title: 'Sample', path: base, storeId: BASE, installState: 'ready', addedAt: '' };
  const fetcher = vi.fn(async (url: URL | RequestInfo) => {
    const ids = new URL(String(url)).searchParams.get('bigIds')!.split(',');
    return new Response(JSON.stringify({ Products: catalog().Products.filter(p => ids.includes(p.ProductId)) }));
  }) as unknown as typeof fetch;
  return { root, base, data, game, fetcher, manager: new GameContent(data, fetcher) };
}
async function installFixture() {
  const f = await fixture();
  const result = await f.manager.plan(f.game, access, 'CZ');
  const selected = result.packages.find(p => p.productId === OWN)!;
  const directory = await f.manager.prepare(f.game, selected);
  await fs.writeFile(path.join(directory, 'MicrosoftGame.Config'), childXml());
  await fs.writeFile(path.join(directory, 'appxmanifest.xml'), appxXml);
  await fs.writeFile(path.join(directory, `layout_${GUID}.xml`), layoutXml);
  await fs.writeFile(path.join(directory, 'logo.PNG'), 'synthetic payload');
  return { ...f, selected, directory };
}

it('parses bounded XML with namespaces and encoded identity values, rejects malformed or external entities', () => {
  expect(parsePackageXml('<Root><!-- comment --><ns:Child A="a &amp; b">&#x41;</ns:Child></Root>').children[0]).toMatchObject({ name: 'ns:Child', attributes: { A: 'a & b' }, text: 'A' });
  for (const xml of ['<!DOCTYPE Game [<!ENTITY x SYSTEM "file:///secret">]><Game/>', '<A><B></A>', '<A/><B/>', '<A X="1" X="2"/>', '<A>&unknown;</A>', '<A X="bad&"/>', '<A>' + '<B>'.repeat(40), '<A>\0</A>', '<A/>garbage']) expect(() => parsePackageXml(xml)).toThrow();
});

it('passes scoped public related IDs to the runtime without inventing account access',async()=>{
  const f=await fixture();const before=await fs.readFile(path.join(f.base,'MicrosoftGame.Config'),'utf8');
  const ids=await f.manager.relatedProducts(f.game,{},'CZ');
  expect(ids.sort()).toEqual([OWN,GP,PAID].sort());
  expect(await fs.readFile(path.join(f.base,'MicrosoftGame.Config'),'utf8')).toBe(before);
  for(const [,options] of vi.mocked(f.fetcher).mock.calls)expect(options?.headers).toBeUndefined();
  const controller=new AbortController();controller.abort();
  await expect(f.manager.relatedProducts(f.game,{},'CZ',controller.signal)).rejects.toThrow();
});
it('does not infer licenses from catalog membership, a bundle title or disk', () => {
  const result = contentOffers(contentManifest(baseXml), catalog(), { [OWN]: 'owned', [GP]: 'gamepass' });
  expect(result.items.map(item => [item.productId, item.access, item.status])).toEqual([[OWN, 'owned', 'available'], [GP, 'gamepass', 'available'], [PAID, undefined, 'unlicensed']]);
  expect(result.packages.map(p => p.productId)).toEqual([OWN, GP]);
  expect(contentOffers(contentManifest(baseXml), catalog(), {}).packages).toHaveLength(0);
});
it('offers a real backend license check for a bundle child without manufacturing child ownership',()=>{
  const result=contentOffers(contentManifest(baseXml),catalog(),{},[OWN]);
  expect(result.items[0]).toMatchObject({productId:OWN,status:'verify'});expect(result.items[0].access).toBeUndefined();
  expect(result.packages.map(pkg=>pkg.productId)).toEqual([OWN]);
  expect(result.items[1].status).toBe('unlicensed');
});
it('rejects unsupported architectures, formats, trial SKUs, ambiguous packages and foreign base families', () => {
  for (const change of [{ PackageFormat: 'APPX' }, { Architectures: ['arm64'] }, { PlatformDependencies: [] }, { MainPackageFamilyNameForDlc: 'Other.Base_hash' }, { ContentId: 'https://evil.invalid/download' }]) {
    const data = catalog(); Object.assign(data.Products[1].DisplaySkuAvailabilities[0].Sku.Properties.Packages[0], change);
    expect(contentOffers(contentManifest(baseXml), data, { [OWN]: 'owned' }).items[0].status).toBe('unsupported');
  }
  const data = catalog(); data.Products[1].DisplaySkuAvailabilities[0].Sku.Properties.IsTrial = true;
  expect(contentOffers(contentManifest(baseXml), data, { [OWN]: 'owned' }).packages).toHaveLength(0);
  data.Products[1].DisplaySkuAvailabilities[0].Sku.Properties.IsTrial = false;
  data.Products[1].DisplaySkuAvailabilities[0].Sku.Properties.Packages.push({ ...pkg(), ContentId: 'aaaaaaaa-89ab-cdef-0123-456789abcdef' });
  expect(contentOffers(contentManifest(baseXml), data, { [OWN]: 'owned' }).packages).toHaveLength(0);
});
it('rejects malformed/duplicate product relationships and foreign base identity', async () => {
  for (const xml of [config(BASE, '<RelatedProducts><RelatedProduct>../../escape</RelatedProduct></RelatedProducts>'), baseXml.replace('</Game>', '<StoreId>' + GP + '</StoreId></Game>'), baseXml.replace('1.0.0.0', '70000.0.0.0')]) expect(() => contentManifest(xml)).toThrow();
  const f = await fixture();
  await expect(f.manager.plan({ ...f.game, storeId: PAID }, access)).rejects.toThrow('Store ID changed');
});
it('queries only declared products in the requested market, without any credential headers', async () => {
  const f = await fixture(); const result = await f.manager.plan(f.game, access, 'CZ');
  expect(result.plan.items).toHaveLength(3);
  const call = vi.mocked(f.fetcher).mock.calls[0];
  const url = new URL(String(call[0]));
  expect(url.hostname).toBe('displaycatalog.mp.microsoft.com'); expect(url.searchParams.get('market')).toBe('CZ');
  expect(url.searchParams.get('bigIds')).toBe([BASE, OWN, GP, PAID].join(',')); expect(call[1]?.headers).toBeUndefined(); expect(call[1]?.redirect).toBe('error');
});
it('rejects failed, oversized and unrelated catalog responses without granting installability', async () => {
  const f = await fixture();
  for (const response of [new Response('', { status: 503 }), new Response('x'.repeat(8_000_001)), new Response(JSON.stringify({ Products: [product('9XXXXXXXXXXX')] }))]) {
    const manager = new GameContent(f.data, async () => response);
    await expect(manager.plan(f.game, access)).rejects.toThrow();
  }
});
it('discovers owned matching content even when the optional manifest list is absent', async () => {
  const f = await fixture(); await fs.writeFile(path.join(f.base, 'MicrosoftGame.Config'), config());
  const reader = vi.fn(access); expect((await f.manager.plan(f.game, reader)).plan.items).toHaveLength(2);
  expect(reader).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledOnce();
});
it('keeps catalog-only completed DLC across launcher restarts without editing or declaring it in the base manifest', async () => {
  const f=await fixture(); const original=config();await fs.writeFile(path.join(f.base,'MicrosoftGame.Config'),original);
  const selected=(await f.manager.plan(f.game,access)).packages.find(pkg=>pkg.productId===OWN)!;
  const directory=await f.manager.prepare(f.game,selected);
  await fs.writeFile(path.join(directory,'MicrosoftGame.Config'),childXml());await fs.writeFile(path.join(directory,'appxmanifest.xml'),appxXml);
  await fs.writeFile(path.join(directory,`layout_${GUID}.xml`),layoutXml);await fs.writeFile(path.join(directory,'logo.png'),'synthetic');
  await f.manager.complete(f.game,selected);
  const offline=new GameContent(f.data,async()=>{throw Error('No launch-time network');});
  expect(await offline.roots(f.game)).toEqual([directory]);
  expect(await fs.readFile(path.join(f.base,'MicrosoftGame.Config'),'utf8')).toBe(original);
  await fs.writeFile(path.join(directory,'MicrosoftGame.Config'),childXml().replace(OWN,PAID));
  expect(await offline.roots(f.game)).toEqual([]);
});
it('distinguishes license-only durables and content bundles from unsupported downloadable formats',()=>{
  const data=catalog();data.Products[1].DisplaySkuAvailabilities[0].Sku.Properties.Packages=[];
  expect(contentOffers(contentManifest(baseXml),data,{[OWN]:'other'}).items[0]).toMatchObject({status:'license-only',access:'other'});
  Object.assign(data.Products[1].DisplaySkuAvailabilities[0].Sku.Properties,{BundledSkus:[{BigId:GP}]});
  expect(contentOffers(contentManifest(baseXml),data,{[OWN]:'owned'}).items[0].status).toBe('bundle');
  const consoleOnly=catalog();consoleOnly.Products[1].DisplaySkuAvailabilities[0].Sku.Properties.Packages[0].PlatformDependencies=[];
  expect(contentOffers(contentManifest(baseXml),consoleOnly,{[OWN]:'owned'}).items[0].status).toBe('unsupported');
});
it('keeps partial content out of runtime roots, then registers only completed matching packages', async () => {
  const f = await installFixture();
  expect(f.directory.startsWith(f.base)).toBe(false); expect(await f.manager.roots(f.game)).toEqual([]);
  await f.manager.complete(f.game, f.selected);
  expect(await f.manager.roots(f.game)).toEqual([f.directory]);
  const plan = await f.manager.plan(f.game, access);
  expect(plan.plan.items[0].status).toBe('installed');
  const unlicensed = (await f.manager.plan(f.game, async () => ({ checkedAt: '', accessByProductId: {} }))).plan.items[0];
  expect(unlicensed.status).toBe('installed'); expect(unlicensed.access).toBeUndefined();
  await f.manager.prepare(f.game, f.selected); expect(await f.manager.roots(f.game)).toEqual([]);
});
it('rejects wrong publisher, parent, Store ID, Appx identity or missing layout payload', async () => {
  for (const failure of ['publisher', 'parent', 'store', 'appx', 'payload', 'layout']) {
    const f = await installFixture();
    if (failure === 'publisher') await fs.writeFile(path.join(f.directory, 'MicrosoftGame.Config'), childXml().replace('CN=Example', 'CN=Other'));
    if (failure === 'parent') await fs.writeFile(path.join(f.directory, 'MicrosoftGame.Config'), childXml().replace('<AllowedProduct>' + BASE, '<AllowedProduct>' + PAID));
    if (failure === 'store') await fs.writeFile(path.join(f.directory, 'MicrosoftGame.Config'), childXml(PAID));
    if (failure === 'appx') await fs.writeFile(path.join(f.directory, 'appxmanifest.xml'), appxXml.replace('1.0.0.0', '2.0.0.0'));
    if (failure === 'payload') await fs.unlink(path.join(f.directory, 'logo.PNG'));
    if (failure === 'layout') await fs.writeFile(path.join(f.directory, `layout_${GUID}.xml`), layoutXml.replace('SourcePath="."', 'SourcePath="../outside"'));
    await expect(f.manager.complete(f.game, f.selected)).rejects.toThrow(); expect(await f.manager.roots(f.game)).toEqual([]);
  }
});
it('rejects managed-path symlinks and content not declared by the parent', async () => {
  const f = await fixture();
  await fs.symlink(f.base, path.join(f.data, 'content'));
  await expect(f.manager.prepare(f.game, { productId: OWN, contentId: GUID, family: 'Example.Content_hash' })).rejects.toThrow('real directory');
  await expect(f.manager.prepare(f.game, { productId: '9XXXXXXXXXXX', contentId: GUID, family: 'Example.Content_hash' })).rejects.toThrow('Invalid content');
});
it('does not retain completion after manifest or payload changes', async () => {
  const f = await installFixture(); await f.manager.complete(f.game, f.selected);
  await fs.writeFile(path.join(f.directory, 'appxmanifest.xml'), appxXml.replace('1.0.0.0', '2.0.0.0'));
  expect(await f.manager.roots(f.game)).toEqual([]);
});

it('rejects a forged Content ID, family, preorder-only SKU or storage inside the base game before creating content', async () => {
  const f=await fixture(); const selected=(await f.manager.plan(f.game,access)).packages[0];
  for(const change of [{contentId:'aaaaaaaa-89ab-cdef-0123-456789abcdef'},{family:'Foreign.Content_hash'}])
    await expect(f.manager.prepare(f.game,{...selected,...change})).rejects.toThrow('Invalid content');
  const rootInside=path.join(f.base,'data');await fs.mkdir(rootInside);
  const manager=new GameContent(rootInside,f.fetcher);
  await expect(manager.prepare(f.game,selected)).rejects.toThrow('overlaps');
  expect(await fs.readdir(rootInside)).toEqual([]);
  const data=catalog();Object.assign(data.Products[1].DisplaySkuAvailabilities[0].Sku.Properties,{IsPreOrder:true});
  expect(contentOffers(contentManifest(baseXml),data,{[OWN]:'owned'}).packages).toEqual([]);
});

it('offers all seven Persona premium DLC from authoritative active rows despite an omitted bundle parent',async()=>{
  const data=JSON.parse(await fs.readFile(new URL('./fixtures/persona-premium-content.json',import.meta.url),'utf8'));
  const baseId='9NKK6Z0K3RH2',ids=data.Products.map((p:any)=>p.ProductId).filter((id:string)=>id!==baseId);
  const base=contentManifest(`<Game><Identity Name="SEGAofAmericaInc.L0cb6b3aea" Version="1.0.0.0" Publisher="CN=Fixture"/><StoreId>${baseId}</StoreId><RelatedProducts>${ids.map((id:string)=>`<RelatedProduct>${id}</RelatedProduct>`).join('')}</RelatedProducts></Game>`);
  const library=new AccountLibrary(vi.fn(),async()=>JSON.stringify({schema:1,account:'fixture@example.test',market:'TW',checkedAt:new Date().toISOString(),
    entitlements:ids.map((productId:string)=>({productId,status:'Active',isTrial:false,sharingSource:'None',special:false,endDate:'2099-01-01T00:00:00Z',satisfiedByProductId:'9NDGTQVVRSVS'}))}));
  library.select('fixture@example.test','/fixture/backend','TW');
  const result=contentOffers(base,data,(await library.access()).accessByProductId);
  expect(result.items).toHaveLength(7);expect(result.packages).toHaveLength(7);
  expect(result.items.every(item=>item.status==='available'&&item.access==='other')).toBe(true);
  expect(contentOffers(base,data,{}).packages).toHaveLength(0);
});

it('plans all seven real Persona PC DLC for its base identity without a RelatedProducts list', async () => {
  const f = await fixture();
  const data = JSON.parse(await fs.readFile(new URL('./fixtures/persona-premium-content.json', import.meta.url), 'utf8'));
  const baseId = '9NKK6Z0K3RH2';
  const xml = `<Game><Identity Name="SEGAofAmericaInc.L0cb6b3aea" Publisher="CN=8E5E0709-F814-48B2-9B8A-DC1D37C0D899" Version="1.0.345.0"/><StoreId>${baseId}</StoreId></Game>`;
  await fs.writeFile(path.join(f.base, 'MicrosoftGame.Config'), xml);
  const fetcher = vi.fn(async (input: URL | RequestInfo) => {
    const ids = new URL(String(input)).searchParams.get('bigIds')!.split(',');
    return new Response(JSON.stringify({ Products: data.Products.filter((p: any) => ids.includes(p.ProductId)) }));
  }) as unknown as typeof fetch;
  const owned: Record<string, 'owned'> = Object.fromEntries(data.Products.map((p: any) => [p.ProductId, 'owned']));
  const manager = new GameContent(f.data, fetcher);
  const result = await manager.plan({ ...f.game, storeId: baseId }, async () => ({ checkedAt: '', accessByProductId: owned }), 'TW');
  expect(result.packages).toHaveLength(7);
  expect(result.plan.items.every(item => item.access === 'owned' && item.status === 'available')).toBe(true);
  expect(result.plan.items.some(item => item.title.includes('人格面具'))).toBe(true);
});

it('registers DLC with a config extracted into its declared SRC destination, preserving the original', async () => {
  const f = await installFixture();
  await fs.mkdir(path.join(f.directory, 'SRC'));
  await fs.rename(path.join(f.directory, 'MicrosoftGame.Config'), path.join(f.directory, 'SRC', 'MicrosoftGame.config'));
  await fs.writeFile(path.join(f.directory, `layout_${GUID}.xml`), '<Package><Chunk Id="1000" Marker="Launch"><FileGroup DestinationPath="\\SRC" SourcePath="." Include="*.*"/></Chunk></Package>');
  expect(await f.manager.roots(f.game)).toEqual([]);
  await f.manager.complete(f.game, f.selected);
  expect(await fs.readFile(path.join(f.directory, 'MicrosoftGame.config'), 'utf8')).toBe(childXml());
  expect(await fs.readFile(path.join(f.directory, 'SRC', 'MicrosoftGame.config'), 'utf8')).toBe(childXml());
  expect(await f.manager.roots(f.game)).toEqual([f.directory]);
});

it('does not promote nested configs with foreign identities, undeclared mappings or symlink destinations', async () => {
  for (const failure of ['identity', 'mapping', 'symlink']) {
    const f = await installFixture();
    const source = path.join(f.directory, 'SRC');
    await fs.mkdir(source);
    await fs.rename(path.join(f.directory, 'MicrosoftGame.Config'), path.join(source, 'MicrosoftGame.config'));
    if (failure === 'identity') await fs.writeFile(path.join(source, 'MicrosoftGame.config'), childXml().replace('CN=Example', 'CN=Other'));
    if (failure === 'symlink') {
      await fs.rename(source, path.join(f.directory, 'original'));
      await fs.symlink(path.join(f.directory, 'original'), source);
    }
    await fs.writeFile(path.join(f.directory, `layout_${GUID}.xml`), `<Package><Chunk><FileGroup ${failure === 'mapping' ? '' : 'DestinationPath="\\SRC"'} SourcePath="." Include="*.*"/></Chunk></Package>`);
    await expect(f.manager.complete(f.game, f.selected)).rejects.toThrow();
    await expect(fs.stat(path.join(f.directory, 'MicrosoftGame.config'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.manager.roots(f.game)).toEqual([]);
  }
});

it('checks licensed matching DLC before any base game directory exists', async () => {
  const f = await fixture();
  const result = await f.manager.preflight(BASE, access, 'TW');
  expect(result.packages.map(pkg => pkg.productId)).toEqual([OWN, GP]);
  expect(await fs.readdir(f.data)).toEqual([]);
});

it('removes only completed managed content, preserving the base and refusing unmarked or foreign records', async () => {
  const f = await installFixture();
  await expect(f.manager.remove(f.game, OWN)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.directory, 'MicrosoftGame.Config'), 'utf8')).toBe(childXml());
  await f.manager.complete(f.game, f.selected);
  const marker = path.join(f.directory, '.nexus-content-complete.json');
  const original = await fs.readFile(marker, 'utf8');
  await fs.writeFile(marker, original.replace(BASE, PAID));
  await expect(f.manager.remove(f.game, OWN)).rejects.toThrow('Invalid content');
  await fs.writeFile(marker, original);
  await f.manager.remove(f.game, OWN);
  await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(f.base, 'MicrosoftGame.Config'), 'utf8')).toBe(baseXml);
  expect(await f.manager.roots(f.game)).toEqual([]);
});

it('reports validated installed files separately from unresolved source-offer licensing', async () => {
  const f = await installFixture(); await f.manager.complete(f.game, f.selected);
  const { ContentCatalog } = await import('./content-catalog.js');
  const discover = vi.spyOn(ContentCatalog.prototype, 'discover').mockResolvedValue({ ...catalog(), related: [OWN], verify: [OWN] });
  try {
    const result = await f.manager.plan(f.game, async () => ({ checkedAt: '', accessByProductId: { [BASE]: 'owned' } }));
    expect(result.plan.items[0]).toMatchObject({ status: 'verify', installedFiles: true });
    expect(result.plan.items[0]).not.toHaveProperty('access');
    expect(result.packages[0].productId).toBe(OWN);
  } finally { discover.mockRestore(); }
});
