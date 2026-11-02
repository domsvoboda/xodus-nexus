import {ui} from './i18n';
import {runtimeFamilyLabels,type GameRuntimeSelection,type InstalledRuntimeFamily} from '../shared/runtime-selection';
export function GameRuntimeFields({value,separate,installed,change,changeSeparate}:{value:GameRuntimeSelection;separate:boolean;installed:InstalledRuntimeFamily[];change:(value:GameRuntimeSelection)=>void;changeSeparate:(value:boolean)=>void}) {
  const missing=value!=='default'&&!installed.some(item=>item.id===value);
  return <>
    <label>{ui('runtime.game_runtime')}<select value={value} onChange={event=>change(event.target.value as GameRuntimeSelection)}>
      <option value="default">{ui('runtime.use_default')}</option>
      {installed.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      {missing?<option value={value} disabled>{ui('runtime.unavailable',{name:runtimeFamilyLabels[value as keyof typeof runtimeFamilyLabels]??String(value)})}</option>:null}
    </select></label>
    {value!=='default'?<>
      <label className="check-field"><input type="checkbox" required checked={separate} onChange={event=>changeSeparate(event.target.checked)}/><span>{ui('runtime.separate_prefix')}</span></label>
      <small>{ui('runtime.prefix_warning')}</small>
    </>:null}
  </>;
}
