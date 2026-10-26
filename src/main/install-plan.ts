import { spawn } from 'node:child_process';
import type { Game, InstallChoice, InstallPlan } from '../shared/types.js';
import { externalLauncherEnvironment } from './launcher-environment.js';
import { observeBackendChild } from './backend-diagnostics.js';

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Z0-9]{12}$/.test(value);
const cid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
const family = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9.-]+_[A-Za-z0-9]+$/.test(value) && value.length <= 200;

export function parseInstallPlan(output: string, productId: string, market: string): InstallPlan {
  if (Buffer.byteLength(output) > 256_000) throw Error('Store package response is too large.');
  const plan = JSON.parse(output);
  if (plan?.schema !== 1 || plan.rootProductId !== productId || plan.market !== market
    || !['ready', 'choice', 'unavailable'].includes(plan.status) || !Array.isArray(plan.choices) || plan.choices.length > 128) throw Error('Invalid Store package response.');
  const seen = new Set<string>();
  for (const item of plan.choices) {
    if (!item || !id(item.productId) || !cid(item.contentId) || !label(item.title) || !item.title
      || !label(item.platform) || !label(item.packageFormat) || !label(item.kind) || typeof item.supported !== 'boolean'
      || (item.parentProductId != null && !id(item.parentProductId)) || (item.mainPackageFamilyName != null && !family(item.mainPackageFamilyName))
      || [item.downloadBytes, item.installBytes].some(value => value != null && (!Number.isSafeInteger(value) || value <= 0))
      || (item.supported && (item.platform !== 'Windows.Desktop' || item.packageFormat !== 'MSIXVC' || !['Game', 'GameAddOn', 'Durable'].includes(item.kind)))
      || (item.supported && item.kind === 'Durable' && (!id(item.parentProductId) || item.parentProductId === item.productId || !family(item.mainPackageFamilyName)))) throw Error('Invalid Store package choice.');
    const key = item.contentId;
    if (seen.has(key)) throw Error('Duplicate Store package choice.');
    seen.add(key);
  }
  // Size fields are advisory and optional for older compatible backends.
  for (const item of plan.choices) {
    if (item.downloadBytes === null) delete item.downloadBytes;
    if (item.installBytes === null) delete item.installBytes;
  }
  const supported = plan.choices.filter((item: InstallPlan['choices'][number]) => item.supported);
  const status = supported.length === 1 && supported[0].kind === 'Game' ? 'ready' : supported.length ? 'choice' : 'unavailable';
  if (status !== plan.status) throw Error('Inconsistent Store package response.');
  return plan as InstallPlan;
}

/** Public metadata subprocess, no account/sign-in commands and no stdin dialogue. */
export async function readInstallPlan(binary: string, productId: string, market: string, includeDlc = false): Promise<InstallPlan> {
  if (!id(productId) || !/^[A-Z]{2}$/.test(market)) throw Error('Enter a valid 12-character Store Product ID.');
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['resolve-package', productId, '--json', '--market', market, ...(includeDlc ? ['--include-dlc'] : [])], { env: externalLauncherEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    observeBackendChild(child, 'resolve-package');
    let stderr = '', bytes = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure = Error('Store package lookup timed out. Try again later.'); child.kill('SIGKILL'); }, 40_000);
    timer.unref();
    const consume = (chunk: Buffer, out: boolean) => {
      bytes += chunk.length;
      if (bytes > 256_000) { failure = Error('Store package response is too large.'); child.kill('SIGKILL'); return; }
      if (!out) stderr += chunk.toString('utf8');
    };
    // Decode after collection so a split UTF-8 character is never corrupted.
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { consume(chunk, true); if (!failure) chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(Error(`Store packages could not be resolved. ${stderr.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(-300)}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  return parseInstallPlan(output, productId, market);
}

export function installSelection(plan: InstallPlan, selected?: string): string {
  if (selected === undefined && plan.status === 'ready') return plan.choices.find(item => item.supported)!.contentId;
  if (typeof selected !== 'string' || !cid(selected) || plan.choices.filter(item => item.supported && item.contentId === selected).length !== 1) {
    throw Error('Choose a supported package from this Store offer before installing.');
  }
  return selected;
}

/** Reuse the main-process public preflight, never renderer-supplied package metadata. */
export class InstallPlans {
  private entries = new Map<string, { until: number; promise: Promise<InstallPlan> }>();
  constructor(private reader = readInstallPlan, private now = Date.now) {}
  async get(binary: string, productId: string, market: string, includeDlc = false): Promise<InstallPlan> {
    if (!id(productId) || !/^[A-Z]{2}$/.test(market)) throw Error('Invalid Store package scope.');
    const key = JSON.stringify([binary, productId, market, includeDlc]);
    let entry = this.entries.get(key);
    if (!entry || entry.until <= this.now()) {
      entry = { until: this.now() + 60_000, promise: Promise.resolve().then(() => this.reader(binary, productId, market, includeDlc)) };
      this.entries.delete(key); this.entries.set(key, entry);
      while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
      const current = entry;
      entry.promise = entry.promise.then(plan => { current.until = this.now() + 60_000; return plan; }, error => {
        if (this.entries.get(key) === current) this.entries.delete(key);
        throw error;
      });
    }
    return structuredClone(await entry.promise);
  }
}

/** A Durable is content for one installed game, not a new runnable base game. */
export function contentParentForChoice(choice: InstallChoice, games: Pick<Game, 'id' | 'storeId' | 'packageName' | 'installState'>[]): string | undefined {
  if (choice.kind !== 'Durable') return;
  if (!choice.supported || !id(choice.parentProductId) || !family(choice.mainPackageFamilyName)) throw Error('The add-on has no verified parent package.');
  const parents = games.filter(game => game.storeId?.toUpperCase() === choice.parentProductId && game.installState === 'ready'
    && (!game.packageName || choice.mainPackageFamilyName!.startsWith(game.packageName + '_')));
  if (parents.length !== 1) throw Error('Install the matching base game first, or use Manage content on the intended installation.');
  return parents[0].id;
}
