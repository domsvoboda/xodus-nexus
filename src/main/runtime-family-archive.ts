import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
// Python is already required by Proton. Isolated stdlib parsing avoids tar
// text-listing ambiguities and never follows archive links while writing.
const extractor = String.raw `
import os,sys,tarfile,posixpath,shutil,lzma,resource
resource.setrlimit(resource.RLIMIT_AS,(1024**3,1024**3))
class BoundedInput:
 def __init__(self,source): self.source=source
 def read(self,count=-1):
  if count<0 or count>2*1024*1024 or self.source.tell()+count>budget: raise ValueError('Archive decoded metadata exceeds limit')
  return self.source.read(count)
 def seek(self,offset,whence=0):
  if whence not in (0,1): raise ValueError('Unsupported archive seek')
  position=offset+(self.source.tell() if whence==1 else 0)
  if position<0 or position>budget: raise ValueError('Archive decoded position exceeds limit')
  return self.source.seek(offset,whence)
 def tell(self): return self.source.tell()
archive,stage,top,maximum=sys.argv[1:];budget=int(maximum)
if os.path.islink(stage) or not os.path.isdir(stage) or os.listdir(stage): raise ValueError('Owned empty staging directory required')
seen={}; total=0; links={}; directories=[]
def name(value):
 if not isinstance(value,str) or not value or len(value)>4096 or '\\' in value or any(ord(c)<32 or ord(c)==127 for c in value) or value.startswith('/'): raise ValueError('Unsafe archive path')
 parts=value.rstrip('/').split('/')
 if any(p in ('','.','..') for p in parts) or len(parts)>64 or parts[0]!=top: raise ValueError('Archive leaves selected runtime root')
 return '/'.join(parts)
with lzma.open(archive,'rb') as decoded, tarfile.open(fileobj=BoundedInput(decoded),mode='r:') as tf:
 for member in tf:
  key=name(member.name)
  if key in seen or len(seen)>=200000: raise ValueError('Duplicate or excessive archive entries')
  if member.type not in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE,tarfile.SYMTYPE,tarfile.LNKTYPE): raise ValueError('Unsupported archive entry type')
  if member.size<0 or member.size>8*1024**3: raise ValueError('Archive entry exceeds limit')
  total+=member.size
  if total>budget: raise ValueError('Expanded runtime exceeds limit')
  seen[key]=member
  if member.issym() or member.islnk(): links[key]=member
 if top not in seen or not seen[top].isdir(): raise ValueError('Missing runtime root directory')
 for key,member in seen.items():
  parent=posixpath.dirname(key)
  while parent:
   if parent in links: raise ValueError('Archive writes through a link')
   if parent in seen and not seen[parent].isdir(): raise ValueError('Archive parent is not a directory')
   parent=posixpath.dirname(parent)
 for key,member in links.items():
  target=member.linkname
  if member.islnk():
   target=name(target)
   trail=set()
   while target in links and links[target].islnk():
    if target in trail: raise ValueError('Cyclic archive hardlink')
    trail.add(target);target=name(links[target].linkname)
   if target not in seen or not seen[target].isreg(): raise ValueError('Hardlink must resolve to an archived regular file')
   total+=seen[target].size
   if total>budget: raise ValueError('Expanded hardlink copies exceed limit')
  else:
   special=key==top+'/files/share/default_pfx/dosdevices/z:' and target=='/'
   if not target or '\\' in target or any(ord(c)<32 or ord(c)==127 for c in target): raise ValueError('Unsafe link target')
   resolved=posixpath.normpath(posixpath.join(posixpath.dirname(key),target))
   if not special and (target.startswith('/') or not resolved.startswith(top+'/')): raise ValueError('Archive link escapes runtime')
 # Resolve every symlink chain, including links in intermediate directories,
 # before creating even the first payload file. z: is never followed.
 inferred=set()
 for key in seen:
  parent=posixpath.dirname(key)
  while parent: inferred.add(parent);parent=posixpath.dirname(parent)
 def resolve_virtual(key,trail):
  if key in trail: raise ValueError('Cyclic archive link')
  parts=key.split('/')
  for length in range(1,len(parts)+1):
   prefix='/'.join(parts[:length])
   if prefix in seen and not seen[prefix].isdir() and prefix not in links and length<len(parts): raise ValueError('Archive link traverses a non-directory')
   if prefix in links:
    item=links[prefix]
    if prefix==top+'/files/share/default_pfx/dosdevices/z:' and item.linkname=='/': raise ValueError('Archive link follows external template mapping')
    target=name(item.linkname) if item.islnk() else posixpath.normpath(posixpath.join(posixpath.dirname(prefix),item.linkname))
    if not target.startswith(top+'/'): raise ValueError('Archive link escapes runtime')
    if length<len(parts): target=posixpath.join(target,*parts[length:])
    return resolve_virtual(target,trail|{key})
  if key not in seen and key not in inferred: raise ValueError('Dangling archive link')
  return key
 for key,item in links.items():
  if key==top+'/files/share/default_pfx/dosdevices/z:' and item.linkname=='/': continue
  if item.issym():
   stack=[]
   for part in posixpath.join(posixpath.dirname(key),item.linkname).split('/'):
    if part=='..':
     previous=resolve_virtual('/'.join(stack),{key})
     if previous in seen and not seen[previous].isdir(): raise ValueError('Archive parent traversal crosses a non-directory')
     stack.pop()
    elif part not in ('','.'): stack.append(part)
  resolve_virtual(key,set())
 # Only after every header has passed, materialize files into private staging.
 for key,member in seen.items():
  destination=os.path.join(stage,*key.split('/'))
  if member.isdir(): os.makedirs(destination,mode=0o700,exist_ok=True);directories.append((destination,member.mode&0o777))
  elif member.isreg():
   os.makedirs(os.path.dirname(destination),mode=0o700,exist_ok=True)
   fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,member.mode&0o777)
   with os.fdopen(fd,'wb') as out,tf.extractfile(member) as data: shutil.copyfileobj(data,out,1024*1024)
 for key,member in links.items():
  destination=os.path.join(stage,*key.split('/'));os.makedirs(os.path.dirname(destination),mode=0o700,exist_ok=True)
  if member.islnk():
   target=name(member.linkname)
   while target in links and links[target].islnk(): target=name(links[target].linkname)
   # Copy bytes instead of creating filesystem hardlinks.
   with open(os.path.join(stage,*target.split('/')),'rb') as source:
    fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,member.mode&0o777)
    with os.fdopen(fd,'wb') as out: shutil.copyfileobj(source,out,1024*1024)
  else: os.symlink(member.linkname,destination)
 for destination,mode in sorted(directories,key=lambda x:len(x[0]),reverse=True): os.chmod(destination,mode)
print('Runtime archive materialized safely')
`;
export async function materializeRuntimeArchive(archive: string, stage: string, top: string, maximumExpandedBytes = 32 * 1024 ** 3): Promise<string> {
    if (!Number.isSafeInteger(maximumExpandedBytes) || maximumExpandedBytes <= 0 || maximumExpandedBytes > 32 * 1024 ** 3)
        throw Error('Invalid runtime expansion limit');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(top) || top.includes('..'))
        throw Error('Invalid runtime archive root');
    if (!(await fs.lstat(stage)).isDirectory() || (await fs.readdir(stage)).length)
        throw Error('Owned empty runtime staging directory required');
    try {
        await execute('python3', ['-I', '-c', extractor, archive, stage, top, String(maximumExpandedBytes)], {
            timeout: 600000, maxBuffer: 1024 * 1024
        });
    }
    catch (error) {
        const failure = error as NodeJS.ErrnoException & {
            stderr?: string;
            killed?: boolean;
        };
        if (failure.code === 'ENOENT')
            throw Error('Python 3 is required to install managed runtimes.');
        if (failure.killed)
            throw Error('The runtime archive could not be unpacked within the allowed time.');
        const reason = failure.stderr?.trim().split('\n').at(-1)?.slice(0, 240);
        throw new Error('The runtime archive failed safety checks.' + (reason ? ' ' + reason : ''), {
            cause: error
        });
    }
    return path.join(stage, top);
}
