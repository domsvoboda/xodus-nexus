export const DEFAULT_SHADER_CACHE_GIB = 4;

export function shaderCacheLimits(value: unknown = DEFAULT_SHADER_CACHE_GIB): { gib: number; bytes: string; mesa: string } {
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 1024 || !Number.isInteger(value * 4)) {
    throw Error('Shader cache limit must be between 0.25 and 1024 GiB, in steps of 0.25 GiB.');
  }
  return {gib:value,bytes:String(value * 1024 ** 3),mesa:Number.isInteger(value)?`${value}G`:`${value * 1024}M`};
}

/** A next-launch preference must not refresh authentication or touch an active game. */
export function isShaderCacheOnlyPatch(patch: object): boolean {
  const keys=Object.keys(patch);return keys.length===1&&keys[0]==='shaderCacheLimitGiB';
}
