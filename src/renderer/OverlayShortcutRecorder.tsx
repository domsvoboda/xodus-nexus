import {useEffect,useState} from 'react';
import {Keyboard} from 'lucide-react';
import {overlayShortcutKey} from './overlay-shortcut-key';
import {ui} from './i18n';

export function OverlayShortcutRecorder({value,onChange}:{value:string;onChange:(shortcut:string)=>void}) {
  const [recording,setRecording]=useState(false),[ready,setReady]=useState(false),[invalid,setInvalid]=useState(false),[failed,setFailed]=useState(false);
  useEffect(()=>{
    if(!recording){setInvalid(false);return;}
    let cancelled=false;
    setReady(false);setInvalid(false);setFailed(false);
    // Release the existing global binding before listening, including when recording it again.
    void window.launcher.setXboxOverlayRecording(true).then(()=>{if(!cancelled)setReady(true);}).catch(()=>{if(!cancelled){setFailed(true);setRecording(false);}});
    const cancel=()=>setRecording(false);
    window.addEventListener('blur',cancel);
    return ()=>{
      cancelled=true;window.removeEventListener('blur',cancel);
      void window.launcher.setXboxOverlayRecording(false).catch(()=>setFailed(true));
    };
  },[recording]);
  return <>
    <button type="button" id="guide-shortcut" className="guide-shortcut-recorder" aria-pressed={recording} aria-busy={recording&&!ready} aria-describedby="guide-shortcut-help" onBlur={()=>setRecording(false)} onClick={event=>{event.currentTarget.focus();setRecording(current=>!current);}} onKeyDown={event=>{
      if(!recording)return;
      if(event.key==='Tab'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey){setRecording(false);return;}
      event.preventDefault();event.stopPropagation();
      if(event.key==='Escape'){setRecording(false);return;}
      if(!ready)return;
      try{const shortcut=overlayShortcutKey(event.nativeEvent);if(shortcut){onChange(shortcut);setRecording(false);}}
      catch{setInvalid(true);}
    }}>
      <Keyboard aria-hidden="true"/><kbd>{recording?(ready?ui('settings.guide_press_shortcut'):ui('settings.guide_prepare_shortcut')):value}</kbd><span>{recording?ui('settings.guide_cancel_recording'):ui('settings.guide_record_shortcut')}</span>
    </button>
    <small id="guide-shortcut-help" aria-live="polite">{failed?ui('settings.guide_record_failed'):invalid?ui('settings.guide_record_invalid'):recording?ui('settings.guide_record_help'):ui('settings.guide_shortcut_help')}</small>
  </>;
}
