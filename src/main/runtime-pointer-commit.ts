import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
interface CommitHandle { writeFile(data:string):Promise<void>; sync():Promise<void>; close():Promise<void>; }
export interface PointerCommitIO {
  open(file:string,flags:string,mode?:number):Promise<CommitHandle>;
  rename(from:string,to:string):Promise<void>;
  unlink(file:string):Promise<void>;
}
export interface PointerCommitResult {
  committed:true;
  durability:'confirmed'|'unknown';
  errors:Error[];
}
function failure(stage:string,error:unknown):Error {
  return new Error(`Runtime activation record ${stage} failed: ${error instanceof Error?error.message:String(error)}`,{cause:error});
}
/** Rename is the visibility boundary. A later sync failure cannot make the old
 * pointer active again. This persists the pointer, not the whole payload. */
export async function commitRuntimePointer(root:string,pointer:object,io:PointerCommitIO=fs):Promise<PointerCommitResult> {
  const temporary=path.join(root,'.current-'+randomUUID()+'.tmp');
  let file:CommitHandle|undefined,directory:CommitHandle|undefined,owned=false,committed=false,durable=false,stage='create';
  const errors:Error[]=[];
  try {
    file=await io.open(temporary,'wx',0o600);owned=true;
    stage='write';await file.writeFile(JSON.stringify(pointer,null,2)+'\n');
    stage='file sync';await file.sync();
    stage='file close';await file.close();file=undefined;
    // Open the directory before publication so open failure cannot publish.
    stage='directory open';directory=await io.open(root,'r');
    stage='rename';await io.rename(temporary,path.join(root,'current.json'));committed=true;owned=false;
    stage='directory sync';await directory.sync();durable=true;
  }catch(error){errors.push(failure(stage,error));}
  finally {
    if(file)try{await file.close();}catch(error){errors.push(failure('file cleanup close',error));}
    if(directory)try{await directory.close();}catch(error){errors.push(failure('directory close',error));if(committed)durable=false;}
    if(owned)try{await io.unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')errors.push(failure('temporary cleanup',error));}
  }
  if(!committed)throw new AggregateError(errors,'Runtime was not activated. '+errors.map(error=>error.message).join(' '));
  return {committed:true,durability:durable?'confirmed':'unknown',errors};
}
