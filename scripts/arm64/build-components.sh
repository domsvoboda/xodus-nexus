#!/bin/bash
# Experimental: build the Nexus runtime overlay DLLs as ARM64X (arm64ec +
# aarch64) from the pinned, patched xodus Wine, overlay them onto the pinned
# CachyOS arm64 Proton and smoke-test the result. Runs on an arm64 Linux host
# (GitHub `ubuntu-24.04-arm`). It reuses `build-shared-runtime.mjs
# --prepare-only` for the pinned checkouts and patch application, so sources
# and patches are exactly those of the x86_64 runtime.
set -euxo pipefail
PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-$PWD/arm64-build}"
JOBS="${JOBS:-4}"
LLVM_MINGW_TAG="${LLVM_MINGW_TAG:-20261020}"
LLVM_MINGW_SHA256="${LLVM_MINGW_SHA256:-}"
LOCK="$PROJECT/scripts/runtime-base-arm64.lock.json"
lock() { node -p "require('$LOCK').$1"; }

test "$(uname -m)" = aarch64
mkdir -p "$WORK"
cd "$WORK"

# ---- toolchain: llvm-mingw (clang + lld, aarch64 host) ---------------------
if [ ! -x "$WORK/llvm-mingw/bin/arm64ec-w64-mingw32-clang" ]; then
  name="llvm-mingw-$LLVM_MINGW_TAG-ucrt-ubuntu-22.04-aarch64"
  curl -fsSL -o "$name.tar.xz" "https://github.com/mstorsjo/llvm-mingw/releases/download/$LLVM_MINGW_TAG/$name.tar.xz"
  if [ -n "$LLVM_MINGW_SHA256" ]; then echo "$LLVM_MINGW_SHA256  $name.tar.xz" | sha256sum -c -; fi
  tar -xJf "$name.tar.xz"
  mv "$name" llvm-mingw
fi
export PATH="$WORK/llvm-mingw/bin:$PATH"
clang --version | head -1
arm64ec-w64-mingw32-clang --version | head -1

# ---- pinned sources and patches (identical to the x86_64 runtime) ---------
if [ ! -d "$WORK/shared/wine-src" ]; then
  node "$PROJECT/scripts/build-shared-runtime.mjs" --prepare-only --work "$WORK/shared" --jobs "$JOBS"
fi
SRC="$WORK/shared/wine-src"
NG_SRC="$WORK/shared/nghttp2-src"
SHADER_SRC="$WORK/shared/vkd3d-src"
VULKAN_HEADERS="$WORK/shared/vulkan-headers"
SPIRV_HEADERS="$WORK/shared/spirv-headers"

# ---- nghttp2 as an ARM64EC DLL (WinHTTP HTTP/2 overlay dependency) -------
NG_BUILD="$WORK/nghttp2-arm64ec"
if [ ! -f "$NG_BUILD/lib/libnghttp2.dll" ]; then
  cmake -S "$NG_SRC" -B "$NG_BUILD" -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=ARM64EC \
    -DCMAKE_C_COMPILER=arm64ec-w64-mingw32-clang -DCMAKE_RC_COMPILER=arm64ec-w64-mingw32-windres \
    -DENABLE_LIB_ONLY=ON -DBUILD_SHARED_LIBS=ON -DBUILD_STATIC_LIBS=OFF -DENABLE_DOC=OFF -DENABLE_APP=OFF \
    -DENABLE_EXAMPLES=OFF -DENABLE_FAILMALLOC=OFF -DBUILD_TESTING=OFF
  cmake --build "$NG_BUILD" --parallel "$JOBS"
fi
mkdir -p "$SRC/include/nghttp2"
cp "$NG_SRC/lib/includes/nghttp2/nghttp2.h" "$SRC/include/nghttp2/nghttp2.h"
cp "$NG_BUILD/lib/includes/nghttp2/nghttp2ver.h" "$SRC/include/nghttp2/nghttp2ver.h"

