#!/bin/sh
# Steam's injected overlay can crash Electron before JavaScript starts (including
# the font bootstrap). Filter only that library, retaining other preloads and
# Steam's launch/tracking environment. Never evaluate or glob loader tokens.
if [ -n "${LD_PRELOAD-}" ]; then
  nexus_filtered_preload=$(
    set -f
    IFS=' :'
    nexus_preload_result=
    nexus_preload_removed=
    for nexus_preload_entry in $LD_PRELOAD; do
      [ -n "$nexus_preload_entry" ] || continue
      case "${nexus_preload_entry##*/}" in
        gameoverlayrenderer.so) nexus_preload_removed=1 ;;
        *)
          if [ -n "$nexus_preload_result" ]; then
            nexus_preload_result="$nexus_preload_result:$nexus_preload_entry"
          else
            nexus_preload_result=$nexus_preload_entry
          fi ;;
      esac
    done
    # A sentinel preserves literal trailing newlines in unrelated loader tokens.
    if [ -n "$nexus_preload_removed" ]; then
      printf '%s.' "$nexus_preload_result"
    else
      printf '%s.' "$LD_PRELOAD"
    fi
  )
  nexus_filtered_preload=${nexus_filtered_preload%.}
  if [ "$nexus_filtered_preload" != "$LD_PRELOAD" ]; then
    if [ -n "$nexus_filtered_preload" ]; then
      export LD_PRELOAD="$nexus_filtered_preload"
    else
      unset LD_PRELOAD
    fi
  fi
  unset nexus_filtered_preload
fi
app_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
binary="$app_root/xodus-nexus.bin"
# Background-service modes run plain Node entry points from this build, never
# the Electron UI. The stable AppImage/wrapper path is what units and Steam call.
case "${1-}" in
  --nexus-daemon|--nexus-client)
    nexus_mode=${1#--nexus-}; shift
    ELECTRON_RUN_AS_NODE=1 exec "$binary" "$app_root/resources/nexus-node/dist-electron/$nexus_mode/index.js" "$@" ;;
esac
# Native helper modes must retain their normal behavior, including Crashpad.
if [ "${ELECTRON_RUN_AS_NODE-}" = 1 ]; then exec "$binary" "$@"; fi
# Steam's GTK input module can deliver the same text twice to Electron. Scope
# the fallback to the top-level Game Mode session, before native GTK starts.
# The main process restores Steam's module for non-Electron child processes.
unset XODUS_NEXUS_STEAM_IME
case ":${XDG_CURRENT_DESKTOP-}:" in
  *:[gG][aA][mM][eE][sS][cC][oO][pP][eE]:*)
    if [ "${GTK_IM_MODULE-}" = Steam ]; then
      export XODUS_NEXUS_STEAM_IME=1
      export GTK_IM_MODULE=simple
    fi ;;
esac
original_set="${FONTCONFIG_FILE+x}"
original="${FONTCONFIG_FILE-}"
config=$(ELECTRON_RUN_AS_NODE=1 "$binary" "$app_root/resources/font-bootstrap/bootstrap.mjs")
if [ -n "$config" ]; then
  export XODUS_NEXUS_FONTCONFIG="$config"
  export XODUS_NEXUS_FONTCONFIG_ORIGINAL_SET="$original_set"
  export XODUS_NEXUS_FONTCONFIG_ORIGINAL="$original"
  export FONTCONFIG_FILE="$config"
fi
exec "$binary" "$@"
