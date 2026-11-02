import type { GameAchievement, GameAchievements } from '../shared/types.js';
import { spawnTracked } from './process.js';

const MAX_BYTES = 4_000_000;
const iconHosts = new Set(['images-eds-ssl.xboxlive.com', 'images-eds.xboxlive.com', 'store-images.s-microsoft.com']);
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
function icon(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && iconHosts.has(url.hostname)) return url.toString();
  } catch { /* No unsafe or local artwork requests. */ }
}

export function parseGameAchievements(raw: string, account: string, titleId: string): GameAchievements {
  if (raw.length > MAX_BYTES) throw Error('Achievements too large.');
  const value = JSON.parse(raw);
  if (!value || value.schema !== 1 || value.account !== account || value.titleId !== titleId || typeof value.partial !== 'boolean' || !Array.isArray(value.items) || value.items.length > 500) throw Error('Invalid achievements response.');
  const ids = new Set<string>();
  const items: GameAchievement[] = value.items.map((item: Record<string, unknown>) => {
    if (!item || !text(item.id, 180) || !item.id || ids.has(item.id) || !text(item.name, 256) || !item.name || !text(item.description, 1500)
      || !['unlocked', 'in-progress', 'locked'].includes(String(item.state)) || typeof item.secret !== 'boolean' || typeof item.revoked !== 'boolean') throw Error('Invalid achievement.');
    ids.add(item.id);
    if (item.revoked && item.state === 'unlocked') throw Error('Invalid revoked achievement.');
    const score = item.gamerscore, progress = item.progress, date = item.unlockedAt, image = item.iconUrl;
    if (score !== null && (!Number.isInteger(score) || Number(score) < 0 || Number(score) > 10_000)) throw Error('Invalid gamerscore.');
    if (progress !== null && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100)) throw Error('Invalid progress.');
    if (date !== null && (!text(date, 40) || !/^\d{4}-\d{2}-\d{2}T/.test(date) || !Number.isFinite(Date.parse(date)) || Date.parse(date) > Date.now() + 300_000 || item.state !== 'unlocked')) throw Error('Invalid unlock date.');
    if (image !== null && !text(image, 2048)) throw Error('Invalid achievement icon.');
    return { id: item.id, name: item.name, description: item.description, state: item.state as GameAchievement['state'], secret: item.secret, revoked: item.revoked,
      ...(score !== null ? { gamerscore: score as number } : {}), ...(progress !== null ? { progress: progress as number } : {}),
      ...(date !== null ? { unlockedAt: new Date(date as string).toISOString() } : {}), ...(image && icon(image as string) ? { iconUrl: icon(image as string) } : {}) };
  });
  return { status: items.length || value.partial ? 'available' : 'unavailable', items, partial: value.partial };
}

type Reader = (binary: string, titleId: string, signal: AbortSignal) => Promise<string>;
async function read(binary: string, titleId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const tracked = spawnTracked(binary, ['achievements', titleId, '--json'], { maxOutput: MAX_BYTES, stdoutOnly: true });
  tracked.child.stdin.end();
  const stop = () => { tracked.child.kill('SIGKILL'); };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(stop, 35_000); timer.unref();
  try {
    const result = await tracked.result; signal.throwIfAborted();
    if (result.code !== 0) {
      // The backend reports a fixed failure stage as JSON on stdout; keep only a safe slug.
      let stage: unknown;
      try { stage = (JSON.parse(result.output) as { error?: unknown }).error; } catch { /* no stage reported */ }
      throw Object.assign(Error('Achievements unavailable.'), { stage: typeof stage === 'string' && /^[a-z0-9-]{1,48}$/.test(stage) ? stage : undefined });
    }
    return result.output;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}

/** No disk cache, telemetry, unlock writes or cross-account responses. */
export class GameAchievementsReader {
  private identity?: { account: string; binary: string };
  private generation = 0;
  private requests = new Map<string, { controller: AbortController; job: Promise<GameAchievements> }>();
  private cache = new Map<string, { until: number; value: GameAchievements }>();
  constructor(private reader: Reader = read) {}
  select(account?: string, binary?: string) {
    const next = account && binary ? { account, binary } : undefined;
    if (JSON.stringify(next) === JSON.stringify(this.identity)) return;
    this.generation++;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear(); this.cache.clear(); this.identity = next;
  }
  async get(titleId: string, refresh = false): Promise<GameAchievements> {
    if (!/^[1-9]\d{0,9}$/.test(titleId) || Number(titleId) > 0xffffffff) throw Error('Invalid Xbox title ID.');
    const identity = this.identity, generation = this.generation;
    if (!identity) return { status: 'unsupported' };
    const cached = this.cache.get(titleId);
    if (!refresh && cached && cached.until > Date.now()) return structuredClone(cached.value);
    const pending = this.requests.get(titleId); if (pending) return structuredClone(await pending.job);
    if (this.requests.size >= 2) return { status: 'error' };
    const controller = new AbortController();
    const job = Promise.resolve().then(async (): Promise<GameAchievements> => {
      try {
        const raw = await this.reader(identity.binary, titleId, controller.signal);
        if (generation !== this.generation || controller.signal.aborted) throw Error('Account changed.');
        const value = parseGameAchievements(raw, identity.account, titleId);
        if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(titleId, { until: Date.now() + 120_000, value });
        return structuredClone(value);
      } catch (error) {
        const reason = (error as { stage?: unknown })?.stage;
        return typeof reason === 'string' ? { status: 'error', reason } : { status: 'error' };
      }
      finally { if (generation === this.generation) this.requests.delete(titleId); }
    });
    this.requests.set(titleId, { controller, job });
    return job;
  }
}
