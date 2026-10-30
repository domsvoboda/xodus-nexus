import {expect,it,vi} from 'vitest';
import {desktopTrayAvailable} from './launcher-tray-desktop';
it('requires a desktop tray host and never enables hiding in Steam Gaming Mode',()=>{
 const check=vi.fn(()=>true);expect(desktopTrayAvailable({XDG_CURRENT_DESKTOP:'KDE'},check)).toBe(true);
 check.mockClear();expect(desktopTrayAvailable({XDG_CURRENT_DESKTOP:'steam:GaMeScOpE'},check)).toBe(false);expect(check).not.toHaveBeenCalled();
 expect(desktopTrayAvailable({},()=>false)).toBe(false);
 expect(desktopTrayAvailable({},()=>{throw Error('DBus unavailable');})).toBe(false);
});
