import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountLibrary, entitlementKind, parseEntitlements } from './account-library.js';
import { CatalogService } from './catalog.js';
import type { CatalogProduct } from '../shared/types.js';

const A='9AAAAAAAAAAA', B='9BBBBBBBBBBB', C='9CCCCCCCCCCC';
const row=(productId=A, extra={})=>({productId,status:'Active',isTrial:false,sharingSource:'None',endDate:'2099-01-01T00:00:00Z',special:false,...extra});
const output=(entries=[row()],account='one@example.test',market='US')=>JSON.stringify({schema:1,account,market,checkedAt:new Date().toISOString(),entitlements:entries});
const product=(productId:string):CatalogProduct=>({productId,title:productId,description:'',categories:[],installability:'supported',supportNote:''});

it('ranks genuine Game Pass licenses before paging and never imports unlicensed or owned collection entries (#202)',async()=>{
 const ids=Array.from({length:65},(_,i)=>`9${String(i).padStart(11,'0')}`),owned='9OWNEDOWNED1',foreign='9FOREIGN0001';
 const reader=vi.fn(async()=>output([...ids.map(id=>row(id,{satisfiedByProductId:'CFQ7TTC0KGQ8'})),row(owned)]));
 const recent=vi.fn(async()=>[foreign,ids[64],owned,ids[63]]);
 const catalog=vi.fn(async(ids:string[])=>ids.slice().reverse().map(product));
 const library=new AccountLibrary(catalog,reader,recent);library.select('one@example.test','/backend','US');
 const first=await library.get('gamepass',undefined,false,'recent-gamepass');
 expect(first.products.slice(0,2).map(p=>p.productId)).toEqual([ids[64],ids[63]]);
 expect(first.recentProductIds).toEqual([ids[64],ids[63]]);expect(first.products).toHaveLength(60);
 expect(first.accessByProductId[foreign]).toBeUndefined();expect(first.products.some(p=>p.productId===owned)).toBe(false);
 const next=await library.get('gamepass',first.cursor,false,'recent-gamepass');
 expect([...first.products,...next.products].map(p=>p.productId).sort()).toEqual(ids);
 expect(recent).toHaveBeenCalledOnce();expect(reader).toHaveBeenCalledOnce();
 await expect(library.get('gamepass',first.cursor)).rejects.toThrow('Invalid');
 const normal=await library.get('gamepass');await expect(library.get('gamepass',normal.cursor,false,'recent-gamepass')).rejects.toThrow('Invalid');
});

