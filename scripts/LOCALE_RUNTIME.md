# Locale-Enabled Nexus Runtime

This directory contains scripts for building and installing a locale-enabled version of the Xodus Proton runtime. The locale-enabled runtime supports the `XODUS_PACKAGE_LOCALE` environment variable, which allows Nexus Launcher to set the game language for titles that respect the Windows `XPackageGetUserLocale` API.

## Problem

By default, the official Xodus Proton runtime does not implement `XPackageGetUserLocale` in xgameruntime. When a game (like Gears of War) calls this API, it returns `E_NOTIMPL`, causing the game to fall back to its default language (usually English), even when a different language is selected in Nexus Launcher.

## Solution

The `xgameruntime-package-locale.patch` asset adds support for `XPackageGetUserLocale` by reading the `XODUS_PACKAGE_LOCALE` environment variable. These scripts help you build and install a Proton runtime with this patch applied.

## Prerequisites

- A prepared Wine source tree (commit `b1dd32734a34472a28eb5be9922df06e07ac0834`)
- Git, rsync, Make, MinGW-w64
- Wine build dependencies
- ~15 GB temporary disk space
- The GitHub CLI (`gh`) for downloading the base Xodus Proton snapshot

## Building the Locale-Enabled Runtime

### Step 1: Build the patched xgameruntime DLL

```bash
# Clone or prepare a Wine source tree at the expected commit
scripts/build-locale-runtime.sh /path/to/wine-b1dd /path/to/build-output
```

This script will:
1. Clone the xgameruntime main branch
2. Copy the Wine source tree
3. Integrate xgameruntime into the Wine tree
4. Apply the `xgameruntime-package-locale.patch`
5. Build the xgameruntime DLL
6. Output the path to the built DLL

The script requires the Wine source to be at commit `b1dd32734a34472a28eb5be9922df06e07ac0834` (the same commit used by the cloud-save preview scripts).

