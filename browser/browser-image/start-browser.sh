#!/bin/sh
set -eu
WIDTH="${1:-1280}"
HEIGHT="${2:-720}"
case "$WIDTH:$HEIGHT" in (*[!0-9:]*|:*) exit 64;; esac
export DISPLAY=127.0.0.1:99
export HOME=/profile
export XDG_CONFIG_HOME=/profile/.config
mkdir -p "$XDG_CONFIG_HOME"
export DBUS_SESSION_BUS_ADDRESS="$(dbus-daemon --session --fork --print-address)"
Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten unix -listen tcp &
openbox >/tmp/openbox.log 2>&1 &
# DISPLAY uses loopback TCP because the container deliberately disables the X11
# unix socket. MIT-SHM cannot work across that transport and makes x11vnc exit
# after its initial framebuffer read, so explicitly disable it.
# Clipboard is one-way: "-seldir recv" accepts cut text from the viewer (local
# paste sets PRIMARY and CLIPBOARD, which Chromium reads) but never sends the
# remote selection back to the viewer. Never disable receiving cut text.
x11vnc -display "$DISPLAY" -noshm -forever -shared -localhost -nopw -rfbport 5900 -seldir recv >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
socat TCP-LISTEN:9222,reuseaddr,fork TCP:127.0.0.1:9223 >/tmp/socat.log 2>&1 &
# Mobile profile (BROWSER_MOBILE=1, set by the orchestrator only for phones):
# the framebuffer above is CSS size x DPR, Chromium renders at that scale factor
# so its CSS viewport equals the phone's (min 500px, see below), with a mobile
# UA and touch events.
# Desktop launches never set BROWSER_MOBILE and get no extra flags.
WINDOW_WIDTH="$WIDTH"
WINDOW_HEIGHT="$HEIGHT"
set --
if [ "${BROWSER_MOBILE:-0}" = "1" ]; then
  CSS_WIDTH="${BROWSER_CSS_WIDTH:-}"
  CSS_HEIGHT="${BROWSER_CSS_HEIGHT:-}"
  DPR="${BROWSER_DPR:-1}"
  case "$CSS_WIDTH:$CSS_HEIGHT" in (*[!0-9:]*|:*|*:) exit 64;; esac
  case "$DPR" in (""|*[!0-9.]*|*.*.*) exit 64;; esac
  CHROME_MAJOR="$(chromium --version 2>/dev/null | sed -n 's/^Chromium \([0-9][0-9]*\)\..*/\1/p')" || CHROME_MAJOR=""
  CHROME_MAJOR="${CHROME_MAJOR:-130}"
  WINDOW_WIDTH="$CSS_WIDTH"
  WINDOW_HEIGHT="$CSS_HEIGHT"
  # Chromium clamps a window to a 500 DIP minimum width. A narrower phone would
  # get a 500px layout viewport with the right edge drawn off the framebuffer.
  # Instead lay out at 500 CSS px and scale it to fill the framebuffer exactly,
  # so the whole page is always visible (slightly zoomed out on small phones).
  MIN_WINDOW_WIDTH=500
  if [ "$CSS_WIDTH" -lt "$MIN_WINDOW_WIDTH" ]; then
    DPR="$(awk -v w="$WIDTH" -v m="$MIN_WINDOW_WIDTH" 'BEGIN { printf "%.4f", w / m }')"
    WINDOW_WIDTH="$MIN_WINDOW_WIDTH"
    WINDOW_HEIGHT="$(awk -v h="$HEIGHT" -v d="$DPR" 'BEGIN { printf "%d", h / d }')"
  fi
  set -- \
    --user-agent="Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Mobile Safari/537.36" \
    --force-device-scale-factor="$DPR" \
    --touch-events=enabled
fi
exec chromium \
  --kiosk \
  --start-maximized \
  --window-position=0,0 \
  --window-size="${WINDOW_WIDTH},${WINDOW_HEIGHT}" \
  --disable-infobars \
  --user-data-dir=/profile \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --remote-allow-origins=* \
  --proxy-server="${BROWSER_EGRESS_PROXY:-http://canvas-browser-egress-proxy:3128}" \
  --proxy-bypass-list="localhost;127.0.0.1" \
  --disable-webrtc \
  --no-sandbox \
  --disable-setuid-sandbox \
  --single-process \
  --no-zygote \
  --disable-crash-reporter \
  --disable-crashpad \
  --disable-crashpad-for-testing \
  --disable-breakpad \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions-except=/opt/canvas-grove/no-passkeys \
  --load-extension=/opt/canvas-grove/no-passkeys \
  --disable-features=WebAuthenticationCable,WebAuthenticationHybridLinking,PasswordManagerOnboarding \
  "$@" \
  about:blank
