import {expect,it} from 'vitest';
import {DEFAULT_SHADER_CACHE_GIB,isShaderCacheOnlyPatch,shaderCacheLimits} from './shader-cache';
it('has a four-GiB default and lossless driver formats for fractional limits',()=>{
  expect(DEFAULT_SHADER_CACHE_GIB).toBe(4);expect(shaderCacheLimits()).toEqual({gib:4,bytes:'4294967296',mesa:'4G'});
  expect(shaderCacheLimits(0.25)).toEqual({gib:0.25,bytes:'268435456',mesa:'256M'});
  expect(shaderCacheLimits(1024)).toEqual({gib:1024,bytes:'1099511627776',mesa:'1024G'});
});
it.each([null,'4','$(unsafe)',0,-1,0.1,1024.25,NaN,Infinity,{},[]])('refuses invalid cache limit %s before use',value=>expect(()=>shaderCacheLimits(value)).toThrow('Shader cache limit'));
it('takes the no-authentication fast path only for the cache-size preference',()=>{
  expect(isShaderCacheOnlyPatch({shaderCacheLimitGiB:8})).toBe(true);
  for(const patch of [{},{runtimeRoot:'/other'},{shaderCacheLimitGiB:8,runtimeRoot:'/other'},{shaderCacheLimitGiB:8,downloadLimitMiB:1}])expect(isShaderCacheOnlyPatch(patch)).toBe(false);
});
