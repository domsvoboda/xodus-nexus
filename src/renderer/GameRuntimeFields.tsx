import {CheckField} from './CheckField';
import {ui} from './i18n';
import {runtimeFamilyLabels,type GameRuntimeSelection,type InstalledRuntimeFamily} from '../shared/runtime-selection';
export function GameRuntimeFields({value,separate,installed,change,changeSeparate}:{value:GameRuntimeSelection;separate:boolean;installed:InstalledRuntimeFamily[];change:(value:GameRuntimeSelection)=>void;changeSeparate:(value:boolean)=>void}) {
  const current=installed.find(item=>item.id===value);
  const missing=value!=='default'&&!current;
  return <>
    <label>{ui('runtime.game_runtime')}<select value={value} onChange={event=>change(event.target.value as GameRuntimeSelection)}>
      <option value="default">{ui('runtime.use_default')}</option>
      {installed.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      {missing?<option value={value} disabled>{ui('runtime.unavailable',{name:runtimeFamilyLabels[value as keyof typeof runtimeFamilyLabels]??String(value)})}</option>:null}
    </select></label>
    {value!=='default'?<>
      <CheckField required checked={separate} onChange={event=>changeSeparate(event.target.checked)} label={ui('runtime.separate_prefix')} description={ui('runtime.prefix_warning')}/>
    </>:null}
  </>;
}
