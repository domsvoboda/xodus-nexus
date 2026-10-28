import {MessageCircle,UsersRound,X} from 'lucide-react';
export function XboxSocialIcon({name}:{name:'people'|'chat'|'close'}){const Icon=name==='people'?UsersRound:name==='chat'?MessageCircle:X;return <Icon aria-hidden="true"/>;}
