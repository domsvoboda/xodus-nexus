import type { RuntimeStatus } from './types.js';

export function nexusRuntimeUpdateAvailable(runtime: RuntimeStatus): boolean {
  // A CachyOS-family runtime is a different family from the Standard Nexus
  // release, so an active one never advertises a Standard update as same-family.
  if (activeRuntimeIsCachyos(runtime)) return false;
  return Boolean(runtime.nexusAvailable && runtime.nexusName &&
    runtime.name !== runtime.nexusName.replace(/-x86_64\.tar\.xz$/, ''));
}

// Describe the active runtime, not the available update. Older Nexus builds
// used upstream-looking folder names with explicit local patch suffixes.
export function runtimeDisplay(runtime: RuntimeStatus): { title: string; source: string; version: string } {
  if (!runtime.installed) return { title: 'Nexus runtime', source: 'Not installed', version: 'Not installed' };
  const name = runtime.name ?? '';
  const nexusPrefix = /^(?:xodus-)?nexus-runtime-/.exec(name)?.[0];
  const nexus = Boolean(nexusPrefix) ||
    (/^(?:proton-xodus-|xodus-proton-)/.test(name) && /-(?:xgamesave-pr28-|eac-bridge-v\d)/.test(name));
  const upstream = !nexus && (/^xodus-proton-[a-f0-9]{8}$/.test(name) || /^proton-xodus-[a-f0-9]{8,40}$/.test(name));
  const title = nexus ? 'Nexus runtime' : upstream ? 'Xodus Proton runtime' : 'Custom runtime';
  return {
    title,
    source: nexus ? 'Nexus runtime' : upstream ? 'Upstream Xodus Proton snapshot' : 'Custom runtime',
    version: nexusPrefix ? name.slice(nexusPrefix.length)
      : runtime.commit ? `Build ${runtime.commit.slice(0, 12)}` : name || 'Version unavailable',
  };
}

/** The verified default runtime belongs to the optional CachyOS family when its
 * recorded build name carries the CachyOS family prefix. Local diagnostic
 * builds use the same prefix, so an explicitly selected local CachyOS runtime
 * is presented truthfully without inventing a managed-family installation. */
export function activeRuntimeIsCachyos(runtime: RuntimeStatus): boolean {
  return runtime.installed === true && /^nexus-runtime-cachyos-/.test(runtime.name ?? '');
}
