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
  # Same generation steps as build-shared-runtime.mjs: the pinned tree has no
  # configure script until autoreconf runs.
  (cd "$SRC/dlls/winevulkan" && python3 make_vulkan -x vk.xml -X video.xml)
  (cd "$SRC" && perl tools/make_specfiles && autoreconf -fiv)
  mkdir -p "$BUILD"
  # With both archs enabled the arm64ec objects are linked into ARM64X hybrids
  # that land in aarch64-windows.
  (cd "$BUILD" && "$SRC/configure" --enable-archs=aarch64,arm64ec --without-x --without-wayland --disable-tests \
    --without-freetype --without-gnutls > configure.out 2>&1 || { tail -60 configure.out; exit 1; })
  tail -20 "$BUILD/configure.out"
fi
# d3dcompiler_47 is included because the arm64 base links vkd3d-shader into it
# statically (no libvkd3d-shader-1.dll import), so the HLSL state-keyword patch
# only reaches games through a patched d3dcompiler build.
TARGETS=(dlls/xgameruntime/aarch64-windows/xgameruntime.dll dlls/winhttp/aarch64-windows/winhttp.dll
  dlls/mscoree/aarch64-windows/mscoree.dll dlls/windows.web/aarch64-windows/windows.web.dll
  dlls/twinapi.appcore/aarch64-windows/twinapi.appcore.dll dlls/d3dcompiler_47/aarch64-windows/d3dcompiler_47.dll)
make -C "$BUILD" -j"$JOBS" "${TARGETS[@]}"

# ---- collect and verify machine types -------------------------------------
OUT="$WORK/components-arm64"
mkdir -p "$OUT"
for t in "${TARGETS[@]}"; do cp "$BUILD/$t" "$OUT/"; done
cp "$NG_BUILD/lib/libnghttp2.dll" "$OUT/"
cp "$SHADER_BUILD/.libs/libvkd3d-shader-1.dll" "$OUT/"
"$BUILD/tools/winebuild/winebuild" --builtin "$OUT/libvkd3d-shader-1.dll"
# ARM64X hybrids carry the ARM64 machine type. Plain ARM64EC images carry the
# AMD64 machine type like real x86_64 code and are told apart by the CHPE
# metadata in their load config, so the check reads that with llvm-readobj.
python3 - "$OUT" <<'PY'
import json, pathlib, struct, sys, hashlib, subprocess
out = pathlib.Path(sys.argv[1]); MACH = {0x8664: 'x86_64', 0xAA64: 'ARM64', 0x14C: 'i386'}
def chpe(path):
    text = subprocess.run(['llvm-readobj', '--coff-load-config', str(path)], capture_output=True, text=True).stdout
    for line in text.splitlines():
        if 'CHPEMetadataPointer' in line:
            return line.split(':')[-1].strip() not in ('0', '0x0')
    return False
