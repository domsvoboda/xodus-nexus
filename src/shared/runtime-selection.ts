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
/** A chosen managed family never borrows the global runtime's availability.
 * A game prefix is stable across families, so no separate-prefix consent is a
 * precondition for choosing a family. */
export function gameRuntimeAvailable(selection:unknown,defaultAvailable:boolean,installed:readonly InstalledRuntimeFamily[]):boolean {
  if(selection===undefined||selection==='default')return defaultAvailable;
  return runtimeFamilies.includes(selection as RuntimeFamily)&&installed.some(item=>item.id===selection);
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

/**
 * Durable per-game prefix location, independent of the currently selected
 * runtime family. It is captured once from the state that existed before a
 * selection change and only selects a backend-owned path layout, so no renderer
 * value can name a directory:
 * - `game`: one canonical per-game prefix, the pre-0.5 default location;
 * - `family`: an existing experimental family-wide prefix (runtime-prefixes/<family>/prefixes);
 * - `build`: an existing build-specific prefix (runtime-prefixes/<family>/<buildId>).
 * The layout origin is path metadata only. It never pins a runtime build and is
 * not rewritten when the family changes.
 */
export type RuntimePrefixOrigin =
  | {layout:'game'}
  | {layout:'family';family:RuntimeFamily}
  | {layout:'build';family:RuntimeFamily;origin:RuntimeBuildApproval};
export type RuntimePrefixIdentity = RuntimePrefixOrigin;
/** Persisted game fields that can describe where an existing prefix lives. */
export interface RuntimePrefixState {
  runtime?:unknown; runtimeBuild?:unknown; runtimePrefixes?:unknown; runtimePrefixIdentity?:unknown;
}
function runtimeFamilyId(value:unknown):RuntimeFamily {
  if(runtimeFamilies.includes(value as RuntimeFamily))return value as RuntimeFamily;
  throw Error('Invalid runtime prefix identity.');
}
export function runtimePrefixOrigin(value:unknown):RuntimePrefixOrigin {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid runtime prefix identity.');
  const item=value as RuntimePrefixOrigin;
  if(item.layout==='game')return {layout:'game'};
  if(item.layout==='family')return {layout:'family',family:runtimeFamilyId(item.family)};
  if(item.layout==='build')return {layout:'build',family:runtimeFamilyId(item.family),origin:runtimeBuildApproval(item.origin)};
  throw Error('Invalid runtime prefix identity.');
}
/** Validates a persisted identity. Unknown layouts, families or build receipts fail closed. */
export function runtimePrefixIdentity(value:unknown):RuntimePrefixIdentity {
  return runtimePrefixOrigin(value);
}
/** Origin of the prefix that the persisted selection used before any change. */
export function legacyRuntimePrefixOrigin(state:RuntimePrefixState):RuntimePrefixOrigin {
  const selection=gameRuntimeSelection(state.runtime);
  if(selection==='default')return {layout:'game'};
  const anchor=runtimePrefixAnchors(state.runtimePrefixes)[selection];
  if(anchor?.layout==='build')return {layout:'build',family:selection,origin:anchor.origin};
  if(anchor)return {layout:'family',family:selection};
  if(state.runtimeBuild!==undefined)return {layout:'build',family:selection,origin:runtimeBuildApproval(state.runtimeBuild)};
  return {layout:'family',family:selection};
}
