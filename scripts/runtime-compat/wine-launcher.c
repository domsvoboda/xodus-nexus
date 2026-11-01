/* SPDX-License-Identifier: MIT
 * Runtime staging in owner-private Xodus launch views. No title selection,
 * original-game writes or import-table hooks. Temporary version metadata
 * is enabled by default; NEXUS_GAMING_SERVICES_VERSION_OVERRIDE=0 opts out.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include "pgs-exports.h"
static uint16_t u16(const unsigned char *p) { return p[0] | (uint16_t)p[1] << 8; }
static uint32_t u32(const unsigned char *p) { return u16(p) | (uint32_t)u16(p + 2) << 16; }
static int range(size_t size, size_t offset, size_t count) { return offset <= size && count <= size - offset; }
/* Decimal-only inherited descriptors; avoid C23 strtol's newer glibc ABI. */
static int parse_fd(const char *text, const char **colon)
{
    const char *p = text; int value = 0;
    if (*p < '0' || *p > '9') return -1;
    while (*p >= '0' && *p <= '9') {
        int digit = *p++ - '0';
        if (value > (INT_MAX - digit) / 10) return -1;
        value = value * 10 + digit;
    }
    if (*p != ':') return -1;
    *colon = p; return value;
}
static size_t rva(const unsigned char *p, size_t size, size_t sections, unsigned count, uint32_t address, size_t length)
{
    for (unsigned i = 0; i < count; ++i) {
        const unsigned char *s = p + sections + i * 40;
        uint32_t start = u32(s + 12), raw = u32(s + 16), offset = u32(s + 20);
        if (address >= start && range(raw, address - start, length) && range(size, offset, raw))
            return (size_t)offset + address - start;
    }
    return SIZE_MAX;
}
/* 1: original SDK, 2: adapter. Unknown exports/ordinals remain unsupported. */
static int sdk_contract(int fd)
{
    struct stat st;
    unsigned char *p;
    size_t pe, optional, sections, exports, names, ordinals, functions;
    unsigned count, n;
    int ok = 0, adapter = 0;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 256 || st.st_size > 268435456) return 0;
    size_t size = (size_t)st.st_size;
    p = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (p == MAP_FAILED) return 0;
    if (u16(p) != 0x5a4d) goto done;
    pe = u32(p + 60);
    if (!range(size, pe, 24) || memcmp(p + pe, "PE\0\0", 4) || u16(p + pe + 4) != 0x8664) goto done;
    optional = pe + 24; count = u16(p + pe + 6); n = u16(p + pe + 20);
    sections = optional + n;
    if (n < 120 || !range(size, optional, n) || u16(p + optional) != 0x20b ||
        u32(p + optional + 108) < 1 || !range(size, sections, (size_t)count * 40)) goto done;
    exports = rva(p, size, sections, count, u32(p + optional + 112), 40);
    if (exports == SIZE_MAX || u32(p + exports + 20) != PGS_EXPORT_COUNT ||
        u32(p + exports + 24) != PGS_EXPORT_COUNT || u32(p + exports + 16) != 1) goto done;
    names = rva(p, size, sections, count, u32(p + exports + 32), PGS_EXPORT_COUNT * 4);
    ordinals = rva(p, size, sections, count, u32(p + exports + 36), PGS_EXPORT_COUNT * 2);
    functions = rva(p, size, sections, count, u32(p + exports + 28), PGS_EXPORT_COUNT * 4);
    if (names == SIZE_MAX || ordinals == SIZE_MAX || functions == SIZE_MAX) goto done;
    for (unsigned i = 0; i < PGS_EXPORT_COUNT; ++i) {
        size_t length = strlen(pgs_exports[i]) + 1;
        size_t name = rva(p, size, sections, count, u32(p + names + i * 4), length);
        if (name == SIZE_MAX || memcmp(p + name, pgs_exports[i], length) ||
            u16(p + ordinals + i * 2) != i || !u32(p + functions + i * 4)) goto done;
        /* A proxy has the same public exports as the SDK. Never preserve it
         * as the original: its forwards would recursively load itself. */
        uint32_t function = u32(p + functions + i * 4), start = u32(p + optional + 112);
        if (function >= start && function - start < u32(p + optional + 116)) {
            static const char prefix[] = "nexus_pgs_native.";
            size_t forward = rva(p, size, sections, count, function, sizeof(prefix) - 1);
            if (forward == SIZE_MAX) goto done;
            if (!strncasecmp((const char *)p + forward, prefix, sizeof(prefix) - 1)) adapter = 1;
        }
    }
    ok = adapter ? 2 : 1;
