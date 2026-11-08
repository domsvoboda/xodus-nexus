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
    ProductType: 'Game',
    DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [{
      PackageFormat: 'MSIXVC',
      PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
    }] } } }],
  }, {
    ProductId: '9BUNDLE1',
    ProductType: 'Game',
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

describe('Public Store landing collections', () => {
  const paidSku = (price: number) => ({ Sku: { SkuType: 'full', Properties: {} }, Availabilities: [{ OrderManagementData: { Price: { MSRP: price, ListPrice: price } } }] });
  const freeSku = () => ({ Sku: { SkuType: 'full', Properties: {} }, Availabilities: [{ OrderManagementData: { Price: { MSRP: 0, ListPrice: 0 } } }] });
  const trialSku = () => ({ Sku: { SkuType: 'trial', Properties: { IsTrial: true } }, Availabilities: [{ OrderManagementData: { Price: { MSRP: 0, ListPrice: 0 } } }] });
  const row = (productId: string, title: string, price: number) => ({ productId, title, isGame: true, priceInfo: { msrp: price, price, displayPrice: price > 0 ? `$${price}` : 'Free' } });
  const game = (productId: string, skus: unknown[]) => ({ ProductId: productId, ProductType: 'Game', DisplaySkuAvailabilities: skus });
  const landingFetcher = (collections: Record<string, unknown[]>, details: Record<string, unknown>, requests: string[]) => (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname.includes('GetComputedProductsList')) {
      const name = url.searchParams.get('listName') ?? '', page = Number(url.searchParams.get('pgNo') ?? '1');
      requests.push(`${name}:${page}`);
      const payload = collections[name]?.[page - 1];
      return payload ? new Response(JSON.stringify(payload), { status: 200 }) : new Response('{}', { status: 404 });
    }
    if (url.pathname.includes('/v7.0/products')) {
      const ids = (url.searchParams.get('bigIds') ?? '').split(',').map(id => id.toUpperCase());
      requests.push(`details:${ids.length}`);
      return new Response(JSON.stringify({ Products: ids.flatMap(id => details[id] ? [details[id]] : []) }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  it('fills the landing page from trending plus top paid games inside a bounded request budget', async () => {
    const requests: string[] = [];
    const collections = {
      TopTrending: [
        { title: 'Trending games', hasMorePages: true, nextPageNumber: 2, productsList: [row('9FREETREND01', 'Free Trending', 0), row('9SHARED00001', 'Shared Paid Game', 19.99), row('9TRENDPAID01', 'Trending Paid', 9.99)] },
        { title: 'Trending games', hasMorePages: true, nextPageNumber: 3, productsList: [] },
      ],
      TopPaid: [
        { title: 'Top paid games', hasMorePages: true, nextPageNumber: 2, productsList: [row('9SHARED00001', 'Shared Paid Game', 19.99), row('9PAIDONE0001', 'Paid One', 29.99)] },
        { title: 'Top paid games', hasMorePages: true, nextPageNumber: 3, productsList: [row('9PAIDTWO0001', 'Paid Two', 39.99)] },
        { title: 'Top paid games', hasMorePages: false, productsList: [row('9PAIDTHREE01', 'Paid Three', 49.99)] },
      ],
    };
    const details = {
      '9FREETREND01': game('9FREETREND01', [freeSku()]),
      '9SHARED00001': game('9SHARED00001', [paidSku(19.99)]),
      '9TRENDPAID01': game('9TRENDPAID01', [paidSku(9.99)]),
      '9PAIDONE0001': game('9PAIDONE0001', [paidSku(29.99)]),
      '9PAIDTWO0001': game('9PAIDTWO0001', [paidSku(39.99)]),
      '9PAIDTHREE01': game('9PAIDTHREE01', [paidSku(49.99)]),
    };
    const result = await new CatalogService(landingFetcher(collections, details, requests)).featured('US');
    expect(result.products.map(product => product.title)).toEqual(['Shared Paid Game', 'Trending Paid', 'Paid One', 'Paid Two', 'Paid Three']);
    expect(result.products.filter(product => product.productId === '9SHARED00001')).toHaveLength(1);
    expect(requests.filter(request => request.startsWith('TopTrending'))).toEqual(['TopTrending:1']);
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1', 'TopPaid:2', 'TopPaid:3']);
    expect(requests.filter(request => request.startsWith('details:')).every(request => Number(request.split(':')[1]) <= 25)).toBe(true);
    expect(result.query).toBe('Trending games');
  });

  it('keeps the surviving Store collection when the other one fails', async () => {
    const trendingOnly = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.includes('GetComputedProductsList')) {
        if (url.searchParams.get('listName') === 'TopPaid') return new Response('{}', { status: 503 });
        return new Response(JSON.stringify({ title: 'Trending games', productsList: [row('9TRENDING01', 'Trending Paid', 9.99)] }), { status: 200 });
      }
      return new Response(JSON.stringify({ Products: [game('9TRENDING01', [paidSku(9.99)])] }), { status: 200 });
    }) as typeof fetch;
    expect((await new CatalogService(trendingOnly).featured('US')).products.map(product => product.title)).toEqual(['Trending Paid']);

    const paidOnly = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.includes('GetComputedProductsList')) {
        if (url.searchParams.get('listName') === 'TopTrending') return new Response('{}', { status: 503 });
        const page = Number(url.searchParams.get('pgNo') ?? '1');
        return new Response(JSON.stringify({ title: 'Top paid games', hasMorePages: page < 2, productsList: page === 1 ? [row('9PAIDONLY01', 'Paid Only', 14.99)] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ Products: [game('9PAIDONLY01', [paidSku(14.99)])] }), { status: 200 });
    }) as typeof fetch;
    expect((await new CatalogService(paidOnly).featured('US')).products.map(product => product.title)).toEqual(['Paid Only']);
  });

  it('fails honestly when every Store collection is unavailable', async () => {
    const offline = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    await expect(new CatalogService(offline).featured('US')).rejects.toThrow('TopTrending');
  });

  it.each([
    ['string', '2'],
    ['fractional', 2.5],
    ['huge jump', 1_000_000],
    ['repeated current page', 1],
    ['backward', 0],
    ['negative sentinel', -1],
    ['boolean', true],
    ['missing', undefined],
  ])('stops pagination on a %s nextPageNumber and keeps the page one results', async (_label, nextPageNumber) => {
    const requests: string[] = [];
    const collections = {
      TopTrending: [{ title: 'Trending games', hasMorePages: false, productsList: [] }],
      TopPaid: [
        { title: 'Top paid games', hasMorePages: true, nextPageNumber, productsList: [row('9PAIDPAGE001', 'Paid Page One', 19.99)] },
        { title: 'Top paid games', hasMorePages: true, nextPageNumber: 2, productsList: [row('9PAIDPAGE002', 'Paid Page Two', 29.99)] },
        { title: 'Top paid games', hasMorePages: false, productsList: [row('9PAIDPAGE003', 'Paid Page Three', 39.99)] },
      ],
    };
    const details = {
      '9PAIDPAGE001': game('9PAIDPAGE001', [paidSku(19.99)]),
      '9PAIDPAGE002': game('9PAIDPAGE002', [paidSku(29.99)]),
      '9PAIDPAGE003': game('9PAIDPAGE003', [paidSku(39.99)]),
    };
    const result = await new CatalogService(landingFetcher(collections, details, requests)).featured('US');
    expect(result.products.map(product => product.title)).toEqual(['Paid Page One']);
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1']);
    expect(requests.filter(request => request.startsWith('details:'))).toHaveLength(1);
  });

  it('never exceeds the paid page budget even when the feed offers further sequential pages', async () => {
    const requests: string[] = [];
    const page = (index: number) => ({
      title: 'Top paid games',
      hasMorePages: true,
      nextPageNumber: index + 1,
      productsList: [row(`9BUDGETPAGE0${index}`, `Budget Page ${index}`, 9.99 + index)],
    });
    const collections = {
      TopTrending: [{ title: 'Trending games', hasMorePages: false, productsList: [] }],
      TopPaid: [page(1), page(2), page(3), page(4), page(5)],
    };
    const details = Object.fromEntries([1, 2, 3, 4, 5].map(index => [`9BUDGETPAGE0${index}`, game(`9BUDGETPAGE0${index}`, [paidSku(9.99 + index)])]));
    const result = await new CatalogService(landingFetcher(collections, details, requests)).featured('US');
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1', 'TopPaid:2', 'TopPaid:3']);
    expect(result.products.map(product => product.title)).toEqual(['Budget Page 1', 'Budget Page 2', 'Budget Page 3']);
  });

  const bundleSku = (children: string[], price = 29.99) => ({
    Sku: { SkuType: 'full', Properties: { IsBundle: true, BundledSkus: children.map(BigId => ({ BigId, IsPrimary: false })) } },
    Availabilities: [{ OrderManagementData: { Price: { MSRP: price, ListPrice: price } } }],
  });
  const groupedGame = (productId: string, group?: string, skus: unknown[] = [paidSku(19.99)]) => ({
    ...game(productId, skus),
    ...(group ? { Properties: { ProductGroupId: group } } : {}),
  });

  it('keeps genuine all-Game bundles and rejects base-game-plus-extra offers in Featured', async () => {
    const collections = {
      TopTrending: [],
      TopPaid: [{ title: 'Top paid games', hasMorePages: false, productsList: [
        row('9STANDALONE1', 'Standalone', 19.99),
        row('9MULTIGAME01', 'Genuine Multi Game', 29.99),
        row('9SHARKBUNDL', 'Game And Currency', 39.99),
        row('9VAULTBUNDL', 'Game And DLC', 49.99),
        row('9CURRENCY01', 'Currency Only', 4.99),
        row('9DLCONLY001', 'DLC Only', 9.99),
        row('9UNKNOWNBND', 'Unknown Child Bundle', 59.99),
        row('9MISSINGBND', 'Missing Child Bundle', 69.99),
      ] }],
    };
    const details = {
      '9STANDALONE1': groupedGame('9STANDALONE1'),
      '9MULTIGAME01': groupedGame('9MULTIGAME01', undefined, [bundleSku(['9GAMECHILD1', '9GAMECHILD2'])]),
      '9GAMECHILD1': { ProductId: '9GAMECHILD1', ProductType: 'Game' },
      '9GAMECHILD2': { ProductId: '9GAMECHILD2', ProductType: 'Game' },
      '9SHARKBUNDL': groupedGame('9SHARKBUNDL', undefined, [bundleSku(['9GAMECHILD1', '9CONSUMABLE'])]),
      '9CONSUMABLE': { ProductId: '9CONSUMABLE', ProductType: 'Consumable' },
      '9VAULTBUNDL': groupedGame('9VAULTBUNDL', undefined, [bundleSku(['9GAMECHILD1', '9DURABLE01'])]),
      '9DURABLE01': { ProductId: '9DURABLE01', ProductType: 'Durable' },
      '9CURRENCY01': { ProductId: '9CURRENCY01', ProductType: 'Consumable' },
      '9DLCONLY001': { ProductId: '9DLCONLY001', ProductType: 'GameAddOn' },
      '9UNKNOWNBND': groupedGame('9UNKNOWNBND', undefined, [bundleSku(['9UNKNOWNCH'])]),
      '9UNKNOWNCH': { ProductId: '9UNKNOWNCH', ProductType: 'Mystery' },
      '9MISSINGBND': groupedGame('9MISSINGBND', undefined, [bundleSku(['9WITHHELD'])]),
    };
    const result = await new CatalogService(landingFetcher(collections, details, [])).featured('US');
    expect(result.products.map(product => product.title)).toEqual(['Standalone', 'Genuine Multi Game']);
  });

  it('keeps one highest-ranked card per official product group and never merges products without a group', async () => {
    const collections = {
      TopTrending: [],
      TopPaid: [{ title: 'Top paid games', hasMorePages: false, productsList: [
        row('9BASEGAME01', 'Base Game', 29.99),
        row('9LOWEREDIT1', 'Lower Edition', 39.99),
        row('9UNKNOWN001', 'Unknown Group One', 9.99),
        row('9UNKNOWN002', 'Unknown Group Two', 9.99),
      ] }],
    };
    const details = {
      '9BASEGAME01': groupedGame('9BASEGAME01', 'group-one'),
      '9LOWEREDIT1': groupedGame('9LOWEREDIT1', 'group-one'),
      '9UNKNOWN001': groupedGame('9UNKNOWN001'),
      '9UNKNOWN002': groupedGame('9UNKNOWN002'),
    };
    const result = await new CatalogService(landingFetcher(collections, details, [])).featured('US');
    expect(result.products.map(product => product.title)).toEqual(['Base Game', 'Unknown Group One', 'Unknown Group Two']);
  });

  it('refills a short Featured shelf from the next official paid page within the hard page bound', async () => {
    const requests: string[] = [];
    const excluded = (id: string) => row(id, `Excluded ${id}`, 9.99);
    const pageOne = Array.from({ length: 11 }, (_, index) => `9EXCLUDEP1${index}`);
    const pageTwo = Array.from({ length: 12 }, (_, index) => `9EXCLUDEP2${index}`);
    const pageThree = Array.from({ length: 12 }, (_, index) => `9EXCLUDEP3${index}`);
    const refill = Array.from({ length: 11 }, (_, index) => `9REFILLP4${index}`);
    const collections = {
      TopTrending: [],
      TopPaid: [
        { title: 'Top paid games', hasMorePages: true, nextPageNumber: 2, productsList: [...pageOne.map(excluded), row('9FIRSTGOOD1', 'First Standalone', 19.99)] },
        { title: 'Top paid games', hasMorePages: true, nextPageNumber: 3, productsList: pageTwo.map(excluded) },
        { title: 'Top paid games', hasMorePages: true, nextPageNumber: 4, productsList: pageThree.map(excluded) },
        { title: 'Top paid games', hasMorePages: true, nextPageNumber: 5, productsList: refill.map((id, index) => row(id, `Refill ${index + 1}`, 19.99)) },
      ],
    };
    const details: Record<string, unknown> = {
      '9DURABLE01': { ProductId: '9DURABLE01', ProductType: 'Durable' },
      '9FIRSTGOOD1': groupedGame('9FIRSTGOOD1'),
    };
    for (const id of [...pageOne, ...pageTwo, ...pageThree]) details[id] = groupedGame(id, undefined, [bundleSku(['9DURABLE01'])]);
    for (const id of refill) details[id] = groupedGame(id);
    const result = await new CatalogService(landingFetcher(collections, details, requests)).featured('US');
    expect(result.products.map(product => product.title)).toEqual(['First Standalone', ...refill.map((_, index) => `Refill ${index + 1}`)]);
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1', 'TopPaid:2', 'TopPaid:3', 'TopPaid:4']);
    expect(result.cursor).toBe('paid-5');
  });

  it('excludes trial and demo offers that appear in the top paid collection', async () => {
    const collections = {
      TopTrending: [{ title: 'Trending games', hasMorePages: false, productsList: [] }],
      TopPaid: [{ title: 'Top paid games', hasMorePages: false, productsList: [row('9TRIALONLY01', 'Trial Only', 29.99), row('9PAIDWITHDEMO', 'Paid With Demo', 39.99)] }],
    };
    const details = {
      '9TRIALONLY01': game('9TRIALONLY01', [trialSku()]),
      '9PAIDWITHDEMO': game('9PAIDWITHDEMO', [trialSku(), paidSku(39.99)]),
    };
    const result = await new CatalogService(landingFetcher(collections, details, [])).featured('US');
    expect(result.products.map(product => product.title)).toEqual(['Paid With Demo']);
  });

  const browsePages = (pages: number, extra: (index: number) => Record<string, unknown>[] = () => []) => {
    const collections: Record<string, unknown[]> = { TopPaid: [] };
    for (let index = 1; index <= pages; index += 1) {
      collections.TopPaid.push({
        title: 'Top paid games',
        hasMorePages: index < pages,
        nextPageNumber: index < pages ? index + 1 : -1,
        productsList: [row(`9BROWSE00${index}`, `Browse ${index}`, 9.99 + index), ...extra(index)],
      });
    }
    return collections;
  };
  const browseDetails = (pages: number, extra: string[] = []) => Object.fromEntries([
    ...Array.from({ length: pages }, (_, index) => [`9BROWSE00${index + 1}`, game(`9BROWSE00${index + 1}`, [paidSku(9.99 + index + 1)])]),
    ...extra.map(id => [id, game(id, [paidSku(19.99)])]),
  ]);

  it('continues from the exact page the featured read did not cover', async () => {
    const requests: string[] = [];
    const service = new CatalogService(landingFetcher(browsePages(6), browseDetails(6), requests));
    const featured = await service.featured('US');
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1', 'TopPaid:2', 'TopPaid:3']);
    expect(featured.hasMore).toBe(true);
    expect(featured.cursor).toBe('paid-4');
    const first = await service.browse('US', featured.cursor);
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1', 'TopPaid:2', 'TopPaid:3', 'TopPaid:4']);
    expect(first.products.map(product => product.title)).toEqual(['Browse 4']);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe('paid-5');
    const second = await service.browse('US', first.cursor);
    expect(second.products.map(product => product.title)).toEqual(['Browse 5']);
    expect(second.cursor).toBe('paid-6');
    const third = await service.browse('US', second.cursor);
    expect(third.hasMore).toBe(false);
    expect(third.cursor).toBeUndefined();
  });

  it('offers no continuation when the paid feed ended inside the featured budget', async () => {
    const requests: string[] = [];
    const featured = await new CatalogService(landingFetcher(browsePages(2), browseDetails(2), requests)).featured('US');
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1', 'TopPaid:2']);
    expect(featured.products.map(product => product.title)).toEqual(['Browse 1', 'Browse 2']);
    expect(featured.hasMore).toBe(false);
    expect(featured.cursor).toBeUndefined();
  });

  it('restarts the paid feed from its first page when the featured paid read failed', async () => {
    const requests: string[] = [];
    const collections = { ...browsePages(6), TopTrending: [{ title: 'Trending games', hasMorePages: false, productsList: [row('9TRENDING01', 'Trending Paid', 9.99)] }] };
    const details = { ...browseDetails(6), '9TRENDING01': game('9TRENDING01', [paidSku(9.99)]) }, state = { failPage2: true };
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.includes('GetComputedProductsList')) {
        const name = url.searchParams.get('listName') ?? '', page = Number(url.searchParams.get('pgNo') ?? '1');
        requests.push(`${name}:${page}`);
        if (name === 'TopPaid' && page === 2 && state.failPage2) return new Response('{}', { status: 503 });
        const payload = collections[name]?.[page - 1];
        return payload ? new Response(JSON.stringify(payload), { status: 200 }) : new Response('{}', { status: 404 });
      }
      if (url.pathname.includes('/v7.0/products')) {
        const ids = (url.searchParams.get('bigIds') ?? '').split(',').map(id => id.toUpperCase());
        return new Response(JSON.stringify({ Products: ids.flatMap(id => details[id] ? [details[id]] : []) }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const service = new CatalogService(fetcher);
    const featured = await service.featured('US');
    // A failed paid read contributes nothing; its items are recovered from page 1.
    expect(featured.products.map(product => product.title)).toEqual(['Trending Paid']);
    expect(featured.hasMore).toBe(true);
    expect(featured.cursor).toBe('paid-1');
    // Recovery reads the skipped first page again instead of assuming it exists.
    const recovered = await service.browse('US', featured.cursor);
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1', 'TopPaid:2', 'TopPaid:1']);
    expect(recovered.products.map(product => product.title)).toEqual(['Browse 1']);
    expect(recovered.cursor).toBe('paid-2');
  });

  it('rejects a totally failed featured read and returns a real continuation after a retry', async () => {
    const requests: string[] = [];
    const collections = browsePages(6), details = browseDetails(6), state = { fail: true };
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.includes('GetComputedProductsList')) {
        const name = url.searchParams.get('listName') ?? '', page = Number(url.searchParams.get('pgNo') ?? '1');
        requests.push(`${name}:${page}`);
        if (state.fail) return new Response('{}', { status: 503 });
        const payload = collections[name]?.[page - 1];
        return payload ? new Response(JSON.stringify(payload), { status: 200 }) : new Response('{}', { status: 404 });
      }
      if (url.pathname.includes('/v7.0/products')) {
        const ids = (url.searchParams.get('bigIds') ?? '').split(',').map(id => id.toUpperCase());
        return new Response(JSON.stringify({ Products: ids.flatMap(id => details[id] ? [details[id]] : []) }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const service = new CatalogService(fetcher);
    await expect(service.featured('US')).rejects.toThrow('TopTrending');
    state.fail = false;
    const retried = await service.featured('US');
    expect(retried.products.map(product => product.title)).toEqual(['Browse 1', 'Browse 2', 'Browse 3']);
    expect(retried.hasMore).toBe(true);
    expect(retried.cursor).toBe('paid-4');
  });

  it('reads the first paid page when no cursor is provided, so a page-1 recovery request is honest', async () => {
    const requests: string[] = [];
    const result = await new CatalogService(landingFetcher(browsePages(4), browseDetails(4), requests)).browse('US');
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:1']);
    expect(result.products.map(product => product.title)).toEqual(['Browse 1']);
    expect(result.cursor).toBe('paid-2');
  });

  it('serves a repeated cursor from one shared request and never redirects the page budget', async () => {
    const requests: string[] = [];
    const service = new CatalogService(landingFetcher(browsePages(6), browseDetails(6), requests));
    const [left, right] = await Promise.all([service.browse('US', 'paid-5'), service.browse('US', 'paid-5')]);
    expect(left.products).toEqual(right.products);
    expect(requests.filter(request => request.startsWith('TopPaid'))).toEqual(['TopPaid:5']);
  });

  it('stops at the last bounded page even when the feed still offers a continuation', async () => {
    const pages = browsePages(41);
    pages.TopPaid[39] = { title: 'Top paid games', hasMorePages: true, nextPageNumber: 41, productsList: [row('9BROWSE0040', 'Browse 40', 29.99)] };
    const result = await new CatalogService(landingFetcher(pages, browseDetails(41), [])).browse('US', 'paid-40');
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeUndefined();
  });

  it('keeps the public browsing policy on continued pages', async () => {
    const collections = browsePages(4, index => index === 4 ? [
      row('9BROWSETRIAL', 'Browse Trial', 29.99),
      row('9BROWSEFREE0', 'Browse Free', 0),
      row('9BROWSEDLC0', 'Browse DLC Bundle', 29.99),
    ] : []);
    const details = {
      ...browseDetails(4),
      '9BROWSETRIAL': game('9BROWSETRIAL', [trialSku()]),
      '9BROWSEFREE0': game('9BROWSEFREE0', [freeSku()]),
      '9BROWSEDLC0': groupedGame('9BROWSEDLC0', undefined, [bundleSku(['9DURABLE01'])]),
      '9DURABLE01': { ProductId: '9DURABLE01', ProductType: 'Durable' },
    };
    const result = await new CatalogService(landingFetcher(collections, details, [])).browse('US', 'paid-4');
    expect(result.products.map(product => product.title)).toEqual(['Browse 4']);
  });

  it.each(['paid-0', 'paid-41', 'paid-1000', 'paid-4x', '4', 'cursor', '', 'paid-'])('rejects the invalid browse cursor %s without any request', async cursor => {
    const requests: string[] = [];
    await expect(new CatalogService(landingFetcher({}, {}, requests)).browse('US', cursor)).rejects.toThrow('browse cursor');
    expect(requests).toEqual([]);
  });
});

describe('Store-only offer policy',()=>{
 const sku=(price:number,props:Record<string,unknown>={},type='full')=>({Sku:{SkuType:type,Properties:props},Availabilities:[{OrderManagementData:{Price:{MSRP:price,ListPrice:price}}}]});
 const parse=(skus:unknown[],extra={},policy:'store'|'library'='store')=>parseCatalogProducts({productsList:[{productId:'9AAAAAAAAAAA',title:'Free Spirit',isGame:true,...extra}]},{Products:[{ProductId:'9AAAAAAAAAAA',ProductType:'Game',DisplaySkuAvailabilities:skus}]},policy);
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
  expect(parseCatalogProducts({productsList:[null,{},false,{productId:'9AAAAAAAAAAA',title:'Valid'}]}, {Products:[null,{ProductId:'9AAAAAAAAAAA',ProductType:'Game'}]},'store')).toHaveLength(1);
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

describe('public collection metadata',()=>{
 const offers=(price=29.99)=>({Sku:{SkuType:'full',Properties:{Packages:[{PackageFormat:'MSIXVC',PlatformDependencies:[{PlatformName:'Windows.Desktop'}]}]}},Availabilities:[{OrderManagementData:{Price:{MSRP:price,ListPrice:price}}}]});
 const freeOffer={Sku:{SkuType:'full',Properties:{}},Availabilities:[{OrderManagementData:{Price:{MSRP:0,ListPrice:0}}}]};
 const detail=(productId:string,title:string,offersValue:unknown[],type='Game')=>({ProductId:productId,ProductType:type,
  LocalizedProperties:[{ProductTitle:title,PublisherName:'Studio'}],DisplaySkuAvailabilities:offersValue});
 it('keeps the requested official order and applies public Store eligibility',async()=>{
  const ids=['9AAAAAA00001','9BBBBBB00002','9CCCCCC00003','9DDDDDD00004'];
  const products=[detail(ids[2],'Third',[offers()]),detail(ids[0],'First',[offers()]),
   detail(ids[1],'Free',[freeOffer]),detail(ids[3],'Add-on',[offers()],'Durable')];
  const fetcher=async(input:unknown)=>{
   const url=new URL(String(input));
   expect(url.pathname).toBe('/v7.0/products');
   expect(url.searchParams.get('market')).toBe('US');
   expect(url.searchParams.get('bigIds')).toBe(ids.join(','));
   return new Response(JSON.stringify({Products:products}),{status:200});
  };
  const result=await new CatalogService(fetcher as typeof fetch).publicProducts(ids,'US');
  expect(result.map(product=>product.productId)).toEqual([ids[0],ids[2]]);
  expect(result.every(product=>!('access' in product))).toBe(true);
 });
 it('batches large metadata windows without losing the requested order',async()=>{
  const ids=Array.from({length:30},(_,index)=>`9${String(index+1).padStart(11,'0')}`);
  const batches:string[][]=[];
  const fetcher=async(input:unknown)=>{
   const url=new URL(String(input)),batch=(url.searchParams.get('bigIds')??'').split(',');
   batches.push(batch);
   return new Response(JSON.stringify({Products:[...batch].reverse().map(value=>detail(value,`Title ${value}`,[offers()]))}),{status:200});
  };
  const result=await new CatalogService(fetcher as typeof fetch).publicProducts(ids,'US');
  expect(batches.map(batch=>batch.length)).toEqual([25,5]);
  expect(result.map(product=>product.productId)).toEqual(ids);
 });
 it('fails the shelf when display metadata is unavailable instead of reporting an empty collection',async()=>{
  const fetcher=async()=>new Response('{}',{status:503});
  await expect(new CatalogService(fetcher as typeof fetch).publicProducts(['9AAAAAA00001'],'US')).rejects.toThrow('public Store metadata');
 });
 it('skips rows without a real localized title and rejects malformed or unbounded lists',async()=>{
  const fetcher=async()=>new Response(JSON.stringify({Products:[detail('9AAAAAA00001','',[]),detail('9BBBBBB00002','Visible',[offers()])]}),{status:200});
  const service=new CatalogService(fetcher as typeof fetch);
  expect((await service.publicProducts(['9AAAAAA00001','9BBBBBB00002'],'US')).map(product=>product.title)).toEqual(['Visible']);
  for(const value of [[],['9aaaaaa00001'],Array.from({length:61},(_,index)=>`9${String(index).padStart(11,'0')}`)])
   await expect(service.publicProducts(value,'US')).rejects.toThrow('public product list');
 });
});
