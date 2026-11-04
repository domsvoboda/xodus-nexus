import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {expect,it} from 'vitest';
import type {Game} from '../shared/types.js';
import {newInstallationTime} from './install-time.js';
import {StateStore} from './store.js';

const game=(patch:Partial<Game>={}):Game=>({id:'fixture',title:'Fixture',path:'/games/fixture',installState:'ready',addedAt:'2025-01-01T00:00:00.000Z',...patch});

it('records completion only for a genuinely new successful installation',()=>{
 expect(newInstallationTime(undefined,'complete','ready','2026-11-04T10:00:00.000Z')).toBe('2026-11-04T10:00:00.000Z');
 expect(newInstallationTime(undefined,'complete','imported','2026-11-04T10:00:00.000Z')).toBeUndefined();
 expect(newInstallationTime(undefined,'complete','incomplete','2026-11-04T10:00:00.000Z')).toBeUndefined();
 expect(newInstallationTime(undefined,'failed','ready','2026-11-04T10:00:00.000Z')).toBeUndefined();
 expect(newInstallationTime(undefined,'paused','ready','2026-11-04T10:00:00.000Z')).toBeUndefined();
 expect(newInstallationTime(undefined,'complete','ready',undefined)).toBeUndefined();
 expect(newInstallationTime(undefined,'complete','ready','not a date')).toBeUndefined();
});

it('never replaces an existing or unknown installation timestamp on repair, update or import',async()=>{
 const existing=game({installedAt:'2026-10-01T09:00:00.000Z'});
 expect(newInstallationTime(existing,'complete','ready','2026-11-04T10:00:00.000Z')).toBeUndefined();
 const directory=await mkdtemp(path.join(tmpdir(),'nexus-install-time-'));
 try{
  const store=new StateStore(directory);await store.load();
  await store.upsertGame(game());
  const legacy=new StateStore(directory);await legacy.load();
  expect(legacy.games[0].installedAt).toBeUndefined();
  expect(legacy.games[0].addedAt).toBe('2025-01-01T00:00:00.000Z');
  await legacy.patchGame('fixture',{installState:'ready'});
  const reopened=new StateStore(directory);await reopened.load();
  expect(reopened.games[0].installedAt).toBeUndefined();
  expect(reopened.games[0].addedAt).toBe('2025-01-01T00:00:00.000Z');
  await reopened.upsertGame(game({installedAt:'2026-11-04T10:00:00.000Z'}));
  const installed=new StateStore(directory);await installed.load();
  expect(installed.games[0].installedAt).toBe('2026-11-04T10:00:00.000Z');
 }finally{await rm(directory,{recursive:true,force:true});}
});
