import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,RefreshCw,LoaderCircle} from 'lucide-react';
import type {AppSnapshot,ManagedFamilyStatus,ManagedRuntimeOptions} from '../shared/types';
import {runtimeFamilyLabels,type RuntimeFamily} from '../shared/runtime-selection';
import {CheckField} from './CheckField';
import {ui} from './i18n';

/** Explicit component operations only. Installing a family never selects it for a game. */
export function ManagedRuntimeSettings({data,disabled,onBusyChange}:{data:AppSnapshot;disabled:boolean;onBusyChange:(busy:boolean)=>void}) {
  const [experimental,setExperimental]=useState(false),[allowCachyos,setAllowCachyos]=useState(false);
  const [prerelease,setPrerelease]=useState<Partial<Record<RuntimeFamily,boolean>>>({});
  const [local,setLocal]=useState<{scope:string;statuses:Partial<Record<RuntimeFamily,ManagedFamilyStatus>>}>();
  const [invalidated,setInvalidated]=useState<Partial<Record<RuntimeFamily,boolean>>>({});
  const [pending,setPending]=useState<RuntimeFamily>();
  const [notice,setNotice]=useState<{scope:string;text:string;error:boolean}>();
  const scope=JSON.stringify([data.settings.runtimeRoot,data.backend.binaryPath,data.backend.commit,data.backend.version,data.launcherUpdate?.currentVersion]);
  const live=useRef(scope),inFlight=useRef(false),mounted=useRef(true);live.current=scope;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setAllowCachyos(false);setPrerelease({});setInvalidated({});setNotice(undefined);},[scope]);
  const statuses=(data.runtime.managedFamilies??[]);
  const snapshotKey=JSON.stringify(statuses);
  useEffect(()=>setLocal(undefined),[scope,snapshotKey]);
  const status=(family:RuntimeFamily)=>local?.scope===scope&&local.statuses[family]||statuses.find(item=>item.id===family);
  const cachyosInstalled=Boolean(status('nexus-cachyos')?.installed);
  const apiReady=typeof window!=='undefined'&&typeof window.launcher?.checkManagedRuntime==='function'&&typeof window.launcher?.installManagedRuntime==='function';
  const active=disabled||Boolean(pending)||statuses.some(item=>item.checking||item.installing);
  const channel=(family:RuntimeFamily)=>prerelease[family]??status(family)?.channel==='prerelease';
  const options=(family:RuntimeFamily):ManagedRuntimeOptions=>({allowCachyos:family==='nexus-cachyos'&&(cachyosInstalled||allowCachyos),allowPrerelease:channel(family)});
  async function perform(family:RuntimeFamily,install:boolean) {
    if(active||inFlight.current||!apiReady||family==='nexus-cachyos'&&!cachyosInstalled&&!allowCachyos)return;
    const candidate=status(family)?.available;
    if(install&&!candidate)return;
    const captured=scope;inFlight.current=true;setPending(family);setNotice(undefined);onBusyChange(true);
    try {
      if(install) {
        const result=await window.launcher.installManagedRuntime(family,candidate!.candidateSha256,options(family));
        if(!mounted.current||live.current!==captured)return;
        const success=result.family===family&&result.success&&result.committed&&result.durability==='confirmed';
        setNotice({scope:captured,error:!success,text:success?ui('runtime.families_installed'):result.error??(result.committed?ui('runtime.families_committed_attention'):ui('runtime.families_failed'))});
        // The next authoritative snapshot owns post-install identity and availability.
        setLocal(undefined);
      } else {
        const result=await window.launcher.checkManagedRuntime(family,options(family));
        if(!mounted.current||live.current!==captured)return;
        if(result.id!==family)throw Error(ui('runtime.families_failed'));
        setInvalidated(current=>({...current,[family]:false}));
        setLocal(current=>({scope:captured,statuses:{...(current?.scope===captured?current.statuses:{}),[family]:result}}));
      }
    }catch(error){if(mounted.current&&live.current===captured)setNotice({scope:captured,error:true,text:error instanceof Error?error.message:String(error)});}
    finally{inFlight.current=false;if(mounted.current){setPending(undefined);onBusyChange(false);}}
  }
  function changePrerelease(family:RuntimeFamily,value:boolean) {
    setPrerelease(current=>({...current,[family]:value}));setInvalidated(current=>({...current,[family]:true}));
    // Changing discovery policy invalidates a previously offered candidate.
    setLocal(current=>({scope,statuses:{...(current?.scope===scope?current.statuses:{}),[family]:{...(status(family)??{id:family,checking:false,installing:false}),available:undefined}}}));
  }
  function row(family:RuntimeFamily) {
    const item=status(family),installed=item?.installed,available=invalidated[family]?undefined:item?.available;
    const busy=pending===family||item?.checking||item?.installing;
    const allowed=family!=='nexus-cachyos'||cachyosInstalled||allowCachyos;
    return <section className="managed-runtime-family" key={family} aria-label={runtimeFamilyLabels[family]}>
      <h3>{runtimeFamilyLabels[family]}</h3>
      <p>{installed?ui('runtime.families_version',{version:item?.version??installed.sourceCommit.slice(0,12)}):ui('runtime.families_not_installed')}</p>
      {item?.phase?<p role="status">{item.phase}</p>:null}
      {item?.error?<p className="alert amber" role="alert">{item.error}</p>:null}
      {family==='nexus-cachyos'&&!installed?<CheckField label={ui('runtime.families_cachyos_optin')} checked={allowCachyos} disabled={active} onChange={event=>{setAllowCachyos(event.target.checked);setInvalidated(current=>({...current,'nexus-cachyos':true}));}}/>:null}
      <CheckField label={ui('runtime.families_prerelease')} checked={channel(family)} disabled={active||!allowed} onChange={event=>changePrerelease(family,event.target.checked)}/>
      {available&&item?.updateAvailable===false?<p role="status">{ui('runtime.families_current')}</p>:null}
      {available&&item?.updateAvailable!==false?<p>{ui('runtime.families_available',{version:available.version})}<br/><small>{ui('runtime.families_requires',{backend:available.requiresBackendVersion,launcher:available.requiresLauncherVersion})}</small></p>:null}
      <div className="button-row">
        <button className="secondary" disabled={active||!apiReady||!allowed} onClick={()=>void perform(family,false)}>{busy?<LoaderCircle className="spin"/>:<RefreshCw/>}{ui('ui.check_for_updates_f26f327')}</button>
        {available&&item?.updateAvailable!==false?<button className="primary" disabled={active||!apiReady||!allowed} onClick={()=>void perform(family,true)}><ArrowDownToLine/>{installed?ui('runtime.families_update',{name:runtimeFamilyLabels[family]}):ui('runtime.families_install',{name:runtimeFamilyLabels[family]})}</button>:null}
      </div>
    </section>;
  }
  return <section className="settings-card managed-runtime-settings" aria-label={ui('runtime.families_title')}>
    <h2>{ui('runtime.families_title')}</h2><p>{ui('runtime.families_help')}</p>
    {notice?.scope===scope?<p role={notice.error?'alert':'status'} className={notice.error?'alert amber':'runtime-phase'}>{notice.text}</p>:null}
    {row('nexus')}
    {experimental||cachyosInstalled?row('nexus-cachyos'):<button className="secondary" disabled={active} onClick={()=>setExperimental(true)}>{ui('runtime.families_show_cachyos')}</button>}
  </section>;
}
