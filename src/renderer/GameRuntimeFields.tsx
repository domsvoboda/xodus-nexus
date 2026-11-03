import {CheckField} from './CheckField';
import {ui} from './i18n';
import {runtimeFamilyLabels,sameRuntimeBuild,type GameRuntimeSelection,type InstalledRuntimeFamily} from '../shared/runtime-selection';
export function GameRuntimeFields({value,separate,installed,approved,change,changeSeparate}:{value:GameRuntimeSelection;separate:boolean;installed:InstalledRuntimeFamily[];approved?:unknown;change:(value:GameRuntimeSelection)=>void;changeSeparate:(value:boolean)=>void}) {
  const current=installed.find(item=>item.id===value);
  const missing=value!=='default'&&!current;
  const changed=value!=='default'&&Boolean(current)&&!sameRuntimeBuild(approved,current);
  const retained=changed&&sameRuntimeBuild(approved,approved)&&separate;
  return <>
    <label>{ui('runtime.game_runtime')}<select value={value} onChange={event=>change(event.target.value as GameRuntimeSelection)}>
      <option value="default">{ui('runtime.use_default')}</option>
      {installed.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      {missing?<option value={value} disabled>{ui('runtime.unavailable',{name:runtimeFamilyLabels[value as keyof typeof runtimeFamilyLabels]??String(value)})}</option>:null}
    </select></label>
    {value!=='default'?<>
      {changed?<p role="alert">{retained?ui('runtime.new_build_available'):ui('runtime.build_changed')}</p>:null}
      {retained?<button type="button" onClick={()=>changeSeparate(true)}>{ui('runtime.use_installed_build')}</button>:null}
      <CheckField required checked={separate} onChange={event=>changeSeparate(event.target.checked)} label={ui('runtime.separate_prefix')} description={ui('runtime.prefix_warning')}/>
    </>:null}
  </>;
}
