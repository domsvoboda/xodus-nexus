import { describe, expect, it, vi } from 'vitest';
import { KeyringSupport } from './keyring.js';
import { keyringCommandFailure, KeyringMetadataError, keyringStep } from './keyring-diagnostic.js';

describe('private keyring failure diagnostics (#329)', () => {
  it.each([
    ['ENOENT', false, '', 'client-missing'], ['EACCES', false, '', 'client-permission'],
    [undefined, true, 'private wallet data', 'timeout'],
    ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', true, 'private wallet data', 'invalid-response'],
    ['ETIMEDOUT', false, 'private wallet data', 'timeout'],
    [1, false, 'Call failed: Connection timed out', 'timeout'],
    [1, false, 'org.freedesktop.DBus.Error.NoReply: private text', 'timeout'],
    [1, false, 'org.freedesktop.DBus.Error.AccessDenied: private text', 'dbus-error'],
    [1, false, 'private org.freedesktop.DBus.Error.PrivateUserName', 'unavailable'],
    [1, false, 'private stdout stderr path /home/private', 'unavailable'],
    [1, false, 'org.freedesktop.DBus.Error.NoReplyPrivate: secret', 'unavailable'],
    [1, false, 'org.freedesktop.DBus.Error.NoReply_42: secret', 'unavailable'],
  ])('classifies only allowlisted metadata: %s / %s', (code, killed, stderr, failure) => {
    const result = keyringCommandFailure(Object.assign(Error('private error'), { code, killed }) as NodeJS.ErrnoException, String(stderr));
    expect(result.failure).toBe(failure);
    expect(result.message).not.toMatch(/private|secret|home|NoReply/);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|home|Private/);
  });
  it('preserves the exact allowlisted D-Bus name but no provider prose', () => {
    expect(keyringCommandFailure({}, 'Call failed: org.freedesktop.DBus.Error.ServiceUnknown (private)'))
      .toMatchObject({ failure: 'dbus-error', dbusError: 'org.freedesktop.DBus.Error.ServiceUnknown' });
  });
  it.each(['NameHasOwner', 'ListActivatableNames', 'ReadAlias', 'StartServiceByName'])('names the %s step without its arguments', method => {
    expect(keyringStep(['service', '/private/path', 'iface', method, 's', 'private'])).toBe(method);
  });
  it('distinguishes collection discovery from lock property checks', () => {
    expect(keyringStep(['s','/private','i','Get','ss','private','Collections'])).toBe('Collections');
    expect(keyringStep(['s','/private','i','Get','ss','private','Locked'])).toBe('Locked');
  });
  it('keeps checks read-only and reports the failing step and timeout to the private logger', async () => {
    const diagnostic=vi.fn();
    const execute=vi.fn(async (_command: string,args: string[]) => {
      if(args.includes('NameHasOwner')) return JSON.stringify({type:'b',data:[true]});
      throw new KeyringMetadataError('timeout','org.freedesktop.DBus.Error.NoReply');
    });
    const support=new KeyringSupport({},execute,'linux',undefined,{diagnostic});
    expect(await support.check()).toMatchObject({state:'unavailable',canStart:false,message:expect.stringContaining('did not answer')});
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0][0]).toMatchObject({step:'ReadAlias',failure:'timeout',dbusError:'org.freedesktop.DBus.Error.NoReply',elapsedMs:expect.any(Number)});
    expect(JSON.stringify(execute.mock.calls)).not.toMatch(/StartServiceByName|Unlock|GetSecret|CreateCollection/);
  });
  it.each([
    ['ReadAlias', {type:'o',data:['/private wallet']}],
    ['Locked', {type:'v',data:[{type:'b',data:'false'}]}],
    ['Locked', {type:'v',data:[null]}],
    ['ReadAlias', null], ['ReadAlias', 'invalid-json'],
  ])('distinguishes malformed %s metadata without leaking it', async (step, reply) => {
    const diagnostic=vi.fn();
    const execute=async (_command: string,args: string[]) => {
      if(args.includes('NameHasOwner')) return JSON.stringify({type:'b',data:[true]});
      if(args.includes('ReadAlias') && step==='Locked') return JSON.stringify({type:'o',data:['/private_collection']});
      return typeof reply==='string'?reply:JSON.stringify(reply);
    };
    const support=new KeyringSupport({},execute,'linux',undefined,{diagnostic});
    expect((await support.check()).state).toBe('unavailable');
    expect(diagnostic).toHaveBeenCalledWith({step,failure:'invalid-response',dbusError:undefined,elapsedMs:expect.any(Number)});
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|invalid-json|collection/);
  });
  it('a broken logger cannot alter a failed check or expose its raw error', async () => {
    const support=new KeyringSupport({},async()=>{throw Error('secret wallet path');},'linux',undefined,{diagnostic:()=>{throw Error('logger failed');}});
    const result=await support.check();
    expect(result.state).toBe('unavailable'); expect(result.message).not.toMatch(/secret|logger/);
  });
});
