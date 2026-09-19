#!/bin/sh
set -eu
# The package also advertises http/https. Without an explicit browser default,
# xdg-open sends the sign-in page back into ChatGPT and the login never opens.
# Preserve the app's own codex:// return handler.
xdg-mime default auth-browser.desktop x-scheme-handler/http
xdg-mime default auth-browser.desktop x-scheme-handler/https
xdg-mime default auth-browser.desktop text/html
xdg-settings set default-web-browser auth-browser.desktop
xdg-mime default chatgpt.desktop x-scheme-handler/codex
