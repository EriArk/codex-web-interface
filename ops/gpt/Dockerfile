FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc openbox && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/gpt
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm init -y && npm install --save-exact playwright@1.62.0
# MIT-licensed browser adapter; pin the revision before its unpublished optional ZIP dependency.
ARG BRIDGE_REVISION=96802cc0d2ea0b7449cf465f8adb3c228decd297
RUN git init /opt/bridge && cd /opt/bridge && git remote add origin https://github.com/DrA1ex/chatgpt-bridge.git && git fetch --depth=1 origin "$BRIDGE_REVISION" && git checkout --detach FETCH_HEAD && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY browser-library.mjs browser.mjs bridge.mjs browser-models.mjs browser-session.mjs browser-assets.mjs bridge-proxy.mjs patch-adapter.mjs /opt/gpt/
RUN node /opt/gpt/patch-adapter.mjs
ENV HOME=/data DISPLAY=:91
USER 1000:1000
CMD ["flock","--nonblock","--no-fork","/data/browser.lock","node","/opt/gpt/browser.mjs"]
