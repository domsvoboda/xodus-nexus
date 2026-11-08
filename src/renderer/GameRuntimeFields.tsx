import {ui} from './i18n';
import {runtimeFamilyLabels,type GameRuntimeSelection,type InstalledRuntimeFamily} from '../shared/runtime-selection';

/** One explicit choice: the default runtime or an installed managed family.
 * The game keeps one stable prefix that its own runtime identity owns, so
 * choosing a family needs no separate prefix consent. */
export function GameRuntimeFields({value,installed,change}:{value:GameRuntimeSelection;installed:InstalledRuntimeFamily[];change:(value:GameRuntimeSelection)=>void}) {
  const current=installed.find(item=>item.id===value);
  const missing=value!=='default'&&!current;
  return <label>{ui('runtime.game_runtime')}<select value={value} onChange={event=>change(event.target.value as GameRuntimeSelection)}>
    <option value="default">{ui('runtime.use_default')}</option>
    {installed.map(item=><option key={item.id} value={item.id}>{runtimeFamilyLabels[item.id]}</option>)}
    {missing?<option value={value} disabled>{ui('runtime.unavailable',{name:runtimeFamilyLabels[value as keyof typeof runtimeFamilyLabels]??String(value)})}</option>:null}
  </select></label>;
}
