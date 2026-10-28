import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import type {CatalogProduct} from '../shared/types';
import {demoSnapshot} from '../shared/demo-data';
import {CatalogGameDetails,catalogGameInstalled,catalogGameQueued} from './CatalogGameDetails';
import {GameDetailsContent} from './GameDetails';
import {LibraryProductCard,StoreProductCard} from './App';
const product:CatalogProduct={productId:'9AAAAAAAAAAA',title:'Uninstalled game',description:'Description',publisher:'Studio',installability:'supported',supportNote:'Windows.Desktop MSIXVC',categories:[]};
it('renders the same full detail layout with Install, screenshots and achievements, without fabricated installation actions',()=>{
 const data=demoSnapshot();data.downloads=[];
 const html=renderToStaticMarkup(<CatalogGameDetails product={product} data={data} back={()=>{}} toast={()=>{}}/>);
 expect(html).toContain('game-details-page');expect(html).toContain('Not installed');expect(html).toContain('>Install</button>');expect(html).toContain('Screenshots');expect(html).toContain('Achievements');
 expect(html).toContain('Install location');
 expect(html).not.toMatch(/>Play<|>Manage<|Installation details|Executable|>Imported</);
 expect(html).toContain(`data-gamepad-detail="${product.productId}"`);
});
it.each(['unsupported','unknown'] as const)('keeps %s products viewable without enabling installation',installability=>{
 const html=renderToStaticMarkup(<CatalogGameDetails product={{...product,installability}} data={demoSnapshot()} back={()=>{}} toast={()=>{}}/>);
 expect(html).toMatch(/<button[^>]*data-gamepad-play[^>]*disabled=""/);expect(html).toContain('Screenshots');expect(html).toContain('Achievements');
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
 const store=StoreProductCard({product,selected:false,disabled:false,label:'Install',select:(p,open)=>calls.push(['select',p.productId,open]),install:p=>calls.push(['install',p.productId])});
 store.props.children[0].props.onFocus();expect(calls).toEqual([['select',product.productId,false]]);
 store.props.children[0].props.onClick();expect(calls.at(-1)).toEqual(['select',product.productId,true]);
});
