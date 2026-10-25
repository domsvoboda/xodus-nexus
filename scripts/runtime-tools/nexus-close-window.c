/*
 * nexus-close-window: ask the game owned by a Nexus launch to close itself.
 *
 * The Nexus daemon sets XODUS_NEXUS_LAUNCH_ID=<operationId> in the game's
 * environment when it starts it. When Steam kills the thin client the daemon
 * runs this helper, which finds every top-level X11 window whose owning
 * process (or one of its ancestors, because Wine reparents processes) carries
 * that exact variable and sends it a WM_DELETE_WINDOW ClientMessage. Wine's
 * X11 driver turns that into WM_CLOSE, so the game exits normally and the
 * Xbox runtime inside Wine gets to flush cloud saves before the daemon falls
 * back to SIGINT/SIGKILL.
 *
 * Matching is done only on the launch id found in /proc/<pid>/environ: never
 * on window titles or executable names. Only processes owned by the calling
 * user are inspected.
 *
 *   nexus-close-window --launch-id <id> [--timeout-ms N] [--dry-run]
 *   nexus-close-window --launch-id <id> --mark-steam-game <appid> [--watch-ms N]
 *
 * The second form never closes anything: it stamps the matching windows with
 * the STEAM_GAME property (the Steam app id), which is how gamescope learns
 * which app a window belongs to. Steam's own reaper makes that happen for
 * games it spawned; a game the Nexus daemon spawned needs it done by hand,
 * or Game Mode never shows it. With --watch-ms it keeps rescanning (0 =
 * until killed) so windows created later are stamped too. A watch also ends
 * when the process that started it (the daemon) goes away, so a daemon crash
 * never leaves a stray marker behind; the restarted daemon starts a new one.
 * SIGTERM/SIGINT (the daemon closing the game) removes STEAM_GAME again before
 * exiting, so gamescope shows Steam while the game finishes in the background.
 *
 * Exit status: 0 at least one window matched (always 0 after a mark/watch
 * run), 1 none matched, 2 on usage or X errors (no display, root window
 * unreadable).
 *
 * Build: cc -std=c99 -Wall -Wextra -Werror -O2 -o nexus-close-window \
 *          nexus-close-window.c -lX11
 */
#define _POSIX_C_SOURCE 200809L

#include <X11/Xlib.h>
#include <X11/Xatom.h>

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define LAUNCH_ID_VAR "XODUS_NEXUS_LAUNCH_ID="
#define MAX_LAUNCH_ID 256
#define MAX_ANCESTORS 32
#define RESCAN_INTERVAL_MS 250
#define MAX_WINDOWS 4096
#define PID_CACHE_SIZE 256

/* The exact "NAME=value" entry we look for, built once from the argument. */
static char needle[sizeof(LAUNCH_ID_VAR) + MAX_LAUNCH_ID];
static size_t needle_len;

static int x_error_count;

/* --mark-steam-game: the app id to stamp, or -1 to close windows instead. */
static long mark_app_id = -1;
/* --watch-ms: rescan for this long in mark mode (0 = until killed, -1 = once). */
static long watch_ms = -1;
/* Set by SIGTERM/SIGINT during a watch; the final pass then removes STEAM_GAME. */
static volatile sig_atomic_t stop_requested;
static int unmark;

static void on_stop(int sig)
{
    (void)sig;
    stop_requested = 1;
}

static int on_x_error(Display *display, XErrorEvent *error)
{
    (void)display;
    (void)error;
    /* Windows vanish between the list query and the property read; a
     * BadWindow there is routine and must not abort the scan. */
    x_error_count++;
    return 0;
}

static void usage(FILE *out)
{
    fputs("usage: nexus-close-window --launch-id <id> [--timeout-ms N] [--dry-run]\n"
          "       nexus-close-window --launch-id <id> --mark-steam-game <appid> [--watch-ms N]\n", out);
}

/* ---- /proc helpers ----------------------------------------------------- */

static int proc_path(char *buf, size_t size, long pid, const char *leaf)
{
    int n = snprintf(buf, size, "/proc/%ld/%s", pid, leaf);
    return (n > 0 && (size_t)n < size) ? 0 : -1;
}

/* True when /proc/<pid> exists and belongs to the calling user. */
static int owned_by_me(long pid)
{
    char path[64];
    struct stat st;
    if (pid <= 0 || proc_path(path, sizeof path, pid, "") != 0) return 0;
    if (stat(path, &st) != 0) return 0;
    return st.st_uid == getuid();
}

/* Open a /proc file read-only, refusing symlinks and anything not a regular
 * file owned by the calling user. Returns -1 when the pid must be ignored. */
static int open_proc_file(long pid, const char *leaf)
{
    char path[64];
    struct stat st;
    int fd;
    if (proc_path(path, sizeof path, pid, leaf) != 0) return -1;
    fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NOCTTY);
    if (fd < 0) return -1;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != getuid()) {
        close(fd);
        return -1;
    }
    return fd;
}

