#!/usr/bin/python3
"""Account-free monitor routing and game process association regressions."""
import importlib.util
import os
import json
import sys
from pathlib import Path
from types import SimpleNamespace as NS

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("game_monitor", root / "assets/overlay/game_monitor.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.modules['game_monitor'] = module
host_spec = importlib.util.spec_from_file_location('guide_host', root / 'assets/overlay/xbox_guide.py')
host = importlib.util.module_from_spec(host_spec)
host_spec.loader.exec_module(host)


def rect(x, y, w, h):
    return NS(x=x, y=y, width=w, height=h)


class Monitor:
    def __init__(self, geometry):
        self.geometry = geometry
    def get_geometry(self):
        return self.geometry


class Window:
    def __init__(self, pid, geometry, visible=True):
        self.pid, self.geometry, self.visible = pid, geometry, visible
    def get_frame_extents(self):
        return self.geometry
    def is_visible(self):
        return self.visible


left = Monitor(rect(0, 187, 1920, 1080))
right = Monitor(rect(1920, 0, 2560, 1440))
groups = {100: 100, 101: 100, 102: 100, 200: 200, 201: 200}
def group(pid):
    if pid not in groups:
        raise ProcessLookupError()
    return groups[pid]
def choose(windows, monitors=(left, right)):
    return module.choose_game_monitor(windows, monitors, 100, lambda w: w.pid, group)

cases = []
game = Window(101, rect(1920, 0, 2560, 1440))
desktop = Window(200, rect(0, 187, 1920, 1080))
assert choose([desktop, game]) is right
cases.append("game-on-right-not-unrelated-left-desktop")
assert choose([game, desktop]) is right
cases.append("another-active-window-does-not-change-game-display")
game.geometry = rect(0, 187, 1920, 1080)
assert choose([desktop, game]) is left
cases.append("moved-game-is-recomputed-on-each-open")
game.geometry = rect(1800, 200, 1000, 700)
assert choose([desktop, game]) is right
cases.append("straddling-window-uses-largest-monitor-intersection")
assert choose([Window(101, rect(1920, 0, 2560, 1440)), Window(102, rect(20, 200, 300, 100))]) is right
cases.append("large-game-window-wins-over-small-own-splash")
assert choose([Window(101, rect(1920, 0, 2560, 1440), False), desktop]) is None
cases.append("hidden-or-unrelated-windows-are-not-a-game")
assert choose([Window(999, rect(1920, 0, 2560, 1440)), desktop]) is None
cases.append("exited-process-cannot-select-a-display")
assert choose([Window(101, rect(9000, 0, 100, 100))]) is None
cases.append("disconnected-monitor-is-not-reused")
negative = Monitor(rect(-1920, -100, 1920, 1080))
assert choose([Window(101, rect(-1800, 0, 900, 800))], [negative, right]) is negative
cases.append("negative-monitor-origins")
scaled = Monitor(rect(1280, 0, 1707, 960))
assert choose([Window(101, rect(1280, 0, 1707, 960))], [left, scaled]) is scaled
cases.append("logical-gtk-coordinates-handle-scaled-output")
for pid in (None, True, -1, 0, 2**31, "101"):
    assert not module.same_game_process(pid, 100, group)
assert not module.same_game_process(201, 100, group)
assert not module.same_game_process(101, 101, group)
cases.append("exact-generated-launch-group-only")
config = {'url':'http://127.0.0.1:54321/overlay.html','token':'a'*64,'monitor':{'x':0,'y':0,'width':1920,'height':1080},'gamePid':100}
assert host.parse_config(json.dumps(config))['gamePid']==100
for pid in (True,0,-1,2**31,'100'):
    try:
        host.parse_config(json.dumps({**config,'gamePid':pid}))
        raise AssertionError('invalid PID accepted')
    except host.GuideError:
        pass
cases.append('bounded-integer-launch-identity-config')

class Display:
    def __init__(self, monitors, active_window=None):
        self.monitors, self.active_window = monitors, active_window
    def get_n_monitors(self): return len(self.monitors)
    def get_monitor(self, index): return self.monitors[index]
    def get_primary_monitor(self): return self.monitors[0] if self.monitors else None
    def get_default_screen(self): return NS(get_active_window=lambda: self.active_window)
    def get_monitor_at_window(self, window): return right
    def get_default_seat(self): return None

display = Display([left, right])
fallback = vars(left.geometry)
assert module.select_guide_monitor(display, 100, fallback, lambda *_: right, lambda _: left) is right
cases.append('actual-game-display-wins-over-active-output')
assert module.select_guide_monitor(display, 100, fallback, lambda *_: None, lambda _: right) is right
cases.append('unresolved-game-opens-on-kde-active-output')
def unsupported(*_): raise ValueError('native-wayland-window-not-exposed')
assert module.select_guide_monitor(display, 100, fallback, unsupported, lambda _: right) is right
cases.append('unavailable-x11-metadata-does-not-block-guide')
assert module.select_guide_monitor(Display([left, right], game), 100, fallback, lambda *_: None, lambda _: None) is right
cases.append('active-x11-window-before-primary-fallback')
assert module.select_guide_monitor(display, 100, fallback, lambda *_: None, lambda _: None) is left
assert module.select_guide_monitor(display, 100, vars(rect(9000,0,1,1)), lambda *_: None, lambda _: None) is left
cases.append('no-window-metadata-still-opens-on-available-display')
assert module.select_guide_monitor(Display([]), 100, fallback, lambda *_: None, lambda _: None) is None
cases.append('only-no-connected-displays-blocks-guide')
print({"passed": True, "cases": cases})