# ---- vkd3d shader compiler as an ARM64EC DLL ------------------------------
SHADER_BUILD="$WORK/vkd3d-arm64ec"
SHADER_STAGE="$WORK/vkd3d-arm64ec-stage"
if [ ! -f "$SHADER_BUILD/.libs/libvkd3d-shader-1.dll" ]; then
  if [ -d "$SHADER_SRC/.git" ]; then mv "$SHADER_SRC/.git" "$WORK/vkd3d-git-metadata"; fi
  (cd "$SHADER_SRC" && autoreconf -fiv)
  mkdir -p "$SHADER_BUILD"
  # config.sub does not know arm64ec, so configure for the aarch64 mingw host
  # and point every tool at the arm64ec llvm-mingw wrappers instead.
  (cd "$SHADER_BUILD" && env SONAME_LIBVULKAN=vulkan-1 CC=arm64ec-w64-mingw32-clang AR=arm64ec-w64-mingw32-ar \
    RANLIB=arm64ec-w64-mingw32-ranlib STRIP=arm64ec-w64-mingw32-strip WIDL=arm64ec-w64-mingw32-widl \
    DLLTOOL=arm64ec-w64-mingw32-dlltool \
    CPPFLAGS="-I$VULKAN_HEADERS/include -I$SPIRV_HEADERS/include" CFLAGS="-O2 -fno-lto" \
    "$SHADER_SRC/configure" --host=aarch64-w64-mingw32 --enable-shared --disable-static --disable-tests \
    --disable-demos --without-opengl --without-xcb --without-ncurses --without-spirv-tools --prefix="$SHADER_STAGE")
  make -C "$SHADER_BUILD" -j"$JOBS"
fi

# ---- Wine: ARM64X overlay DLLs --------------------------------------------
BUILD="$WORK/wine-build-arm64"
if [ ! -f "$BUILD/Makefile" ]; then
  mkdir -p "$BUILD"
  # The pinned tree ships its generated files (configure, winevulkan, spec
  # files) like the x86_64 build, which runs configure directly too. With both
  # archs enabled the arm64ec objects are linked into ARM64X hybrids that land
  # in aarch64-windows.
  (cd "$BUILD" && "$SRC/configure" --enable-archs=aarch64,arm64ec --without-x --without-wayland --disable-tests \
    --without-freetype --without-gnutls > configure.out 2>&1 || { tail -60 configure.out; exit 1; })
  tail -20 "$BUILD/configure.out"
fi
TARGETS=(dlls/xgameruntime/aarch64-windows/xgameruntime.dll dlls/winhttp/aarch64-windows/winhttp.dll
  dlls/mscoree/aarch64-windows/mscoree.dll dlls/windows.web/aarch64-windows/windows.web.dll
  dlls/twinapi.appcore/aarch64-windows/twinapi.appcore.dll)
make -C "$BUILD" -j"$JOBS" "${TARGETS[@]}"

