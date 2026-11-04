import {XboxVoiceHost} from '../XboxVoiceHost';
export function render({route}:{route:string}){return route==='#xbox-media'?<XboxVoiceHost api={window.launcher}/>:undefined;}