/* Does /proc/<pid>/environ contain exactly the needle as one entry?
 * The file is streamed in bounded chunks; an entry longer than the buffer
 * cannot be our variable and is skipped rather than grown. */
static int environ_has_launch_id(long pid)
{
    unsigned char chunk[4096];
    char entry[sizeof needle];
    size_t entry_len = 0;
    int overflow = 0, found = 0, fd;
    ssize_t got;

    fd = open_proc_file(pid, "environ");
    if (fd < 0) return 0;

    for (;;) {
        size_t i;
        got = read(fd, chunk, sizeof chunk);
        if (got < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (got == 0) break;
        for (i = 0; i < (size_t)got; i++) {
            unsigned char c = chunk[i];
            if (c == '\0') {
                if (!overflow && entry_len == needle_len && memcmp(entry, needle, needle_len) == 0) {
                    found = 1;
                    goto done;
                }
                entry_len = 0;
                overflow = 0;
            } else if (entry_len < sizeof entry) {
                entry[entry_len++] = (char)c;
            } else {
                overflow = 1;
            }
        }
    }
    /* A final entry without a trailing NUL. */
    if (!overflow && entry_len == needle_len && memcmp(entry, needle, needle_len) == 0) found = 1;
done:
    close(fd);
    return found;
}

/* Parent pid from /proc/<pid>/stat field 4; -1 when unreadable. The comm
 * field may contain spaces and parentheses, so parse after the last ')'. */
static long parent_pid(long pid)
{
    char buf[1024];
    char *close_paren;
    char state;
    long ppid;
    size_t used = 0;
    int fd;
    ssize_t got;

    fd = open_proc_file(pid, "stat");
    if (fd < 0) return -1;
    while (used < sizeof buf - 1) {
        got = read(fd, buf + used, sizeof buf - 1 - used);
        if (got < 0) {
            if (errno == EINTR) continue;
            close(fd);
            return -1;
        }
        if (got == 0) break;
        used += (size_t)got;
    }
    close(fd);
    buf[used] = '\0';

    close_paren = strrchr(buf, ')');
    if (!close_paren) return -1;
    if (sscanf(close_paren + 1, " %c %ld", &state, &ppid) != 2) return -1;
    return ppid > 0 ? ppid : -1;
}

/* The process, or any of its ancestors (bounded walk), carries the id. */
static int process_matches(long pid)
{
    int level;
    for (level = 0; level < MAX_ANCESTORS && pid > 1; level++) {
        if (!owned_by_me(pid)) return 0;
        if (environ_has_launch_id(pid)) return 1;
        pid = parent_pid(pid);
    }
    return 0;
}

/* Small per-scan cache so a process with many windows is inspected once. */
struct pid_cache {
    long pid[PID_CACHE_SIZE];
    int matched[PID_CACHE_SIZE];
    size_t count;
};

static int cached_process_matches(struct pid_cache *cache, long pid)
{
    size_t i;
    int matched;
    for (i = 0; i < cache->count; i++)
        if (cache->pid[i] == pid) return cache->matched[i];
    matched = process_matches(pid);
    if (cache->count < PID_CACHE_SIZE) {
        cache->pid[cache->count] = pid;
        cache->matched[cache->count] = matched;
        cache->count++;
    }
    return matched;
}

/* ---- X11 helpers -------------------------------------------------------- */

/* Read a format-32 property of the given type. Caller XFree()s *data. */
static int get_long_property(Display *display, Window window, Atom property, Atom type,
                             long **data, unsigned long *count)
{
    Atom actual_type = None;
    int actual_format = 0;
    unsigned long items = 0, remaining = 0;
    unsigned char *bytes = NULL;

    *data = NULL;
    *count = 0;
    if (XGetWindowProperty(display, window, property, 0, MAX_WINDOWS, False, type,
                           &actual_type, &actual_format, &items, &remaining, &bytes) != Success)
        return -1;
    if (!bytes) return -1;
    if (actual_type != type || actual_format != 32 || items == 0) {
        XFree(bytes);
        return -1;
    }
    *data = (long *)bytes;
    *count = items;
    return 0;
}

/* Fill `windows` with candidate top-level windows: _NET_CLIENT_LIST from the
 * root when an EWMH window manager publishes it, otherwise (no window manager,
 * as under a bare Xvfb) the direct children of the root window. */
static int candidate_windows(Display *display, Window root, Atom net_client_list,
                             Window *windows, unsigned long *count)
{
    long *list = NULL;
    unsigned long n = 0, i;
    Window parent_return, root_return, *children = NULL;
    unsigned int nchildren = 0;

    *count = 0;
    if (get_long_property(display, root, net_client_list, XA_WINDOW, &list, &n) == 0) {
        for (i = 0; i < n && i < MAX_WINDOWS; i++) windows[i] = (Window)list[i];
        *count = n < MAX_WINDOWS ? n : MAX_WINDOWS;
        XFree(list);
        return 0;
    }

    x_error_count = 0;
    if (!XQueryTree(display, root, &root_return, &parent_return, &children, &nchildren)) return -1;
    XSync(display, False);
    if (x_error_count) {
        if (children) XFree(children);
        return -1;
    }
    for (i = 0; i < nchildren && i < MAX_WINDOWS; i++) windows[i] = children[i];
    *count = nchildren < MAX_WINDOWS ? nchildren : MAX_WINDOWS;
    if (children) XFree(children);
    return 0;
}

static long window_pid(Display *display, Window window, Atom net_wm_pid)
{
    long *data = NULL;
    unsigned long n = 0;
    long pid;
    if (get_long_property(display, window, net_wm_pid, XA_CARDINAL, &data, &n) != 0) return -1;
    pid = data[0];
    XFree(data);
    return pid > 0 ? pid : -1;
}

static void send_delete_window(Display *display, Window window, Atom wm_protocols, Atom wm_delete_window)
{
    XEvent event;
    memset(&event, 0, sizeof event);
    event.xclient.type = ClientMessage;
    event.xclient.window = window;
    event.xclient.message_type = wm_protocols;
    event.xclient.format = 32;
    event.xclient.data.l[0] = (long)wm_delete_window;
    event.xclient.data.l[1] = CurrentTime;
    XSendEvent(display, window, False, NoEventMask, &event);
    XFlush(display);
}

/* Stamp STEAM_GAME on a window unless it already carries this app id; in the
 * final pass of a stopped watch, remove the stamp this helper put there. */
static int mark_steam_game(Display *display, Window window, Atom steam_game)
{
    long *data = NULL;
    unsigned long n = 0;
    long value = mark_app_id;
    if (get_long_property(display, window, steam_game, XA_CARDINAL, &data, &n) == 0) {
        long current = data[0];
        XFree(data);
        if (unmark) {
            if (current != mark_app_id) return 0;
            XDeleteProperty(display, window, steam_game);
            return 1;
        }
        if (current == mark_app_id) return 0;
    }
    if (unmark) return 0;
    XChangeProperty(display, window, steam_game, XA_CARDINAL, 32, PropModeReplace,
                    (unsigned char *)&value, 1);
    return 1;
}

/* One pass over the current windows. Returns the number of matches, or -1
 * when the root window could not be read (an X error). */
static long scan_once(Display *display, Window root, Atom net_client_list, Atom net_wm_pid,
                      Atom wm_protocols, Atom wm_delete_window, Atom steam_game, int dry_run, Window *windows)
{
    struct pid_cache cache;
    unsigned long count = 0, i;
    long matched = 0;

    cache.count = 0;
    if (candidate_windows(display, root, net_client_list, windows, &count) != 0) return -1;

    for (i = 0; i < count; i++) {
        long pid = window_pid(display, windows[i], net_wm_pid);
        if (pid < 0) continue;
        if (!cached_process_matches(&cache, pid)) continue;
        if (dry_run) {
            printf("match 0x%lx pid %ld\n", (unsigned long)windows[i], pid);
        } else if (mark_app_id >= 0) {
            if (mark_steam_game(display, windows[i], steam_game))
                printf("%s 0x%lx pid %ld\n", unmark ? "unmarked" : "marked", (unsigned long)windows[i], pid);
        } else {
            send_delete_window(display, windows[i], wm_protocols, wm_delete_window);
            printf("closed 0x%lx pid %ld\n", (unsigned long)windows[i], pid);
        }
        matched++;
    }
    /* Deliver pending requests and swallow BadWindow errors through the handler. */
    XSync(display, False);
    fflush(stdout);
    return matched;
}

/* ---- main --------------------------------------------------------------- */

static long elapsed_ms(const struct timespec *start)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (now.tv_sec - start->tv_sec) * 1000L + (now.tv_nsec - start->tv_nsec) / 1000000L;
}

