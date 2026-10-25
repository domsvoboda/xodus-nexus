/* SPDX-License-Identifier: MIT
 * Account-free native regression: detached/terminal provider scheduling.
 */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <stdio.h>
#include "xtaskqueue.h"
#include "xasyncprovider.h"
static IXThreadingImpl *threads;
static LONG checks, failures;
#define CHECK(name, x) do { ++checks; if (!(x)) { ++failures; printf("FAIL %s\n", name); } } while (0)
struct context { XAsyncBlock block, detached; LONG work, cleanup; HRESULT begin; };
static LONG CALLBACK exception(EXCEPTION_POINTERS *data)
{
    if (data->ExceptionRecord->ExceptionCode == EXCEPTION_ACCESS_VIOLATION) {
        printf("FAIL schedule-access-violation address=%p\n", (void *)data->ExceptionRecord->ExceptionInformation[1]);
        fflush(stdout); ExitProcess(77);
    }
    return EXCEPTION_CONTINUE_SEARCH;
}
static HRESULT WINAPI provider(XAsyncOp op, const XAsyncProviderData *data)
{
    struct context *test = data->context;
    switch (op) {
    case XAsyncOp_Begin:
        if (FAILED(test->begin)) return test->begin;
        /* A detached block can be encountered inside a native SDK provider.
         * Reject it without corrupting the real pending operation. */
        CHECK("detached-provider-block", IXThreadingImpl_XAsyncSchedule(threads, &test->detached, 0) == E_INVALIDARG);
        CHECK("provider-block-schedule", IXThreadingImpl_XAsyncSchedule(threads, data->async, 0) == S_OK);
        return S_OK;
    case XAsyncOp_DoWork:
        ++test->work;
        IXThreadingImpl_XAsyncComplete(threads, data->async, S_OK, 0);
        return E_PENDING;
    case XAsyncOp_Cleanup: ++test->cleanup; break;
    default: break;
    }
    return S_OK;
}
int main(int argc, char **argv)
{
    AddVectoredExceptionHandler(1, exception);
    HMODULE dll = LoadLibraryA(argc > 1 ? argv[1] : "xgameruntime.dll");
    HRESULT (WINAPI *query)(const GUID *, const GUID *, void **) = dll ? (void *)GetProcAddress(dll, "QueryApiImpl") : NULL;
    CHECK("threading", query && query(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, (void **)&threads) == S_OK);
    if (!threads) return 1;
    XAsyncBlock empty = {0};
    CHECK("unbegun-block", IXThreadingImpl_XAsyncSchedule(threads, &empty, 0) == E_INVALIDARG);
    CHECK("null-block", IXThreadingImpl_XAsyncSchedule(threads, NULL, 0) == E_INVALIDARG);
    XTaskQueueHandle queue;
    CHECK("queue", IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &queue) == S_OK);
    struct context test = {0};
    test.block.queue = queue;
    CHECK("begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "schedule", provider) == S_OK);
    CHECK("work", IXThreadingImpl_XTaskQueueDispatch(threads, queue, XTaskQueuePort_Work, 0));
    CHECK("completed-status", IXThreadingImpl_XAsyncGetStatus(threads, &test.block, TRUE) == S_OK);
    CHECK("completed-rejects-schedule", IXThreadingImpl_XAsyncSchedule(threads, &test.block, 0) == E_INVALIDARG);
    CHECK("no-extra-work", !IXThreadingImpl_XTaskQueueDispatch(threads, queue, XTaskQueuePort_Work, 0));
    CHECK("cleanup-once", test.work == 1 && test.cleanup == 1);
    ZeroMemory(&test, sizeof(test)); test.block.queue = queue; test.begin = E_ABORT;
    CHECK("failed-begin", IXThreadingImpl_XAsyncBegin(threads, &test.block, &test, NULL, "failure", provider) == S_OK);
    CHECK("failed-status", IXThreadingImpl_XAsyncGetStatus(threads, &test.block, TRUE) == E_ABORT);
    CHECK("preserve-original-failure", IXThreadingImpl_XAsyncSchedule(threads, &test.block, 0) == E_ABORT);
    CHECK("failed-cleanup-once", test.cleanup == 1 && !test.work);
    IXThreadingImpl_XTaskQueueCloseHandle(threads, queue);
    printf("CHECKS %ld FAILURES %ld\n", checks, failures);
    return failures ? 1 : 0;
}
