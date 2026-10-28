import {expect,it} from 'vitest';
import {overlayChatPosition} from './XboxOverlayChat';
it('keeps the draggable chat controls inside the current overlay viewport',()=>{
 expect(overlayChatPosition(-100,-100,420,620,{width:3440,height:1398})).toEqual({x:8,y:8});
 expect(overlayChatPosition(4000,2000,420,620,{width:3440,height:1398})).toEqual({x:3012,y:770});
 expect(overlayChatPosition(500,100,420,620,{width:3440,height:1398})).toEqual({x:500,y:100});
});
