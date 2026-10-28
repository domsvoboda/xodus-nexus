import type { XboxPlayerProfile } from '../shared/types';

/** Optional enrichment never delays the inbox or queues a request for every conversation. */
export class InboxProfiles {
  private stopped=false;
  constructor(private load:(id:string)=>Promise<XboxPlayerProfile>,private ready:(profile:XboxPlayerProfile)=>void){}
  async start(ids:readonly string[]):Promise<void>{
    const queue=[...new Set(ids)].slice(0,12);
    const worker=async()=>{
      while(!this.stopped){
        const id=queue.shift();if(!id)return;
        try{const profile=await this.load(id);if(!this.stopped&&profile.xuid===id)this.ready(profile);}catch{/* The inbox remains usable without optional profiles. */}
      }
    };
    await Promise.all([worker(),worker()]);
  }
  stop():void{this.stopped=true;}
}
