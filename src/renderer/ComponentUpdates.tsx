import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,LoaderCircle} from 'lucide-react';
import type {AppSnapshot,ComponentUpdatePlan,ComponentUpdateBatchResult,ComponentUpdateOutcome} from '../shared/types';
import type {useConfirmation} from './Confirmation';
import {ui} from './i18n';

type Confirm = ReturnType<typeof useConfirmation>;
function outcomeLabel(value:ComponentUpdateOutcome):string {
  switch(value){
    case 'updated':return ui('updates.updated');case 'unchanged':return ui('updates.unchanged');
    case 'skipped':return ui('updates.skipped');case 'stale':return ui('updates.stale');
    case 'committed-needs-attention':return ui('updates.committed_attention');
    case 'failed-before-commit':return ui('updates.failed');case 'not-run':return ui('updates.not_run');case 'deferred':return ui('updates.deferred');
  }
}
function planStateLabel(state:ComponentUpdatePlan['items'][number]['state']):string {
  switch(state){
    case 'ready':return ui('updates.ready');case 'unchanged':return ui('updates.unchanged');
    case 'deferred':return ui('updates.deferred');case 'skipped':return ui('updates.skipped');
  }
}

type DiscoveryResult =
  | {status:'plan';plan:ComponentUpdatePlan}
  | {status:'blocked'}
  | {status:'stale'}
  | {status:'failed'};

/** Read-only discovery plus the explicit batch action for installed managed
 * components. Nothing is installed while rendering or while planning. */
export function useComponentUpdates({data,disabled,onBusyChange,confirm}:{data:AppSnapshot;disabled:boolean;onBusyChange:(busy:boolean)=>void;confirm:Confirm}) {
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
  const readyItems=!applicable&&plan?plan.items.filter(item=>item.state==='ready'):[];
  const running=pending||status?.running===true;
  const apiReady=typeof window!=='undefined'&&typeof window.launcher?.planComponentUpdates==='function'&&typeof window.launcher?.applyComponentUpdates==='function'&&typeof window.launcher?.retryComponentUpdate==='function';
  async function discover(): Promise<DiscoveryResult> {
    if(disabled||running||inFlight.current||!apiReady)return {status:'blocked'};
    const captured=scope;inFlight.current=true;setPending(true);setError(undefined);onBusyChange(true);
    try {
      const next=await window.launcher.planComponentUpdates();
      if(!mounted.current||live.current!==captured)return {status:'stale'};
      planScopes.current.set(next.id,captured);
      setLocal({scope:captured,plan:next});
      return {status:'plan',plan:next};
    }catch(reason){
      if(mounted.current&&live.current===captured){setError({scope:captured,text:reason instanceof Error?reason.message:String(reason)});return {status:'failed'};}
      return {status:'stale'};
    }
    finally{inFlight.current=false;if(mounted.current){setPending(false);onBusyChange(false);}}
  }
  async function apply() {
    if(disabled||running||inFlight.current||!apiReady)return;
    const captured=scope;inFlight.current=true;setPending(true);setError(undefined);onBusyChange(true);
    try {
      let target=plan;
      if(!target||target.id===applicable?.planId||planScopes.current.get(target.id)!==captured) {
        const next=await window.launcher.planComponentUpdates();
        if(!mounted.current||live.current!==captured)return;
        planScopes.current.set(next.id,captured);
        setLocal({scope:captured,plan:next});
        target=next;
      }
      const ready=target.items.filter(item=>item.state==='ready');
      if(!ready.length)return;
      const summary=ready.map(item=>item.label+(item.targetVersion?' \u2192 '+item.targetVersion:'')).join('; ');
      const accepted=await confirm({title:ui('updates.confirm_title'),message:ui('updates.confirm_help')+' '+summary,confirmLabel:ui('updates.apply')});
      if(!accepted||!mounted.current||live.current!==captured)return;
      const batch=await window.launcher.applyComponentUpdates(target.id);
      if(mounted.current&&live.current===captured)setLocal({scope:captured,plan:target,result:batch});
    }catch(reason){if(mounted.current&&live.current===captured)setError({scope:captured,text:reason instanceof Error?reason.message:String(reason)});}
    finally{inFlight.current=false;if(mounted.current){setPending(false);onBusyChange(false);}}
  }
  async function retry(itemId:string) {
    if(disabled||running||inFlight.current||!apiReady)return;
    if(!plan||!applicable?.items.some(item=>item.id===itemId&&item.retryable))return;
    const captured=scope;inFlight.current=true;setPending(true);setError(undefined);onBusyChange(true);
    try {
      const batch=await window.launcher.retryComponentUpdate(plan.id,itemId);
      if(mounted.current&&live.current===captured)setLocal({scope:captured,plan,result:batch});
    }catch(reason){if(mounted.current&&live.current===captured)setError({scope:captured,text:reason instanceof Error?reason.message:String(reason)});}
    finally{inFlight.current=false;if(mounted.current){setPending(false);onBusyChange(false);}}
  }
  const action=readyItems.length>0
    ? <button className="primary" disabled={disabled||running||!apiReady} onClick={()=>void apply()}>{running?<LoaderCircle className="spin"/>:<ArrowDownToLine/>}{ui('updates.action')}</button>
    : undefined;
  const showPlan=Boolean(plan)&&(applicable!==undefined||readyItems.length===0);
  const phaseNotice=status?.running&&status.phase?status.phase:undefined;
  const hasDetails=Boolean(phaseNotice)||error?.scope===scope||showPlan||applicable?.restartRequired;
  const details=hasDetails?<div className="component-update-details">
    {phaseNotice?<p role="status" className="runtime-phase"><LoaderCircle className="spin"/><span>{phaseNotice}</span></p>:null}
    {error?.scope===scope?<p role="alert" className="alert amber">{error.text}</p>:null}
    {showPlan&&plan?<ul className="component-update-results" aria-label={ui('updates.results')}>
      {plan.items.map(item=>{
        const row=applicable?.items.find(result=>result.id===item.id);
        const label=row?outcomeLabel(row.outcome):planStateLabel(item.state);
        return <li key={item.id}><div><strong>{item.label}</strong><span>{label}</span>{item.currentVersion||item.targetVersion?<small>{item.currentVersion??'\u2026'}{item.targetVersion?' \u2192 '+item.targetVersion:''}</small>:null}{row?.message||item.reason?<p>{row?.message??item.reason}</p>:null}</div>
          {row?.retryable?<button className="secondary" disabled={disabled||running} onClick={()=>void retry(item.id)}>{ui('updates.retry',{name:item.label})}</button>:null}
        </li>;
      })}
    </ul>:null}
    {applicable?.restartRequired?<p role="status">{ui('updates.restart_help')}</p>:null}
  </div>:undefined;
  return {action,details,discover};
}
