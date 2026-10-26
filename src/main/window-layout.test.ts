import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transpileModule,ScriptTarget} from 'typescript';
const source=readFileSync('src/main/index.ts','utf8'),start=source.indexOf('  const windowState = hiddenCapture ? undefined : readWindowState();');
const prefix=source.slice(start,source.indexOf('  mainWindow = new BrowserWindow(',start));
const code=transpileModule('(()=>{'+prefix+'return {bounds,area,tooLarge};})()', {compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
function layout(width:number,height:number,saved?:{x:number;y:number;width:number;height:number;maximized:boolean},secondary?:{x:number;y:number;width:number;height:number}){
 const primary={x:0,y:0,width,height},matching=vi.fn(()=>({workArea:secondary??primary}));
 const context=createContext({hiddenCapture:false,readWindowState:()=>saved,restoredBoundsOnScreen:()=>true,screen:{getPrimaryDisplay:()=>({workArea:primary}),getDisplayMatching:matching}});
 return{...runInContext(code,context),matching};
}
it.each([[1280,800],[800,480],[640,480]])('lets the compositor maximize first startup on %ix%i', (width,height)=>{
 const r=layout(width,height);expect(r.tooLarge).toBe(true);expect(r.bounds.width).toBeLessThanOrEqual(width);expect(r.bounds.height).toBeLessThanOrEqual(height);expect(r.matching).not.toHaveBeenCalled();
});
it('keeps normal desktop startup centered and unmaximized',()=>{
 const r=layout(2560,1440);expect(r.tooLarge).toBe(false);expect(r.bounds).toMatchObject({width:1440,height:900,x:560,y:270});
});
it('uses the restored secondary monitor rather than incorrectly maximizing against the primary',()=>{
 const saved={x:1920,y:0,width:1600,height:900,maximized:false},secondary={x:1920,y:0,width:2560,height:1440};
 const r=layout(1280,800,saved,secondary);expect(r.tooLarge).toBe(false);expect(r.area).toEqual(secondary);expect(r.bounds).toEqual(saved);expect(r.matching).toHaveBeenCalledWith({x:1920,y:0,width:1600,height:900});
});
it('maximizes a saved oversized window on the smaller secondary monitor',()=>{
 const r=layout(2560,1440,{x:2560,y:0,width:1440,height:900,maximized:false},{x:2560,y:0,width:1280,height:720});expect(r.tooLarge).toBe(true);
});
it('retains restored maximization, work-area minimums and hidden-capture guard',()=>{
 const r=layout(2560,1440,{x:20,y:20,width:1000,height:700,maximized:true});expect(r.bounds.maximized).toBe(true);
 expect(source).toContain('minWidth: Math.min(800, area.width)');expect(source).toContain('minHeight: Math.min(600, area.height)');expect(source).toContain('if (windowState?.maximized || tooLarge) mainWindow.maximize();');
});