it('keeps default requests independent of the public feed and rejects unsupported order before account reads',async()=>{
 const reader=vi.fn(async()=>output([row(A,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]));
 const recent=vi.fn(async()=>[A]);const library=new AccountLibrary(async ids=>ids.map(product),reader,recent);
 library.select('one@example.test','/backend','US');
 await expect(library.get('owned',undefined,false,'recent-gamepass')).rejects.toThrow('Invalid library order');
 await expect(library.get('gamepass',undefined,false,'foreign' as never)).rejects.toThrow('Invalid library order');
 expect(reader).not.toHaveBeenCalled();expect(recent).not.toHaveBeenCalled();
 for(const kind of ['all','owned','gamepass','other'] as const)await library.get(kind);
 expect(recent).not.toHaveBeenCalled();expect(reader).toHaveBeenCalledOnce();
});
it('freezes public rank per snapshot, separates page caches and refreshes without changing access',async()=>{
 let ranking=[B,A];const recent=vi.fn(async()=>ranking);
 const library=new AccountLibrary(async ids=>ids.map(product),async()=>output([row(A,{satisfiedByProductId:'CFQ7TTC0KGQ8'}),row(B,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]),recent);
 library.select('one@example.test','/backend','US');
 expect((await library.get('gamepass')).products.map(p=>p.productId)).toEqual([A,B]);
 const ranked=await library.get('gamepass',undefined,false,'recent-gamepass');expect(ranked.products.map(p=>p.productId)).toEqual([B,A]);
 ranked.recentProductIds!.reverse();ranking=[A,B];
 expect((await library.get('gamepass',undefined,false,'recent-gamepass')).products.map(p=>p.productId)).toEqual([B,A]);
 expect((await library.get('gamepass')).products.map(p=>p.productId)).toEqual([A,B]);
 expect((await library.get('gamepass',undefined,true,'recent-gamepass')).products.map(p=>p.productId)).toEqual([A,B]);
 expect(recent).toHaveBeenCalledTimes(2);expect((await library.access()).accessByProductId).toEqual({[A]:'gamepass',[B]:'gamepass'});
});
it('rejects late ranks after account changes and does not cache malformed public feeds',async()=>{
 let finish!:(ids:string[])=>void;
 const recent=vi.fn(()=>new Promise<string[]>(resolve=>{finish=resolve;}));
 const library=new AccountLibrary(async ids=>ids.map(product),async()=>output([row(A,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]),recent);
 library.select('one@example.test','/backend','US');const job=library.get('gamepass',undefined,false,'recent-gamepass');
 const rejected=expect(job).rejects.toThrow('changed');await vi.waitFor(()=>expect(recent).toHaveBeenCalledOnce());
 library.select('other@example.test','/backend','US');finish([A]);await rejected;
 expect(library.peekAccess()).toEqual({});
 for(const value of [[A,A],['foreign'],Array(1001).fill(A),null]){
  let fail=true;const feed=vi.fn(async()=>{if(fail)return value as string[];return [A];});
  const separate=new AccountLibrary(async ids=>ids.map(product),async()=>output([row(A,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]),feed);
  separate.select('one@example.test','/backend','US');
  await expect(separate.get('gamepass',undefined,false,'recent-gamepass')).rejects.toThrow('recently added list');
  fail=false;expect((await separate.get('gamepass',undefined,false,'recent-gamepass')).products[0].productId).toBe(A);
  expect(feed).toHaveBeenCalledTimes(2);
 }
});

it('shows explicit disc-to-digital access in All and Owned without an unknown-source warning', async () => {
  const reader = vi.fn(async () => output([row(A, { special: true, isPositron: true }), row(B)]));
  const library = new AccountLibrary(async ids => ids.map(product), reader);
  library.select('one@example.test', '/not-executed', 'US');
  const all = await library.get('all');
  expect(all.products.find(p => p.productId === A)).toMatchObject({ access: 'owned' });
  expect(all.excludedEntitlements).toBe(0);
  expect(all.unclassifiedEntitlements).toBe(0);
  expect((await library.get('other')).products).toEqual([]);
  expect((await library.get('owned')).products.map(p => p.productId)).toEqual([A, B]);
  expect((await library.get('gamepass')).products).toEqual([]);
  expect(library.peekAccess()).toEqual({ [A]: 'owned', [B]: 'owned' });
  expect(reader).toHaveBeenCalledTimes(1);
});

it('propagates conditional access through valid parents without bypassing chain restrictions', () => {
  const conditional = { special: true, isPositron: true };
  const kind = (rows: ReturnType<typeof row>[]) => entitlementKind(A, parseEntitlements(output(rows), 'one@example.test', 'US').entries);
  expect(kind([row(A), row(B, conditional)])).toBe('owned');
  expect(kind([row(A, { satisfiedByProductId: B }), row(B, conditional)])).toBe('owned');
  expect(kind([row(A, { ...conditional, satisfiedByProductId: B }), row(B)])).toBe('owned');
  expect(kind([row(A, { ...conditional, satisfiedByProductId: 'CFQ7TTC0KGQ8' })])).toBe('owned');
  expect(kind([row(A, { ...conditional, satisfiedByProductId: B })])).toBe('owned');
  for (const invalid of [{ status: 'Revoked' }, { isTrial: true }, { sharingSource: 'Family' }, { endDate: '2000-01-01T00:00:00Z' }]) {
    expect(kind([row(A, { ...conditional, ...invalid })])).toBeUndefined();
    expect(kind([row(A, { satisfiedByProductId: B }), row(B, { ...conditional, ...invalid })])).toBeUndefined();
    expect(kind([row(A, { ...conditional, satisfiedByProductId: B }), row(B, invalid)])).toBeUndefined();
  }
  expect(kind([row(A, { ...conditional, satisfiedByProductId: B }), row(B, { special: true })])).toBeUndefined();
  expect(kind([row(A, { ...conditional, satisfiedByProductId: B }), row(B, { satisfiedByProductId: A })])).toBeUndefined();
});

it('never upgrades legacy special rows or malformed and contradictory Positron provenance', () => {
  for (const extra of [{ special: true }, { special: true, isPositron: false }]) {
    const parsed = parseEntitlements(output([row(A, extra)]), 'one@example.test', 'US');
    expect(entitlementKind(A, parsed.entries)).toBeUndefined();
  }
  for (const extra of [{ special: true, isPositron: 'true' }, { special: true, isPositron: null },
    { special: true, isPositron: 1 }, { special: false, isPositron: true }]) {
    const parsed = parseEntitlements(output([row(A, extra), row(B, { satisfiedByProductId: A }), row(C)]), 'one@example.test', 'US');
    expect([...parsed.entries.keys()]).toEqual([C]);
    expect(parsed.skipped).toBe(2);
  }
  const ordinary = parseEntitlements(output([row(A, { isPositron: false })]), 'one@example.test', 'US');
  expect(entitlementKind(A, ordinary.entries)).toBe('owned');
});

it('bounds conditional chains and quarantines malformed conditional parents rather than recovering access', () => {
  const conditional = { special: true, isPositron: true };
  const deep = Array.from({ length: 17 }, (_, i) => row(String(i).padStart(12, '0'), {
    ...(i === 0 ? conditional : {}), ...(i < 16 ? { satisfiedByProductId: String(i + 1).padStart(12, '0') } : {}),
  }));
  expect(entitlementKind(deep[0].productId, parseEntitlements(output(deep), 'one@example.test', 'US').entries)).toBeUndefined();
  const bad = parseEntitlements(output([row(A, { ...conditional, satisfiedByProductId: B }), row(B, { endDate: undefined }), row(C)]), 'one@example.test', 'US');
  expect([...bad.entries.keys()]).toEqual([C]);
  expect(bad.skipped).toBe(2);
});

it('rechecks conditional access after expiry, revocation or account change and paginates it in All', async () => {
  let status = 'Active';
  const rows = Array.from({ length: 61 }, (_, i) => row(String(i).padStart(12, '0'), { special: true, isPositron: true }));
  const reader = vi.fn(async () => output(rows.map(entry => ({ ...entry, status }))));
  const library = new AccountLibrary(async ids => ids.map(product), reader);
  library.select('one@example.test', '/not-executed', 'US');
  const first = await library.get('all');
  expect(first.products).toHaveLength(60);
  expect((await library.get('all', first.cursor)).products).toHaveLength(1);
  expect((await library.get('other')).products).toEqual([]);
  const owned = await library.get('owned');
  expect(owned.products).toHaveLength(60);
  expect((await library.get('owned', owned.cursor)).products).toHaveLength(1);
  status = 'Revoked';
  expect((await library.get('all', undefined, true)).products).toEqual([]);
  expect(library.peekAccess()).toEqual({});
  status = 'Active';
  await library.get('all', undefined, true);
  vi.useFakeTimers();
  try { vi.setSystemTime(Date.parse('2100-01-01T00:00:00Z')); expect(library.peekAccess()).toEqual({}); }
  finally { vi.useRealTimers(); }
  library.select('two@example.test', '/not-executed', 'US');
  await expect(library.get('all')).rejects.toThrow('Invalid account library response');
  expect(library.peekAccess()).toEqual({});
});

it('keeps conditional PC games visible through the real catalog path without inventing support or including DLC', async () => {
  const record = (productId: string, type: string, format: string) => ({ ProductId: productId, ProductType: type,
    LocalizedProperties: [{ ProductTitle: productId }], DisplaySkuAvailabilities: [{ Sku: { Properties: {
      Packages: [{ PackageFormat: format, PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }] }],
    } } }] });
  const service = new CatalogService((async () => new Response(JSON.stringify({ Products: [
    record(A, 'Game', 'MSIXVC'), record(B, 'Game', 'EAppxBundle'), record(C, 'Durable', 'MSIXVC'),
  ] }))) as typeof fetch);
  const library = new AccountLibrary((ids, market) => service.licensedProducts(ids, market), async () => output([
    row(A, { special: true, isPositron: true }), row(B, { special: true, isPositron: true }), row(C, { special: true, isPositron: true }),
  ]));
  library.select('one@example.test', '/not-executed', 'US');
  const products = (await library.get('all')).products;
  expect(products).toHaveLength(2);
  expect(products.find(p => p.productId === A)).toMatchObject({ access: 'owned', installability: 'supported' });
  expect(products.find(p => p.productId === B)).toMatchObject({ access: 'owned', installability: 'unsupported' });
  expect((await library.get('owned')).products).toHaveLength(2);
  expect((await library.get('other')).products).toEqual([]);
});

it('provides account-bound fresh in-memory discovery hints without starting reads or reusing stale rights', async () => {
  const reader=vi.fn(async()=>output([row(),row(B,{satisfiedByProductId:'9ZZZZZZZZZZZ'}),row(C,{isTrial:true})]));
  const library=new AccountLibrary(async ids=>ids.map(product),reader);
  library.select('one@example.test','/backend','US');
  expect(library.peekAccess()).toEqual({});expect(reader).not.toHaveBeenCalled();
  await library.access(); const cached=library.peekAccess();
  expect(cached).toEqual({[A]:'owned',[B]:'other'}); cached[A]='gamepass';
  expect(library.peekAccess()[A]).toBe('owned');expect(reader).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  try { vi.setSystemTime(Date.now()+300_001);expect(library.peekAccess()).toEqual({});expect(reader).toHaveBeenCalledTimes(1); }
  finally {vi.useRealTimers();}
  library.select('different@example.test','/backend','US');expect(library.peekAccess()).toEqual({});
  library.select(undefined,undefined,'US');expect(library.peekAccess()).toEqual({});
});

it('keeps unsupported and unknown owned games separate from Game Pass without exposing add-ons or unlicensed products', async () => {
  const D = '9DDDDDDDDDDD', E = '9EEEEEEEEEEE', F = '9FFFFFFFFFFF';
  const record = (productId: string, kind = 'Game', format = 'MSIXVC') => ({ ProductId: productId, ProductType: kind,
    LocalizedProperties: [{ ProductTitle: productId }], DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [{ PackageFormat: format, PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }] }] } } }] });
  const records = [record(A, 'Game', 'EAppxBundle'), record(B), record(C, 'Game', 'APPX'), record(D, 'Durable'),
    { ProductId: E, ProductType: 'Game', LocalizedProperties: [{ ProductTitle: 'Incomplete edition' }], DisplaySkuAvailabilities: [{ Sku: { Properties: { BundledSkus: [{ BigId: F }] } } }] }, record('9UNLICENSED0')];
  const service = new CatalogService((async () => new Response(JSON.stringify({ Products: records }))) as typeof fetch);
  const library = new AccountLibrary((ids, market) => service.licensedProducts(ids, market), async () => output([
    row(A), row(B), row(C, { satisfiedByProductId: 'CFQ7TTC0KGQ8' }), row(D), row(E),
  ]));
  library.select('one@example.test', '/not-executed', 'US');
  const owned = (await library.get('owned')).products;
  expect(owned.map(p => p.productId).sort()).toEqual([A, B, E]);
  expect(owned.find(p => p.productId === A)).toMatchObject({ access: 'owned', installability: 'unsupported' });
  expect(owned.find(p => p.productId === E)).toMatchObject({ access: 'owned', installability: 'unknown' });
  expect((await library.get('gamepass')).products).toMatchObject([{ productId: C, access: 'gamepass', installability: 'unsupported' }]);
  expect((await library.get('all')).products).toHaveLength(4);
});

