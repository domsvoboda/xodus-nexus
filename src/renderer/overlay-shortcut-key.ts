import {xboxOverlayShortcut} from '../shared/xbox-overlay-settings';

/** Translate a recorded chord into the same validated accelerator used by the desktop. */
export function overlayShortcutKey(event:Pick<KeyboardEvent,'key'|'code'|'metaKey'|'ctrlKey'|'altKey'|'shiftKey'|'repeat'|'isComposing'>):string|undefined {
  if(event.repeat||event.isComposing||['Meta','Super','OS','Control','Alt','AltGraph','Shift','Process','Dead','Unidentified'].includes(event.key))return;
  const modifiers=[event.metaKey&&'Super',event.ctrlKey&&'Control',event.altKey&&'Alt',event.shiftKey&&'Shift'].filter(Boolean);
  const key=/^Digit[0-9]$/.test(event.code)?event.code.slice(5):event.key===' '?'Space':event.key.replace(/^Arrow/,'');
  return xboxOverlayShortcut([...modifiers,key.length===1?key.toUpperCase():key].join('+'));
}
