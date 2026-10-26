import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentParentForChoice, InstallPlans, installSelection, parseInstallPlan, readInstallPlan } from './install-plan.js';

const root = '9AAAAAAAAAAA';
const contentId = '11111111-1111-4111-8111-111111111111';
const choice = { productId: root, contentId, title: 'Test game', platform: 'Windows.Desktop', packageFormat: 'MSIXVC', kind: 'Game', supported: true };
const plan = () => ({ schema: 1, rootProductId: root, market: 'US', status: 'ready', choices: [{ ...choice }] });
const parse = (value: unknown) => parseInstallPlan(JSON.stringify(value), root, 'US');
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function executable(code: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-package-plan-')); dirs.push(dir);
  const file = path.join(dir, 'cli'); await fs.writeFile(file, `#!${process.execPath}\n${code}`, { mode: 0o700 }); return file;
}
describe('package preflight protocol', () => {
  it('accepts one verified PC game and rejects a foreign Content ID', () => {
    expect(installSelection(parse(plan()))).toBe(contentId);
    expect(() => installSelection(parse(plan()), '22222222-2222-4222-8222-222222222222')).toThrow();
  });
  it('requires explicit choice for multiple games and for an add-on', () => {
    const multi = { ...plan(), status: 'choice', choices: [choice, { ...choice, contentId: '22222222-2222-4222-8222-222222222222' }] };
    expect(() => installSelection(parse(multi))).toThrow();
    expect(installSelection(parse(multi), contentId)).toBe(contentId);
    expect(() => installSelection(parse({ ...plan(), status: 'choice', choices: [{ ...choice, kind: 'GameAddOn' }] }))).toThrow();
  });
  it('accepts a scoped Durable only as an explicit choice, never as an automatic base game', () => {
    const durable={...choice,kind:'Durable',parentProductId:'9BBBBBBBBBBB',mainPackageFamilyName:'Example.Base_hash'};
    const selected=parse({...plan(),status:'choice',choices:[durable]});
    expect(()=>installSelection(selected)).toThrow();expect(installSelection(selected,contentId)).toBe(contentId);
    for(const fields of [{parentProductId:undefined},{parentProductId:'bad'},{mainPackageFamilyName:undefined},{mainPackageFamilyName:'../outside'}])
      expect(()=>parse({...plan(),status:'choice',choices:[{...durable,...fields}]})).toThrow();
  });
  it.each([
    { ...plan(), rootProductId: '9BBBBBBBBBBB' }, { ...plan(), market: 'CZ' }, { ...plan(), schema: 2 },
    { ...plan(), status: 'choice' }, { ...plan(), choices: [choice, choice] },
    { ...plan(), choices: [{ ...choice, platform: 'Xbox.One' }] },
    { ...plan(), choices: [{ ...choice, title: 'Bad\nlabel' }] },
    { ...plan(), choices: [{ ...choice, packageFormat: 'APPX' }] },
  ])('rejects mismatched or dishonest metadata %#', value => { expect(() => parse(value)).toThrow(); });
  it('cannot select an unsupported console package', () => {
    const value = parse({ ...plan(), status: 'unavailable', choices: [{ ...choice, supported: false, platform: 'Xbox.One' }] });
    expect(() => installSelection(value, contentId)).toThrow();
  });
  it('accepts optional bounded size estimates and preserves older backends without them', () => {
    expect(parse(plan()).choices[0].downloadBytes).toBeUndefined();
    const sized = {...plan(), choices:[{...choice, downloadBytes:2_069_975_040, installBytes:3_000_000_000}]};
    expect(parse(sized).choices[0]).toMatchObject({downloadBytes:2_069_975_040,installBytes:3_000_000_000});
    expect(parse({...plan(),choices:[{...choice,downloadBytes:null,installBytes:null}]}).choices[0]).toEqual(choice);
    for (const field of ['downloadBytes','installBytes']) for (const value of [-1,0,1.5,Number.MAX_SAFE_INTEGER+1,'100',true,{},[]])
      expect(()=>parse({...plan(),choices:[{...choice,[field]:value}]})).toThrow('Invalid Store package choice');
  });
  it('runs only the public command, closes stdin and preserves UTF-8', async () => {
    const value = { ...plan(), choices: [{ ...choice, title: 'Příliš žluťoučký' }] };
    const cli = await executable(`if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['resolve-package','${root}','--json','--market','US']))process.exit(2); process.stdin.on('end',()=>{const b=Buffer.from(${JSON.stringify(JSON.stringify(value))});process.stdout.write(b.subarray(0,110));process.stdout.write(b.subarray(110));});process.stdin.resume();`);
    expect(await readInstallPlan(cli, root, 'US')).toEqual(value);
  });
  it('opts in to Durable selection only when explicitly requested by the main process',async()=>{
    const cli=await executable(`if(!process.argv.includes('--include-dlc'))process.exit(2);process.stdout.write(${JSON.stringify(JSON.stringify(plan()))});`);
    expect((await readInstallPlan(cli,root,'US',true)).status).toBe('ready');
    await expect(readInstallPlan(cli,root,'US')).rejects.toThrow();
  });
  it('bounds output, checks process failure and validates inputs before execution', async () => {
    const huge = await executable('process.stdout.write("x".repeat(300000));');
    await expect(readInstallPlan(huge, root, 'US')).rejects.toThrow('too large');
    const failed = await executable('console.error("Store unavailable");process.exit(1);');
    await expect(readInstallPlan(failed, root, 'US')).rejects.toThrow('Store unavailable');
    await expect(readInstallPlan('/must-not-run', '--help', 'US')).rejects.toThrow('Product ID');
  });
});

