#!/usr/bin/env bash
set -euo pipefail

# Builds a locale-enabled xgameruntime DLL from main branch sources.
# Usage: build-locale-runtime.sh WINE_SOURCE WORK_DIRECTORY
#
# The resulting DLL supports XPackageGetUserLocale via XODUS_PACKAGE_LOCALE
# environment variable, enabling game language selection in Nexus Launcher.

script_root=$(realpath -e -- "$(dirname -- "$0")/..")
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 WINE_SOURCE WORK_DIRECTORY" >&2
  exit 2
fi
wine_source=$(realpath -e -- "$1")
work_dir=$(realpath -m -- "$2")
if [[ -e $work_dir ]]; then
  echo "Work directory already exists: $work_dir" >&2
  exit 1
fi

mkdir -p -- "$work_dir"

# Clone xgameruntime main branch
echo "Cloning xgameruntime main branch..."
git clone --filter=blob:none --no-checkout https://github.com/xodus-gaming/xgameruntime.git "$work_dir/xgameruntime"
git -C "$work_dir/xgameruntime" checkout --detach main

# Copy Wine source
echo "Copying Wine source..."
mkdir -p -- "$work_dir/src"
cp -a --reflink=auto "$wine_source/." "$work_dir/src/"

# Copy xgameruntime source into Wine tree
echo "Integrating xgameruntime..."
rsync -a --exclude=.git "$work_dir/xgameruntime/" "$work_dir/src/dlls/xgameruntime/"

# Apply the locale patch
echo "Applying xgameruntime-package-locale patch..."
git -C "$work_dir/src" apply --check "$script_root/assets/xgameruntime-package-locale.patch"
git -C "$work_dir/src" apply "$script_root/assets/xgameruntime-package-locale.patch"

# Build only xgameruntime DLL
echo "Building xgameruntime DLL..."
(
  cd "$work_dir/build"
  ../src/configure --enable-win64
  make -j$(nproc) dlls/xgameruntime/x86_64-windows/xgameruntime.dll
)

result="$work_dir/build/dlls/xgameruntime/x86_64-windows/xgameruntime.dll"
if [[ $(file -b -- "$result") != *'PE32+ executable for WINE (DLL)'* ]]; then
  echo 'The build did not produce the expected 64-bit Wine DLL.' >&2
  exit 1
fi

# Verify the patch was applied
if ! grep -a -q 'XODUS_PACKAGE_LOCALE' "$result"; then
  echo 'The DLL lacks the XODUS_PACKAGE_LOCALE support.' >&2
  exit 1
fi

echo "Built $result"
echo "Activate with: scripts/install-locale-runtime.sh '$result' RUNTIME_ROOT"
