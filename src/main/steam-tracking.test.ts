import { describe, expect, it } from 'vitest';
import { steamLaunchCommand } from './steam-compat.js';
import { steamTrackingRerun } from './steam-tracking.js';

const tracking = ['/s/steam-launch-wrapper', '--oom-score-adjust', '900', '--', '/s/reaper', 'SteamLaunch', 'AppId=1', '--'];
const tool = ['/s/_v2-entry-point', '--verb=waitforexitandrun', '--', '/c/proton', 'waitforexitandrun'];

describe('Steam tracking re-run', () => {
  it('runs the shortcut again inside the wrappers and the reaper, with the original LD_PRELOAD', () => {
    const plan = steamTrackingRerun(['/w/wrap', ...tracking, ...tool, '/bin/sh'], { LD_PRELOAD: '', XODUS_NEXUS_STEAM_LD_PRELOAD: '/o.so' }, '/p/launch-game', 'abc');
    expect(plan?.words).toEqual(['/w/wrap', ...tracking, '/bin/sh', '/p/launch-game', 'abc', '/w/wrap', ...tool, '/bin/sh']);
    expect(plan?.env).toMatchObject({ XODUS_NEXUS_STEAM_TRACKED: '1', LD_PRELOAD: '/o.so' });
  });

  it('hands the second run the command without the tracking, so the launch keeps its wrappers and tool', () => {
    const plan = steamTrackingRerun(['/w/wrap', ...tracking, ...tool, '/bin/sh'], {}, '/p/launch-game', 'abc');
    expect(steamLaunchCommand(plan!.words.slice(plan!.words.indexOf('abc') + 1))).toEqual(['/w/wrap', ...tool]);
    const native = steamTrackingRerun(['/w/wrap', ...tracking, '/bin/sh'], {}, '/p/launch-game', 'abc');
    expect(steamLaunchCommand(native!.words.slice(native!.words.indexOf('abc') + 1))).toEqual(['/w/wrap']);
  });

  it('does not run again inside the tracking, or without it', () => {
    expect(steamTrackingRerun([...tracking, '/bin/sh'], { XODUS_NEXUS_STEAM_TRACKED: '1' }, '/p/launch-game', 'abc')).toBeUndefined();
    expect(steamTrackingRerun(['/w/wrap', '/bin/sh'], {}, '/p/launch-game', 'abc')).toBeUndefined();
    expect(steamTrackingRerun(undefined, {}, '/p/launch-game', 'abc')).toBeUndefined();
  });
});
