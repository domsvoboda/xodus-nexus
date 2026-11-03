import { describe, expect, it } from 'vitest';
import { CatalogService, parseCatalogProducts } from './catalog.js';

const search = {
  productsList: [{
    productId: '9game123',
    title: 'Purchased Game',
    description: 'A real Store description.',
    publisherName: 'Studio',
    isGame: true,
    posterArtUrl: 'https://store-images.s-microsoft.com/image/poster',
    redirectUrl: 'https://www.xbox.com/games/store/game/9game123',
    priceInfo: { displayPrice: '$29.99' },
    plaintextPassName: undefined,
    categories: ['Action'],
  }, {
    productId: '9bundle1',
    title: 'Bundle Game',
    description: 'Bundle',
    isGame: true,
    plaintextPassName: 'Xbox Game Pass',
  }],
  cursor: 'next_page',
  hasMorePages: true,
};

const catalog = {
  Products: [{
    ProductId: '9GAME123',
    DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [{
      PackageFormat: 'MSIXVC',
      PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
    }] } } }],
  }, {
    ProductId: '9BUNDLE1',
    DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [] } } }],
  }],
};

describe('Microsoft Store catalog parsing', () => {
  it('separates purchase price, subscription availability, and Xodus package support', () => {
    const products = parseCatalogProducts(search, catalog);
    expect(products[0]).toMatchObject({
      productId: '9GAME123',
      purchasePrice: '$29.99',
      includedWith: undefined,
      installability: 'supported',
      packageFormat: 'MSIXVC',
    });
    expect(products[1]).toMatchObject({
      includedWith: 'Xbox Game Pass',
      installability: 'unsupported',
    });
  });

  it('rejects image URLs outside Microsoft Store hosts', () => {
    const products = parseCatalogProducts({ productsList: [{ ...search.productsList[0], posterArtUrl: 'https://example.com/tracker.png' }] }, catalog);
    expect(products[0].posterUrl).toBeUndefined();
  });

  it('prefers branded box art over textless poster art', () => {
    const products = parseCatalogProducts({ productsList: [{ ...search.productsList[0], boxArtUrl: 'https://store-images.s-microsoft.com/image/boxart' }] }, catalog);
    expect(products[0].posterUrl).toBe('https://store-images.s-microsoft.com/image/boxart');
  });

  it('keeps a multi-product Store edition intact for backend package selection', () => {
    const products = parseCatalogProducts({ productsList: [{ productId: '9edition', title: 'Game Standard Edition', isGame: true }] }, {
      Products: [{
        ProductId: '9EDITION',
        DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [], BundledSkus: [
          { BigId: '9package', IsPrimary: true },
          { BigId: '9bonus', IsPrimary: false },
        ] } } }],
      }, {
        ProductId: '9PACKAGE',
        DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [{
          PackageFormat: 'MSIXVC', PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
        }] } } }],
      }, {
        ProductId: '9BONUS',
        DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [] } } }],
      }],
    });
    expect(products[0]).toMatchObject({
      productId: '9EDITION',
      installability: 'supported',
      packageFormat: 'MSIXVC',
    });
    expect(products[0].installProductId).toBeUndefined();
  });

  it('does not treat an unsupported direct EAppx package as a resolvable bundle', () => {
    const products = parseCatalogProducts({ productsList: [{ productId: '9eappx', title: 'Legacy PC Game', isGame: true }] }, {
      Products: [{
        ProductId: '9EAPPX',
        DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [{
          PackageFormat: 'EAppx', PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
        }], BundledSkus: [{ BigId: '9package', IsPrimary: true }] } } }],
      }],
    });
    expect(products[0]).toMatchObject({ installability: 'unsupported', packageFormat: 'EAPPX' });
    expect(products[0].installProductId).toBeUndefined();
  });
});

