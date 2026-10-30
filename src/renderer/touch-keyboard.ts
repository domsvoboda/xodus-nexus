const textTypes=new Set(['text','search','email','password','number','tel','url']);

/** Request Steam's keyboard only for a real touch on an editable text field. */
export function installTouchKeyboard(win:Window,show:()=>Promise<unknown>):()=>void{
  const pointer=(event:PointerEvent)=>{
    if(!event.isTrusted||!['touch','pen'].includes(event.pointerType))return;
    const element=event.target as HTMLInputElement|HTMLTextAreaElement|null;
    if(!element||element!==win.document.activeElement||!element.isConnected||element.disabled||element.readOnly)return;
    if(element.tagName==='TEXTAREA'||element.tagName==='INPUT'&&textTypes.has(element.type))void show().catch(()=>{});
  };
  // Chromium focuses a touched input after pointerup, before its trusted click.
  win.addEventListener('click',pointer,true);
  return ()=>win.removeEventListener('click',pointer,true);
}
