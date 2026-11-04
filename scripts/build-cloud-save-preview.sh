#!/usr/bin/env bash
set -euo pipefail

# Builds the pinned, unmerged xgameruntime PR in a copy of a compatible Wine tree.
# Usage: build-cloud-save-preview.sh WINE_SOURCE WORK_DIRECTORY [--xuser-contract]

pr_commit=3fd4ae1091339ef07d6f2d53fda8e15541f96ad3
wine_commit=b1dd32734a34472a28eb5be9922df06e07ac0834
script_root=$(realpath -e -- "$(dirname -- "$0")/..")
if [[ $# -lt 2 || $# -gt 3 || ( $# -eq 3 && $3 != --xuser-contract ) ]]; then
  echo "Usage: $0 WINE_SOURCE WORK_DIRECTORY [--xuser-contract]" >&2
  exit 2
fi
wine_source=$(realpath -e -- "$1")
work_dir=$(realpath -m -- "$2")
if [[ $(git -C "$wine_source" rev-parse HEAD) != "$wine_commit" ]]; then
  echo "Wine source must be at $wine_commit for this preview build." >&2
  exit 1
fi
if [[ -e $work_dir ]]; then
  echo "Work directory already exists: $work_dir" >&2
  exit 1
fi
mkdir -p -- "$work_dir"
git clone --filter=blob:none --no-checkout https://github.com/xodus-gaming/xgameruntime.git "$work_dir/pr"
git -C "$work_dir/pr" fetch --depth 1 origin pull/28/head
if [[ $(git -C "$work_dir/pr" rev-parse FETCH_HEAD) != "$pr_commit" ]]; then
  echo 'PR #28 moved; inspect the new diff before rebuilding.' >&2
  exit 1
fi
git -C "$work_dir/pr" checkout --detach "$pr_commit"

mkdir -p -- "$work_dir/src" "$work_dir/build"
cp -a --reflink=auto "$wine_source/." "$work_dir/src/"
rsync -a --exclude=.git "$work_dir/pr/" "$work_dir/src/dlls/xgameruntime/"
git -C "$work_dir/src" apply --check "$script_root/assets/xgameruntime-tcp-bridge.patch"
git -C "$work_dir/src" apply "$script_root/assets/xgameruntime-tcp-bridge.patch"
git -C "$work_dir/src" apply --check "$script_root/assets/xgameruntime-async-completion-lifetime.patch"
git -C "$work_dir/src" apply "$script_root/assets/xgameruntime-async-completion-lifetime.patch"
if [[ ${3:-} == --xuser-contract ]]; then
  # ABI-preserving replacement experiment, not the old two research patches.
  git -C "$work_dir/src" apply --check "$script_root/assets/xgameruntime-xuser-contract.patch"
  git -C "$work_dir/src" apply "$script_root/assets/xgameruntime-xuser-contract.patch"
fi
git -C "$work_dir/src" apply --check "$script_root/assets/xgameruntime-package-locale.patch"
git -C "$work_dir/src" apply "$script_root/assets/xgameruntime-package-locale.patch"
(
  cd "$work_dir/build"
  # XODUS_CONFIGURE_EXTRA carries extra configure flags (CI builds only the
  # mingw xgameruntime DLL and passes --without-x to skip the X11 dev files
  # wine's configure otherwise requires; local builds leave it unset).
  # shellcheck disable=SC2086
  ../src/configure --enable-win64 ${XODUS_CONFIGURE_EXTRA:-}
  make -j8 dlls/xgameruntime/x86_64-windows/xgameruntime.dll
)

result="$work_dir/build/dlls/xgameruntime/x86_64-windows/xgameruntime.dll"
# file(1) wording differs between versions (5.48 prints "for WINE", older
# runner versions print "for MS Windows"); check the architecture instead.
if ! file -b -- "$result" | grep -q 'PE32+ executable.*x86-64'; then
  echo 'The build did not produce the expected 64-bit Wine DLL:' >&2
  file -b -- "$result" >&2
  exit 1
fi
echo "Built $result"
if [[ ${3:-} == --xuser-contract ]]; then
  dll_sha=$(sha256sum "$result" | cut -d ' ' -f 1)
  echo "Activate onto the preserved shared baseline with: node scripts/install-xuser-contract-runtime.mjs install '$result' RUNTIME_ROOT '$dll_sha'"
else
  echo "Activate with: scripts/install-cloud-save-preview.sh '$result' RUNTIME_ROOT '$pr_commit'"
fi
