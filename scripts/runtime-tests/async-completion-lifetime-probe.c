/* Regression: the GDK permits deleting/reusing XAsyncBlock in completion.
 * No Xbox identity, game files, network, or save data is used. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <stdio.h>
#include "xtaskqueue.h"
#include "xasyncprovider.h"

static IXThreadingImpl *threads;
static XTaskQueueHandle queue;
static LONG callbacks, cleanups, results, cancels, checks, failures;
static HRESULT outcome;
static SIZE_T payload;
static BOOL consume, reuse;
#define CHECK(x) do { checks++; if (!(x)) { failures++; printf("FAIL %d\n", __LINE__); } } while (0)

static HRESULT WINAPI provider(XAsyncOp op, const XAsyncProviderData *data)
{
    if (op == XAsyncOp_GetResult && data->buffer) *(DWORD *)data->buffer = 0x12345678;
    if (op == XAsyncOp_GetResult) InterlockedIncrement(&results);
    if (op == XAsyncOp_Cancel) InterlockedIncrement(&cancels);
    if (op == XAsyncOp_Cleanup) InterlockedIncrement(&cleanups);
    return S_OK;
}

static void WINAPI completed(XAsyncBlock *block)
{
    DWORD result = 0;
    LONG entry = cleanups;
    CHECK(IXThreadingImpl_XAsyncGetStatus(threads, block, FALSE) == outcome);
    if (consume) {
        CHECK(IXThreadingImpl_XAsyncGetResult(threads, block, NULL, sizeof(result), &result, NULL) == S_OK);
        CHECK(result == 0x12345678);
        /* Native XAsync runs provider Cleanup only after this callback
         * returns; titles may read result data after closing its handle. */
        CHECK(cleanups == entry);
        /* Results are returned once; a finished operation ignores Cancel. */
        CHECK(IXThreadingImpl_XAsyncGetResult(threads, block, NULL, sizeof(result), &result, NULL) == E_ILLEGAL_METHOD_CALL);
        IXThreadingImpl_XAsyncCancel(threads, block);
        CHECK(cleanups == entry);
    }
    InterlockedIncrement(&callbacks);
    if (reuse) {
        /* A new state must not make the old completion clean it by mistake. */
        /* Native XAsync snapshots callback at Begin. Set it for the next
         * operation before Begin, not after it has already been captured. */
        block->callback = NULL;
        CHECK(IXThreadingImpl_XAsyncBegin(threads, block, NULL, NULL, "reused", provider) == S_OK);
    } else {
        CHECK(VirtualFree(block, 0, MEM_RELEASE));
    }
}

int main(int argc, char **argv)
{
    HRESULT (WINAPI *query)(const GUID *, REFIID, void **);
    HMODULE dll = LoadLibraryA(argc > 1 ? argv[1] : "xgameruntime.dll");
    int i;
    if (!dll) { printf("DLL load failed %lu\n", GetLastError()); return 1; }
    query = (void *)GetProcAddress(dll, "QueryApiImpl");
    CHECK(query != NULL);
    if (!query) return 1;
    CHECK(query(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, (void **)&threads) == S_OK);
    CHECK(IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &queue) == S_OK);
    for (i = 0; i < 400; i++) {
        LONG before = cleanups;
        XAsyncBlock *block = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        CHECK(block != NULL);
        if (!block) return 1;
        outcome = i % 4 == 0 ? E_FAIL : S_OK;
        payload = i % 4 == 2 ? sizeof(DWORD) : 0;
        consume = payload != 0;
        reuse = i % 4 == 3;
        block->queue = queue;
        block->callback = completed;
        CHECK(IXThreadingImpl_XAsyncBegin(threads, block, NULL, NULL, "lifetime", provider) == S_OK);
        IXThreadingImpl_XAsyncComplete(threads, block, outcome, payload);
        CHECK(IXThreadingImpl_XTaskQueueDispatch(threads, queue, XTaskQueuePort_Completion, 0));
        CHECK(cleanups == before + 1);
        if (reuse) {
            block->callback = NULL;
            IXThreadingImpl_XAsyncComplete(threads, block, S_OK, 0);
            CHECK(cleanups == before + 2);
            CHECK(VirtualFree(block, 0, MEM_RELEASE));
        }
    }
    CHECK(callbacks == 400);
    CHECK(cleanups == 500);
    CHECK(results == 100);
    CHECK(cancels == 0);
    IXThreadingImpl_XTaskQueueCloseHandle(threads, queue);
    IXThreadingImpl_Release(threads);
    printf("ASYNC CHECKS %ld FAILURES %ld CALLBACKS %ld CLEANUPS %ld\n", checks, failures, callbacks, cleanups);
    return failures ? 1 : 0;
}
