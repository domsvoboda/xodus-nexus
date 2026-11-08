import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import type {CatalogProduct} from '../shared/types';
import {demoSnapshot} from '../shared/demo-data';
import {CatalogGameDetails,catalogGameInstalled,catalogGameQueued} from './CatalogGameDetails';
import {GameDetailsContent} from './GameDetails';
import {LibraryProductCard,StoreProductCard,StorePage} from './App';
const product:CatalogProduct={productId:'9AAAAAAAAAAA',title:'Uninstalled game',description:'Description',publisher:'Studio',installability:'supported',supportNote:'Windows.Desktop MSIXVC',categories:[]};
it('renders full public details with only a Store page action until a license is verified',()=>{
 const data=demoSnapshot();data.downloads=[];
 const html=renderToStaticMarkup(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 expect(html).toContain('game-details-page');expect(html).toContain('Not installed');expect(html).not.toContain('>Install</button>');expect(html).toContain('Store page');expect(html).toContain('Screenshots');expect(html).toContain('Achievements');
 expect(html).not.toContain('Install location');
 expect(html).not.toMatch(/>Play<|>Manage<|Installation details|Executable|>Imported</);
 expect(html).toContain(`data-gamepad-detail="${product.productId}"`);
});
it.each(['unsupported','unknown'] as const)('keeps %s products viewable without enabling installation',installability=>{
 const html=renderToStaticMarkup(<CatalogGameDetails storeMode product={{...product,installability}} data={demoSnapshot()} back={()=>{}} toast={()=>{}}/>);
 expect(html).not.toContain('data-gamepad-play');expect(html).toContain('Screenshots');expect(html).toContain('Achievements');
});
it('does not mistake an unrelated imported game without a Store ID for an installed catalog game',()=>{
 const data=demoSnapshot();data.games=[{...data.games[0],storeId:undefined}];data.downloads=[];
 expect(catalogGameInstalled(product,data)).toBeUndefined();expect(catalogGameQueued(product,data)).toBe(false);
 data.games[0].storeId='9BBBBBBBBBBB';expect(catalogGameInstalled({...product,installProductId:'9BBBBBBBBBBB'},data)).toBe(data.games[0]);
 data.downloads=[{...demoSnapshot().downloads[0],productId:product.productId,status:'paused'}];expect(catalogGameQueued(product,data)).toBe(true);
});
it('shows supported gallery and metadata when not installed and omits installed-only management',()=>{
 const html=renderToStaticMarkup(<GameDetailsContent game={{id:product.productId,title:product.title}} back={()=>{}} backLabel="Back to Store" play={<button>Install</button>} refresh={()=>{}} details={{productId:product.productId,title:product.title,description:'<script>literal</script>',categories:['Action'],screenshots:['https://store-images.s-microsoft.com/shot']}}/>);
 expect(html).toContain('Back to Store');expect(html).toContain('Open screenshot 1');expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('Installation details');
});
it('keeps product-card detail clicks independent from installation and Store focus selection',()=>{
 const calls:unknown[]=[];
 const library=LibraryProductCard({product:{...product,access:'owned'},present:false,downloading:false,canInstall:true,install:p=>calls.push(['install',p.productId]),open:p=>calls.push(['open',p.productId])});
 library.props.children[0].props.onClick();expect(calls).toEqual([['open',product.productId]]);
 library.props.children[1].props.onClick();expect(calls.at(-1)).toEqual(['install',product.productId]);
 calls.length=0;
 const store=StoreProductCard({licensed:true,product,selected:false,disabled:false,label:'Install',select:(p,open)=>calls.push(['select',p.productId,open]),install:p=>calls.push(['install',p.productId])});
 store.props.children[0].props.onFocus();expect(calls).toEqual([['select',product.productId,false]]);
 store.props.children[0].props.onClick();expect(calls.at(-1)).toEqual(['select',product.productId,true]);
});

it('applies strict public Store eligibility without changing the existing Library detail verification route',()=>{
 const data=demoSnapshot();data.games=[];data.downloads=[];
 const store=renderToStaticMarkup(<CatalogGameDetails storeMode product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 const library=renderToStaticMarkup(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 expect(store).not.toContain('>Install</button>');expect(store).not.toContain('Install location');expect(store).not.toContain(product.supportNote);
 expect(library).toContain('>Install</button>');expect(library).toContain('Install location');expect(library).toContain(product.supportNote);
 const page=renderToStaticMarkup(<StorePage data={data} toast={()=>{}} go={()=>{}} initialQuery=""/>);
 expect(page).not.toContain('manual-install');expect(page).not.toContain('Install unlisted ID');
});

it('omits the generic direct-package sentence and activity disclaimer while keeping Install',()=>{
 const direct={...product,supportNote:'A direct Windows.Desktop MSIXVC package was verified. Ownership is checked by Xodus when installation starts.'};
 const html=renderToStaticMarkup(<CatalogGameDetails product={direct} data={demoSnapshot()} back={()=>{}} toast={()=>{}}/>);
 expect(html).not.toContain(direct.supportNote);
 expect(html).not.toContain('Xbox activity may be delayed or unavailable for some games. Local session time is not added to the Xbox total.');
 expect(html).toContain('>Install</button>');
 expect(html).toContain('Install location');
});

it('keeps the details Browse button and path input at the same 40px height without changing shared 44px controls',()=>{
 const details=readFileSync('src/renderer/game-details.css','utf8'),controls=readFileSync('src/renderer/controls.css','utf8');
 expect(details).toMatch(/\.gd-install-options input \{[^}]*height: 40px/);
 expect(details).toContain('.gd-install-options .input-action { grid-template-columns: minmax(0,1fr) 40px; }');
 expect(details).toMatch(/\.gd-install-options \.input-action button \{[^}]*width: 40px;[^}]*min-width: 40px;[^}]*height: 40px;[^}]*min-height: 40px;[^}]*padding: 0;/);
 expect(controls).toContain('.input-action button { min-width: var(--control-height); min-height: var(--control-height); flex-shrink: 0; }');
});