it.each(['network', 'http', 'json', 'shape'])('does not cache a %s catalog failure as an empty successful library', async failure => {
  let healthy = false;
  const fetcher = vi.fn(async () => {
    if (!healthy) {
      if (failure === 'network') throw Error('private signed URL must not appear');
      if (failure === 'http') return new Response('', { status: 503 });
      if (failure === 'json') return new Response('{');
      return new Response('{}');
    }
    return new Response(JSON.stringify({ Products: [{ ProductId: A, ProductType: 'Game',
      LocalizedProperties: [{ ProductTitle: 'A game' }],
      DisplaySkuAvailabilities: [{ Sku: { Properties: { Packages: [{ PackageFormat: 'MSIXVC', PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }] }] } } }],
    }] }));
  });
  const catalog = new CatalogService(fetcher as typeof fetch);
  const library = new AccountLibrary((ids, market) => catalog.licensedProducts(ids, market), async () => output());
  library.select('one@example.test', '/backend', 'US');
  await expect(library.get('all')).rejects.toThrow('game details could not be loaded');
  expect((await library.access()).accessByProductId[A]).toBe('owned');
  healthy = true;
  expect((await library.get('all')).products.map(entry => entry.productId)).toEqual([A]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('maps real failed child processes to safe session guidance and recovers on a later refresh', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-session-reader-'));
  const binary = path.join(directory, 'backend');
  const catalog = vi.fn(async (ids: string[]) => ids.map(product));
  const library = new AccountLibrary(catalog); library.select('one@example.test', binary, 'US');
  const fixture = async (stdout: string, stderr: string, code: number) => fs.writeFile(binary,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${code});\n`, { mode: 0o700 });
  try {
    for (const [stage, message] of [['session-user-expired', 'Sign in again'], ['ticket-timeout', 'timed out'], ['session-device-refresh-failed', 'could not be renewed'], ['ticket-response-parse', 'unreadable response'], ['ticket-interaction-required', 'interactive sign-in']]) {
      await fixture('', `private@example.test raw-secret\nNEXUS_SESSION_DIAGNOSTIC_V1 ${stage}\n`, 1);
      const failure = await library.get('all').catch(error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(message);
      expect((failure as Error).message).not.toMatch(/example\.test|raw-secret/);
    }
    expect(catalog).not.toHaveBeenCalled();
    await fixture('', 'private-secret\nNEXUS_TICKET_DIAGNOSTIC_V1 ticket-refused 800488AB\n', 1);
    await expect(library.get('all')).rejects.toThrow('Microsoft refused the stored sign-in (code 0x800488AB)');
    await fixture('NEXUS_SESSION_DIAGNOSTIC_V1 session-user-expired\n', 'untrusted error\n', 1);
    await expect(library.get('all')).rejects.toThrow('licenses could not be loaded');
    await fixture('', 'NEXUS_SESSION_DIAGNOSTIC_V1 ticket-timeout\nNEXUS_SESSION_DIAGNOSTIC_V1 ticket-response-received\nentitlement failure private-secret\n', 1);
    await expect(library.get('all')).rejects.toThrow('licenses could not be loaded');
    const response = output() + '\n'; const middle = Math.floor(response.length / 2);
    await fs.writeFile(binary, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(response.slice(0, middle))});setTimeout(()=>{process.stderr.write('NEXUS_SESSION_DIAGNOSTIC_V1 ticket-response-received\\n');setTimeout(()=>process.stdout.write(${JSON.stringify(response.slice(middle))}),20)},20);\n`, { mode: 0o700 });
    expect((await library.get('all', undefined, true)).products.map(item => item.productId)).toEqual([A]);
    expect(catalog).toHaveBeenCalledTimes(1);
  } finally { library.reset(); await fs.rm(directory, { recursive: true, force: true }); }
});

