import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,CircleAlert,Gamepad2,LoaderCircle,RefreshCw} from 'lucide-react';
import type {AppSnapshot,ManagedFamilyStatus,ManagedRuntimeOptions} from '../shared/types';
import type {RuntimeFamily} from '../shared/runtime-selection';
import {activeRuntimeIsCachyos,runtimeDisplay} from '../shared/runtime-display';
import {StatusDot} from './StatusDot';
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
  const managedBinary=item?.installed?.displayWinePath;
  const defaultBinary=activeLocal?data.runtime.winePath:undefined;
  const binary=managedBinary??defaultBinary;
  const binaryNote=managedBinary?ui('runtime.cachyos_binary_managed'):defaultBinary?ui('runtime.cachyos_binary_default'):ui('runtime.cachyos_binary_missing');
  return <section className="settings-card managed-runtime-settings" aria-label={ui('runtime.cachyos_title')}>
    <div className="settings-heading">
      <div className="settings-icon"><Gamepad2 /></div>
      <div><h2>{ui('runtime.cachyos_title')}</h2>{summary?<p>{summary}</p>:null}</div>
      <span className={`status-label ${installed||activeLocal?'ready':'unknown'}`}><StatusDot tone={installed||activeLocal?'green':'amber'} />{installed?ui('ui.ready_c2e3ac4'):activeLocal?ui('runtime.cachyos_active_label'):ui('ui.not_installed_d177cdc')}</span>
    </div>
    <div className="managed-runtime-binary">
      <span className="overline">{ui('runtime.cachyos_binary')}</span>
      <p className="diagnostic-path mono" data-cachyos-binary={managedBinary?'managed':defaultBinary?'default':'missing'}>{binary??ui('ui.not_installed_d177cdc')}</p>
      <small>{binaryNote}</small>
    </div>
    {notice?.scope===scope?<p role={notice.error?'alert':'status'} className={notice.error?'alert amber':'runtime-phase'}>{notice.text}</p>:null}
    {item?.error?<div className="alert amber" role="alert"><CircleAlert /><span>{item.error}</span></div>:null}
    {busy&&item?.phase?<div className="runtime-phase"><LoaderCircle className="spin" /><span>{item.phase}</span></div>:null}
    {available&&item?.updateAvailable===false?<p role="status">{ui('runtime.cachyos_current')}</p>:null}
    {available&&item?.updateAvailable!==false?<p>{ui('runtime.families_available',{version:available.version})}<br/><small>{ui('runtime.families_requires',{backend:available.requiresBackendVersion,launcher:available.requiresLauncherVersion})}</small></p>:null}
    <div className="button-row end">
      <button className="secondary" disabled={active||!apiReady} onClick={()=>void perform(false)}>{pending==='check'||pending===undefined&&item?.checking?<LoaderCircle className="spin" />:<RefreshCw />}{ui('ui.check_for_updates_f26f327')}</button>
      {available&&item?.updateAvailable!==false?<button className="primary" disabled={active||!apiReady} onClick={()=>void perform(true)}>{pending==='install'||pending===undefined&&item?.installing?<LoaderCircle className="spin" />:<ArrowDownToLine />}{installed?ui('runtime.families_update',{name:ui('runtime.cachyos_title')}):ui('runtime.families_install',{name:ui('runtime.cachyos_title')})}</button>:null}
    </div>
  </section>;
}
