import {useEffect,useState} from 'react';
import {UserRound} from 'lucide-react';

/** The Xbox image service requires dimensions for some legacy gamerpics. */
export function xboxGamerpicSource(src:string|undefined|null,size:64|128|208):string|undefined{
 if(!src)return undefined;
 try{const url=new URL(src);if(url.protocol==='https:'&&url.hostname==='images-eds-ssl.xboxlive.com'&&!url.username&&!url.password&&!url.port){url.searchParams.set('w',String(size));url.searchParams.set('h',String(size));return url.href;}}catch{}
 return src;
}
export function XboxAvatar({src,name,online,className='',size=64}:{src?:string|null;name?:string;online?:boolean;className?:string;size?:64|128|208}){
 const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);
 return <span className={'social-gamerpic '+className+(online?' is-online':'')} aria-hidden="true">
  {src&&!failed?<img src={xboxGamerpicSource(src,size)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:name?<span>{name[0]?.toUpperCase()}</span>:<UserRound/>}
 </span>;
}
export function XboxGamertag({name}:{name:string}){
 const match=/^(.*)(#[0-9]+)$/.exec(name);
 return <>{match?<>{match[1]}<span className="social-gamertag-suffix">{match[2]}</span></>:name}</>;
}
