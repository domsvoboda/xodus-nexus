import {ArrowDownToLine,CircleAlert,FolderOpen,Gamepad2,LoaderCircle,RefreshCw} from 'lucide-react';
import {StatusDot} from './StatusDot';
import {ui} from './i18n';

export interface RuntimeCardStatus {tone:'green'|'amber';label:string}

/** Shared runtime card. The default runtime and every managed family describe
 * their own verified state in exactly the same layout, so a status or version
 * difference is about the runtime itself and never about one family's surface.
 * The phase panel is progress only: an idle ready runtime keeps no stale status
 * text, so both ready cards stay identical. */
export function RuntimeFamilyCard({family,title,status,summary,errors,phase,notice,available,requires,current,log,checking,installing,importing,installLabel,importLabel,onCheck,onInstall,onImport,disabled}:{
  family:string; title:string;
  status:RuntimeCardStatus;
  summary?:string;
  errors?:string[];
  phase?:string;
  notice?:{text:string;error:boolean};
  available?:string;
  requires?:string;
  current?:boolean;
  log?:string[];
  checking:boolean; installing:boolean; importing?:boolean;
  installLabel?:string; importLabel?:string;
  onCheck:()=>void; onInstall?:()=>void; onImport?:()=>void;
  disabled:boolean;
}) {
  const busy=checking||installing||Boolean(importing);
  return <section className="settings-card managed-runtime-settings" data-runtime-family={family} aria-label={title}>
    <div className="settings-heading">
      <div className="settings-icon"><Gamepad2 /></div>
      <div><h2>{title}</h2>{summary?<p>{summary}</p>:null}</div>
      <span className={`status-label ${status.tone==='green'?'ready':'unknown'}`}><StatusDot tone={status.tone} />{status.label}</span>
    </div>
    {notice?<p role={notice.error?'alert':'status'} className={notice.error?'alert amber':'runtime-phase'}>{notice.text}</p>:null}
    {(errors??[]).map(error=><div key={error} className="alert amber" role="alert"><CircleAlert /><span>{error}</span></div>)}
    {phase&&busy?<div className="runtime-phase"><LoaderCircle className="spin" /><span>{phase}</span></div>:null}
    {available?<p>{available}{requires?<><br /><small>{requires}</small></>:null}</p>:null}
    {current?<p role="status">{ui('runtime.families_current')}</p>:null}
    {log?<pre className="build-log">{log.join('\n')||ui('ui.waiting_for_output_f05fefe')}</pre>:null}
    <div className="button-row end">
      <button className="secondary" disabled={disabled||busy} onClick={onCheck}>{checking?<LoaderCircle className="spin" />:<RefreshCw />}{ui('ui.check_for_updates_f26f327')}</button>
      {onImport&&importLabel?<button className="secondary" disabled={disabled||busy} onClick={onImport}>{importing?<LoaderCircle className="spin" />:<FolderOpen />}{importLabel}</button>:null}
      {onInstall&&installLabel?<button className="primary" disabled={disabled||busy} onClick={onInstall}>{installing?<LoaderCircle className="spin" />:<ArrowDownToLine />}{installLabel}</button>:null}
    </div>
  </section>;
}