it('provides fresh access for content planning without loading unrelated catalog products', async () => {
  const catalog=vi.fn(async (ids:string[])=>ids.map(product));
  const reader=vi.fn(async()=>output([row(),row(B,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]));
  const library=new AccountLibrary(catalog,reader); library.select('one@example.test','/backend','US');
  expect((await library.access(true)).accessByProductId).toEqual({[A]:'owned',[B]:'gamepass'});
  expect(catalog).not.toHaveBeenCalled(); expect(reader).toHaveBeenCalledTimes(1);
  await library.access(true); expect(reader).toHaveBeenCalledTimes(2);
  library.select(undefined,undefined,'US'); await expect(library.access()).rejects.toThrow('Sign in');
});

it('distinguishes owned bundles and Game Pass from active access whose source is unknown',()=>{
  const {entries}=parseEntitlements(output([row(),row(B,{satisfiedByProductId:A}),row(C,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]),'one@example.test','US');
  expect(entitlementKind(A,entries)).toBe('owned');
  expect(entitlementKind(B,entries)).toBe('owned');
  expect(entitlementKind(C,entries)).toBe('gamepass');
  entries.delete(A); expect(entitlementKind(B,entries)).toBe('other');
  entries.set(A,row(A,{satisfiedByProductId:B})); expect(entitlementKind(B,entries)).toBeUndefined();
});

it.each(['CFQ7TTBZT8LN', 'CFQ7TTC0K5DH', '9UNKNOWNROOT'])('keeps a valid child of missing parent %s visible without claiming ownership', async parent => {
  const library = new AccountLibrary(async ids => ids.map(product), async () => output([row(A, { satisfiedByProductId: parent })]));
  library.select('one@example.test', '/not-executed', 'US');
  const all = await library.get('all');
  expect(all.products).toMatchObject([{ productId: A, access: 'other' }]);
  expect(all.skippedEntitlements).toBe(0);
  expect(all.unclassifiedEntitlements).toBe(1);
  expect((await library.get('owned')).products).toEqual([]);
  expect((await library.get('gamepass')).products).toEqual([]);
  expect((await library.get('other')).products).toHaveLength(1);
  expect((await library.access()).accessByProductId).toEqual({ [A]: 'other' });
});

it('does not bypass an explicitly expired, revoked, shared, trial or special subscription parent', () => {
  const parent = 'CFQ7TTC0KGQ8';
  for (const extra of [{ isTrial: true }, { special: true }, { status: 'Revoked' }, { endDate: '2000-01-01T00:00:00Z' }, { sharingSource: 'Family' }]) {
    const parsed = parseEntitlements(output([row(A, { satisfiedByProductId: parent }), row(parent, extra)]), 'one@example.test', 'US');
    expect(entitlementKind(A, parsed.entries)).toBeUndefined();
  }
});

it('reports policy exclusions separately and never recovers broken chains as other access', async () => {
  const D = '9DDDDDDDDDDD';
  const library = new AccountLibrary(async ids => ids.map(product), async () => output([
    row(A, { special: true }), row(B, { satisfiedByProductId: C }), row(C, { satisfiedByProductId: B }), row(D),
  ]));
  library.select('one@example.test', '/not-executed', 'US');
  const result = await library.get('all');
  expect(result.products.map(p => p.productId)).toEqual([D]);
  expect(result.excludedEntitlements).toBe(3);
  expect(result.unclassifiedEntitlements).toBe(0);
});

it('keeps other-access pagination, account binding and expiration gates intact', async () => {
  const entries = Array.from({ length: 61 }, (_, i) => row(String(i).padStart(12, '0'), { satisfiedByProductId: 'CFQ7TTBZT8LN' }));
  const library = new AccountLibrary(async ids => ids.map(product), async () => output(entries));
  library.select('one@example.test', '/not-executed', 'US');
  const first = await library.get('other');
  expect(first.products).toHaveLength(60);
  expect((await library.get('other', first.cursor)).products).toHaveLength(1);
  await expect(library.get('all', first.cursor)).rejects.toThrow();
  library.select(undefined, undefined, 'US');
  await expect(library.get('other', first.cursor)).rejects.toThrow('Sign in');
  const { entries: parsed } = parseEntitlements(output(entries), 'one@example.test', 'US');
  expect(entitlementKind(entries[0].productId, parsed, Date.parse('2100-01-01T00:00:00Z'))).toBeUndefined();
});

it('never labels expired, trial, special, revoked or shared entitlements as owned',()=>{
  for(const extra of [{isTrial:true},{special:true},{status:'Revoked'},{endDate:'2000-01-01T00:00:00Z'},{sharingSource:'Family'}]) {
    const {entries}=parseEntitlements(output([row(A,extra)]),'one@example.test','US');
    expect(entitlementKind(A,entries)).toBeUndefined();
  }
  expect(entitlementKind('CFQ7TTC0KGQ8',new Map([['CFQ7TTC0KGQ8',row('CFQ7TTC0KGQ8')]]))).toBeUndefined();
});

it('rejects foreign identities/market and stale or malformed protocol envelopes',()=>{
  for(const text of [output([row()],'other'),output([row()],'one@example.test','CZ'), 'null',
    JSON.stringify({...JSON.parse(output()),entitlements:{}}), JSON.stringify({...JSON.parse(output()),checkedAt:'2000-01-01T00:00:00Z'})]) {
    expect(()=>parseEntitlements(text,'one@example.test','US')).toThrow();
  }
});

it('omits malformed and duplicate rows plus their dependent children without hiding independent games',()=>{
  const result = parseEntitlements(output([row(),row(B,{isTrial:undefined}),row(C,{satisfiedByProductId:B}),row('invalid')]),'one@example.test','US');
  expect([...result.entries.keys()]).toEqual([A]); expect(result.skipped).toBe(3);
  for (const rows of [[row(A), row(A)], [row(A), row(A,{isTrial:true})], [row(A),row(A,{status:undefined})]]) {
    const parsed = parseEntitlements(output([...rows,row(B,{satisfiedByProductId:A}),row(C)]),'one@example.test','US');
    expect([...parsed.entries.keys()]).toEqual([C]); expect(parsed.skipped).toBe(3);
  }
});

it('never defaults missing policy fields into ownership or trusts an invalid subscription parent',()=>{
  for (const extra of [{isTrial:undefined}, {special:undefined}, {sharingSource:undefined}, {endDate:undefined}, {endDate:'invalid'}, {satisfiedByProductId:'bad'}]) {
    const parsed = parseEntitlements(output([row(A,extra),row(B)]),'one@example.test','US');
    expect([...parsed.entries.keys()]).toEqual([B]); expect(parsed.skipped).toBe(1);
  }
  const parsed = parseEntitlements(output([row('CFQ7TTC0KGQ8',{endDate:undefined}),row(A,{satisfiedByProductId:'CFQ7TTC0KGQ8'}),row(B)]),'one@example.test','US');
  expect([...parsed.entries.keys()]).toEqual([B]);
});

it('exposes a partial-result count on all filters and content access remains limited to valid records',async()=>{
  const text=JSON.stringify({...JSON.parse(output([row(),row(B,{endDate:undefined})])),skippedEntitlements:2});
  const library=new AccountLibrary(async ids=>ids.map(product),async()=>text); library.select('one@example.test','/backend','US');
  for(const kind of ['all','owned','gamepass'] as const) expect((await library.get(kind)).skippedEntitlements).toBe(3);
  expect((await library.access()).accessByProductId).toEqual({[A]:'owned'});
});

it('loads all/owned/Game Pass using one account read and caches only bound pages in memory',async()=>{
  const reader=vi.fn(async()=>output([row(),row(B,{satisfiedByProductId:'CFQ7TTC0KGQ8'})]));
  const catalog=vi.fn(async(ids:string[])=>ids.map(product));
  const library=new AccountLibrary(catalog,reader); library.select('one@example.test','/backend','neutral');
  const all=await library.get('all'); expect(all.products.map(p=>p.access)).toEqual(['owned','gamepass']);
  expect((await library.get('owned')).products.map(p=>p.productId)).toEqual([A]);
  expect((await library.get('gamepass')).products.map(p=>p.productId)).toEqual([B]);
  expect(reader).toHaveBeenCalledTimes(1);
  await library.get('all'); expect(catalog).toHaveBeenCalledTimes(3);
  library.select(undefined,'/backend','US'); await expect(library.get('all')).rejects.toThrow('Sign in');
});

it('does not publish a late response after an account switch',async()=>{
  let finish!:(value:string)=>void;
  const library=new AccountLibrary(async ids=>ids.map(product),()=>new Promise(resolve=>{finish=resolve;}));
  library.select('one@example.test','/backend','US');
  const request=library.get('all'); const rejected=expect(request).rejects.toThrow('changed');
  library.select('two@example.test','/backend','US'); finish(output()); await rejected;
});

it('binds pagination to snapshot and filter, rather than accepting arbitrary product IDs',async()=>{
  const entries=Array.from({length:61},(_,i)=>row(String(i).padStart(12,'0')));
  const library=new AccountLibrary(async ids=>ids.map(product),async()=>output(entries));
  library.select('one@example.test','/backend','US');
  const first=await library.get('all'); expect(first.products).toHaveLength(60); expect(first.cursor).toBeTruthy();
  const last=await library.get('all',first.cursor); expect(last.products).toHaveLength(1); expect(last.cursor).toBeUndefined();
  await expect(library.get('owned',first.cursor)).rejects.toThrow('Invalid');
  await library.get('all',undefined,true); await expect(library.get('all',first.cursor)).rejects.toThrow('expired');
});

it('loads owned access for a launch while it prepares, waits only briefly and never throws', async () => {
  // Signed out: nothing to read.
  const idle = new AccountLibrary(async ids => ids.map(product), vi.fn());
  expect(await idle.startLaunchAccess()(10)).toEqual({});

  // Not cached: the read starts at once and its result is used when it arrives in time.
  let finish!: (text: string) => void;
  const reader = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const library = new AccountLibrary(async ids => ids.map(product), reader);
  library.select('one@example.test', '/backend', 'US');
  const read = library.startLaunchAccess();
  expect(reader).toHaveBeenCalledOnce();
  setTimeout(() => finish(output([row(), row(B, { satisfiedByProductId: '9ZZZZZZZZZZZ' })])), 5);
  expect(await read(1_000)).toEqual({ [A]: 'owned', [B]: 'other' });

  // Fresh cache: answered from memory without another read.
  expect(await library.startLaunchAccess()(0)).toEqual({ [A]: 'owned', [B]: 'other' });
  expect(reader).toHaveBeenCalledOnce();

  // A slow read: the launch goes on with what is cached (nothing) and the read keeps going for later.
  const slowReader = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const slow = new AccountLibrary(async ids => ids.map(product), slowReader);
  slow.select('one@example.test', '/backend', 'US');
  expect(await slow.startLaunchAccess()(5)).toEqual({});
  finish(output());
  await vi.waitFor(() => expect(slow.peekAccess()).toEqual({ [A]: 'owned' }));

  // A failed read is no launch error.
  const failing = new AccountLibrary(async ids => ids.map(product), vi.fn(async () => { throw Error('offline'); }));
  failing.select('one@example.test', '/backend', 'US');
  expect(await failing.startLaunchAccess()(1_000)).toEqual({});
});