done:
    munmap(p, size); return ok;
}
static int mapped_fd(const char *map, const char *path)
{
    if (!map) return -1;
    size_t length = strlen(path);
    for (const char *item = map; *item;) {
        const char *end = strchr(item, '|'); if (!end) end = item + strlen(item);
        const char *colon;
        int fd = parse_fd(item, &colon);
        if (fd >= 0) {
            const char *nt = colon + 1;
            if ((size_t)(end - nt) == length + 6 && !strncmp(nt, "\\??\\Z:", 6)) {
                int match = 1;
                for (size_t i = 0; i < length; ++i) if ((nt[i + 6] == '\\' ? '/' : nt[i + 6]) != path[i]) { match = 0; break; }
                if (match) return (int)fd;
            }
        }
        item = *end ? end + 1 : end;
    }
    return -1;
}
static int copy_fd(int source, int directory, const char *name)
{
    char temporary[128];
    snprintf(temporary, sizeof(temporary), ".nexus-pgs-%ld-%s", (long)getpid(), name);
    int output = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (output < 0) return -1;
    char bytes[65536]; off_t offset = 0; ssize_t n; int result = -1;
    while ((n = pread(source, bytes, sizeof(bytes), offset)) > 0) {
        ssize_t written = 0;
        while (written < n) {
            ssize_t m = write(output, bytes + written, (size_t)(n - written));
            if (m < 0 && errno == EINTR) continue;
            if (m <= 0) goto done;
            written += m;
        }
        offset += n;
    }
    if (n < 0 || fchmod(output, 0644) || fsync(output)) goto done;
    /* Atomic directory-entry replacement, never follow a game-file symlink. */
    if (!renameat(directory, temporary, directory, name)) result = 0;
done:
    close(output);
    if (result) unlinkat(directory, temporary, 0);
    return result;
}
static int same_file(int a, int b)
{
    char left[4096], right[4096]; off_t offset = 0; ssize_t n, m;
    do {
        n = pread(a, left, sizeof(left), offset); m = pread(b, right, sizeof(right), offset);
        if (n < 0 || m != n || memcmp(left, right, (size_t)n)) return 0;
        offset += n;
    } while (n);
    return 1;
}
static unsigned staged;
static int stagedFds[64];
static int visit(int directory, const char *path, int proxy, unsigned depth)
{
    if (depth > 64) return -1;
    DIR *dir = fdopendir(dup(directory));
    if (!dir) return -1;
    struct dirent *item; int result = 0;
    while ((item = readdir(dir))) {
        if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
        struct stat st;
        if (fstatat(directory, item->d_name, &st, AT_SYMLINK_NOFOLLOW)) { result = -1; break; }
        if (S_ISDIR(st.st_mode)) {
            int child = openat(directory, item->d_name, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            char *childPath = NULL;
            if (child < 0 || asprintf(&childPath, "%s/%s", path, item->d_name) < 0) result = -1;
            else result = visit(child, childPath, proxy, depth + 1);
            if (child >= 0) close(child);
            free(childPath);
            if (result) break;
        } else if (!strcasecmp(item->d_name, "PlayFabGameSave.dll")) {
            char *sdkPath = NULL;
            if (asprintf(&sdkPath, "%s/%s", path, item->d_name) < 0) { result = -1; break; }
            int mapped = mapped_fd(getenv("WINE_DLL_FILE_MAP"), sdkPath);
            int source = mapped < 0 ? openat(directory, item->d_name, O_RDONLY | O_CLOEXEC | O_NONBLOCK) : mapped;
            int contract = source >= 0 ? sdk_contract(source) : 0;
            int adapter = contract == 2;
            if (contract) {
                /* Backend launch views link unchanged package files. Read
                 * the owner's alias, then replace only the private link. */
                int alias = openat(directory, "nexus_pgs_native.dll", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
                if (staged == 64) result = -1;
                else if (alias >= 0) {
                    int current = openat(directory, item->d_name, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
                    if (sdk_contract(alias) != 1 || current < 0 || sdk_contract(current) != 2 ||
                        (!adapter && !same_file(source, alias))) result = -1;
                    else if (copy_fd(alias, directory, "nexus_pgs_native.dll") ||
                        copy_fd(proxy, directory, item->d_name)) result = -1;
                    if (current >= 0) close(current);
                } else if (adapter) {
                    fprintf(stderr, "Nexus runtime: original PlayFab SDK is missing; restore the game's original PlayFabGameSave.dll before launching.\n");
                    result = -1;
                } else if (errno != ENOENT || copy_fd(source, directory, "nexus_pgs_native.dll") ||
                    copy_fd(proxy, directory, item->d_name)) result = -1;
                if (alias >= 0) close(alias);
                if (!result) stagedFds[staged++] = mapped;
            } else fprintf(stderr, "Nexus runtime: unsupported PlayFab SDK export contract; left unchanged.\n");
            if (mapped < 0 && source >= 0) close(source);
            free(sdkPath);
            if (result) break;
        }
    }
    closedir(dir); return result;
}
static void filter_map(const char *key)
{
    const char *map = getenv(key);
    if (!map) return;
    char *output = calloc(strlen(map) + 1, 1);
    if (!output) { perror("Nexus runtime file map"); exit(70); }
    size_t used = 0;
    for (const char *item = map; *item;) {
        const char *end = strchr(item, '|'); if (!end) end = item + strlen(item);
        const char *colon; int fd = parse_fd(item, &colon); int replaced = 0;
        if (fd >= 0) for (unsigned i = 0; i < staged; ++i)
            if (stagedFds[i] >= 0 && fd == stagedFds[i]) replaced = 1;
        if (!replaced) {
            if (used) output[used++] = '|';
            memcpy(output + used, item, (size_t)(end - item)); used += (size_t)(end - item);
        }
        item = *end ? end + 1 : end;
    }
    if (setenv(key, output, 1)) { perror("Nexus runtime file map"); exit(70); }
    free(output);
}
static int version_override(const char *binary, const char *loader)
{
    const char *enabled = getenv("NEXUS_GAMING_SERVICES_VERSION_OVERRIDE");
    if (enabled && strcmp(enabled, "1")) return 0;
    const char *prefix = getenv("WINEPREFIX");
    struct stat st;
    if (!prefix || prefix[0] != '/' || lstat(prefix, &st) || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 0022)) {
        fprintf(stderr, "Nexus runtime: explicit owner-only-write WINEPREFIX required for version override.\n"); return -1;
    }
    char helper[PATH_MAX];
    if (snprintf(helper, sizeof(helper), "%s/../share/xodus-nexus/compat/gaming-services-version.exe", binary) >= (int)sizeof(helper)) return -1;
    pid_t child = fork();
    if (child < 0) return -1;
    if (!child) {
        /* Bootstrap is a normal runtime executable, not a mapped game. */
        unsetenv("WINE_DLL_FILE_MAP"); unsetenv("WINE_EXE_FILE_MAP");
        unsetenv("XODUS_SOCKET"); unsetenv("XODUS_BRIDGE_KEY"); unsetenv("XODUS_BRIDGE_PORT");
        execl(loader, loader, helper, "apply", (char *)NULL);
        _exit(70);
    }
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return -1;
    return WIFEXITED(status) && !WEXITSTATUS(status) ? 0 : -1;
}
int main(int argc, char **argv)
{
    char binary[PATH_MAX], loader[PATH_MAX], proxyPath[PATH_MAX], *slash;
    ssize_t length = readlink("/proc/self/exe", binary, sizeof(binary) - 1);
    if (length < 0 || length == (ssize_t)sizeof(binary) - 1) return 70;
    binary[length] = 0; slash = strrchr(binary, '/'); if (!slash) return 70; *slash = 0;
    if (snprintf(loader, sizeof(loader), "%s/wine.nexus-original", binary) >= (int)sizeof(loader) ||
        snprintf(proxyPath, sizeof(proxyPath), "%s/../share/xodus-nexus/compat/PlayFabGameSave.dll", binary) >= (int)sizeof(proxyPath)) return 70;
    struct stat executable;
    if (argc > 1 && argv[1][0] == '/' && !lstat(argv[1], &executable) && S_ISREG(executable.st_mode) &&
        getenv("WINE_DLL_FILE_MAP") && version_override(binary, loader)) return 70;
    if (argc > 1 && argv[1][0] == '/' && !lstat(argv[1], &executable) && S_ISREG(executable.st_mode) &&
        getenv("WINE_DLL_FILE_MAP") && strcmp(getenv("NEXUS_PLAYFAB_ADAPTER") ? getenv("NEXUS_PLAYFAB_ADAPTER") : "", "0")) {
        char *view = strdup(argv[1]); if (!view) return 70;
        char *cursor = strrchr(view, '/');
        while (cursor && cursor != view) {
            *cursor = 0;
            char *base = strrchr(view, '/'); base = base ? base + 1 : view;
            if (!strncmp(base, ".xodus-chain-", 13) || !strncmp(base, "xodus-chain-", 12)) {
                /* Reject every symlink directory component, including aliased views. */
                int dir = open("/", O_DIRECTORY | O_CLOEXEC);
                char *components = strdup(view + 1), *save = NULL;
                if (!components) return 70;
                for (char *part = strtok_r(components, "/", &save); part && dir >= 0; part = strtok_r(NULL, "/", &save)) {
                    int next = openat(dir, part, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); close(dir); dir = next;
                }
                free(components);
                struct stat st;
                if (dir >= 0 && !fstat(dir, &st) && st.st_uid == geteuid() && !(st.st_mode & 0022)) {
                    /* Backend TempDir inherits umask (often 0755). Seal the
                     * owner-only-write temporary view before staging. */
                    if (fchmod(dir, 0700)) { perror("Nexus runtime private view"); return 70; }
                    int lock = openat(dir, ".nexus-pgs-lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
                    int proxy = open(proxyPath, O_RDONLY | O_CLOEXEC);
                    if (lock < 0 || proxy < 0 || flock(lock, LOCK_EX) || visit(dir, view, proxy, 0)) {
                        fprintf(stderr, "Nexus runtime: PlayFab staging failed; refusing a partial launch.\n"); return 70;
                    }
                    close(proxy); close(lock);
                }
                if (dir >= 0) close(dir);
                break;
            }
            cursor = strrchr(view, '/');
        }
        free(view);
    }
    if (staged) {
        filter_map("WINE_DLL_FILE_MAP"); filter_map("WINE_EXE_FILE_MAP");
        const char *old = getenv("WINEDLLOVERRIDES"); char *overrides;
        if (asprintf(&overrides, "%s%splayfabgamesave=n;nexus_pgs_native=n", old ? old : "", old && *old ? ";" : "") < 0 ||
            setenv("WINEDLLOVERRIDES", overrides, 1)) return 70;
        free(overrides);
    }
    if (getenv("NEXUS_BOOTSTRAP_DIAGNOSTICS"))
        fprintf(stderr, "NEXUS_BOOTSTRAP sdk=%u appLocal=0\n", staged);
    argv[0] = loader;
    execv(loader, argv);
    perror("Nexus runtime Wine loader"); return 70;
}
