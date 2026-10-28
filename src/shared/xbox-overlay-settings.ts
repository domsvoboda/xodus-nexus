import type {Settings} from './types.js';
export const defaultXboxOverlay={overlayEnabled:false,overlayShortcut:'Super+G',overlaySide:'left' as const};
export function xboxOverlayShortcut(value:unknown):string{
 if(typeof value!=='string'||value.length>80||/[\x00-\x1f\x7f]/.test(value))throw Error('Enter an overlay shortcut, such as Super+G or Shift+Tab.');
 const parts=value.split('+').map(part=>part.trim()),key=parts.pop()??'';
 const modifiers=['Super','Control','Alt','Shift'];
 if(!parts.every(part=>modifiers.includes(part))||new Set(parts).size!==parts.length
  ||!/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Tab|Space|Home|End|Insert|Delete|PageUp|PageDown|Up|Down|Left|Right)$/.test(key)
  ||!parts.length&&!/^F([1-9]|1[0-9]|2[0-4])$/.test(key))throw Error('Use a shortcut such as Super+G, Shift+Tab or Control+Shift+G.');
 return [...modifiers.filter(part=>parts.includes(part)),key].join('+');
}
export function xboxOverlaySettings(settings:Pick<Settings,'overlayEnabled'|'overlayShortcut'|'overlaySide'>){
 let overlayShortcut=defaultXboxOverlay.overlayShortcut;
 try{overlayShortcut=xboxOverlayShortcut(settings.overlayShortcut??overlayShortcut);}catch{}
 return {overlayEnabled:typeof settings.overlayEnabled==='boolean'?settings.overlayEnabled:defaultXboxOverlay.overlayEnabled,overlayShortcut,overlaySide:settings.overlaySide==='right'?'right' as const:'left' as const};
}
export function xboxOverlayPatch(patch:Partial<Settings>):Partial<Settings>{
 const result:Partial<Settings>={};
 if(patch.overlayEnabled!==undefined){if(typeof patch.overlayEnabled!=='boolean')throw Error('Invalid overlay setting.');result.overlayEnabled=patch.overlayEnabled;}
 if(patch.overlayShortcut!==undefined)result.overlayShortcut=xboxOverlayShortcut(patch.overlayShortcut);
 if(patch.overlaySide!==undefined){if(!['left','right'].includes(patch.overlaySide))throw Error('Choose the left or right overlay edge.');result.overlaySide=patch.overlaySide;}
 return result;
}
