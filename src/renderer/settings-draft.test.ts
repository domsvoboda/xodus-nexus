import {expect,it} from 'vitest';
import {demoSnapshot} from '../shared/demo-data';
import type {Settings} from '../shared/types';
import {reconcileSettingsDraft} from './settings-draft';

it('preserves the recorded shortcut and other unsaved edits through cloned status snapshots',()=>{
 const saved={...demoSnapshot().settings,overlayShortcut:'Super+G',overlaySide:'left' as const};
 const draft={...saved,overlayShortcut:'Control+Shift+H',overlaySide:'right' as const,installRoot:'/unsaved/path',shaderCacheLimitGiB:8};
 expect(reconcileSettingsDraft(draft,saved,{...saved})).toBe(draft);
 expect(reconcileSettingsDraft(draft,saved,saved)).toBe(draft);
});

it('applies changed persisted fields without overwriting unrelated drafts',()=>{
 const saved={...demoSnapshot().settings,overlayShortcut:'Super+G',overlaySide:'left' as const};
 const draft={...saved,overlayShortcut:'Control+Shift+H',installRoot:'/unsaved/path'};
 const next={...saved,overlaySide:'right' as const};
 expect(reconcileSettingsDraft(draft,saved,next)).toEqual({...draft,overlaySide:'right'});
 expect(draft.overlaySide).toBe('left');expect(saved.overlaySide).toBe('left');
});

it('acknowledges an explicit save and subsequent changes without reverting to defaults',()=>{
 const saved={...demoSnapshot().settings,overlayShortcut:'Super+G'};
 const draft={...saved,overlayShortcut:'Control+Shift+H'};
 const persisted={...draft};
 const acknowledged=reconcileSettingsDraft(draft,saved,persisted);
 expect(acknowledged).toEqual(persisted);
 expect(reconcileSettingsDraft(acknowledged,persisted,{...persisted})).toBe(acknowledged);
 expect(reconcileSettingsDraft(acknowledged,persisted,{...persisted,overlayShortcut:'Shift+Tab'}).overlayShortcut).toBe('Shift+Tab');
});

it('reflects normalized saved paths while preserving a different pending field',()=>{
 const saved=demoSnapshot().settings;
 const draft={...saved,installRoot:'/games/../new-games',overlayShortcut:'Control+Shift+H'};
 expect(reconcileSettingsDraft(draft,saved,{...saved,installRoot:'/new-games'})).toEqual({...draft,installRoot:'/new-games'});
});

it('removes deleted optional preferences without mutating any input',()=>{
 const saved={...demoSnapshot().settings,overlayShortcut:'Shift+Tab'};
 const next:Settings={...saved};delete next.overlayShortcut;
 const draft={...saved,market:'US'};
 expect(reconcileSettingsDraft(draft,saved,next)).not.toHaveProperty('overlayShortcut');
 expect(draft.overlayShortcut).toBe('Shift+Tab');expect(saved.overlayShortcut).toBe('Shift+Tab');
 expect(reconcileSettingsDraft(draft,saved,next).market).toBe('US');
});
