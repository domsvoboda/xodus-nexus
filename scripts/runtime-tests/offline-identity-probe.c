/* SPDX-License-Identifier: MIT
 * Offline identity contract: with Microsoft unreachable, XUserAddAsync fails
 * without a cached identity and succeeds with one, exposing the cached XUID,
 * gamertag and age group; token requests still fail with the network error
 * and the connectivity hint drops to local access. Uses no account, service
 * or network: XODUS_FORCE_OFFLINE makes the runtime treat the network as
 * unreachable, and the cache is a synthetic file set in a private directory. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "xuser.h"
#include "xtaskqueue.h"
#include "xasyncprovider.h"
#include "xnetworking.h"

static IXUserImpl6 *users;
static IXUserGamertagImpl *gamertags;
static IXThreadingImpl *threading;
static IXNetworkingImpl *networking;
static LONG checks, failures;
#define CHECK(name, test) do { ++checks; if (!(test)) { ++failures; printf("FAIL %s line=%d\n", name, __LINE__); } } while (0)
#define CANNOT_CONNECT HRESULT_FROM_WIN32(12029)

static const char identity_text[] =
    "schema=1\nxuid=2535400000000001\nageGroup=3\nsavedAt=%llu\n"
    "gamertag=NexusProbe\nmodernGamertag=Nexus Probe\nmodernGamertagSuffix=1234\nuniqueModernGamertag=Nexus Probe#1234\n";
static const char endpoints_text[] =
    "{\"EndPoints\":[{\"Protocol\":\"https\",\"Host\":\"*.xboxlive.com\",\"HostType\":\"wildcard\","
    "\"RelyingParty\":\"http://xboxlive.com\",\"TokenType\":\"JWT\",\"SignaturePolicyIndex\":0}],"
    "\"SignaturePolicies\":[{\"Version\":1,\"MaxBodyBytes\":8192}]}";

static BOOL write_file(const WCHAR *directory, const WCHAR *name, const char *text)
{
    WCHAR path[MAX_PATH];
    DWORD written, size = (DWORD)strlen(text);
    HANDLE file;
    wcscpy(path, directory);
    wcscat(path, L"\\");
    wcscat(path, name);
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    WriteFile(file, text, size, &written, NULL);
    CloseHandle(file);
    return written == size;
}

static HRESULT add_user(XTaskQueueHandle queue, XUserHandle *user)
{
    XAsyncBlock async = {0};
    HRESULT hr;
    *user = NULL;
    async.queue = queue;
    hr = IXUserImpl6_XUserAddAsync(users, XUserAddOptions_AddDefaultUserSilently, &async);
    if (FAILED(hr)) return hr;
    hr = IXThreadingImpl_XAsyncGetStatus(threading, &async, TRUE);
    if (FAILED(hr)) return hr;
    return IXUserImpl6_XUserAddResult(users, &async, user);
}

static HRESULT request_token(XTaskQueueHandle queue, XUserHandle user)
{
    XAsyncBlock async = {0};
    HRESULT hr;
    async.queue = queue;
    hr = IXUserImpl6_XUserGetTokenAndSignatureAsync(users, user, XUserGetTokenAndSignatureOptions_None, "GET",
                                                    "https://profile.xboxlive.com/users/me/profile/settings", 0, NULL, 0, NULL, &async);
    if (FAILED(hr)) return hr;
    return IXThreadingImpl_XAsyncGetStatus(threading, &async, TRUE);
}

int main(void)
{
    WCHAR base[MAX_PATH], local[MAX_PATH], cache[MAX_PATH];
    char text[512], gamertag[128];
    XNetworkingConnectivityHint hint = {0};
    XTaskQueueHandle queue = NULL;
    XUserHandle user = NULL;
    HMODULE dll;
    HRESULT (WINAPI *query)(const GUID *, REFIID, void **);
    ULARGE_INTEGER now;
    FILETIME time;
    UINT64 xuid = 0;
    XUserState state = XUserState_SignedOut;
    XUserAgeGroup age = XUserAgeGroup_Unknown;
    SIZE_T used = 0;
    HRESULT hr;

    /* Private cache root: the runtime writes and reads below %LOCALAPPDATA%.
     * Paths are assembled without wide printf so the layout does not depend on
     * the C runtime's %s semantics. A previous run's cache is removed first. */
    if (!GetTempPathW(MAX_PATH - 64, base)) return 2;
    wcscpy(local, base);
    wcscat(local, L"nexus-offline-identity-probe");
    CreateDirectoryW(local, NULL);
    wcscpy(cache, local);
    wcscat(cache, L"\\Xodus Nexus");
    CreateDirectoryW(cache, NULL);
    wcscat(cache, L"\\offline-identity");
    CreateDirectoryW(cache, NULL);
    /* The launcher names the account; the cache lives in a directory of that key. */
    wcscat(cache, L"\\0123456789abcdef0123456789abcdef");
    CreateDirectoryW(cache, NULL);
    SetEnvironmentVariableW(L"XODUS_ACCOUNT_HASH", L"0123456789abcdef0123456789abcdef");
    {
        static const WCHAR *const names[] = { L"identity.txt", L"endpoints-default.json", L"endpoints-current.json" };
        WCHAR stale[MAX_PATH];
        unsigned i;
        for (i = 0; i < 3; i++) { wcscpy(stale, cache); wcscat(stale, L"\\"); wcscat(stale, names[i]); DeleteFileW(stale); }
    }
    SetEnvironmentVariableW(L"LOCALAPPDATA", local);
    SetEnvironmentVariableW(L"XODUS_FORCE_OFFLINE", L"1");

    dll = LoadLibraryA("xgameruntime.dll");
    if (!dll || !(query = (void *)GetProcAddress(dll, "QueryApiImpl"))) return 2;
    if (FAILED(query(&CLSID_XUserImpl, &IID_IXUserImpl6, (void **)&users)) ||
        FAILED(query(&CLSID_XUserImpl, &IID_IXUserGamertagImpl, (void **)&gamertags)) ||
        FAILED(query(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, (void **)&threading)) ||
        FAILED(query(&CLSID_XNetworkingImpl, &IID_IXNetworkingImpl, (void **)&networking))) return 2;
    CHECK("queue", IXThreadingImpl_XTaskQueueCreate(threading, XTaskQueueDispatchMode_ThreadPool, XTaskQueueDispatchMode_ThreadPool, &queue) == S_OK && queue);
    IXThreadingImpl_XTaskQueueSetCurrentProcessTaskQueue(threading, queue);

    /* Online before this run: the hint reports internet access. */
    CHECK("hint-online", IXNetworkingImpl_XNetworkingGetConnectivityHint(networking, &hint) == S_OK &&
          hint.connectivityLevel == XNetworkingConnectivityLevelHint_InternetAccess);

    /* No cached identity: the unreachable network is reported, nothing is invented. */
    hr = add_user(queue, &user);
    CHECK("no-cache-fails", hr == CANNOT_CONNECT && !user);
    CHECK("hint-still-online", IXNetworkingImpl_XNetworkingGetConnectivityHint(networking, &hint) == S_OK &&
          hint.connectivityLevel == XNetworkingConnectivityLevelHint_InternetAccess);

    /* A stale cache (31 days) is refused. */
    GetSystemTimeAsFileTime(&time);
    now.LowPart = time.dwLowDateTime;
    now.HighPart = time.dwHighDateTime;
    snprintf(text, sizeof(text), identity_text, now.QuadPart - 31ull * 24 * 3600 * 10000000ull);
    CHECK("cache-dir", GetFileAttributesW(cache) != INVALID_FILE_ATTRIBUTES);
    CHECK("write-stale", write_file(cache, L"identity.txt", text) && write_file(cache, L"endpoints-default.json", endpoints_text) &&
          write_file(cache, L"endpoints-current.json", endpoints_text));
    hr = add_user(queue, &user);
    CHECK("stale-cache-fails", hr == CANNOT_CONNECT && !user);

    /* A fresh cache signs the user in offline. */
    snprintf(text, sizeof(text), identity_text, now.QuadPart - 10000000ull);
    CHECK("write-fresh", write_file(cache, L"identity.txt", text));
    hr = add_user(queue, &user);
    CHECK("cached-sign-in", hr == S_OK && user);
    if (SUCCEEDED(hr) && user)
    {
        CHECK("xuid", IXUserImpl6_XUserGetId(users, user, &xuid) == S_OK && xuid == 2535400000000001ull);
        CHECK("state", IXUserImpl6_XUserGetState(users, user, &state) == S_OK && state == XUserState_SignedIn);
        CHECK("age", IXUserImpl6_XUserGetAgeGroup(users, user, &age) == S_OK && age == XUserAgeGroup_Adult);
        CHECK("gamertag-classic", IXUserGamertagImpl_XUserGetGamertag(gamertags, user, XUserGamertagComponent_Classic, sizeof(gamertag), gamertag, &used) == S_OK &&
              !strcmp(gamertag, "NexusProbe"));
        CHECK("gamertag-unique", IXUserGamertagImpl_XUserGetGamertag(gamertags, user, XUserGamertagComponent_UniqueModern, sizeof(gamertag), gamertag, &used) == S_OK &&
              !strcmp(gamertag, "Nexus Probe#1234"));
        CHECK("token-fails-offline", request_token(queue, user) == CANNOT_CONNECT);
        CHECK("hint-local", IXNetworkingImpl_XNetworkingGetConnectivityHint(networking, &hint) == S_OK &&
              hint.connectivityLevel == XNetworkingConnectivityLevelHint_LocalAccess && hint.networkInitialized);
        IXUserImpl6_XUserCloseHandle(users, user);
    }

    /* Another account on the same device never sees this account's identity,
     * and without an account key nothing is read at all. */
    SetEnvironmentVariableW(L"XODUS_ACCOUNT_HASH", L"fedcba9876543210fedcba9876543210");
    hr = add_user(queue, &user);
    CHECK("other-account-no-cache", hr == CANNOT_CONNECT && !user);
    SetEnvironmentVariableW(L"XODUS_ACCOUNT_HASH", NULL);
    hr = add_user(queue, &user);
    CHECK("no-account-key-no-cache", hr == CANNOT_CONNECT && !user);
    SetEnvironmentVariableW(L"XODUS_ACCOUNT_HASH", L"0123456789abcdef0123456789abcdef");

    /* The cache never holds secrets: only the identity lines written above. */
    {
        WCHAR path[MAX_PATH];
        HANDLE file;
        DWORD read = 0;
        char copy[600] = {0};
        wcscpy(path, cache);
        wcscat(path, L"\\identity.txt");
        file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
        CHECK("cache-readable", file != INVALID_HANDLE_VALUE);
        if (file != INVALID_HANDLE_VALUE) { ReadFile(file, copy, sizeof(copy) - 1, &read, NULL); CloseHandle(file); }
        CHECK("cache-is-identity-only", !strstr(copy, "Token") && !strstr(copy, "token") && strstr(copy, "xuid=") && strstr(copy, "gamertag="));
    }

    IXThreadingImpl_XTaskQueueCloseHandle(threading, queue);
    IXNetworkingImpl_Release(networking);
    IXThreadingImpl_Release(threading);
    IXUserGamertagImpl_Release(gamertags);
    IXUserImpl6_Release(users);
    printf("CHECKS %ld FAILURES %ld\n", checks, failures);
    return failures ? 1 : 0;
}
