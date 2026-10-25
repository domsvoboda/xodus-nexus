/* Minimal smoke-test program: prints its own machine type and loads the
 * overlaid xgameruntime.dll, so the arm64 Wine and its FEX layer are exercised
 * without any account, network or game. */
#include <windows.h>
#include <stdio.h>

int main(void)
{
    SYSTEM_INFO info;
    HMODULE module;
    GetNativeSystemInfo(&info);
    printf("hello from PE; processor architecture %u (9=x64, 12=arm64)\n", info.wProcessorArchitecture);
    module = LoadLibraryW(L"xgameruntime.dll");
    if (!module)
    {
        printf("xgameruntime.dll did not load: %lu\n", GetLastError());
        return 2;
    }
    /* The public XGameRuntime* API is a header-level static library; the DLL
     * itself exports the implementation entry points. */
    printf("xgameruntime.dll loaded; InitializeApiImpl %s, QueryApiImpl %s\n",
           GetProcAddress(module, "InitializeApiImpl") ? "exported" : "missing",
           GetProcAddress(module, "QueryApiImpl") ? "exported" : "missing");
    if (!GetProcAddress(module, "InitializeApiImpl")) return 3;
    FreeLibrary(module);
    return 0;
}
