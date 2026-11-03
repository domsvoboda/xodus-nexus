import {useEffect,useRef,useState} from 'react';
import {RefreshCw,LoaderCircle} from 'lucide-react';
import type {AppSnapshot,ComponentUpdatePlan,ComponentUpdateBatchResult,ComponentUpdateOutcome} from '../shared/types';
import {useConfirmation} from './Confirmation';
import {ui} from './i18n';
function outcomeLabel(value:ComponentUpdateOutcome):string {
  switch(value){
    case 'updated':return ui('updates.updated');case 'unchanged':return ui('updates.unchanged');
    case 'skipped':return ui('updates.skipped');case 'stale':return ui('updates.stale');
    case 'committed-needs-attention':return ui('updates.committed_attention');
    case 'failed-before-commit':return ui('updates.failed');case 'not-run':return ui('updates.not_run');case 'deferred':return ui('updates.deferred');
  }
}
export function ComponentUpdates({data,disabled,onBusyChange}:{data:AppSnapshot;disabled:boolean;onBusyChange:(busy:boolean)=>void}) {
  const confirm=useConfirmation();
  const [local,setLocal]=useState<{scope:string;plan:ComponentUpdatePlan;result?:ComponentUpdateBatchResult}>();
  const [pending,setPending]=useState(false),[error,setError]=useState<{scope:string;text:string}>();
  // Component identities change during a successful batch. Main owns exact identity checks.
  const scope=JSON.stringify([data.settings.runtimeRoot,data.settings.market,data.auth.username,data.auth.player,data.auth.stored]);
  const live=useRef(scope),mounted=useRef(true),inFlight=useRef(false);live.current=scope;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const status=data.componentUpdates,signature=JSON.stringify(status);
  const planScopes=useRef(new Map<string,string>());
  if(status?.plan&&!planScopes.current.has(status.plan.id))planScopes.current.set(status.plan.id,scope);
  while(planScopes.current.size>16)planScopes.current.delete(planScopes.current.keys().next().value!);
  const visibleStatus=status?.plan&&planScopes.current.get(status.plan.id)===scope?status:undefined;
  useEffect(()=>setLocal(undefined),[scope,signature]);
  const plan=local?.scope===scope?local.plan:visibleStatus?.plan;
  const result=local?.scope===scope?local.result:visibleStatus?.result;
  const applicable=result&&result.planId===plan?.id?result:undefined;
  const running=pending||status?.running===true;
  const apiReady=typeof window!=='undefined'&&typeof window.launcher?.planComponentUpdates==='function'&&typeof window.launcher?.applyComponentUpdates==='function'&&typeof window.launcher?.retryComponentUpdate==='function';
  async function perform(retryId?:string) {
    if(disabled||running||inFlight.current||!apiReady)return;
    const captured=scope;inFlight.current=true;setPending(true);setError(undefined);onBusyChange(true);
    try {
      if(retryId){
        if(!plan||!applicable?.items.some(item=>item.id===retryId&&item.retryable))return;
        const next=await window.launcher.retryComponentUpdate(plan.id,retryId);
        if(mounted.current&&live.current===captured)setLocal({scope:captured,plan,result:next});
      }else{
        const next=await window.launcher.planComponentUpdates();
        if(!mounted.current||live.current!==captured)return;
        planScopes.current.set(next.id,captured);
        setLocal({scope:captured,plan:next});
        const ready=next.items.filter(item=>item.state==='ready');
        if(!ready.length)return;
        const summary=ready.map(item=>item.label+(item.targetVersion?' → '+item.targetVersion:'')).join('; ');
        const accepted=await confirm({title:ui('updates.confirm_title'),message:ui('updates.confirm_help')+' '+summary,confirmLabel:ui('updates.apply')});
        if(!accepted||!mounted.current||live.current!==captured)return;
        const batch=await window.launcher.applyComponentUpdates(next.id);
        if(mounted.current&&live.current===captured)setLocal({scope:captured,plan:next,result:batch});
      }
    }catch(reason){if(mounted.current&&live.current===captured)setError({scope:captured,text:reason instanceof Error?reason.message:String(reason)});}
    finally{inFlight.current=false;if(mounted.current){setPending(false);onBusyChange(false);}}
  }
  return <section className="settings-card component-updates" aria-label={ui('updates.title')}>
    <h2>{ui('updates.title')}</h2><p>{ui('updates.help')}</p>
    {status?.running&&status.phase?<p role="status">{status.phase}</p>:null}
    {error?.scope===scope?<p role="alert" className="alert amber">{error.text}</p>:null}
    <button className="primary" disabled={disabled||running||!apiReady} onClick={()=>void perform()}>{running?<LoaderCircle className="spin"/>:<RefreshCw/>}{ui('updates.action')}</button>
    {plan?<ul className="component-update-results" aria-label={ui('updates.results')}>
      {plan.items.map(item=>{
        const row=applicable?.items.find(result=>result.id===item.id);
        const label=row?outcomeLabel(row.outcome):item.state==='ready'?ui('updates.ready'):item.state==='unchanged'?ui('updates.unchanged'):item.state==='deferred'?ui('updates.deferred'):ui('updates.skipped');
        return <li key={item.id}><div><strong>{item.label}</strong><span>{label}</span>{item.currentVersion||item.targetVersion?<small>{item.currentVersion??'…'}{item.targetVersion?' → '+item.targetVersion:''}</small>:null}{row?.message||item.reason?<p>{row?.message??item.reason}</p>:null}</div>
          {row?.retryable?<button className="secondary" disabled={disabled||running} onClick={()=>void perform(item.id)}>{ui('updates.retry',{name:item.label})}</button>:null}
        </li>;
      })}
    </ul>:null}
    {applicable?.restartRequired?<p role="status">{ui('updates.restart_help')}</p>:null}
  </section>;
}
