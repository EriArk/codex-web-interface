import { useEffect, useState } from "react";

export function UpdateNotice({ visible, busy }: { visible: boolean; busy: boolean }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    if (!script) return;
    const current = new URL(script.src).pathname;
    const styles = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'),
    )
      .map((link) => new URL(link.href).pathname)
      .filter((path) => path.startsWith("/assets/"))
      .sort();
    if (!current.startsWith("/assets/")) return; // Vite development has no release.
    let disposed = false;
    let checking = false;
    let lastCheck = 0;
    let controller: AbortController | undefined;
    const check = async () => {
      if (checking || document.visibilityState === "hidden" || Date.now() - lastCheck < 30000)
        return;
      checking = true;
      lastCheck = Date.now();
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch("/version.json", {
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
          return;
        const version: unknown = await response.json();
        if (
          !disposed &&
          version &&
          typeof version === "object" &&
          "entry" in version &&
          typeof version.entry === "string" &&
          /^\/assets\/[\w.-]+\.js$/.test(version.entry) &&
          "styles" in version &&
          Array.isArray(version.styles) &&
          version.styles.every(
            (path: unknown) => typeof path === "string" && /^\/assets\/[\w.-]+\.css$/.test(path),
          )
        )
          setAvailable(
            version.entry !== current ||
              JSON.stringify(version.styles.toSorted()) !== JSON.stringify(styles),
          );
      } catch {
        // Offline or a proxy error must not interrupt the conversation.
      } finally {
        clearTimeout(timeout);
        checking = false;
      }
    };
    const update = () => void check();
    update();
    const timer = setInterval(update, 60000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    window.addEventListener("online", update);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
      window.removeEventListener("online", update);
    };
  }, []);
  if (!available || !visible) return null;
  return (
    <div className="update-notice" role="status">
      <span>
        Есть обновление сайта<small>Черновик сохранится</small>
      </span>
      <button type="button" className="secondary" disabled={busy} onClick={() => location.reload()}>
        Обновить
      </button>
    </div>
  );
}