describe('CatalogService', () => {
  it('keeps licensed games regardless of package support, but never includes add-ons', async () => {
    const id='9AAAAAAAAAAA';
    const data={Products:[{ ...catalog.Products[0],ProductId:id,ProductType:'Game',LocalizedProperties:[{ProductTitle:'Licensed PC Game',PublisherName:'Studio'}]},
      { ...catalog.Products[0],ProductId:'9BBBBBBBBBBB',ProductType:'Durable',LocalizedProperties:[{ProductTitle:'DLC'}]},
      {ProductId:'9CCCCCCCCCCC',ProductType:'Game',LocalizedProperties:[{ProductTitle:'Console game'}],DisplaySkuAvailabilities:[]} ]};
    const fetcher=(async()=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})) as typeof fetch;
    const result=await new CatalogService(fetcher).licensedProducts([id,'9BBBBBBBBBBB','9CCCCCCCCCCC'],'US');
    expect(result.map(p=>p.title)).toEqual(['Licensed PC Game', 'Console game']);
    expect(result[0].installability).toBe('supported');
    expect(result[1].installability).toBe('unsupported');
  });
  it('keeps owned legacy PC formats visible and incomplete bundle metadata unknown', async () => {
    const products = [{ ProductId: '9AAAAAAAAAAA', ProductType: 'Game', LocalizedProperties: [{ ProductTitle: 'Legacy PC game' }],
      DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [{ PackageFormat: 'EAppxBundle', PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }] }] } } }] },
    { ProductId: '9BBBBBBBBBBB', ProductType: 'Game', DisplaySkuAvailabilities: [{ Sku: { Properties: { BundledSkus: [{ BigId: '9CCCCCCCCCCC' }] } } }] }];
    const service = new CatalogService((async () => new Response(JSON.stringify({ Products: products }))) as typeof fetch);
    const result = await service.licensedProducts(['9AAAAAAAAAAA', '9BBBBBBBBBBB'], 'US');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ installability: 'unsupported', packageFormat: 'EAPPXBUNDLE' });
    expect(result[1]).toMatchObject({ title: '9BBBBBBBBBBB', installability: 'unknown' });
    expect(result.some(p => p.productId === '9CCCCCCCCCCC')).toBe(false);
  });
  it('queries games and enriches them with display catalog package metadata', async () => {
    const urls: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input); urls.push(url);
      return new Response(JSON.stringify(url.includes('displaycatalog') ? catalog : search), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await new CatalogService(fetcher).search('gears', 'neutral');
    expect(result.market).toBe('US');
    expect(result.hasMore).toBe(true);
    expect(result.products[0].installability).toBe('supported');
    expect(urls[0]).toContain('mediaType=games');
    expect(urls[1]).toContain('bigIds=9GAME123%2C9BUNDLE1');
  });

  it('loads the live computed games collection and enriches its products', async () => {
    const urls: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input); urls.push(url);
      return new Response(JSON.stringify(url.includes('displaycatalog') ? catalog : { ...search, title: 'Trending games' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const result = await new CatalogService(fetcher).featured('CZ');
    expect(result.query).toBe('Trending games');
    expect(result.market).toBe('CZ');
    expect(result.hasMore).toBe(false);
    expect(urls[0]).toContain('GetComputedProductsList');
    expect(urls[0]).toContain('mediaType=Games');
  });

  it('looks up Store cover artwork by Product ID, preferring square box art, and rejects foreign hosts', async () => {
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes('displaycatalog') ? {
        Products: [{
          ProductId: '9GAME123',
          LocalizedProperties: [{ Images: [
            { ImagePurpose: 'Logo', Uri: '//store-images.s-microsoft.com/image/logo' },
            { ImagePurpose: 'FeaturePromotionalSquareArt', Uri: '//store-images.s-microsoft.com/image/promo' },
            { ImagePurpose: 'BoxArt', Uri: '//store-images.s-microsoft.com/image/boxart' },
          ] }],
        }, {
          ProductId: '9FOREIGN',
          LocalizedProperties: [{ Images: [
            { ImagePurpose: 'BoxArt', Uri: '//tracker.example.com/image/boxart' },
          ] }],
        }],
      } : search), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const posters = await new CatalogService(fetcher).posters(['9game123', '9foreign', 'bad id'], 'US');
    expect(posters.get('9GAME123')).toBe('https://store-images.s-microsoft.com/image/boxart');
    expect(posters.has('9FOREIGN')).toBe(false);
  });

  it('selects separate branded tile and wide artwork, skipping unsafe images and unrelated products', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ Products: [
      { ProductId: '9GAME123', LocalizedProperties: [{ Images: [
        { ImagePurpose: 'Logo', Uri: '//store-images.s-microsoft.com/logo' },
        { ImagePurpose: 'BoxArt', Uri: '//foreign.example/box' },
        { ImagePurpose: 'BoxArt', Uri: '//store-images.s-microsoft.com/box' },
        { ImagePurpose: 'SuperHeroArt', Uri: '//store-images.s-microsoft.com/hero' },
        { ImagePurpose: 'TitledHeroArt', Uri: '//store-images.s-microsoft.com/titled-hero' },
      ] }] },
      { ProductId: '9OTHER', LocalizedProperties: [{ Images: [{ ImagePurpose: 'BoxArt', Uri: '//store-images.s-microsoft.com/other' }] }] },
    ] }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const artwork = await new CatalogService(fetcher).artwork(['9game123'], 'US');
    expect(artwork.get('9GAME123')).toEqual({ coverUrl: 'https://store-images.s-microsoft.com/box', heroUrl: 'https://store-images.s-microsoft.com/titled-hero' });
    expect(artwork.has('9OTHER')).toBe(false);
  });

  it('keeps artwork optional when the catalog is offline or has only a package logo', async () => {
    const offline = (async () => { throw Error('Offline'); }) as typeof fetch;
    expect((await new CatalogService(offline).artwork(['9GAME123'], 'US')).size).toBe(0);
    const logo = (async () => new Response(JSON.stringify({ Products: [{ ProductId: '9GAME123', LocalizedProperties: [{ Images: [
      { ImagePurpose: 'Logo', Uri: '//store-images.s-microsoft.com/logo' },
    ] }] }] }))) as typeof fetch;
    expect((await new CatalogService(logo).artwork(['9GAME123'], 'US')).size).toBe(0);
  });
});