it('routes a Durable only to its unique matching installed base, never a standalone game or another copy',()=>{
  const durable={...choice,kind:'Durable',parentProductId:'9BBBBBBBBBBB',mainPackageFamilyName:'Example.Base_hash'};
  const game={id:'parent',storeId:'9BBBBBBBBBBB',packageName:'Example.Base',installState:'ready' as const};
  expect(contentParentForChoice(durable,[game])).toBe('parent');
  expect(contentParentForChoice(choice,[])).toBeUndefined();
  for(const games of [[],[game,{...game,id:'copy'}],[{...game,storeId:root}],[{...game,packageName:'Foreign.Base'}],[{...game,installState:'incomplete' as const}]])
    expect(()=>contentParentForChoice(durable,games)).toThrow('matching base');
});
it('deduplicates public main-process preflight, clones output and scopes it to binary, market and TTL',async()=>{
  let now=0;
  const reader=vi.fn(async()=>parse(plan()));const cache=new InstallPlans(reader,()=>now);
  const [one,two]=await Promise.all([cache.get('/cli',root,'US'),cache.get('/cli',root,'US')]);
  expect(reader).toHaveBeenCalledTimes(1);one.choices[0].title='mutated';expect(two.choices[0].title).toBe('Test game');
  expect((await cache.get('/cli',root,'US')).choices[0].title).toBe('Test game');
  await cache.get('/other-cli',root,'US');await cache.get('/cli',root,'DE');expect(reader).toHaveBeenCalledTimes(3);
  now=60_000;await cache.get('/cli',root,'US');expect(reader).toHaveBeenCalledTimes(4);
  await cache.get('/cli',root,'US',true);expect(reader).toHaveBeenCalledTimes(5);
});
it('does not cache failed preflight or execute invalid input',async()=>{
  let fail=true;const reader=vi.fn(async()=>{if(fail)throw Error('failure');return parse(plan());});const cache=new InstallPlans(reader);
  await expect(cache.get('/cli',root,'US')).rejects.toThrow('failure');fail=false;
  expect((await cache.get('/cli',root,'US')).status).toBe('ready');expect(reader).toHaveBeenCalledTimes(2);
  await expect(cache.get('/cli','../outside','US')).rejects.toThrow('scope');expect(reader).toHaveBeenCalledTimes(2);
});
