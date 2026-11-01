import { lstatSync, promises as fs } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acceptSteamHandoff, captureSteamLaunchEnvironment, offerSteamHandoff, steamGameEnvironment, steamHandoffRequest } from './steam-launch-context.js';

const environment = { SteamGameId:'16968485195965530112', SteamAppId:'3950780123', SDL_GAMECONTROLLERCONFIG:'synthetic mapping with spaces' };
const offers: ReturnType<typeof offerSteamHandoff>[] = [];
const leases: Awaited<ReturnType<typeof acceptSteamHandoff>>[] = [];
afterEach(() => { for (const lease of leases.splice(0)) lease.close(); for (const offer of offers.splice(0)) offer.close(); });
async function offer(timeout?: number) {
  const finished = vi.fn();
  const value = offerSteamHandoff(environment, finished, timeout); offers.push(value);
  await vi.waitFor(async () => expect((await fs.lstat(value.handoff.lease.socket)).mode & 0o777).toBe(0o600));
  return { ...value, finished };
}

it('publishes the handoff only after its socket is private, before the listen callback can run', () => {
  const f = offerSteamHandoff(environment, vi.fn()); offers.push(f);
  expect(lstatSync(f.handoff.lease.socket).mode & 0o777).toBe(0o600);
});

it('captures only bounded Steam identity and controller mappings, never arbitrary environment or secrets', () => {
  const captured = captureSteamLaunchEnvironment({ ...environment, LD_PRELOAD:'/overlay.so', DISPLAY:':123', XODUS_BRIDGE_KEY:'private', PATH:'/unwanted', PROTON_DISABLE_HIDRAW:'1' });
  expect(captured).toEqual(environment);
  for (const value of [undefined, '', '0', '-1', '123;bad', '18446744073709551616']) expect(captureSteamLaunchEnvironment({ SteamGameId:value })).toBeUndefined();
  for (const value of ['bad\0line', 'a'.repeat(32769)]) expect(() => captureSteamLaunchEnvironment({ ...environment, SDL_GAMECONTROLLERCONFIG:value })).toThrow();
  expect(captureSteamLaunchEnvironment({ ...environment, SDL_GAMECONTROLLERCONFIG:'Xbox mapping\nSteam Controller mapping\n' })?.SDL_GAMECONTROLLERCONFIG).toBe('Xbox mapping\nSteam Controller mapping\n');
  expect(() => captureSteamLaunchEnvironment({ ...environment, SDL_GAMECONTROLLER_IGNORE_DEVICES:'bad\nline' })).toThrow();
  expect(() => captureSteamLaunchEnvironment({ ...environment, SteamAppId:'bad' })).toThrow();
});

it('validates structured handoff before using its request-local environment', async () => {
  const f = await offer();
  expect(steamHandoffRequest(JSON.parse(JSON.stringify({ nexusSteam:f.handoff })))).toEqual(f.handoff);
  expect(steamHandoffRequest({ nexusShortcut:{} })).toBeUndefined();
  for (const value of [null, [], {}, { ...f.handoff, unexpected:true },
    { ...f.handoff, environment:{ ...environment, LD_PRELOAD:'/bad' } },
    { ...f.handoff, environment:{ ...environment, SteamAppId:1 } },
    { ...f.handoff, environment:{} },
    { ...f.handoff, lease:{ ...f.handoff.lease, token:'bad' } }])
    expect(() => steamHandoffRequest({ nexusSteam:value })).toThrow();
});

it('uses a copy for the current game and clears stale Steam filters, leaving desktop and Xbox flags untouched', () => {
  const base = { SteamGameId:'123', SDL_GAMECONTROLLER_IGNORE_DEVICES:'stale', DISPLAY:':1', PATH:'/bin', PROTON_DISABLE_HIDRAW:'0x1234/0xabcd' };
  expect(steamGameEnvironment(base)).toEqual(base);
  expect(steamGameEnvironment(base)).not.toBe(base);
  const changed = steamGameEnvironment(base, environment);
  expect(changed).toEqual({ DISPLAY:':1', PATH:'/bin', PROTON_DISABLE_HIDRAW:'0x1234/0xabcd', ...environment });
  expect(base.SteamGameId).toBe('123'); expect(base.SDL_GAMECONTROLLER_IGNORE_DEVICES).toBe('stale');
});

it('keeps the authenticated secondary alive until game cleanup and closes exactly once', async () => {
  const f = await offer();
  const lease = await acceptSteamHandoff(f.handoff); leases.push(lease);
  expect(f.finished).not.toHaveBeenCalled(); expect(lease.signal.aborted).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.finished).not.toHaveBeenCalled();
  lease.close();
  await vi.waitFor(() => expect(f.finished).toHaveBeenCalledTimes(1));
  await vi.waitFor(async () => expect(await fs.lstat(path.dirname(f.handoff.lease.socket)).catch(() => undefined)).toBeUndefined());
  f.close(); expect(f.finished).toHaveBeenCalledTimes(1);
});

it('propagates Steam-facing exit to the active lease without killing unrelated processes', async () => {
  const f = await offer();
  const lease = await acceptSteamHandoff(f.handoff); leases.push(lease);
  f.close();
  await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
  expect(f.finished).not.toHaveBeenCalled();
});

it('rejects a wrong secret without ending the real Steam launch', async () => {
  const f = await offer();
  await expect(acceptSteamHandoff({ ...f.handoff, lease:{ ...f.handoff.lease, token:'0'.repeat(64) } })).rejects.toThrow();
  expect(f.finished).not.toHaveBeenCalled();
  const lease = await acceptSteamHandoff(f.handoff); leases.push(lease);
  expect(lease.signal.aborted).toBe(false);
});

it('bounds unclaimed launch lifetime and rejects untrusted paths, symlinks and permissions', async () => {
  const f = await offer(250);
  for (const socket of ['/tmp/other.sock', '/tmp/nexus-steam-9999-ABCDEF/launch.sock', f.handoff.lease.socket + '/bad'])
    await expect(acceptSteamHandoff({ ...f.handoff, lease:{ ...f.handoff.lease, socket } })).rejects.toThrow();
  await fs.chmod(f.handoff.lease.socket, 0o666);
  await expect(acceptSteamHandoff(f.handoff)).rejects.toThrow('Unsafe');
  await fs.chmod(f.handoff.lease.socket, 0o600);
  await vi.waitFor(() => expect(f.finished).toHaveBeenCalledTimes(1));
});

it('rejects a symlink substituted for the handoff socket', async () => {
  const f = await offer();
  const socket = f.handoff.lease.socket, moved = socket + '.original';
  await fs.rename(socket, moved);
  try {
    await fs.symlink(moved, socket);
    await expect(acceptSteamHandoff(f.handoff)).rejects.toThrow('Unsafe');
  } finally { await fs.unlink(socket); await fs.rename(moved, socket); }
});

it('does not let unauthenticated local connections consume the lease', async () => {
  const f = await offer();
  const peer = createConnection(f.handoff.lease.socket);
  peer.on('error', () => {});
  await new Promise<void>(resolve => { peer.once('connect', () => peer.write('invalid\n')); peer.once('close', resolve); });
  expect(f.finished).not.toHaveBeenCalled();
  const lease = await acceptSteamHandoff(f.handoff); leases.push(lease);
  expect(lease.signal.aborted).toBe(false);
});
