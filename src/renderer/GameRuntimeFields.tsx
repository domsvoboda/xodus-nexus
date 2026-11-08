import {ui} from './i18n';
import {runtimeFamilyLabels,type GameRuntimeSelection,type InstalledRuntimeFamily} from '../shared/runtime-selection';

/** One explicit choice per game. Standard is the default for a game that has no
 * selection. CachyOS is offered only after a verified installation. The
 * selector never changes a global runtime pointer or a prefix location. */
export function GameRuntimeFields({value,installed,change}:{value:GameRuntimeSelection;installed:InstalledRuntimeFamily[];change:(value:GameRuntimeSelection)=>void}) {
  const explicitStandard=value==='nexus';
  const available=installed.some(item=>item.id===value);
  const missing=value!=='default'&&!available;
  return <label>{ui('runtime.game_runtime')}<select value={value} onChange={event=>change(event.target.value as GameRuntimeSelection)}>
    <option value="default">{ui('runtime.family_standard_default')}</option>
    {installed.filter(item=>item.id!=='nexus').map(item=><option key={item.id} value={item.id}>{runtimeFamilyLabels[item.id]}</option>)}
    {explicitStandard&&available?<option value="nexus">{runtimeFamilyLabels.nexus}</option>:null}
    {missing?<option value={value} disabled>{ui('runtime.unavailable',{name:runtimeFamilyLabels[value as keyof typeof runtimeFamilyLabels]??String(value)})}</option>:null}
  </select></label>;
}
