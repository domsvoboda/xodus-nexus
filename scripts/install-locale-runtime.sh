#!/usr/bin/env bash
set -euo pipefail

# Installs a locale-enabled xgameruntime DLL as a separate Proton release.
# Usage: install-locale-runtime.sh BUILT_DLL RUNTIME_ROOT XGAMERUNTIME_COMMIT
#
# The locale-enabled DLL supports XPackageGetUserLocale via XODUS_PACKAGE_LOCALE
# environment variable. The active runtime remains unchanged; this creates
# a new release variant with a -locale-v1 suffix.

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 BUILT_DLL RUNTIME_ROOT XGAMERUNTIME_COMMIT" >&2
  exit 2
fi

source_dll=$(realpath -e -- "$1")
runtime_root=$(realpath -e -- "$2")
source_commit=$3
if [[ ! $source_commit =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Expected a full 40-character xgameruntime commit.' >&2
  exit 2
fi
if [[ $(file -b -- "$source_dll") != *'PE32+ executable for WINE (DLL)'* ]]; then
  echo 'The source is not a 64-bit Wine DLL.' >&2
  exit 2
fi
if ! grep -a -q 'XODUS_PACKAGE_LOCALE' "$source_dll"; then
  echo 'The DLL lacks the XODUS_PACKAGE_LOCALE support.' >&2
  exit 2
fi

# Check for active processes
if pgrep -x xodus-cli >/dev/null || pgrep -x xodus-service >/dev/null || pgrep -x wine >/dev/null || pgrep -x wine64 >/dev/null; then
  echo 'A Xodus/game process is active; wait until it exits.' >&2
  exit 1
fi

pointer="$runtime_root/current.json"
releases="$runtime_root/releases"

# Get the current runtime info
if [[ ! -f "$pointer" ]]; then
  echo 'No runtime is currently installed. Install a standard Nexus Runtime first.' >&2
  exit 1
fi

current_name=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).name' "$pointer")
if [[ ! $current_name =~ ^proton-xodus-[A-Za-z0-9._-]+$ ]]; then
  echo 'The active runtime pointer has an unexpected release name.' >&2
  exit 1
fi

base="$releases/$current_name"
if [[ ! -x "$base/files/bin/wine" || ! -f "$base/files/lib/wine/x86_64-windows/xgameruntime.dll" ]]; then
  echo 'The active Proton release is incomplete.' >&2
  exit 1
fi

# Create the locale-enabled variant name
target_name="${current_name}-locale-v1"
target="$releases/$target_name"
if [[ -e $target ]]; then
  echo "Target already exists: $target" >&2
  exit 1
fi

# Create a staging directory
staging=$(mktemp -d "$releases/.staging-locale-XXXXXXXX")
trap 'if [[ -n ${staging:-} && -d $staging ]]; then rm -rf -- "$staging"; fi' EXIT

# Copy the base runtime
cp -a --reflink=auto "$base/." "$staging/"

# Replace xgameruntime.dll with the locale-enabled version
install -m 0644 -- "$source_dll" "$staging/files/lib/wine/x86_64-windows/xgameruntime.dll"
install -m 0644 -- "$source_dll" "$staging/files/share/default_pfx/drive_c/windows/system32/xgameruntime.dll"

# Verify the installed Wine still works
"$staging/files/bin/wine" --version >/dev/null

# Create metadata. The new release keeps every feature of the base runtime;
# the launcher decides whether cloud saves and the offline patches are active
# from this file, so overwriting it with "package-locale" alone would silently
# disable them. A DLL built from xgameruntime main without the base patch
# stack is rejected.
dll_sha=$(sha256sum "$source_dll" | cut -d ' ' -f 1)
base_sha=$(sha256sum "$base/files/lib/wine/x86_64-windows/xgameruntime.dll" | cut -d ' ' -f 1)
BASE="$base" SOURCE_DLL="$source_dll" SOURCE_COMMIT="$source_commit" DLL_SHA="$dll_sha" BASE_SHA="$base_sha" TARGET_NAME="$target_name" node - "$staging" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const staging = process.argv[2];
let base = {};
try { base = JSON.parse(fs.readFileSync(path.join(process.env.BASE, 'XODUS_NEXUS_PATCH.json'), 'utf8')); } catch {}
const markerByFeature = {
  'cloud-saves-pr28': 'XODUS_SAVE_SYNC',
  'xodus-tcp-bridge-v1': 'XODUS_BRIDGE_PORT',
  'xuser-state-v1': 'xodus-userstate-v1',
  'xuser-guest-v1': 'xodus-userguest-v1',
  'package-locale': 'XODUS_PACKAGE_LOCALE',
};
const dll = fs.readFileSync(process.env.SOURCE_DLL).toString('latin1');
const baseFeatures = Array.isArray(base.features) ? base.features : [];
for (const feature of baseFeatures) {
  const marker = markerByFeature[feature];
  if (marker && !dll.includes(marker)) {
    console.error(`The base runtime provides '${feature}', but the source DLL lacks the '${marker}' marker.`);
    console.error('Build the DLL from the same patch stack (scripts/build-cloud-save-preview.sh already applies the locale patch) instead of xgameruntime main.');
    process.exit(1);
  }
}
const features = [...baseFeatures.filter((feature) => feature !== 'package-locale'), 'package-locale'];
fs.writeFileSync(path.join(staging, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({
  name: 'locale-v1',
  source: base.source ?? 'https://github.com/xodus-gaming/xgameruntime (main branch)',
  description: 'Adds XPackageGetUserLocale support via XODUS_PACKAGE_LOCALE for game language selection',
  xgameruntimeCommit: process.env.SOURCE_COMMIT,
  baseDllSha256: process.env.BASE_SHA,
  patchedDllSha256: process.env.DLL_SHA,
  features,
  ...(base.warning ? { warning: base.warning } : {}),
  installedAt: new Date().toISOString(),
}, null, 2) + '\n');
NODE

# Move to final location
mv -- "$staging" "$target"
staging=''

# Do NOT activate automatically - let the user switch manually
# via Settings -> Use previous runtime or by selecting this specific release
echo "Installed $target_name (DLL SHA-256 $dll_sha). The active runtime is unchanged."
echo "To activate: Select '$target_name' in Settings -> Nexus Runtime -> Use previous runtime,"
echo "or manually set the runtime pointer to: $target"
