import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  clearUpdate,
  pendingUpdate,
  readRelease,
  releaseId,
  rememberUpdate,
  updateUrl,
} from "./updateVersion";

const failure = "Обновление не загрузилось. Попробуй ещё раз.";
type Deployment = { ownerForceAllowed: boolean; maintenance: { revision: string; startedAt: number; state: string } | null };
export function UpdateNotice({ visible, busy }: { visible: boolean; busy: boolean }) {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try { const value = await api<Deployment>("/deployment?brief=1", { signal: abort.signal, timeoutMs: 8000 }); if (!abort.signal.aborted) setDeployment(value); }
      catch { /* Reconnect polling retains the pending release during restart. */ }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [visible]);
  const pending = deployment?.maintenance;
  const apply = async (force: boolean) => {
    if (!pending || sending) return;
    if (force && !window.confirm("Обновить жёстко? Активные задачи и терминалы могут прерваться у всех пользователей.")) return;
    setSending(true); setMessage("");
    try {
      await api("/deployment/apply", { method: "POST", body: { revision: pending.revision, startedAt: pending.startedAt, force, confirm: force } });
      setMessage(force ? "Начинаем жёсткое обновление…" : "Обновление установится после завершения активной работы.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Не удалось начать обновление."); }
    finally { setSending(false); }
  };
  return <>
    {visible && deployment?.ownerForceAllowed && pending && ["waiting", "installing"].includes(pending.state) && <div className="update-notice" role="status">
      <span>{pending.state === "installing" ? "Устанавливаем обновление сервера…" : message || "Готово обновление сервера"}</span>
      {pending.state === "waiting" && <>
        <button type="button" className="secondary" disabled={sending} onClick={() => void apply(false)}>Обновить</button>
        <button type="button" className="danger" disabled={sending} onClick={() => void apply(true)}>Обновить жёстко</button>
      </>}
    </div>}
    <ClientUpdateNotice visible={visible} busy={busy} allowForce={!!deployment?.ownerForceAllowed} />
  </>;
}
function ClientUpdateNotice({ visible, busy, allowForce }: { visible: boolean; busy: boolean; allowForce: boolean }) {
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
  const apply = async (force = false) => {
    if ((busy && !force) || applying.current) return;
    if (force && (!allowForce || !window.confirm("Перезагрузить интерфейс сейчас, даже если идёт работа?"))) return;
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
      {available && allowForce && <button type="button" className="danger" disabled={updating} onClick={() => void apply(true)}>Обновить жёстко</button>}
    </div>
  );
}
