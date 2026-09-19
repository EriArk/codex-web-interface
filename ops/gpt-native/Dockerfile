# Isolated native-client evaluation. Never mount the browser connector profile here.
FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07
ARG APP_SHA256=d27a9c02919cfe484dcc5f34584b9ea9fd0d7a65c69dcc872b5bdcfa0efb5983
COPY chatgpt_amd64.deb /tmp/chatgpt.deb
RUN echo "${APP_SHA256}  /tmp/chatgpt.deb" | sha256sum -c - && \
    apt-get update && apt-get install -y --no-install-recommends /tmp/chatgpt.deb \
      dbus-x11 x11vnc openbox x11-utils xterm && \
    rm /tmp/chatgpt.deb && rm -rf /var/lib/apt/lists/*
COPY start.sh entrypoint.sh auth-browser.sh configure-browser.sh /opt/native/
COPY auth-browser.desktop /usr/share/applications/auth-browser.desktop
RUN chmod 755 /opt/native/*.sh
ENV HOME=/data DISPLAY=:92 XDG_RUNTIME_DIR=/data/run
USER 1000:1000
WORKDIR /data
CMD ["/opt/native/entrypoint.sh"]
