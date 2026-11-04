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
  nexus: 'Standard', 'nexus-cachyos': 'CachyOS',
};
export interface RuntimeBuildApproval {
  buildId:string; manifestSha256:string; sourceCommit:string;
}
export function runtimeBuildApproval(value:unknown):Readonly<RuntimeBuildApproval> {
  const item=value as RuntimeBuildApproval|undefined;
  if(!item||typeof item!=='object'||typeof item.buildId!=='string'||typeof item.manifestSha256!=='string'||typeof item.sourceCommit!=='string'||!/^[a-f0-9]{64}$/.test(item.buildId??'')||!/^[a-f0-9]{64}$/.test(item.manifestSha256??'')||!/^[a-f0-9]{40}$/.test(item.sourceCommit??''))throw Error('Choose and explicitly approve an installed runtime build.');
  return Object.freeze({buildId:item.buildId,manifestSha256:item.manifestSha256,sourceCommit:item.sourceCommit});
}
export function sameRuntimeBuild(a:unknown,b:unknown):boolean {
  try{const left=runtimeBuildApproval(a),right=runtimeBuildApproval(b);return left.buildId===right.buildId&&left.manifestSha256===right.manifestSha256&&left.sourceCommit===right.sourceCommit;}catch{return false;}
}
export interface InstalledRuntimeFamily {
  id: RuntimeFamily; label: string; buildId: string; sourceCommit: string; manifestSha256:string;
  /** Read-only display path from the verified managed payload. It is never a
   * launch, approval or selection input. */
  displayWinePath?: string;
}
/** A chosen managed family never borrows the global runtime's availability. */
export function gameRuntimeAvailable(selection:unknown,separatePrefix:unknown,defaultAvailable:boolean,installed:readonly InstalledRuntimeFamily[]):boolean {
  if(selection===undefined||selection==='default')return defaultAvailable;
  return separatePrefix===true&&runtimeFamilies.includes(selection as RuntimeFamily)&&installed.some(item=>item.id===selection);
}

/** Prefix identity survives family updates and switching away/back. Build origin is compatibility metadata, never a runtime pin. */
export type RuntimePrefixAnchor = {layout:'family'} | {layout:'build';origin:RuntimeBuildApproval};
export type RuntimePrefixAnchors = Partial<Record<RuntimeFamily,RuntimePrefixAnchor>>;
export function runtimePrefixAnchor(value:unknown):RuntimePrefixAnchor {
  if(!value||typeof value!=='object')throw Error('Invalid runtime prefix identity.');
  const item=value as RuntimePrefixAnchor;
  if(item.layout==='family')return {layout:'family'};
  if(item.layout==='build')return {layout:'build',origin:runtimeBuildApproval(item.origin)};
  throw Error('Invalid runtime prefix identity.');
}
export function runtimePrefixAnchors(value:unknown):RuntimePrefixAnchors {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid runtime prefix identities.');
  const result:RuntimePrefixAnchors={};
  for(const [family,anchor] of Object.entries(value)) {
    if(!runtimeFamilies.includes(family as RuntimeFamily))throw Error('Invalid runtime prefix family.');
    result[family as RuntimeFamily]=runtimePrefixAnchor(anchor);
  }
  return result;
}
