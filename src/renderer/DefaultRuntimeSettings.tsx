import type {AppSnapshot} from '../shared/types';
import {activeRuntimeIsCachyos,nexusRuntimeUpdateAvailable,runtimeDisplay} from '../shared/runtime-display';
import {RuntimeFamilyCard} from './RuntimeFamilyCard';
import {ui,uiText} from './i18n';

/** The runtime that games use by default. It reports the verified active
 * runtime truthfully, so an external or custom Wine never looks like a managed
 * Standard installation. Installing the Standard release is a separate,
 * explicit action and stays hidden while another family is the default. */
export function DefaultRuntimeSettings({data,busy,disabled,invoke,runtimeLogs}:{
  data:AppSnapshot; busy?:string; disabled:boolean; runtimeLogs:string[];
  invoke:(name:string,fn:()=>Promise<unknown>,success?:string)=>void;
}) {
  const info=runtimeDisplay(data.runtime);
  const activeCachyos=activeRuntimeIsCachyos(data.runtime);
  const nexusActive=data.runtime.installed===true&&info.source==='Nexus runtime';
  const updateAvailable=nexusRuntimeUpdateAvailable(data.runtime)&&!activeCachyos;
  const availableVersion=data.runtime.nexusVersion?.replace(/^runtime-/,'')??'';
  const checking=busy==='runtime-check'||Boolean(data.runtime.nexusChecking);
  const installing=busy==='runtime-install-nexus'||data.runtime.updating;
  return <RuntimeFamilyCard family="default"
    title={ui('runtime.default_title')}
    status={{tone:!data.runtime.installed?'amber':nexusActive?'green':'amber',label:!data.runtime.installed?ui('ui.missing_8af1d32'):nexusActive?ui('ui.ready_c2e3ac4'):ui('ui.other_runtime_ce6adfb')}}
    summary={data.runtime.installed?ui('ui.active_ae2c40a',{runtime:info.title,version:info.version}):ui('ui.no_runtime_selected_b8e7445')}
    errors={[data.runtime.nexusError,data.runtime.error?uiText(data.runtime.error):undefined].filter((value):value is string=>Boolean(value))}
    phase={data.runtime.phase?uiText(data.runtime.phase):undefined}
    available={updateAvailable&&availableVersion?ui('runtime.families_available',{version:availableVersion}):undefined}
    current={nexusActive&&Boolean(data.runtime.nexusAvailable)&&!updateAvailable}
    log={data.runtime.updating||runtimeLogs.length?runtimeLogs:undefined}
    checking={checking}
    installing={installing}
    installLabel={updateAvailable?ui('ui.install_nexus_runtime_2cf3608'):undefined}
    onCheck={()=>invoke('runtime-check',()=>window.launcher.checkNexusRuntime())}
    onInstall={()=>invoke('runtime-install-nexus',()=>window.launcher.installNexusRuntime(),ui('ui.nexus_runtime_was_verified_installed_and_selecte_51b0ff1'))}
    disabled={disabled}/>;
}
