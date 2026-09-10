const CACHE = "codex-shell-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/icon.svg", "/manifest.webmanifest"])),
  );
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("codex-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (event.request.mode === "navigate") {
    // A protected Remote/download page must never replace the offline app shell.
    if (url.pathname !== "/") return;
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          if (response.ok) caches.open(CACHE).then((cache) => cache.put("/", response.clone()));
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/fonts/") ||
    ["/icon.svg", "/manifest.webmanifest"].includes(url.pathname)
  ) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok)
              caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
            return response;
          }),
      ),
    );
  }
});

// Legacy status stays valid for existing workers; optional bounded display follows device preferences.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data;
      try {
        data = event.data?.json();
      } catch {
        return;
      }
      if (!data || !/^[a-f0-9]{32}$/.test(data.id) || !["Codex", "GPT"].includes(data.title))
        return;
      const allowed = [
        "Работа завершена",
        "Нужен ответ на вопрос",
        "Нужно разрешение",
        "Не удалось завершить работу",
        "Проверь состояние работы",
        "Уведомления работают",
      ];
      if (!allowed.includes(data.body)) return;
      const display = data.display;
      const validDisplay =
        display &&
        typeof display.title === "string" &&
        typeof display.body === "string" &&
        display.title.startsWith(data.title + " · ") &&
        display.title.length <= 200 &&
        display.body.length <= 560 &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject forged control characters while allowing the body newline.
        !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
          display.title + display.body,
        );
      await self.registration.showNotification(validDisplay ? display.title : data.title, {
        body: validDisplay ? display.body : data.body,
        icon: "/icon.svg",
        tag: "work-" + data.id,
        data: { id: data.id },
        renotify: false,
      });
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.id;
  if (!/^[a-f0-9]{32}$/.test(id || "")) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => {
        const url = new URL(client.url);
        return url.origin === self.location.origin && url.pathname === "/";
      });
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "notification.open", id });
      } else await self.clients.openWindow("/#notification=" + id);
    })(),
  );
});