describe('Store-only offer policy',()=>{
 const sku=(price:number,props:Record<string,unknown>={},type='full')=>({Sku:{SkuType:type,Properties:props},Availabilities:[{OrderManagementData:{Price:{MSRP:price,ListPrice:price}}}]});
 const parse=(skus:unknown[],extra={},policy:'store'|'library'='store')=>parseCatalogProducts({productsList:[{productId:'9AAAAAAAAAAA',title:'Free Spirit',isGame:true,...extra}]},{Products:[{ProductId:'9AAAAAAAAAAA',DisplaySkuAvailabilities:skus}]},policy);
 it('excludes structured free, trial and demo but retains paid and missing/malformed prices',()=>{
  expect(parse([sku(0)])).toEqual([]);
  expect(parse([sku(0,{IsTrial:true})])).toEqual([]);
  expect(parse([sku(0,{},'demo')])).toEqual([]);
  expect(parse([sku(10,{IsDemo:true})])).toEqual([]);
  expect(parse([null,{},sku(0,{IsTrial:true})])).toEqual([]);
  expect(parse([sku(25,{IsTrial:false})],{plaintextPassName:'PC Game Pass'})).toHaveLength(1);
  expect(parse([])).toHaveLength(1);
  expect(parse([],{priceInfo:{displayPrice:'Free',price:null}})).toHaveLength(1);
  expect(parse([],{priceInfo:{price:'0',isFree:'true'}})).toHaveLength(1);
  expect(parse([],{priceInfo:{price:0}})).toEqual([]);
 });
 it('uses retail SKU metadata without mistaking an optional trial for the full edition',()=>{
  expect(parse([sku(0,{IsTrial:true}),sku(40,{IsTrial:false})])).toHaveLength(1);
  expect(parse([sku(40,{IsTrial:false}),sku(0,{IsTrial:true})])).toHaveLength(1);
  expect(parse([sku(0,{IsTrial:true})],{},'library')).toHaveLength(1);
  expect(parse([sku(0)],{},'library')).toHaveLength(1);
  expect(parse([sku(0),{Sku:{Properties:{IsTrial:false}}}])).toHaveLength(1);
  expect(parse([{Sku:{Properties:{IsTrial:false}},Availabilities:[{OrderManagementData:{Price:{MSRP:'malformed',ListPrice:0}}}]}])).toHaveLength(1);
 });
 it('never resolves package support or bundle children from explicit trial/preorder SKUs',()=>{
  const pkg={Packages:[{PackageFormat:'MSIXVC',PlatformDependencies:[{PlatformName:'Windows.Desktop'}]}]};
  expect(parse([sku(0,{...pkg,IsTrial:true}),sku(30,{IsTrial:false})])[0].installability).not.toBe('supported');
  expect(parse([sku(30,{...pkg,IsPreOrder:true}),sku(30,{IsTrial:false})])[0].installability).not.toBe('supported');
 });
 it('handles malformed rows without treating absent prices as free',()=>{
  expect(parseCatalogProducts({productsList:[null,{},false,{productId:'9AAAAAAAAAAA',title:'Valid'}]}, {Products:[null]},'store')).toHaveLength(1);
 });
 it('applies the same policy to actual search and featured service paths while preserving licensed games',async()=>{
  const id='9AAAAAAAAAAA';
  const fetcher=async(input:unknown)=>new Response(JSON.stringify(String(input).includes('displaycatalog')?{Products:[{ProductId:id,ProductType:'Game',LocalizedProperties:[{ProductTitle:'Owned free game'}],DisplaySkuAvailabilities:[sku(0)]}]}:{productsList:[{productId:id,title:'Free game',isGame:true}]}),{status:200});
  const service=new CatalogService(fetcher as typeof fetch);
  expect((await service.search('Free game','US')).products).toEqual([]);
  expect((await service.featured('US')).products).toEqual([]);
  expect(await service.licensedProducts([id],'US')).toHaveLength(1);
 });
});
