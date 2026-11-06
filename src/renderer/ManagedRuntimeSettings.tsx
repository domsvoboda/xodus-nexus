import {useEffect,useRef,useState} from 'react';
import type {AppSnapshot,ManagedFamilyStatus,ManagedRuntimeOptions} from '../shared/types';
import type {RuntimeFamily} from '../shared/runtime-selection';
import {activeRuntimeIsCachyos,runtimeDisplay} from '../shared/runtime-display';
import {RuntimeFamilyCard} from './RuntimeFamilyCard';
import {ui} from './i18n';

const family:RuntimeFamily='nexus-cachyos';
// A click on this card is the explicit opt-in for the optional family. Nothing
// is checked, installed or selected while rendering.
const options=(allowPrerelease:boolean):ManagedRuntimeOptions=>({allowCachyos:true,allowPrerelease});

/** Explicit optional CachyOS runtime operations. Installing never selects it for a game. */
export function ManagedRuntimeSettings({data,disabled,onBusyChange}:{data:AppSnapshot;disabled:boolean;onBusyChange:(busy:boolean)=>void}) {
  const [local,setLocal]=useState<{scope:string;status:ManagedFamilyStatus}>();
  const [pending,setPending]=useState<'check'|'install'>();
  const [notice,setNotice]=useState<{scope:string;text:string;error:boolean}>();
  const scope=JSON.stringify([data.settings.runtimeRoot,data.backend.binaryPath,data.backend.commit,data.backend.version,data.launcherUpdate?.currentVersion]);
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
  // The recorded installation channel is never reset by removing the discovery
  // control; uninstalled families only ever discover stable releases.
  const channel=item?.channel==='prerelease';
  // A verified default runtime of this family is reported truthfully, but it is
  // not a managed-family installation.
  const activeLocal=!installed&&activeRuntimeIsCachyos(data.runtime);
  const activeVersion=activeLocal?runtimeDisplay(data.runtime).version:'';
  const apiReady=typeof window!=='undefined'&&typeof window.launcher?.checkManagedRuntime==='function'&&typeof window.launcher?.installManagedRuntime==='function';
  // Another family may be checking or installing through its own surface; keep
  // this card idle instead of starting a competing managed runtime operation.
  const active=disabled||Boolean(pending)||statuses.some(status=>status.checking||status.installing);
  const busy=pending!==undefined||Boolean(item?.checking||item?.installing);
  async function perform(install:boolean) {
    if(active||inFlight.current||!apiReady)return;
    const candidate=item?.available;
    if(install&&!candidate)return;
    const captured=scope;inFlight.current=true;setPending(install?'install':'check');setNotice(undefined);onBusyChange(true);
    try {
      if(install) {
        const result=await window.launcher.installManagedRuntime(family,candidate!.candidateSha256,options(channel));
        if(!mounted.current||live.current!==captured)return;
        const success=result.family===family&&result.success&&result.committed&&result.durability==='confirmed';
        setNotice({scope:captured,error:!success,text:success?ui('runtime.cachyos_installed'):result.error??(result.committed?ui('runtime.families_committed_attention'):ui('runtime.families_failed'))});
        // The next authoritative snapshot owns post-install identity and availability.
        setLocal(undefined);
      } else {
        const result=await window.launcher.checkManagedRuntime(family,options(channel));
        if(!mounted.current||live.current!==captured)return;
        if(result.id!==family)throw Error(ui('runtime.families_failed'));
        setLocal({scope:captured,status:result});
      }
    }catch(error){if(mounted.current&&live.current===captured)setNotice({scope:captured,error:true,text:error instanceof Error?error.message:String(error)});}
    finally{inFlight.current=false;if(mounted.current){setPending(undefined);onBusyChange(false);}}
  }
  const version=item?.version??item?.installed?.sourceCommit.slice(0,12)??'';
  const summary=installed?ui('runtime.families_version',{version}):activeLocal?ui('runtime.cachyos_active',{version:activeVersion}):undefined;
  const title=ui('runtime.cachyos_title');
  return <RuntimeFamilyCard family={family} title={title}
    status={installed||activeLocal?{tone:'green',label:installed?ui('ui.ready_c2e3ac4'):ui('runtime.cachyos_active_label')}:{tone:'amber',label:ui('ui.not_installed_d177cdc')}}
    summary={summary}
    errors={item?.error?[item.error]:undefined}
    phase={busy&&item?.phase?item.phase:undefined}
    notice={notice?.scope===scope?notice:undefined}
    available={available&&item?.updateAvailable!==false?ui('runtime.families_available',{version:available.version}):undefined}
    requires={available&&item?.updateAvailable!==false?ui('runtime.families_requires',{backend:available.requiresBackendVersion,launcher:available.requiresLauncherVersion}):undefined}
    current={Boolean(available&&item?.updateAvailable===false)}
    checking={pending==='check'||pending===undefined&&Boolean(item?.checking)}
    installing={pending==='install'||pending===undefined&&Boolean(item?.installing)}
    installLabel={available&&item?.updateAvailable!==false?(installed?ui('runtime.families_update',{name:title}):ui('runtime.families_install',{name:title})):undefined}
    onCheck={()=>void perform(false)}
    onInstall={()=>void perform(true)}
    disabled={active||!apiReady}/>;
}
