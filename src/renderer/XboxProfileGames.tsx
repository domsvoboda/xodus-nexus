import {ui} from './i18n';
import {useEffect,useState} from 'react';
import {Gamepad2,LoaderCircle,RefreshCw} from 'lucide-react';
import type {XboxProfileGame,XboxProfileGames as ProfileGames,XboxSocialApi} from '../shared/types';

export function xboxGameProgress(game:XboxProfileGame):{achievements?:string;gamerscore?:string}{
 const result:{achievements?:string;gamerscore?:string}={};
 const unlocked=game.achievementsUnlocked,total=game.achievementsTotal,score=game.currentGamerscore,maxScore=game.totalGamerscore;
 // The title-history service uses zero when a total is unavailable.
 if(unlocked!==undefined&&(unlocked>0||(total??0)>0))result.achievements=total&&total>=unlocked?`${unlocked} / ${total} achievements`:`${unlocked} achievements unlocked`;
 if(score!==undefined&&(score>0||(maxScore??0)>0))result.gamerscore=maxScore&&maxScore>=score?`${score} / ${maxScore} Gamerscore`:`${score} Gamerscore`;
 return result;
}

export function XboxProfileGames({api,xuid}:{api:XboxSocialApi;xuid:string}){
 const [games,setGames]=useState<ProfileGames>(),[problem,setProblem]=useState<string>(),[revision,setRevision]=useState(0);
 useEffect(()=>{
  let alive=true;setGames(undefined);setProblem(undefined);
  void api.getXboxPlayerGames(xuid).then(value=>{if(alive)setGames(value);},()=>{if(alive)setProblem('Xbox could not share this player’s game history. It may be private.');});
  return()=>{alive=false;};
 },[api,xuid,revision]);
 return <section className="social-profile-games" aria-label={ui("social.xbox_game_history_985d8f")}>
  <h3>{ui("social.games_d9dae7")}</h3>
  {games?<>
   {games.items.length?<div className="social-profile-game-list">{games.items.map(game=>{const progress=xboxGameProgress(game);return <article key={game.titleId} className="social-profile-game">
    {game.imageUrl?<img src={game.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/>:<div className="social-profile-game-placeholder"><Gamepad2/></div>}
    <div><h4>{game.name}</h4>{game.lastPlayed?<p>{ui("ui.last_played_63abe4e")} {new Date(game.lastPlayed).toLocaleDateString()}</p>:null}
     {progress.achievements?<p>{progress.achievements}</p>:null}
     {progress.gamerscore?<p><b className="social-score-icon" aria-hidden="true">G</b> {progress.gamerscore}</p>:null}
    </div>
   </article>;})}</div>:<p className="social-profile-private">{ui("social.no_games_shared_by_this_player_282d02")}</p>}
   {games.truncated?<p className="social-profile-private">{ui("social.showing_the_first_7e92a4")} {games.items.length} {ui("social.games_shared_by_xbox_307e6c")}</p>:null}
  </>:problem?<><p className="social-profile-private">{problem}</p><button className="social-menu-action" onClick={()=>setRevision(value=>value+1)}><RefreshCw/>{ui("social.try_again_d8b839")}</button></>:<p className="social-loading"><LoaderCircle className="spin"/>{ui("ui.loading_games_578df84")}</p>}
 </section>;
}
