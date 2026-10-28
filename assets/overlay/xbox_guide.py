#!/usr/bin/python3
"""Local Nexus Guide UI using a layer surface or a standard desktop window.

First stdin line: {url, token, monitor:{x,y,width,height}}. Further lines are
show/hide/quit, or {"command":...}. Stdout contains safe lifecycle events only.
"""

import json
import os
import re
import sys
from urllib.parse import urlsplit
from game_monitor import select_guide_monitor

SHELF_REVEAL_SCRIPT = """(()=>{const root=document.documentElement;
root.classList.remove('nexus-guide-shown');void root.offsetWidth;
root.classList.add('nexus-guide-shown');})();"""
SHELF_RESET_SCRIPT = "document.documentElement.classList.remove('nexus-guide-shown');"
SHELF_PREPARE_SCRIPT = """document.documentElement.classList.remove('nexus-guide-shown');
return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));"""


class GuideError(Exception):
    pass


def emit(event, code=None):
    value = {"event": event}
    if code is not None:
        value["code"] = code
    try:
        print(json.dumps(value, separators=(",", ":")), flush=True)
    except (BrokenPipeError, OSError):
        pass


def parse_config(line):
    try:
        value = json.loads(line)
        if not isinstance(value, dict) or not {"url", "token", "monitor"} <= set(value) or set(value) - {"url", "token", "monitor", "gamePid"}:
            raise ValueError()
        url, token, monitor = value["url"], value["token"], value["monitor"]
        if not isinstance(url, str) or len(url) > 256:
            raise ValueError()
        parsed = urlsplit(url)
        port = parsed.port
        if not port or url != f"http://127.0.0.1:{port}/overlay.html":
            raise ValueError()
        if not isinstance(token, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", token):
            raise ValueError()
        if not isinstance(monitor, dict) or set(monitor) != {"x", "y", "width", "height"}:
            raise ValueError()
        if any(type(n) is not int for n in monitor.values()):
            raise ValueError()
        if any(abs(monitor[k]) > 131072 for k in ("x", "y")):
            raise ValueError()
        if any(not 0 < monitor[k] <= 32768 for k in ("width", "height")):
            raise ValueError()
        if "gamePid" in value and (type(value["gamePid"]) is not int or not 0 < value["gamePid"] < 2**31):
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, OverflowError):
        raise GuideError("invalid-config") from None


