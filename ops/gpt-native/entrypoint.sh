#!/bin/sh
set -eu
umask 077
mkdir -p "$XDG_RUNTIME_DIR" /data/logs
chmod 700 "$XDG_RUNTIME_DIR"
exec flock --nonblock --no-fork /data/runtime.lock dbus-run-session -- /opt/native/start.sh