report = {}
for f in sorted(out.glob('*.dll')):
    b = f.read_bytes(); off = struct.unpack_from('<I', b, 0x3C)[0]; m = struct.unpack_from('<H', b, off + 4)[0]
    machine = MACH.get(m, hex(m))
    if machine == 'x86_64' and chpe(f): machine = 'ARM64EC'
    report[f.name] = {'machine': machine, 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
    print(f'{f.name:28} {machine:8} {len(b):>9} bytes')
(out / 'arm64-components.json').write_text(json.dumps(report, indent=2) + '\n')
bad = [n for n, r in report.items() if r['machine'] not in ('ARM64', 'ARM64EC')]
if bad: raise SystemExit(f'unexpected machine types: {bad}')
PY

# ---- components directory with the x86_64 contract -----------------------
# Host shim (aarch64), x86_64 compatibility PEs, ARM64EC DXVK, licences and a
# source-manifest.json that assemble-shared-runtime.mjs accepts.
COMPONENTS="$WORK/components"
if [ ! -f "$COMPONENTS/source-manifest.json" ]; then
  rm -rf "$COMPONENTS" "$WORK/dxvk-work"
  mkdir -p "$WORK/dxvk-work"
  node "$PROJECT/scripts/arm64/collect-components.mjs" --shared "$WORK/shared" --pe "$OUT" \
    --work "$WORK/dxvk-work" --output "$COMPONENTS" --jobs "$JOBS"
fi

# ---- media: pinned LGPL FFmpeg libraries built for aarch64 ------------------
# MEDIA_BUNDLE points at the media-bundle.tar.xz from build-runtime-media.mjs
# on an aarch64 host (CI builds it on ubuntu-22.04-arm for the glibc ceiling).
MEDIA_ARGS=()
if [ -n "${MEDIA_BUNDLE:-}" ]; then
  rm -rf "$WORK/media"; mkdir -p "$WORK/media"
  tar -xJf "$MEDIA_BUNDLE" -C "$WORK/media"
  node "$PROJECT/scripts/ci/check-media-glibc.mjs" "$WORK/media/media-manifest.json"
  test "$(node -p "require('$WORK/media/media-manifest.json').arch")" = aarch64
  MEDIA_ARGS=(--media "$WORK/media")
fi

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


# ---- assembly: the same script as x86_64, following the arm64 layout --------
RUNTIME="$WORK/runtime-arm64"
rm -rf "$RUNTIME"
node "$PROJECT/scripts/assemble-shared-runtime.mjs" --base "$BASE_DIR/$DIRECTORY" --components "$COMPONENTS" \
  "${MEDIA_ARGS[@]}" --output "$RUNTIME"
node -e "const m=require('$RUNTIME/XODUS_NEXUS_PATCH.json'); if(m.arch!=='aarch64'||m.hostPeArch!=='aarch64-windows'||!m.componentsByArch['aarch64-windows']['d3dcompiler_47.dll'])process.exit(1)"

# ---- smoke test: the assembled runtime runs an arm64 and an x86_64 PE -------
# The loader is now the Nexus shim, which execs wine.nexus-original beside it.
SMOKE="$WORK/smoke"
rm -rf "$SMOKE"
mkdir -p "$SMOKE"
x86_64-w64-mingw32-gcc -O2 -o "$SMOKE/hello-x64.exe" "$PROJECT/scripts/arm64/hello.c"
aarch64-w64-mingw32-clang -O2 -o "$SMOKE/hello-arm64.exe" "$PROJECT/scripts/arm64/hello.c"
export WINEPREFIX="$SMOKE/pfx" WINEDEBUG=-all WINEDLLPATH="$RUNTIME/files/lib/vkd3d:$RUNTIME/files/lib/wine"
export LD_LIBRARY_PATH="$RUNTIME/$(lock layout.hostLibraries)" PATH="$RUNTIME/$(lock layout.bin):$PATH"
export FEX_APP_CONFIG_LOCATION="$RUNTIME/files/share/fex-emu/" FEX_DISKCACHE=1
wine --version
timeout 600 wine wineboot --init > "$SMOKE/wineboot.log" 2>&1 || echo "wineboot exit $?"
tail -5 "$SMOKE/wineboot.log"
timeout 300 wine "$SMOKE/hello-arm64.exe" > "$SMOKE/hello-arm64.log" 2>&1 || { echo "arm64 hello exit $?"; cat "$SMOKE/hello-arm64.log"; exit 1; }
tail -5 "$SMOKE/hello-arm64.log"
timeout 300 wine "$SMOKE/hello-x64.exe" > "$SMOKE/hello-x64.log" 2>&1 || { echo "x64 hello exit $?"; cat "$SMOKE/hello-x64.log"; exit 1; }
tail -5 "$SMOKE/hello-x64.log"
timeout 120 wineserver -w || true
# The assembled default prefix must carry the overlaid DXVK and d3dcompiler.
for dll in dxgi.dll d3d11.dll d3dcompiler_47.dll xgameruntime.dll; do
  cmp "$COMPONENTS/$dll" "$RUNTIME/$(lock layout.defaultPrefix)/drive_c/windows/system32/$dll"
done

# ---- package: candidate archive, checksum and corresponding source ---------
# Never published from here; the workflow uploads it as a candidate artifact.
if [ -n "${NEXUS_VERSION:-}" ]; then
  NEXUS_NAME="xodus-nexus-runtime-$NEXUS_VERSION"
  DIST="$WORK/dist"
  rm -rf "$DIST"; mkdir -p "$DIST"
  node -e "const fs=require('fs');const f='$RUNTIME/XODUS_NEXUS_PATCH.json';const m=JSON.parse(fs.readFileSync(f));m.baseProtonRelease='$TAG';m.baseSnapshot='$ARCHIVE';m.patchState=process.env.GITHUB_SHA||'local';fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n')"
  mv "$RUNTIME" "$WORK/$NEXUS_NAME"
  (cd "$WORK" && XZ_OPT="${XZ_OPT:--T2}" tar -cJf "$DIST/$NEXUS_NAME-aarch64.tar.xz" "$NEXUS_NAME")
  (cd "$DIST" && sha512sum "$NEXUS_NAME-aarch64.tar.xz" > "$NEXUS_NAME-aarch64.sha512sum")
  SOURCE_PATHS=(shared/wine-src shared/nghttp2-src shared/vkd3d-src shared/vulkan-headers shared/spirv-headers dxvk-work/dxvk/dxvk-src dxvk-work/dxvk/dxvk-tools)
  if [ -d "$WORK/media" ]; then SOURCE_PATHS+=("media/$(node -p "require('$PROJECT/scripts/runtime-media.lock.json').archive")" media/media-manifest.json); fi
  (cd "$WORK" && XZ_OPT="${XZ_OPT:--T2}" tar --exclude=.git -cJf "$DIST/$NEXUS_NAME-source.tar.xz" "${SOURCE_PATHS[@]}" \
    -C "$PROJECT" LICENSE assets scripts/runtime-patches.lock.json scripts/runtime-media.lock.json scripts/runtime-base-arm64.lock.json \
    scripts/runtime-dxvk.lock.json scripts/verify-runtime-base.mjs scripts/runtime-layout.mjs scripts/runtime-compat scripts/arm64 \
    scripts/build-shared-runtime.mjs scripts/build-runtime-dxvk.mjs scripts/build-runtime-media.mjs \
    scripts/assemble-shared-runtime.mjs scripts/SHARED_RUNTIME.md)
  ls -la "$DIST"
fi
echo ARM64-RUNTIME-EXPERIMENT-DONE
