import {useEffect,useState} from 'react';
import {CircleAlert,Gamepad2,LoaderCircle,RefreshCw} from 'lucide-react';
import type {CatalogProduct,RecentGamePassShelf} from '../shared/types';
import {ui} from './i18n';

export interface RecentGamePassState {
  shelf?: RecentGamePassShelf;
  loading: boolean;
  error?: string;
}

/** Public shelf data. It is independent of the signed-in account and is only
 * refreshed by an explicit retry, never by each render or keystroke. */
export function useRecentGamePassShelf(): RecentGamePassState & {retry:()=>void} {
  const [state,setState]=useState<RecentGamePassState>({loading:true});
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;
    setState(previous=>({shelf:previous.shelf,loading:true}));
    const api=window.launcher as Window['launcher']&{getRecentGamePassShelf?:()=>Promise<RecentGamePassShelf>};
    if(!api.getRecentGamePassShelf){
      // Older test harnesses may not expose the optional channel.
      setState({loading:false});
      return;
    }
    void api.getRecentGamePassShelf().then(value=>{
      if(!active)return;
      const staleMessage=value.stale
        ?value.products.length?ui('ui.showing_the_last_loaded_pc_game_pass_list_try_agai_4344aca'):ui('ui.the_pc_game_pass_catalog_could_not_be_loaded_check_9d5d552')
        :undefined;
      setState({shelf:value,loading:false,error:staleMessage});
    }).catch(()=>{
      if(!active)return;
      setState(previous=>({shelf:previous.shelf,loading:false,
        error:previous.shelf?.products.length
          ?ui('ui.showing_the_last_loaded_pc_game_pass_list_try_agai_4344aca')
          :ui('ui.the_pc_game_pass_catalog_could_not_be_loaded_check_9d5d552')}));
    });
    return ()=>{active=false;};
  },[revision]);
  return {...state,retry:()=>setRevision(value=>value+1)};
}

export function HomeGamePassSection({shelf,loading,error,retry,open}:RecentGamePassState&{
  retry:()=>void;
  open:(product:CatalogProduct)=>void;
}) {
  const products=shelf?.products??[];
  return <section className="home-gamepass" aria-labelledby="home-gamepass-title" aria-busy={loading||undefined}>
    <div className="section-title">
      <h2 id="home-gamepass-title">{ui('ui.recently_added_in_game_pass_07849d1')}</h2>
      {loading?<span className="shelf-loading" role="status" aria-label={ui('ui.loading_live_store_collection_20763b0')}><LoaderCircle className="spin"/></span>:null}
    </div>
    {products.length>0
      ? <>
          <div className="poster-row">
            {products.map(product=><button className="poster-card home-gamepass-card" key={product.productId} data-gamepad-key={`home-gamepass:${product.productId}`}
              onClick={()=>open(product)}>
              {product.posterUrl
                ?<img className="game-cover cover-store" src={product.posterUrl} alt={ui('ui.artwork_1bf7d06',{game:product.title})}/>
                :<div className="cover-placeholder"><Gamepad2/></div>}
              <strong title={product.title}>{product.title}</strong>
              <span>{product.publisher??product.productId}</span>
              <small className="gamepass-badge">{ui('ui.game_pass_5c83b40')}</small>
            </button>)}
          </div>
          {error?<div className="shelf-warning" role="status"><CircleAlert/><span>{error}</span><button onClick={retry}><RefreshCw/>{ui('ui.try_again_d8b839')}</button></div>:null}
        </>
      : loading
        ? <div className="catalog-loading" role="status"><LoaderCircle className="spin"/><span>{ui('ui.loading_live_store_collection_20763b0')}</span></div>
        : error
          ? <div className="catalog-empty" role="alert"><CircleAlert/><h2>{error}</h2><button className="secondary" onClick={retry}><RefreshCw/>{ui('ui.try_again_d8b839')}</button></div>
          : <div className="catalog-empty" role="status"><Gamepad2/><h2>{ui('ui.no_new_pc_game_pass_games_are_available_right_now_08d8175')}</h2></div>}
  </section>;
}