# ---- collect and verify machine types -------------------------------------
OUT="$WORK/components-arm64"
mkdir -p "$OUT"
for t in "${TARGETS[@]}"; do cp "$BUILD/$t" "$OUT/"; done
cp "$NG_BUILD/lib/libnghttp2.dll" "$OUT/"
cp "$SHADER_BUILD/.libs/libvkd3d-shader-1.dll" "$OUT/"
"$BUILD/tools/winebuild/winebuild" --builtin "$OUT/libvkd3d-shader-1.dll"
python3 - "$OUT" <<'PY'
import json, pathlib, struct, sys, hashlib
out = pathlib.Path(sys.argv[1]); MACH = {0x8664: 'x86_64', 0xAA64: 'ARM64', 0xA641: 'ARM64EC', 0x14C: 'i386'}
report = {}
for f in sorted(out.glob('*.dll')):
    b = f.read_bytes(); off = struct.unpack_from('<I', b, 0x3C)[0]; m = struct.unpack_from('<H', b, off + 4)[0]
    report[f.name] = {'machine': MACH.get(m, hex(m)), 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
    print(f'{f.name:28} {report[f.name]["machine"]:8} {len(b):>9} bytes')
(out / 'arm64-components.json').write_text(json.dumps(report, indent=2) + '\n')
bad = [n for n, r in report.items() if r['machine'] not in ('ARM64', 'ARM64EC')]
if bad: raise SystemExit(f'unexpected machine types: {bad}')
PY

# ---- base: pinned CachyOS arm64 Proton -------------------------------------
BASE_DIR="$WORK/base"
ARCHIVE="$(lock archive)"; DIRECTORY="$(lock directory)"; TAG="$(lock tag)"; REPO="$(lock repository)"
if [ ! -d "$BASE_DIR/$DIRECTORY" ]; then
  mkdir -p "$BASE_DIR"
  curl -fsSL -o "$BASE_DIR/$ARCHIVE" "https://github.com/$REPO/releases/download/$TAG/$ARCHIVE"
  echo "$(lock archiveSha512)  $BASE_DIR/$ARCHIVE" | sha512sum -c -
  tar -tJf "$BASE_DIR/$ARCHIVE" > "$BASE_DIR/listing.txt"
  test "$(head -n1 "$BASE_DIR/listing.txt" | cut -d/ -f1)" = "$DIRECTORY"
  if grep -E '(^/|(^|/)\.\.(/|$))' "$BASE_DIR/listing.txt"; then exit 1; fi
  tar -xJf "$BASE_DIR/$ARCHIVE" -C "$BASE_DIR"
fi
node "$PROJECT/scripts/verify-runtime-base.mjs" "$BASE_DIR/$DIRECTORY" "$LOCK"

# ---- experimental assembly: overlay into the arm64 PE directories ----------
RUNTIME="$WORK/runtime-arm64"
rm -rf "$RUNTIME"
cp -a --reflink=auto "$BASE_DIR/$DIRECTORY" "$RUNTIME"
HOST_PE="$(lock layout.hostPeArch)"; PFX="$(lock layout.defaultPrefix)"
for dll in xgameruntime.dll winhttp.dll mscoree.dll windows.web.dll twinapi.appcore.dll libnghttp2.dll; do
  install -m 644 "$OUT/$dll" "$RUNTIME/files/lib/wine/$HOST_PE/$dll"
  install -m 644 "$OUT/$dll" "$RUNTIME/$PFX/drive_c/windows/system32/$dll"
done
install -m 644 "$OUT/libvkd3d-shader-1.dll" "$RUNTIME/files/lib/vkd3d/$HOST_PE/libvkd3d-shader-1.dll"
install -m 644 "$OUT/libvkd3d-shader-1.dll" "$RUNTIME/$PFX/drive_c/windows/system32/libvkd3d-shader-1.dll"
cp "$OUT/arm64-components.json" "$RUNTIME/XODUS_NEXUS_ARM64_EXPERIMENT.json"

# ---- smoke test: arm64 Wine runs an x86_64 PE through its bundled FEX ------
SMOKE="$WORK/smoke"
rm -rf "$SMOKE"
mkdir -p "$SMOKE"
x86_64-w64-mingw32-gcc -O2 -o "$SMOKE/hello-x64.exe" "$PROJECT/scripts/arm64/hello.c"
aarch64-w64-mingw32-clang -O2 -o "$SMOKE/hello-arm64.exe" "$PROJECT/scripts/arm64/hello.c"
# A fresh prefix: the shipped default prefix links into the base tree with
# relative symlinks that do not survive a copy, so let Wine create one from
# WINEDLLPATH (which already carries the overlays).
export WINEPREFIX="$SMOKE/pfx" WINEDEBUG=-all WINEDLLPATH="$RUNTIME/files/lib/vkd3d:$RUNTIME/files/lib/wine"
export LD_LIBRARY_PATH="$RUNTIME/files/lib/aarch64-linux-gnu" PATH="$RUNTIME/$(lock layout.bin):$PATH"
export FEX_APP_CONFIG_LOCATION="$RUNTIME/files/share/fex-emu/" FEX_DISKCACHE=1
wine --version
timeout 600 wine wineboot --init > "$SMOKE/wineboot.log" 2>&1 || echo "wineboot exit $?"
tail -5 "$SMOKE/wineboot.log"
timeout 300 wine "$SMOKE/hello-arm64.exe" > "$SMOKE/hello-arm64.log" 2>&1 || echo "arm64 hello exit $?"
tail -5 "$SMOKE/hello-arm64.log"
timeout 300 wine "$SMOKE/hello-x64.exe" > "$SMOKE/hello-x64.log" 2>&1 || echo "x64 hello exit $?"
tail -5 "$SMOKE/hello-x64.log"
timeout 120 wineserver -w || true
echo ARM64-RUNTIME-EXPERIMENT-DONE
