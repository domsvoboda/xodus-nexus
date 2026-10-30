import {expect,it,vi} from 'vitest';
import {LauncherTray} from './launcher-tray';
it('keeps normal closing until explicitly enabled with a working icon',()=>{
 const icon={destroy:vi.fn()},create=vi.fn(()=>icon),tray=new LauncherTray(create),event={preventDefault:vi.fn()},hide=vi.fn();
 expect(tray.close(event,hide)).toBe(false);expect(hide).not.toHaveBeenCalled();
 expect(tray.configure(true)).toBe(true);expect(tray.configure(true)).toBe(true);expect(create).toHaveBeenCalledOnce();
 expect(tray.close(event,hide)).toBe(true);expect(event.preventDefault).toHaveBeenCalledOnce();expect(hide).toHaveBeenCalledOnce();
 tray.configure(false);expect(icon.destroy).toHaveBeenCalledOnce();expect(tray.close(event,hide)).toBe(false);
});
it('never traps a window when no tray exists or when quitting',()=>{
 for(const tray of [new LauncherTray(()=>{throw Error('no tray host');}),new LauncherTray(()=>({destroy(){}}),()=>false)]){
  expect(tray.configure(true)).toBe(false);expect(tray.close({preventDefault(){throw Error('unexpected');}},()=>{throw Error('hidden');})).toBe(false);
 }
 const icon={destroy:vi.fn()},tray=new LauncherTray(()=>icon);tray.configure(true);tray.quit();tray.quit();
 expect(icon.destroy).toHaveBeenCalledOnce();expect(tray.configure(true)).toBe(false);expect(tray.close({preventDefault:vi.fn()},vi.fn())).toBe(false);
});
