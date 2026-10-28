import {XboxChatDesktop} from '../XboxChatDesktop';
export function render(route:string){const xuid=/^#xbox-chat=([1-9][0-9]{0,19})$/.exec(route)?.[1];return xuid?<XboxChatDesktop key={xuid} xuid={xuid}/>:undefined;}