def run(config):
    os.environ["WEBKIT_DMABUF_RENDERER_FORCE_SHM"] = "1"
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2
    except (ImportError, ValueError):
        raise GuideError("dependencies-unavailable") from None

    try:
        gi.require_version("GtkLayerShell", "0.1")
        from gi.repository import GtkLayerShell
    except (ImportError, ValueError):
        GtkLayerShell = None

    GLib.set_prgname("xodus-xbox-guide")
    GLib.set_application_name("Nexus Guide")
    initialized, _ = Gtk.init_check([])
    if not initialized:
        raise GuideError("desktop-display-unavailable")
    layered = bool(GtkLayerShell and GtkLayerShell.is_supported())

    class Guide:
        def __init__(self):
            self.ready = False
            self.closing = False
            self.pending_show = False
            self.show_generation = 0
            self.shelf_preparing = False
            self.shelf_timeout = 0
            self.shelf_cancellable = None
            self.exit_code = 0
            self.input = b""
            self.origin = config["url"].rsplit("/", 1)[0]
            self.window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
            self.window.set_title("Nexus Guide")
            self.window.set_decorated(False)
            self.window.set_skip_taskbar_hint(True)
            self.window.set_skip_pager_hint(True)
            self.window.set_app_paintable(True)
            visual = self.window.get_screen().get_rgba_visual()
            if visual is None:
                raise GuideError("transparent-surface-unavailable")
            self.window.set_visual(visual)
            css = Gtk.CssProvider()
            css.load_from_data(b"window { background-color: transparent; }")
            self.window.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
            if layered:
                GtkLayerShell.init_for_window(self.window)
                GtkLayerShell.set_respect_close(self.window, True)
                GtkLayerShell.set_namespace(self.window, "xodus-xbox-guide")
                GtkLayerShell.set_layer(self.window, GtkLayerShell.Layer.OVERLAY)
                GtkLayerShell.set_exclusive_zone(self.window, 0)
                GtkLayerShell.set_keyboard_mode(self.window, GtkLayerShell.KeyboardMode.NONE)
                for edge in (GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.BOTTOM,
                             GtkLayerShell.Edge.LEFT, GtkLayerShell.Edge.RIGHT):
                    GtkLayerShell.set_anchor(self.window, edge, True)
            else:
                self.window.set_keep_above(True)
            self.window.connect("focus-out-event", self.focus_lost)
            emit("host", "layer-shell" if layered else "desktop-window")
            self.select_monitor()
            self.window.connect("key-press-event", self.key_pressed)
            self.window.connect("key-release-event", self.key_released)
            self.window.connect("map-event", self.mapped)
            if not layered:
                self.window.connect("window-state-event", self.desktop_state_changed)
            self.window.connect("unmap-event", lambda *_: emit("hidden"))
            self.window.connect("delete-event", lambda *_: self.hide())
            self.window.connect("destroy", lambda *_: Gtk.main_quit() if Gtk.main_level() else None)

            self.context = WebKit2.WebContext.new_ephemeral()
            self.context.get_website_data_manager().set_network_proxy_settings(WebKit2.NetworkProxyMode.NO_PROXY, None)
            self.context.get_cookie_manager().set_accept_policy(WebKit2.CookieAcceptPolicy.NEVER)
            self.context.connect("download-started", lambda _context, download: download.cancel())
            manager = WebKit2.UserContentManager()
            # A URI allow-list plus a top-frame origin/path check keeps the bridge
            # secret out of error pages, redirects, frames, and unrelated origins.
            script = """(()=>{if(window===window.top&&location.origin===ORIGIN&&location.pathname==='/overlay.html'){
Object.defineProperty(window,'nexusOverlaySession',{value:TOKEN,writable:false,configurable:false,enumerable:false});}})();"""
            script = script.replace("ORIGIN", json.dumps(self.origin)).replace("TOKEN", json.dumps(config["token"]))
            manager.add_script(WebKit2.UserScript.new(
                script, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                WebKit2.UserScriptInjectionTime.START, ["http://127.0.0.1/*"], None))
            self.webview = WebKit2.WebView(web_context=self.context, user_content_manager=manager)
            settings = self.webview.get_settings()
            # Keep compositing for complete paints, using this process's SHM
            # transport to avoid the DMA-BUF explicit-sync surface path.
            settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
            for key in ("enable-developer-extras", "javascript-can-access-clipboard",
                        "javascript-can-open-windows-automatically", "enable-media-stream",
                        "enable-webrtc", "enable-media", "enable-webaudio", "enable-webgl", "enable-html5-local-storage",
                        "allow-file-access-from-file-urls", "allow-universal-access-from-file-urls"):
                if settings.find_property(key):
                    settings.set_property(key, False)
            self.webview.set_background_color(Gdk.RGBA(0, 0, 0, 0))
            self.webview.connect("permission-request", self.deny_permission)
            self.webview.connect("create", lambda *_: None)
            self.webview.connect("run-file-chooser", self.deny_file_chooser)
            self.webview.connect("context-menu", lambda *_: True)
            self.webview.connect("decide-policy", self.decide_policy)
            self.webview.connect("load-failed", lambda *_: self.fail("page-load-failed"))
            self.webview.connect("web-process-terminated", lambda *_: self.fail("web-process-terminated"))
            self.webview.connect("load-changed", self.load_changed)
            self.webview.connect("key-press-event", self.key_pressed)
            self.webview.connect("key-release-event", self.key_released)
            self.window.add(self.webview)
            self.webview.show()  # Its parent layer window remains unmapped.
            os.set_blocking(sys.stdin.fileno(), False)
            GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self.read_commands)
            GLib.timeout_add_seconds(30, self.load_timeout)
            self.webview.load_uri(config["url"])

        def select_monitor(self):
            display = Gdk.Display.get_default()
            monitor = select_guide_monitor(display, config.get("gamePid"), config["monitor"])
            if monitor is None:
                raise GuideError("game-monitor-unavailable")
            wanted = {key: getattr(monitor.get_geometry(), key) for key in ("x", "y", "width", "height")}
            index = next(i for i in range(display.get_n_monitors()) if display.get_monitor(i) == monitor)
            if layered:
                GtkLayerShell.set_monitor(self.window, monitor)
            else:
                self.window.move(wanted["x"], wanted["y"])
                self.window.resize(wanted["width"], wanted["height"])
                self.desktop_monitor_index = index
                self.window.fullscreen_on_monitor(self.window.get_screen(), index)

        def safe_page(self, uri):
            try:
                parsed = urlsplit(uri)
                return (f"{parsed.scheme}://{parsed.netloc}" == self.origin
                        and parsed.path == "/overlay.html" and not parsed.query)
            except (ValueError, TypeError):
                return False

        def decide_policy(self, _view, decision, kind):
            if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
                allowed = self.safe_page(decision.get_navigation_action().get_request().get_uri())
            elif kind == WebKit2.PolicyDecisionType.RESPONSE:
                if not decision.is_main_frame_main_resource():
                    return False
                response = decision.get_response()
                allowed = self.safe_page(response.get_uri()) and 200 <= response.get_status_code() < 300
            else:
                allowed = False
            if not allowed:
                decision.ignore()
                return True
            return False

        def deny_permission(self, _view, request):
            request.deny()
            return True

        def deny_file_chooser(self, _view, request):
            request.cancel()
            return True

        def load_changed(self, _view, event):
            if self.closing or self.ready or event != WebKit2.LoadEvent.FINISHED:
                return
            if not self.safe_page(self.webview.get_uri()):
                self.fail("page-load-failed")
                return
            self.ready = True
            emit("ready")
            if self.pending_show:
                self.show()

        def load_timeout(self):
            if not self.ready and not self.closing:
                self.fail("page-load-timeout")
            return False

        def desktop_state_changed(self, _window, event):
            if (event.changed_mask & Gdk.WindowState.FULLSCREEN
                    and event.new_window_state & Gdk.WindowState.FULLSCREEN and self.pending_show):
                self.window.present_with_time(Gdk.CURRENT_TIME)
                self.mapped()
            return False

        def mapped(self, *_):
            if self.closing or not self.pending_show or not self.shelf_preparing or self.shelf_cancellable:
                return False
            if not layered and not self.window.get_window().get_state() & Gdk.WindowState.FULLSCREEN:
                return False
            self.webview.grab_focus()
            generation = self.show_generation
            self.shelf_cancellable = Gio.Cancellable()
            if self.shelf_timeout:
                GLib.source_remove(self.shelf_timeout)
            self.shelf_timeout = GLib.timeout_add_seconds(3, self.shelf_prepare_timed_out, generation)
            try:
                # WebKit retains its last backing image across unmap. Keep that
                # image transparent until the closed shelf has crossed two
                # browser frame callbacks, then begin the new slide.
                self.webview.call_async_javascript_function(
                    SHELF_PREPARE_SCRIPT, -1, None, None, None,
                    self.shelf_cancellable, self.shelf_prepared, generation)
            except Exception:
                self.fail("shelf-prepare-failed")
            return False

        def shelf_prepared(self, view, result, generation):
            try:
                view.call_async_javascript_function_finish(result)
            except Exception:
                if generation == self.show_generation and self.shelf_preparing:
                    self.fail("shelf-prepare-failed")
                return
            if (generation != self.show_generation or self.closing
                    or not self.pending_show or not self.window.get_visible()):
                return
            if self.shelf_timeout:
                GLib.source_remove(self.shelf_timeout)
                self.shelf_timeout = 0
            self.shelf_cancellable = None
            self.shelf_preparing = False
            self.webview.set_opacity(1)
            self.update_shelf(True)
            if layered:
                GtkLayerShell.set_keyboard_mode(self.window, GtkLayerShell.KeyboardMode.ON_DEMAND)
            if not layered:
                self.focus_desktop_window()
            emit("shown")

        def shelf_prepare_timed_out(self, generation):
            if generation == self.show_generation and self.shelf_preparing:
                self.shelf_timeout = 0
                self.fail("shelf-prepare-timeout")
            return False

        def update_shelf(self, shown):
            if self.closing or not self.ready or not self.safe_page(self.webview.get_uri()):
                return
            self.webview.run_javascript(
                SHELF_REVEAL_SCRIPT if shown else SHELF_RESET_SCRIPT,
                None, None, None)

        def show(self):
            self.pending_show = True
            if not self.ready or self.closing:
                return
            try:
                self.select_monitor()
            except GuideError as error:
                self.fail(str(error))
                return
            if self.window.get_visible():
                if not self.shelf_preparing:
                    emit("shown")
                return
            self.show_generation += 1
            self.shelf_preparing = True
            self.webview.set_opacity(0)
            if layered:
                GtkLayerShell.set_keyboard_mode(self.window, GtkLayerShell.KeyboardMode.EXCLUSIVE)
            self.window.show_all()
            if not layered:
                self.window.fullscreen_on_monitor(self.window.get_screen(), self.desktop_monitor_index)
                if not self.shelf_timeout:
                    self.shelf_timeout = GLib.timeout_add_seconds(3, self.shelf_prepare_timed_out, self.show_generation)
            self.window.present_with_time(Gdk.CURRENT_TIME)

        def hide(self):
            self.pending_show = False
            self.show_generation += 1
            self.shelf_preparing = False
            if self.shelf_timeout:
                GLib.source_remove(self.shelf_timeout)
                self.shelf_timeout = 0
            if self.shelf_cancellable:
                self.shelf_cancellable.cancel()
                self.shelf_cancellable = None
            if layered:
                GtkLayerShell.set_keyboard_mode(self.window, GtkLayerShell.KeyboardMode.NONE)
            if self.window.get_visible():
                self.window.hide()
                self.update_shelf(False)
            else:
                emit("hidden")
            return True

        def focus_desktop_window(self):
            native = self.window.get_window()
            if native is None:
                return
            native.focus(Gdk.CURRENT_TIME)
            try:
                gi.require_version("GdkX11", "3.0")
                from gi.repository import GdkX11
                if not isinstance(Gdk.Display.get_default(), GdkX11.X11Display):
                    return
                # Focus only our own X11 surface; no game hooks or global input grabs.
                import ctypes
                import ctypes.util
                library = ctypes.util.find_library("X11")
                if not library:
                    return
                x11 = ctypes.CDLL(library)
                x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
                x11.XOpenDisplay.restype = ctypes.c_void_p
                x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
                x11.XFlush.argtypes = [ctypes.c_void_p]
                x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
                display = x11.XOpenDisplay(None)
                if display:
                    try:
                        x11.XSetInputFocus(display, GdkX11.X11Window.get_xid(native), 2, 0)
                        x11.XFlush(display)
                    finally:
                        x11.XCloseDisplay(display)
            except (ImportError, ValueError, OSError, AttributeError):
                pass

        def focus_lost(self, *_):
            if not self.shelf_preparing and self.window.get_visible():
                self.hide()
            return False

        def key_pressed(self, _widget, event):
            if event.keyval == Gdk.KEY_Escape:
                return True
            return False

        def key_released(self, _widget, event):
            if event.keyval == Gdk.KEY_Escape:
                # Return focus after key-up, so a held Escape is not carried
                # into the game's keyboard-enter state when this layer hides.
                self.hide()
                return True
            return False

        def fail(self, code):
            if not self.closing:
                emit("error", code)
                self.exit_code = 1
                self.quit()
            return True

        def quit(self):
            if not self.closing:
                self.closing = True
                self.hide()
                self.webview.stop_loading()
                self.window.destroy()

        def read_commands(self, fd, condition):
            try:
                chunk = os.read(fd, 4096)
                if not chunk:
                    self.quit()
                    return False
                self.input += chunk
                if len(self.input) > 8192:
                    return not self.fail("invalid-command")
                while b"\n" in self.input:
                    line, self.input = self.input.split(b"\n", 1)
                    command = line.decode("utf-8").strip()
                    if command.startswith("{"):
                        value = json.loads(command)
                        command = value.get("command") if isinstance(value, dict) and set(value) == {"command"} else None
                    if command not in ("show", "hide", "quit"):
                        return not self.fail("invalid-command")
                    getattr(self, command)()
                    if self.closing:
                        return False
                if condition & GLib.IO_ERR:
                    self.quit()
                    return False
                return True
            except BlockingIOError:
                return True
            except (OSError, UnicodeError, ValueError, TypeError):
                return not self.fail("invalid-command")

    guide = Guide()
    try:
        Gtk.main()
    finally:
        guide.quit()
    return guide.exit_code


def main():
    try:
        if sys.argv[1:] == ["--check"]:
            try:
                import gi
                gi.require_version("Gtk", "3.0")
                gi.require_version("WebKit2", "4.1")
                from gi.repository import Gtk, WebKit2
            except (ImportError, ValueError):
                raise GuideError("dependencies-unavailable") from None
            print(json.dumps({"ready": True}), flush=True)
            return 0
        if sys.argv[1:]:
            raise GuideError("invalid-config")
        # Avoid buffered read-ahead swallowing commands sent with the config.
        line = b""
        while len(line) <= 8192:
            chunk = os.read(sys.stdin.fileno(), 1)
            if not chunk:
                break
            line += chunk
            if chunk == b"\n":
                break
        if len(line) > 8192 or not line.endswith(b"\n"):
            raise GuideError("invalid-config")
        return run(parse_config(line.decode("utf-8")))
    except GuideError as error:
        emit("error", str(error))
    except (Exception, KeyboardInterrupt):
        emit("error", "overlay-host-unavailable")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
