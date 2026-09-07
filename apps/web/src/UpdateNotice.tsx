import { useEffect, useRef, useState } from "react";
import {
  clearUpdate,
  pendingUpdate,
  readRelease,
  releaseId,
  rememberUpdate,
  updateUrl,
} from "./updateVersion";

const failure = "Обновление не загрузилось. Попробуй ещё раз.";
export function UpdateNotice({ visible, busy }: { visible: boolean; busy: boolean }) {
  // This is the release that actually booted, independent of lazy-loaded route styles.
  const [current] = useState(
    () => document.querySelector<HTMLMetaElement>('meta[name="codex-release"]')?.content ?? "",
  );
  const [available, setAvailable] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true),
    applying = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!releaseId(current)) return;
    const navigation = new URL(location.href);
    const marker = navigation.searchParams.get("_codex_update");
    const expected = pendingUpdate() ?? (releaseId(marker) ? marker : null);
    if (expected === current) {
      clearUpdate();
      setNotice("Сайт обновлён");
    } else if (expected) {
      setNotice(failure);
      setAvailable(expected);
    }
    // The cache-busting query is only needed for navigation, not for shared links.
    if (navigation.searchParams.has("_codex_update")) {
      navigation.searchParams.delete("_codex_update");
      history.replaceState(history.state, "", navigation.href);
    }
    let disposed = false,
      checking = false,
      lastCheck = 0;
    let controller: AbortController | undefined;
    const check = async () => {
      if (checking || applying.current || document.hidden || Date.now() - lastCheck < 30000) return;
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
        const id = readRelease(await response.json());
        if (!disposed && id) {
          setAvailable(id === current ? null : id);
          if (id === current && expected && expected !== current) {
            clearUpdate();
            setNotice("Установлена актуальная версия");
          }
        }
      } catch {
        // An unavailable release endpoint must not interrupt the conversation.
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
      mounted.current = false;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
      window.removeEventListener("online", update);
    };
  }, [current]);
  useEffect(() => {
    if (!notice || notice === failure) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const apply = async () => {
    if (busy || applying.current) return;
    applying.current = true;
    setUpdating(true);
    setNotice("");
    try {
      const response = await fetch("/version.json", {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/json" },
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw Error("Release unavailable");
      const id = readRelease(await response.json());
      if (!id) throw Error("Invalid release");
      if (!mounted.current) return;
      if (id === current) {
        clearUpdate();
        setAvailable(null);
        setNotice("Установлена актуальная версия");
      } else {
        rememberUpdate(id);
        // Network-first SW navigation plus a fresh URL avoids reusing an old HTML document.
        location.replace(updateUrl(location.href, id));
        return;
      }
    } catch {
      if (mounted.current) setNotice(failure);
    }
    applying.current = false;
    if (mounted.current) setUpdating(false);
  };
  if ((!available && !notice) || !visible) return null;
  return (
    <div className="update-notice" role="status">
      <span>{updating ? "Обновляем…" : notice || "Есть обновление сайта"}</span>
      {available && (
        <button
          type="button"
          className="secondary"
          disabled={busy || updating}
          onClick={() => void apply()}
        >
          {updating ? <span className="spinner" role="img" aria-label="Обновление" /> : "Обновить"}
        </button>
      )}
    </div>
  );
}