**Important:** a DLL built from xgameruntime main carries only the locale patch. If the active runtime is a cloud-save preview (PR #28 stack with the TCP bridge, XUser state/guest and task-queue patches), `install-locale-runtime.sh` refuses such a DLL, because replacing the runtime DLL with it would silently break cloud saves and the offline/task-queue support. Build the DLL with `scripts/build-cloud-save-preview.sh` instead; that script already applies `xgameruntime-package-locale.patch` on top of the full patch stack, and `scripts/install-cloud-save-preview.sh` activates the result with complete feature metadata.

### Step 2: Install the locale-enabled runtime

First, install a standard Nexus Runtime through Settings if you haven't already.

```bash
# Get the xgameruntime commit hash (check assets/xgameruntime-package-locale.patch for compatibility)
XGAMERUNTIME_COMMIT=$(git ls-remote https://github.com/xodus-gaming/xgameruntime.git HEAD | awk '{print $1}')

# Install the locale-enabled variant
scripts/install-locale-runtime.sh /path/to/build-output/build/dlls/xgameruntime/x86_64-windows/xgameruntime.dll ~/.local/share/xodus-nexus/runtimes "$XGAMERUNTIME_COMMIT"
```

This creates a new runtime release with a `-locale-v1` suffix (e.g., `proton-xodus-8.0-xgamesave-...-locale-v1`).

### Step 3: Activate the locale-enabled runtime

The install script does **not** activate the new runtime automatically. To activate it:

1. Open Nexus Launcher
2. Go to Settings → Nexus Runtime
3. Click "Use previous runtime" to switch back to the base runtime, then the locale-enabled variant should be available
4. **OR** manually set the runtime pointer:
   ```bash
   # List available releases
   ls ~/.local/share/xodus-nexus/runtimes/releases/
   
   # Create a new current.json pointing to the locale-enabled runtime
   echo '{"name":"proton-xodus-8.0-...-locale-v1","winePath":"~/.local/share/xodus-nexus/runtimes/releases/proton-xodus-8.0-...-locale-v1/files/bin/wine","installedAt":"..."}' > ~/.local/share/xodus-nexus/runtimes/current.json
   ```

## How It Works

When you select a game language in Nexus Launcher (e.g., `cs-CZ`):

1. Nexus sets environment variables including `XODUS_PACKAGE_LOCALE=cs-CZ`
2. The patched xgameruntime DLL reads this variable via `GetEnvironmentVariableA`
3. When the game calls `XPackageGetUserLocale`, xgameruntime returns the value from `XODUS_PACKAGE_LOCALE`
4. The game uses this locale for its UI and content

Nexus also exports `LANG`/`LC_ALL` for the selected locale and, when the game prefix pins a different Windows user locale, deletes `HKCU\Control Panel\International` in the prefix before launch. Wine rebuilds that registry key from the launch environment on the next query, so titles that read `GetUserDefaultLocaleName` instead of `XPackageGetUserLocale` also follow the selected language.

For Unreal GDK titles the text culture is resolved at engine init, before the cloud save with the in-game Language Select is available (Gears of War: E-Day, for example, never calls `XPackageGetUserLocale`). When a game language is selected, Nexus therefore also pins the culture in a read-only `Game.ini` (`[Internationalization] Culture=<locale>`) inside the prefix under `AppData/Local/Microsoft/<product>/WinGDK/<TitleId>/Saved/Config/WinGDK/`, matched by the `<TitleId>` from `MicrosoftGame.config`. This is scoped defensively:

- it only runs for Unreal installations (an `Engine/` directory in the game install); every other engine is never touched,
- Nexus only manages the two marker-owned lines it wrote itself; any manually authored `Culture` line wins and is left untouched,
- clearing the game language in the launcher removes the pinned lines again, so the game's own language logic takes back control.

The install script merges the metadata of the base runtime: the new release keeps every feature of the base (`cloud-saves-pr28`, `xodus-tcp-bridge-v1`, `xuser-state-v1`, `xuser-guest-v1`, …) and appends `package-locale`. The launcher uses this feature list to decide whether the cloud-save service and the offline patches are active; overwriting it with `package-locale` alone would disable cloud saves and in-game Xbox sign-in for every game.

## Verifying the Patch

You can verify that the patch is working by:

1. Checking the DLL contains the patch:
   ```bash
   grep -a 'XODUS_PACKAGE_LOCALE' /path/to/xgameruntime.dll
   ```

2. Looking for the metadata file:
   ```bash
   cat ~/.local/share/xodus-nexus/runtimes/releases/*-locale-v1/XODUS_NEXUS_PATCH.json
   ```

## Reverting

To return to the standard runtime:

```bash
# In Nexus Launcher: Settings → Nexus Runtime → Use previous runtime
# Or manually:
cp ~/.local/share/xodus-nexus/runtimes/releases/proton-xodus-*/current.json.backup \
   ~/.local/share/xodus-nexus/runtimes/current.json
```

## Notes

- The locale-enabled runtime is a **separate release** with a `-locale-v1` suffix. The original runtime remains untouched.
- Both the `x86_64-windows/xgameruntime.dll` and the prefix copy are replaced.
- The patch only affects the `XPackageGetUserLocale` function. All other functionality remains unchanged.
- Not all games support language selection through this API. Some games may require additional patches or may not have the requested language available in their installation.
- The game must have the selected language's localization files installed. If you selected Czech but the game only has English files, it will still display in English.

## Troubleshooting

### "The active runtime pointer has an unexpected release name"
This error occurs if you don't have a standard Nexus Runtime installed first. Install one through Settings → Nexus Runtime → Check snapshot → Install Nexus Runtime.

### "A Xodus/game process is active"
Close all Xodus, Wine, and game processes before running the install script.

### "The DLL lacks the XODUS_PACKAGE_LOCALE support"
The DLL was not built with the patch. Make sure you used `build-locale-runtime.sh` and that the patch applied successfully (the script checks this before building).

### Game still in English after switching to locale-enabled runtime
1. Verify the game actually has the selected language installed (check for localization files in the game directory)
2. Make sure you selected the language in the game's settings in Nexus
3. Check the game log (in Nexus Library → right-click game → View log) for any locale-related errors
4. Check whether the active runtime still reports the full feature set in `XODUS_NEXUS_PATCH.json`. If it only lists `package-locale`, the launcher treats it as a runtime without cloud saves and the XUser patches; reinstall the runtime with a current script so the metadata is merged
5. Games that read the Windows user locale instead of `XPackageGetUserLocale` need a current Nexus build: it resets the prefix locale before launch. Verify with `wine reg query "HKCU\Control Panel\International" /v LocaleName` in the game prefix
