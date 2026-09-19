#!/bin/sh
set -eu
umask 077
mkdir -p "$XDG_RUNTIME_DIR" /data/logs
chmod 700 "$XDG_RUNTIME_DIR"
/opt/native/configure-browser.sh
# All logs/profile data remain inside the private per-user mount.
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp >/data/logs/display.log 2>&1 &
display_pid=$!
cleanup() { kill "$display_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
attempt=0
until xdpyinfo >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || exit 1
  sleep .1
done
openbox >/data/logs/window-manager.log 2>&1 &
# Private Docker-network VNC; no host port. Password created by the installer.
x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 \
  -rfbauth /data/vnc-auth -noxdamage -quiet >/data/logs/vnc.log 2>&1 &
# Container isolation is the sandbox boundary for this non-production spike.
# An explicitly provisioned read adapter owns an inherited pipe, never a listener.
if [ -f /data/native-adapter/binding.json ]; then
  node /opt/native/adapter/supervisor.mjs >/data/logs/adapter.log 2>&1
else
  chatgpt --no-sandbox --disable-gpu >/data/logs/app.log 2>&1
fi