static void sleep_ms(long ms)
{
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (ms % 1000) * 1000000L;
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR && !stop_requested) {}
}

/* A Steam app id: an unsigned 32-bit decimal. */
static int parse_app_id(const char *text, long *out)
{
    char *end = NULL;
    unsigned long value;
    errno = 0;
    value = strtoul(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || *text == '-' || value > 0xffffffffUL) return -1;
    *out = (long)value;
    return 0;
}

static int parse_timeout(const char *text, long *out)
{
    char *end = NULL;
    long value;
    errno = 0;
    value = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value < 0 || value > 86400000L) return -1;
    *out = value;
    return 0;
}

int main(int argc, char **argv)
{
    const char *launch_id = NULL;
    const char *display_name;
    long timeout_ms = 0;
    int dry_run = 0, i, status;
    size_t id_len;
    Display *display;
    Window root;
    Atom net_client_list, net_wm_pid, wm_protocols, wm_delete_window, steam_game;
    static Window windows[MAX_WINDOWS];
    struct timespec start;
    pid_t parent = getppid();

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--launch-id") == 0 && i + 1 < argc) {
            launch_id = argv[++i];
        } else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) {
            if (parse_timeout(argv[++i], &timeout_ms) != 0) {
                fputs("nexus-close-window: --timeout-ms expects a non-negative integer\n", stderr);
                return 2;
            }
        } else if (strcmp(argv[i], "--mark-steam-game") == 0 && i + 1 < argc) {
            if (parse_app_id(argv[++i], &mark_app_id) != 0) {
                fputs("nexus-close-window: --mark-steam-game expects a Steam app id\n", stderr);
                return 2;
            }
        } else if (strcmp(argv[i], "--watch-ms") == 0 && i + 1 < argc) {
            if (parse_timeout(argv[++i], &watch_ms) != 0) {
                fputs("nexus-close-window: --watch-ms expects a non-negative integer\n", stderr);
                return 2;
            }
        } else if (strcmp(argv[i], "--dry-run") == 0) {
            dry_run = 1;
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            usage(stdout);
            return 0;
        } else {
            usage(stderr);
            return 2;
        }
    }
    if (!launch_id || (watch_ms >= 0 && mark_app_id < 0)) {
        usage(stderr);
        return 2;
    }
    id_len = strlen(launch_id);
    if (id_len == 0 || id_len > MAX_LAUNCH_ID) {
        fputs("nexus-close-window: --launch-id must be 1..256 characters\n", stderr);
        return 2;
    }
    for (i = 0; launch_id[i]; i++) {
        unsigned char c = (unsigned char)launch_id[i];
        if (c < 0x21 || c > 0x7e) {
            fputs("nexus-close-window: --launch-id must be printable ASCII without spaces\n", stderr);
            return 2;
        }
    }
    memcpy(needle, LAUNCH_ID_VAR, sizeof(LAUNCH_ID_VAR) - 1);
    memcpy(needle + sizeof(LAUNCH_ID_VAR) - 1, launch_id, id_len);
    needle_len = sizeof(LAUNCH_ID_VAR) - 1 + id_len;
    needle[needle_len] = '\0';

    display_name = getenv("DISPLAY");
    display = XOpenDisplay(NULL);
    if (!display) {
        fprintf(stderr, "nexus-close-window: cannot open X display (DISPLAY=%s)\n",
                display_name ? display_name : "unset");
        return 2;
    }
    XSetErrorHandler(on_x_error);
    root = DefaultRootWindow(display);
    net_client_list = XInternAtom(display, "_NET_CLIENT_LIST", False);
    net_wm_pid = XInternAtom(display, "_NET_WM_PID", False);
    wm_protocols = XInternAtom(display, "WM_PROTOCOLS", False);
    wm_delete_window = XInternAtom(display, "WM_DELETE_WINDOW", False);
    steam_game = XInternAtom(display, "STEAM_GAME", False);

    if (mark_app_id >= 0 && watch_ms >= 0) {
        struct sigaction action;
        memset(&action, 0, sizeof action);
        action.sa_handler = on_stop;
        sigemptyset(&action.sa_mask);
        sigaction(SIGTERM, &action, NULL);
        sigaction(SIGINT, &action, NULL);
    }

    clock_gettime(CLOCK_MONOTONIC, &start);
    status = 1;
    for (;;) {
        long matched = scan_once(display, root, net_client_list, net_wm_pid,
                                 wm_protocols, wm_delete_window, steam_game, dry_run, windows);
        if (matched < 0) {
            fputs("nexus-close-window: cannot read the root window\n", stderr);
            status = 2;
            break;
        }
        if (mark_app_id >= 0 && !dry_run) {
            /* Marking: keep going for the watch window; new windows appear late. */
            status = 0;
            if (stop_requested && !unmark) {
                /* The daemon is closing the game: hand the screen back to Steam now. */
                unmark = 1;
                continue;
            }
            if (unmark) break;
            if (watch_ms < 0 || (watch_ms > 0 && elapsed_ms(&start) >= watch_ms)) break;
            /* Reparented: the daemon that owns this watch died. */
            if (getppid() != parent) break;
            sleep_ms(RESCAN_INTERVAL_MS * 2);
            continue;
        }
        if (matched > 0) {
            status = 0;
            break;
        }
        if (timeout_ms <= 0 || elapsed_ms(&start) >= timeout_ms) break;
        sleep_ms(RESCAN_INTERVAL_MS);
    }
    XCloseDisplay(display);
    return status;
}
