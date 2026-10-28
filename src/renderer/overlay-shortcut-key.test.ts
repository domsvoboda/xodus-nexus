import {expect,it} from 'vitest';
import {overlayShortcutKey} from './overlay-shortcut-key';
const key=(patch:Partial<KeyboardEvent>={})=>overlayShortcutKey({key:'g',code:'KeyG',metaKey:true,ctrlKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,...patch});
it('records supported chords in canonical desktop order',()=>{
  expect(key()).toBe('Super+G');
  expect(key({metaKey:false,ctrlKey:true,shiftKey:true,key:'G'})).toBe('Control+Shift+G');
  expect(key({metaKey:false,shiftKey:true,key:'Tab',code:'Tab'})).toBe('Shift+Tab');
  expect(key({ctrlKey:true,shiftKey:true,key:'!',code:'Digit1'})).toBe('Super+Control+Shift+1');
  expect(key({key:'ArrowLeft',code:'ArrowLeft'})).toBe('Super+Left');
  expect(key({key:' ',code:'Space'})).toBe('Super+Space');
  expect(key({metaKey:false,key:'F10',code:'F10'})).toBe('F10');
});
it.each([{key:'Control'},{key:'AltGraph'},{key:'Dead'},{key:'Process'},{repeat:true},{isComposing:true}])('waits for a complete non-composing chord: %j',patch=>expect(key(patch)).toBeUndefined());
it.each([{metaKey:false},{key:';',code:'Semicolon'},{metaKey:false,key:'Tab',code:'Tab'}])('rejects unsupported keys or bare typing keys: %j',patch=>expect(()=>key(patch)).toThrow());
