import {useEffect,useRef,useState} from 'react';
import type {AppSnapshot,ManagedFamilyStatus,ManagedRuntimeOptions} from '../shared/types';
import {runtimeFamilies,type RuntimeFamily} from '../shared/runtime-selection';
import {RuntimeFamilyCard} from './RuntimeFamilyCard';
import {ui} from './i18n';

const title=(family:RuntimeFamily)=>family==='nexus'?ui('runtime.standard_title'):ui('runtime.cachyos_title');
const options=(family:RuntimeFamily,allowPrerelease:boolean):ManagedRuntimeOptions=>({allowCachyos:family==='nexus-cachyos',allowPrerelease});

/** One managed family card. Installing or updating here changes only this
 * family's receipt. It never selects a global runtime or a game runtime. */
function ManagedRuntimeFamily({family,data,disabled,onBusyChange}:{
  family:RuntimeFamily;data:AppSnapshot;disabled:boolean;onBusyChange:(busy:boolean)=>void;
}) {
  const [local,setLocal]=useState<{scope:string;status:ManagedFamilyStatus}>();
  const [pending,setPending]=useState<'check'|'install'|'import'>();
  const [notice,setNotice]=useState<{scope:string;text:string;error:boolean}>();
  const scope=JSON.stringify([family,data.settings.runtimeRoot,data.backend.binaryPath,data.backend.commit,data.backend.version,data.launcherUpdate?.currentVersion]);
  const live=useRef(scope),inFlight=useRef(false),mounted=useRef(true);live.current=scope;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setNotice(undefined);},[scope]);
  const statuses=(data.runtime.managedFamilies??[]);
  const snapshotKey=JSON.stringify(statuses);
  useEffect(()=>setLocal(undefined),[scope,snapshotKey]);
  const snapshot=statuses.find(item=>item.id===family);
  const item=local?.scope===scope?local.status:snapshot;
  const installed=Boolean(item?.installed);
  const available=item?.available;
  // The recorded release channel is always derived from the verified install,
  // never from a global selection.
  const channel=item?.channel==='prerelease';
  const apiReady=typeof window!=='undefined'&&typeof window.launcher?.checkManagedRuntime==='function'&&typeof window.launcher?.installManagedRuntime==='function';
  const importReady=typeof window!=='undefined'&&typeof window.launcher?.importManagedRuntime==='function'&&typeof window.launcher?.chooseDirectory==='function';
  // A family operation owns the component slot. Other runtime operations stay
  // disabled so two installers can never race the shared runtime root.
  const active=disabled||Boolean(pending)||statuses.some(status=>status.checking||status.installing);
  const busy=pending!==undefined||Boolean(item?.checking||item?.installing);
  async function perform(install:boolean) {
    if(active||inFlight.current||!apiReady)return;
    const candidate=item?.available;
    if(install&&!candidate)return;
    const captured=scope;inFlight.current=true;setPending(install?'install':'check');setNotice(undefined);onBusyChange(true);
    try {
      if(install) {
        const result=await window.launcher.installManagedRuntime(family,candidate!.candidateSha256,options(family,channel));
        if(!mounted.current||live.current!==captured)return;
        const success=result.family===family&&result.success&&result.committed&&result.durability==='confirmed';
        setNotice({scope:captured,error:!success,text:success?ui('runtime.families_installed',{name:title(family)}):result.error??(result.committed?ui('runtime.families_committed_attention'):ui('runtime.families_failed'))});
        // The next authoritative snapshot owns post-install identity and availability.
        setLocal(undefined);
      } else {
        const result=await window.launcher.checkManagedRuntime(family,options(family,channel));
        if(!mounted.current||live.current!==captured)return;
        if(result.id!==family)throw Error(ui('runtime.families_failed'));
        setLocal({scope:captured,status:result});
      }
    }catch(error){if(mounted.current&&live.current===captured)setNotice({scope:captured,error:true,text:error instanceof Error?error.message:String(error)});}
    finally{inFlight.current=false;if(mounted.current){setPending(undefined);onBusyChange(false);}}
  }
  async function importArchive() {
    if(active||inFlight.current||!importReady)return;
    let directory:string|null|undefined;
    try { directory=await window.launcher.chooseDirectory('runtime'); }
    catch(error){setNotice({scope,error:true,text:error instanceof Error?error.message:String(error)});return;}
    if(!directory)return;
    const captured=scope;inFlight.current=true;setPending('import');setNotice(undefined);onBusyChange(true);
    try {
      const result=await window.launcher.importManagedRuntime(family,directory,options(family,channel));
      if(!mounted.current||live.current!==captured)return;
      const success=result.family===family&&result.success&&result.committed&&result.durability==='confirmed';
      setNotice({scope:captured,error:!success,text:success?ui('runtime.families_installed',{name:title(family)}):result.error??(result.committed?ui('runtime.families_committed_attention'):ui('runtime.families_failed'))});
      setLocal(undefined);
    }catch(error){if(mounted.current&&live.current===captured)setNotice({scope:captured,error:true,text:error instanceof Error?error.message:String(error)});}
    finally{inFlight.current=false;if(mounted.current){setPending(undefined);onBusyChange(false);}}
  }
  const version=item?.version??item?.installed?.sourceCommit.slice(0,12)??'';
  const name=title(family);
  const candidateVisible=Boolean(available&&item?.updateAvailable!==false);
  return <RuntimeFamilyCard family={family} title={name}
    status={installed?{tone:'green',label:ui('ui.ready_c2e3ac4')}:{tone:'amber',label:ui('runtime.families_not_installed')}}
    summary={installed?ui('runtime.families_version',{version}):undefined}
    errors={item?.error?[item.error]:undefined}
    phase={busy&&item?.phase?item.phase:undefined}
    notice={notice?.scope===scope?notice:undefined}
    available={candidateVisible?ui('runtime.families_available',{version:available!.version}):undefined}
    requires={candidateVisible?ui('runtime.families_requires',{backend:available!.requiresBackendVersion,launcher:available!.requiresLauncherVersion}):undefined}
    current={Boolean(available&&item?.updateAvailable===false)}
    checking={pending==='check'||(pending===undefined&&Boolean(item?.checking))}
    installing={pending==='install'||(pending===undefined&&Boolean(item?.installing))}
    importing={pending==='import'}
    installLabel={candidateVisible?(installed?ui('runtime.families_update',{name}):ui('runtime.families_install',{name})):undefined}
    importLabel={importReady?ui('runtime.families_import'):undefined}
    onCheck={()=>void perform(false)}
    onInstall={()=>void perform(true)}
    onImport={importReady?()=>void importArchive():undefined}
    disabled={active||!apiReady}/>;
}

/** Both supported managed families are always shown, each with its own verified
 * installed version and its own install/update action. There is no global family
 * toggle or single runtime pointer in this surface. */
export function ManagedRuntimeSettings({data,disabled,onBusyChange}:{data:AppSnapshot;disabled:boolean;onBusyChange:(busy:boolean)=>void}) {
  const notify=useRef(onBusyChange);notify.current=onBusyChange;
  const busy=useRef(new Set<RuntimeFamily>());
  const change=(family:RuntimeFamily,value:boolean)=>{
    if(value)busy.current.add(family);else busy.current.delete(family);
    notify.current(busy.current.size>0);
  };
  useEffect(()=>()=>{busy.current.clear();notify.current(false);},[]);
  return <div className="runtime-family-settings">
    <p className="fine-print">{ui('runtime.families_help')}</p>
    {runtimeFamilies.map(family=><ManagedRuntimeFamily key={family} family={family} data={data} disabled={disabled}
      onBusyChange={value=>change(family,value)}/>)}
  </div>;
}
