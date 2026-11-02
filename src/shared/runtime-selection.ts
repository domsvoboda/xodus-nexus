/** Fixed, managed families only. Legacy Game.winePath is never consulted. */
export const runtimeFamilies = ['nexus', 'nexus-cachyos'] as const;
export type RuntimeFamily = typeof runtimeFamilies[number];
export type GameRuntimeSelection = 'default' | RuntimeFamily;
export function gameRuntimeSelection(value: unknown): GameRuntimeSelection {
  if (value === undefined || value === 'default') return 'default';
  if (runtimeFamilies.includes(value as RuntimeFamily)) return value as RuntimeFamily;
  throw Error('Unknown managed runtime selection. Choose the default or an installed Nexus runtime.');
}
export const runtimeFamilyLabels: Record<RuntimeFamily, string> = {
  nexus: 'Nexus Runtime', 'nexus-cachyos': 'Nexus Runtime (CachyOS, experimental)',
};
export interface InstalledRuntimeFamily {
  id: RuntimeFamily; label: string; buildId: string; sourceCommit: string;
}
/** A chosen managed family never borrows the global runtime's availability. */
export function gameRuntimeAvailable(selection:unknown,separatePrefix:unknown,defaultAvailable:boolean,installed:readonly InstalledRuntimeFamily[]):boolean {
  if(selection===undefined||selection==='default')return defaultAvailable;
  return separatePrefix===true&&runtimeFamilies.includes(selection as RuntimeFamily)&&installed.some(item=>item.id===selection);
}
