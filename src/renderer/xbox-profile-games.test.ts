import {expect,it} from 'vitest';
import {xboxGameProgress} from './XboxProfileGames';
const game={titleId:'1',name:'Game'};
it('does not present absent, zero or inconsistent service totals as impossible achievement progress',()=>{
 expect(xboxGameProgress({...game,achievementsUnlocked:10,achievementsTotal:0,currentGamerscore:150,totalGamerscore:1000})).toEqual({achievements:'10 achievements unlocked',gamerscore:'150 / 1000 Gamerscore'});
 expect(xboxGameProgress({...game,achievementsUnlocked:0,achievementsTotal:60,currentGamerscore:0,totalGamerscore:1000})).toEqual({achievements:'0 / 60 achievements',gamerscore:'0 / 1000 Gamerscore'});
 expect(xboxGameProgress({...game,achievementsUnlocked:12,achievementsTotal:10,currentGamerscore:200,totalGamerscore:100})).toEqual({achievements:'12 achievements unlocked',gamerscore:'200 Gamerscore'});
 expect(xboxGameProgress({...game,achievementsUnlocked:0,achievementsTotal:0,currentGamerscore:0,totalGamerscore:0})).toEqual({});
 expect(xboxGameProgress(game)).toEqual({});
});
