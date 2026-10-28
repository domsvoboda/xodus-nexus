import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {spawnTracked} from './process.js';
import {externalLauncherEnvironment} from './launcher-environment.js';

type Job={id:number;args:string[];input?:string;signal:AbortSignal;resolve:(output:string)=>void;reject:(error:Error)=>void;abort:()=>void;finished?:boolean};
class SocialBroker {
  private readonly child:ChildProcessWithoutNullStreams;
  private readonly decoder=new StringDecoder('utf8');
  private buffer='';private diagnostic='';private sequence=0;
  private readonly queue:Job[]=[];private active?:Job;private timer?:ReturnType<typeof setTimeout>;
  dead=false;
  constructor(readonly binary:string,private readonly failure:(diagnostic:string)=>Error){
    this.child=spawn(binary,['native-social','listen'],{env:externalLauncherEnvironment({...process.env,XODUS_LOG:'error'}),stdio:['pipe','pipe','pipe']});
    this.child.stdin.on('error',()=>this.close());
    this.child.stderr.on('data',(bytes:Buffer)=>{this.diagnostic=(this.diagnostic+bytes.toString('utf8')).slice(-8192);});
    this.child.stdout.on('data',(bytes:Buffer)=>this.receive(bytes));
    this.child.once('error',()=>this.close());this.child.once('close',()=>this.close());
  }
  request(args:string[],input:string|undefined,signal:AbortSignal):Promise<string>{
    signal.throwIfAborted();
    if(this.dead)return Promise.reject(Error('Xbox social helper disconnected. Try again.'));
    if(this.queue.length>=32)return Promise.reject(Error('Xbox social is busy. Try again in a moment.'));
    return new Promise((resolve,reject)=>{
      const job:Job={id:++this.sequence,args,input,signal,resolve,reject,abort:()=>{
        if(this.active===job){this.finish(job,undefined,Error('Xbox social request cancelled.'));return;}
        const index=this.queue.indexOf(job);if(index!==-1){this.queue.splice(index,1);this.finish(job,undefined,Error('Xbox social request cancelled.'));}
      }};
      signal.addEventListener('abort',job.abort,{once:true});
      // Interactive chat must not wait behind a batch of optional profile reads.
      if(args[0]==='conversation'||args[0]==='send-message'){
        const optional=this.queue.findIndex(value=>!['conversation','send-message'].includes(value.args[0]));
        if(optional<0)this.queue.push(job);else this.queue.splice(optional,0,job);
      }else this.queue.push(job);
      if(signal.aborted)job.abort();else this.pump();
    });
  }
  private finish(job:Job,output?:string,error?:Error):void{
    if(job.finished)return;job.finished=true;
    job.signal.removeEventListener('abort',job.abort);
    if(error)job.reject(error);else job.resolve(output!);
  }
  private pump():void{
    if(this.dead||this.active)return;
    const job=this.queue.shift();if(!job)return;
    if(job.signal.aborted){this.finish(job,undefined,Error('Xbox social request cancelled.'));this.pump();return;}
    this.active=job;this.diagnostic='';
    this.timer=setTimeout(()=>this.close(),job.args[0]==='send-message'?60_000:50_000);this.timer.unref();
    this.child.stdin.write(JSON.stringify({id:job.id,args:job.args,input:job.input??null})+'\n');
  }
  private receive(bytes:Buffer):void{
    if(this.dead)return;this.buffer+=this.decoder.write(bytes);
    if(this.buffer.length>8_000_000){this.close();return;}
    let end:number;
    while((end=this.buffer.indexOf('\n'))!==-1){
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      const job=this.active;if(!job){this.close();return;}
      let frame:any;try{frame=JSON.parse(line);}catch{this.close();return;}
      if(!frame||frame.id!==job.id||typeof frame.ok!=='boolean'||(frame.ok?(!frame.result||typeof frame.result!=='object'):!/^([a-z-]{1,64})$/.test(frame.stage))){this.close();return;}
      clearTimeout(this.timer);this.active=undefined;
      if(frame.ok)this.finish(job,JSON.stringify(frame.result));
      else this.finish(job,undefined,this.failure(`${this.diagnostic}\nXbox social unavailable (${frame.stage}).`));
      this.pump();
    }
  }
  close():void{
    if(this.dead)return;this.dead=true;clearTimeout(this.timer);
    const jobs=[...(this.active?[this.active]:[]),...this.queue.splice(0)];this.active=undefined;
    for(const job of jobs)this.finish(job,undefined,Error('Xbox social helper disconnected. The request was not retried.'));
    this.child.kill('SIGTERM');this.child.stdin.destroy();
  }
}
let broker:SocialBroker|undefined;
const support=new Map<string,Promise<boolean>>();
export async function supportsSocialBroker(binary:string):Promise<boolean>{
  let check=support.get(binary);
  if(!check){
    check=(async()=>{
      const task=spawnTracked(binary,['native-social','--help'],{stdoutOnly:true,maxOutput:50_000,env:{...process.env,XODUS_LOG:'error'}});
      const timer=setTimeout(()=>task.child.kill('SIGTERM'),5000);timer.unref();task.child.stdin.end();
      try{const result=await task.result;return result.code===0&&/(?:^|\n)\s*listen(?:\s|$)/mi.test(result.output);}catch{return false;}finally{clearTimeout(timer);}
    })();support.set(binary,check);
  }
  return check;
}
export function readSocialBroker(binary:string,args:string[],input:string|undefined,signal:AbortSignal,failure:(diagnostic:string)=>Error):Promise<string>{
  if(!broker||broker.dead||broker.binary!==binary){broker?.close();broker=new SocialBroker(binary,failure);}
  return broker.request(args,input,signal);
}
export function resetSocialTransport():void{broker?.close();broker=undefined;}
