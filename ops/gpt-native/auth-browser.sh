#!/bin/sh
set -eu
umask 077
# Only the native client's external web sign-in uses this private profile.
# No automation/debugging port, copied login, or anti-bot modifications.
case "${1:-}" in
  https://*|http://*|about:blank) ;;
  *) exit 2 ;;
esac
[ "$#" -eq 1 ] || exit 2
mkdir -p /data/auth-browser /data/logs
url="$1"
set --
if [ -n "${HTTPS_PROXY:-}" ]; then set -- "--proxy-server=$HTTPS_PROXY"; fi
exec /ms-playwright/chromium-1234/chrome-linux64/chrome \
  --disable-dev-shm-usage --no-first-run --no-default-browser-check \
  --user-data-dir=/data/auth-browser --start-maximized "$@" "$url" \
  >>/data/logs/auth-browser.log 2>&1
