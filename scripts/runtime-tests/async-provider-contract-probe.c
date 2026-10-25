/* Provider return/completion contract. No identity, network, games or saves. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <stdio.h>
#include "xtaskqueue.h"
#include "xasyncprovider.h"
#include "xnetworking.h"

static IXThreadingImpl *threads;
static XTaskQueueHandle queue;
static LONG checks, failures;
#define CHECK(name, x) do { ++checks; if (!(x)) { ++failures; printf("FAIL %s\n", name); } } while (0)
struct test_context {
    XAsyncBlock block;
    HRESULT begin_result, work_result, expected;
    LONG callbacks, cleanup, work, cancels;
    BOOL schedule, complete_work, complete_pending, provider_copy, check_deferred_cleanup;
    SIZE_T result_capacity;
    BOOL wait_in_callback, complete_cancel;
};
static void WINAPI completed(XAsyncBlock *block)
{
    struct test_context *test = block->context;
    ++test->callbacks;
    CHECK("callback-status", IXThreadingImpl_XAsyncGetStatus(threads, block, test->wait_in_callback) == test->expected);
}
static HRESULT WINAPI provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct test_context *test = data->context;
    if (data->async != &test->block) test->provider_copy = TRUE;
    switch (op) {
    case XAsyncOp_Begin:
        if (test->schedule) CHECK("schedule", IXThreadingImpl_XAsyncSchedule(threads, data->async, 0) == S_OK);
        return test->begin_result;
    case XAsyncOp_DoWork:
        ++test->work;
        if (test->complete_pending) IXThreadingImpl_XAsyncComplete(threads, data->async, E_PENDING, 7);
        if (test->complete_work) {
            IXThreadingImpl_XAsyncComplete(threads, data->async, test->expected, 0);
            if (test->check_deferred_cleanup) CHECK("cleanup-waits-for-provider-return", test->cleanup == 0);
        }
        return test->work_result;
    case XAsyncOp_GetResult:
        CHECK("provider-receives-caller-buffer-capacity", data->bufferSize == test->result_capacity);
        {
            /* The caller's capacity is private to this provider call. */
            SIZE_T size = 0;
            CHECK("result-size-during-get-result", IXThreadingImpl_XAsyncGetResultSize(threads, data->async, &size) == S_OK && size == sizeof(DWORD));
        }
        *(DWORD *)data->buffer = 0x12345678;
        break;
    case XAsyncOp_Cleanup: ++test->cleanup; break;
    case XAsyncOp_Cancel:
        ++test->cancels;
        if (test->complete_cancel) IXThreadingImpl_XAsyncComplete(threads, data->async, E_ABORT, 0);
        break;
    default: break;
    }
    return S_OK;
}
static void init(struct test_context *test)
{
    ZeroMemory(test, sizeof(*test));
    test->block.queue = queue;
    test->block.context = test;
    test->block.callback = completed;
    test->begin_result = S_OK;
    test->work_result = E_PENDING;
}
static void drain(void)
{
    while (IXThreadingImpl_XTaskQueueDispatch(threads, queue, XTaskQueuePort_Completion, 0));
}
static void WINAPI free_completed(XAsyncBlock *block)
{
    struct test_context *test = block->context;
    ++test->callbacks;
    CHECK("free-callback-status", IXThreadingImpl_XAsyncGetStatus(threads, block, FALSE) == S_OK);
    CHECK("free-user-block-inside-completion", VirtualFree(block, 0, MEM_RELEASE));
}
struct connectivity_test {
    LONG callbacks;
    BOOL initialized;
    HANDLE event;
};
static DWORD WINAPI watchdog(void *event)
{
    if (WaitForSingleObject(event, 10000) != WAIT_OBJECT_0) {
        printf("FAIL async-cleanup-deadlock\n"); fflush(stdout); ExitProcess(77);
    }
    return 0;
}
static void WINAPI connectivity_changed(void *context, const XNetworkingConnectivityHint *hint)
{
    struct connectivity_test *test = context;
    test->initialized = hint->networkInitialized;
    InterlockedIncrement(&test->callbacks);
    if (test->event) SetEvent(test->event);
}
int main(int argc, char **argv)
{
    HANDLE finished = CreateEventW(NULL, TRUE, FALSE, NULL);
    HANDLE guard = CreateThread(NULL, 0, watchdog, finished, 0, NULL);
    HRESULT (WINAPI *query)(const GUID *, REFIID, void **);
    HMODULE dll = LoadLibraryA(argc > 1 ? argv[1] : "xgameruntime.dll");
    struct test_context test;
    const HRESULT failures_to_test[] = { E_FAIL, E_NOTIMPL, E_ABORT };
    UINT i;
    if (!dll) { printf("FAIL load %lu\n", GetLastError()); return 1; }
    query = (void *)GetProcAddress(dll, "QueryApiImpl");
    if (!query || FAILED(query(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, (void **)&threads))) return 1;
    CHECK("queue", IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &queue) == S_OK);
    for (i = 0; i < ARRAYSIZE(failures_to_test); ++i) {
        init(&test);
        test.begin_result = test.expected = failures_to_test[i];
        CHECK("begin-setup-succeeds-provider-error-is-async", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "contract", provider) == S_OK);
        CHECK("provider-receives-private-block", test.provider_copy);
        drain();
        CHECK("begin-error-completes", test.callbacks == 1);
        CHECK("begin-error-cleanup-once", test.cleanup == 1);
        /* Clean up a pending baseline implementation without hanging. */
        if (!test.callbacks) { IXThreadingImpl_XAsyncComplete(threads, &test.block, test.expected, 0); drain(); }
    }
    init(&test);
    test.begin_result = E_PENDING;
    test.expected = S_OK;
    CHECK("pending-begin-setup-succeeds", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "contract", provider) == S_OK);
    drain();
    CHECK("pending-begin-not-completed", test.callbacks == 0 && test.cleanup == 0);
    IXThreadingImpl_XAsyncComplete(threads, &test.block, S_OK, 0); drain();
    CHECK("pending-begin-can-complete", test.callbacks == 1 && test.cleanup == 1);

    init(&test); test.expected = S_OK; test.wait_in_callback = TRUE;
    CHECK("callback-self-wait-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "cleanup-self-wait", provider) == S_OK);
    IXThreadingImpl_XAsyncComplete(threads, &test.block, S_OK, 0); drain();
    CHECK("callback-self-wait-finishes", test.callbacks == 1 && test.cleanup == 1);

    init(&test); test.expected = S_OK;
    CHECK("best-effort-cancel-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "cancel-notification", provider) == S_OK);
    IXThreadingImpl_XAsyncCancel(threads, &test.block);
    CHECK("cancel-notifies-provider", test.cancels == 1);
    CHECK("cancel-does-not-fabricate-completion", IXThreadingImpl_XAsyncGetStatus(threads, &test.block, FALSE) == E_PENDING);
    IXThreadingImpl_XAsyncComplete(threads, &test.block, S_OK, 0); drain();
    CHECK("cancel-can-complete-normally", test.callbacks == 1 && test.cleanup == 1);

    init(&test); test.expected = E_ABORT; test.complete_cancel = TRUE; test.wait_in_callback = TRUE;
    CHECK("cancel-complete-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "cancel-cleanup", provider) == S_OK);
    IXThreadingImpl_XAsyncCancel(threads, &test.block); drain();
    CHECK("real-provider-cancel-completes", test.cancels == 1 && test.callbacks == 1 && test.cleanup == 1);
    IXThreadingImpl_XAsyncCancel(threads, &test.block);
    CHECK("cleaned-provider-not-canceled-again", test.cancels == 1);

    for (i = 0; i < 4; ++i) {
        init(&test); test.schedule = TRUE;
        test.work_result = i == 0 ? E_FAIL : i == 1 || i == 3 ? S_OK : E_PENDING;
        test.expected = i == 0 ? E_FAIL : i == 1 ? E_UNEXPECTED : S_OK;
        test.complete_work = i >= 2;
        CHECK("work-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "contract", provider) == S_OK);
        CHECK("work-dispatch", IXThreadingImpl_XTaskQueueDispatch(threads, queue, XTaskQueuePort_Work, 0));
        drain();
        CHECK("work-terminal-return-completes", test.callbacks == 1 && test.cleanup == 1);
        CHECK("work-invoked-once", test.work == 1);
        if (!test.callbacks) { IXThreadingImpl_XAsyncComplete(threads, &test.block, test.expected, 0); drain(); }
    }
    init(&test); test.expected = S_OK;
    CHECK("first-complete-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "contract", provider) == S_OK);
    IXThreadingImpl_XAsyncComplete(threads, &test.block, E_PENDING, 42); drain();
    CHECK("complete-pending-is-no-op", !test.callbacks && !test.cleanup && IXThreadingImpl_XAsyncGetStatus(threads, &test.block, FALSE) == E_PENDING);
    IXThreadingImpl_XAsyncComplete(threads, &test.block, S_OK, 0);
    IXThreadingImpl_XAsyncComplete(threads, &test.block, E_FAIL, 0);
    drain();
    CHECK("first-terminal-result-wins", IXThreadingImpl_XAsyncGetStatus(threads, &test.block, FALSE) == S_OK);
    CHECK("completion-once", test.callbacks == 1 && test.cleanup == 1);
    init(&test); test.expected = S_OK;
    {
        DWORD result[5] = {0};
        SIZE_T used = 0;
        test.result_capacity = sizeof(result);
        CHECK("payload-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, &test, "capacity", provider) == S_OK);
        IXThreadingImpl_XAsyncComplete(threads, &test.block, S_OK, sizeof(DWORD));
        CHECK("reject-wrong-result-identity", IXThreadingImpl_XAsyncGetResult(threads, &test.block, NULL, sizeof(result), result, &used) == E_INVALIDARG);
        CHECK("reject-null-result-buffer", IXThreadingImpl_XAsyncGetResult(threads, &test.block, &test, sizeof(result), NULL, &used) == E_INVALIDARG);
        CHECK("accept-larger-result-buffer", IXThreadingImpl_XAsyncGetResult(threads, &test.block, &test, sizeof(result), result, &used) == S_OK);
        CHECK("payload-and-used-size", result[0] == 0x12345678 && used == sizeof(DWORD));
        drain();
        CHECK("payload-cleanup-once", test.callbacks == 1 && test.cleanup == 1);
    }
    IXThreadingImpl_XTaskQueueCloseHandle(threads, queue);
    /* Immediate completion can free the user block while DoWork is still
     * running. Runtime post-provider handling must not touch freed memory. */
    CHECK("immediate-completion-queue", IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Immediate, &queue) == S_OK);
    init(&test); test.expected = S_OK; test.schedule = TRUE;
    test.complete_work = TRUE; test.work_result = S_OK;
    test.check_deferred_cleanup = TRUE;
    {
        XAsyncBlock *block = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        CHECK("allocate-user-block", block != NULL);
        if (!block) return 1;
        block->queue = queue; block->context = &test; block->callback = free_completed;
        CHECK("immediate-begin", IXThreadingImpl_XAsyncBegin(threads, block, &test, NULL, "free-user", provider) == S_OK);
        CHECK("immediate-work-dispatch", IXThreadingImpl_XTaskQueueDispatch(threads, queue, XTaskQueuePort_Work, 0));
        CHECK("immediate-completion-and-cleanup-once", test.callbacks == 1 && test.cleanup == 1);
    }
    IXThreadingImpl_XTaskQueueCloseHandle(threads, queue);
    /* Async providers can own external work without a queued callback yet.
     * Closing the public handle must not free their completion queue. */
    CHECK("retained-queue-create", IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_ThreadPool, XTaskQueueDispatchMode_ThreadPool, &queue) == S_OK);
    init(&test); test.expected = S_OK;
    CHECK("retained-queue-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "retained-queue", provider) == S_OK);
    IXThreadingImpl_XTaskQueueCloseHandle(threads, queue);
    IXThreadingImpl_XAsyncComplete(threads, &test.block, S_OK, 0);
    CHECK("retained-queue-completion", IXThreadingImpl_XAsyncGetStatus(threads, &test.block, TRUE) == S_OK && test.callbacks == 1);
    {
        IXNetworkingImpl2 *network;
        XAsyncBlock block = {0};
        XNetworkingSecurityInformation result, *information = NULL;
        SIZE_T required = 0, used = 0;
        CHECK("network-interface", query(&CLSID_XNetworkingImpl, &IID_IXNetworkingImpl2, (void **)&network) == S_OK);
        {
            XTaskQueueRegistrationToken first, second;
            struct connectivity_test one = {0}, two = {0};
            CHECK("connectivity-manual-queue", IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &queue) == S_OK);
            CHECK("connectivity-register-first", IXNetworkingImpl2_XNetworkingRegisterConnectivityHintChanged(network, queue, &one, connectivity_changed, &first) == S_OK);
            CHECK("connectivity-register-second", IXNetworkingImpl2_XNetworkingRegisterConnectivityHintChanged(network, queue, &two, connectivity_changed, &second) == S_OK && first.token != second.token);
            CHECK("connectivity-manual-not-inline", !one.callbacks && !two.callbacks);
            CHECK("connectivity-unregister-before-dispatch", IXNetworkingImpl2_XNetworkingUnregisterConnectivityHintChanged(network, second, TRUE));
            drain();
            CHECK("connectivity-initial-notification", one.callbacks == 1 && one.initialized);
            CHECK("connectivity-suppresses-unregistered", !two.callbacks);
            CHECK("connectivity-unregister-first", IXNetworkingImpl2_XNetworkingUnregisterConnectivityHintChanged(network, first, TRUE));
            CHECK("connectivity-reject-stale-token", !IXNetworkingImpl2_XNetworkingUnregisterConnectivityHintChanged(network, first, TRUE));
            IXThreadingImpl_XTaskQueueCloseHandle(threads, queue);
            ZeroMemory(&one, sizeof(one));
            one.event = CreateEventW(NULL, TRUE, FALSE, NULL);
            CHECK("connectivity-default-queue", IXNetworkingImpl2_XNetworkingRegisterConnectivityHintChanged(network, NULL, &one, connectivity_changed, &first) == S_OK);
            CHECK("connectivity-default-callback", WaitForSingleObject(one.event, 3000) == WAIT_OBJECT_0 && one.callbacks == 1);
            CHECK("connectivity-default-unregister", IXNetworkingImpl2_XNetworkingUnregisterConnectivityHintChanged(network, first, TRUE));
            CloseHandle(one.event);
        }
        CHECK("security-reject-null-url", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsync(network, NULL, &block) == E_INVALIDARG);
        CHECK("security-reject-insecure-url", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsync(network, "http://example.invalid/", &block) == E_INVALIDARG);
        CHECK("security-reject-empty-url", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsync(network, "", &block) == E_INVALIDARG);
        CHECK("security-reject-insecure-websocket", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsync(network, "ws://example.invalid/", &block) == E_INVALIDARG);
        CHECK("security-reject-empty-websocket-host", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsync(network, "wss://", &block) == E_INVALIDARG);
        CHECK("security-utf16-begin", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlUtf16Async(network, L"https://example.invalid/", &block) == S_OK);
        CHECK("security-complete", IXThreadingImpl_XAsyncGetStatus(threads, &block, TRUE) == S_OK);
        CHECK("security-result-size", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlUtf16AsyncResultSize(network, &block, &required) == S_OK && required == sizeof(result));
        CHECK("security-small-result", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlUtf16AsyncResult(network, &block, sizeof(result) - 1, &used, (UINT8 *)&result, &information) == HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER) && information == NULL);
        CHECK("security-result", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlUtf16AsyncResult(network, &block, sizeof(result), &used, (UINT8 *)&result, &information) == S_OK && information == &result && used == sizeof(result));
        CHECK("security-tls-policy", result.enabledHttpSecurityProtocolFlags == 0x2800 && !result.thumbprintCount && !result.thumbprints);
        CHECK("security-invalid-certificate-handle", FAILED(IXNetworkingImpl2_XNetworkingVerifyServerCertificate(network, (void *)1, &result)));
        ZeroMemory(&block, sizeof(block));
        CHECK("security-utf8-begin", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsync(network, "https://example.invalid/", &block) == S_OK);
        CHECK("security-utf8-complete", IXThreadingImpl_XAsyncGetStatus(threads, &block, TRUE) == S_OK);
        CHECK("security-utf8-result", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsyncResult(network, &block, sizeof(result), &used, (UINT8 *)&result, &information) == S_OK);
        ZeroMemory(&block, sizeof(block));
        CHECK("security-wss-begin", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsync(network, "wss://example.invalid:443/client/hubs/test", &block) == S_OK);
        CHECK("security-wss-complete", IXThreadingImpl_XAsyncGetStatus(threads, &block, TRUE) == S_OK);
        CHECK("security-wss-result", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlAsyncResult(network, &block, sizeof(result), &used, (UINT8 *)&result, &information) == S_OK && result.enabledHttpSecurityProtocolFlags == 0x2800);
        ZeroMemory(&block, sizeof(block));
        CHECK("security-wss-uppercase-begin", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlUtf16Async(network, L"WSS://example.invalid/", &block) == S_OK);
        CHECK("security-wss-uppercase-complete", IXThreadingImpl_XAsyncGetStatus(threads, &block, TRUE) == S_OK);
        CHECK("security-wss-uppercase-result", IXNetworkingImpl2_XNetworkingQuerySecurityInformationForUrlUtf16AsyncResult(network, &block, sizeof(result), &used, (UINT8 *)&result, &information) == S_OK);
        IXNetworkingImpl2_Release(network);
    }
    IXThreadingImpl_Release(threads);
    SetEvent(finished);
    WaitForSingleObject(guard, INFINITE);
    CloseHandle(guard);
    CloseHandle(finished);
    printf("ASYNC PROVIDER CHECKS %ld FAILURES %ld\n", checks, failures);
    return failures ? 1 : 0;
}
