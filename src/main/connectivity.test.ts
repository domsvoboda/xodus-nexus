import { describe, expect, it } from 'vitest';
import { classifyConnectivity, ConnectivityMonitor, CONNECTIVITY_HOSTS, PROBE_TIMEOUT_MS, probeHost } from './connectivity.js';

describe('connectivity verdict', () => {
  it('is offline without a network interface, before any probe', () => {
    const status = classifyConnectivity(false, [], '2026-10-24T00:00:00.000Z');
    expect(status).toEqual({ state: 'offline', checkedAt: '2026-10-24T00:00:00.000Z', reason: 'No network interface is connected.' });
  });
  it('stays online while any Microsoft host answers', () => {
    expect(classifyConnectivity(true, [false, true], 'now').state).toBe('online');
    expect(classifyConnectivity(true, [true, true], 'now').state).toBe('online');
  });
  it('never treats an empty probe configuration as evidence of disconnection', () => {
    expect(classifyConnectivity(true, [], 'now').state).toBe('unknown');
  });
  it('is offline only when every host is unreachable or hangs', () => {
    const status = classifyConnectivity(true, [false, false], 'now');
    expect(status.state).toBe('offline');
    expect(status.reason).toContain(`${PROBE_TIMEOUT_MS / 1000} seconds`);
  });
  it('probes the hosts a launch contacts first', () => {
    expect(CONNECTIVITY_HOSTS).toEqual(['login.live.com', 'xsts.auth.xboxlive.com']);
  });
  it('reports an unreachable local port as offline without hanging', async () => {
    // Nothing listens on this port of the loopback interface; the connect is refused at once.
    expect(await probeHost('127.0.0.1', 9, 1_000)).toBe(false);
  });
});

describe('connectivity monitor', () => {
  const monitor = (answers: Record<string, boolean>, interfaceOnline = true, now = () => 1_000) => {
    const changes: string[] = [];
    const probed: string[] = [];
    const instance = new ConnectivityMonitor({
      interfaceOnline: () => interfaceOnline,
      hosts: Object.keys(answers),
      probe: async host => { probed.push(host); return answers[host]; },
      onChange: () => changes.push(instance.current.state),
      now,
    });
    return { instance, changes, probed };
  };

  it('starts unknown and announces the first verdict', async () => {
    const { instance, changes } = monitor({ a: true, b: false });
    expect(instance.current.state).toBe('unknown');
    expect((await instance.check()).state).toBe('online');
    expect(changes).toEqual(['online']);
  });
  it('reuses a fresh verdict and re-probes a stale or forced one', async () => {
    let clock = 1_000;
    const { instance, probed } = monitor({ a: false }, true, () => clock);
    expect((await instance.check()).state).toBe('offline');
    expect(probed).toHaveLength(1);
    clock += 5_000;
    await instance.check();
    expect(probed).toHaveLength(1);
    clock += 6_000;
    await instance.check();
    expect(probed).toHaveLength(2);
    await instance.check(true);
    expect(probed).toHaveLength(3);
  });
  it('skips probes without an interface and reports a change only once', async () => {
    const { instance, probed, changes } = monitor({ a: true }, false);
    await instance.check(true);
    await instance.check(true);
    expect(probed).toEqual([]);
    expect(instance.current.state).toBe('offline');
    expect(changes).toEqual(['offline']);
  });
  it('shares one probe between concurrent checks', async () => {
    const { instance, probed } = monitor({ a: true });
    await Promise.all([instance.check(true), instance.check(true), instance.check()]);
    expect(probed).toHaveLength(1);
  });
  it('treats a failing probe as unreachable', async () => {
    const instance = new ConnectivityMonitor({ interfaceOnline: () => true, hosts: ['a'], probe: async () => { throw new Error('dns'); } });
    expect((await instance.check()).state).toBe('offline');
  });
});
