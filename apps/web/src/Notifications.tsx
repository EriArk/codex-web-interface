import { useEffect, useRef, useState } from "react";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import "./notifications.css";

const storageKey = "codex-push-device";
const changed = "codex-push-changed";
function deviceId() {
  try {
    return localStorage.getItem(storageKey) || "";
  } catch {
    return "";
  }
}
function saveDevice(id: string) {
  try {
    if (id) localStorage.setItem(storageKey, id);
    else localStorage.removeItem(storageKey);
  } catch {}
  window.dispatchEvent(new Event(changed));
}
type Categories = { completed: boolean; attention: boolean; errors: boolean };
type PushStatus = {
  available: boolean;
  publicKey?: string;
  enabled: boolean;
  categories: Categories;
  preview: boolean;
};
export function Notifications({ visible }: { visible: boolean }) {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [status, setStatus] = useState<PushStatus | null>(null),
    [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null),
    [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!visible || !supported) return;
    let disposed = false;
    const timer = setTimeout(() => {
      if (!disposed) setError("Не удалось подготовить уведомления. Обнови страницу.");
    }, 12000);
    void (async () => {
      const id = deviceId();
      const [data, reg] = await Promise.all([
        api<PushStatus>("/push" + (id ? "?id=" + id : "")),
        navigator.serviceWorker.ready,
      ]);
      const sub = await reg.pushManager.getSubscription();
      if (disposed) return;
      if (data.enabled && (!sub || Notification.permission === "denied")) {
        await api("/push/" + id, { method: "DELETE", timeoutMs: 10000 });
        data.enabled = false;
        saveDevice("");
      }
      if (disposed) return;
      setStatus(data);
      setRegistration(reg);
      setSubscription(sub);
      setError("");
    })()
      .catch((e) => {
        if (!disposed) setError(messageOf(e));
      })
      .finally(() => clearTimeout(timer));
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [visible, supported]);
  const store = async (
    sub: PushSubscription,
    categories: Categories,
    preview = status?.preview ?? true,
  ) => {
    const data = await api<{ id: string }>("/push", {
      method: "POST",
      body: { subscription: sub.toJSON(), categories, preview },
      timeoutMs: 15000,
    });
    saveDevice(data.id);
    setSubscription(sub);
    setStatus((s) => (s ? { ...s, enabled: true, categories, preview } : s));
  };
  const enable = () => {
    if (!registration || !status?.publicKey || pending) return;
    setPending(true);
    setError("");
    const key = Uint8Array.from(
      atob(status.publicKey.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
    // Subscribe directly in this tap. Safari must not lose activation during a fetch first.
    const request = subscription
      ? Promise.resolve(subscription)
      : registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    void request
      .then((sub) => store(sub, status.categories))
      .catch((e) =>
        setError(
          e?.name === "NotAllowedError"
            ? "Уведомления не разрешены на этом устройстве."
            : messageOf(e),
        ),
      )
      .finally(() => setPending(false));
  };
  const disable = async () => {
    setPending(true);
    setError("");
    try {
      const id = deviceId();
      if (id) await api("/push/" + id, { method: "DELETE", timeoutMs: 10000 });
      saveDevice("");
      setStatus((s) => (s ? { ...s, enabled: false } : s));
      await subscription?.unsubscribe();
      setSubscription(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(false);
    }
  };
  const preference = async (key: keyof Categories, value: boolean) => {
    if (!subscription || !status) return;
    setPending(true);
    setError("");
    try {
      await store(subscription, { ...status.categories, [key]: value });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="notification-settings" aria-label="Уведомления">
      <h3>Уведомления</h3>
      {!supported ? (
        <p className="small muted">Для уведомлений открой установленное веб-приложение.</p>
      ) : status?.available === false ? (
        <p className="small muted">Уведомления пока недоступны.</p>
      ) : (
        <>
          <button
            type="button"
            disabled={
              pending ||
              !registration ||
              !status ||
              (!status.enabled && Notification.permission === "denied")
            }
            onClick={() => (status?.enabled ? void disable() : enable())}
          >
            {status?.enabled ? "Выключить на этом устройстве" : "Включить на этом устройстве"}
          </button>
          {Notification.permission === "denied" && (
            <p className="small muted">Уведомления запрещены в настройках устройства.</p>
          )}
          {status?.enabled && (
            <>
              <fieldset disabled={pending}>
                {(
                  [
                    ["completed", "Завершение работы"],
                    ["attention", "Вопросы и разрешения"],
                    ["errors", "Сбои и проверка состояния"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={status.categories[key]}
                      onChange={(e) => void preference(key, e.target.checked)}
                    />
                    {label}
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={status.preview ?? true}
                    onChange={(e) => {
                      if (!subscription) return;
                      setPending(true);
                      setError("");
                      void store(subscription, status.categories, e.target.checked)
                        .catch((e) => setError(messageOf(e)))
                        .finally(() => setPending(false));
                    }}
                  />
                  Показывать чат и текст ответа
                </label>
              </fieldset>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setError("");
                  void api("/push/test", {
                    method: "POST",
                    body: { id: deviceId() },
                    timeoutMs: 10000,
                  })
                    .catch((e) => setError(messageOf(e)))
                    .finally(() => setPending(false));
                }}
              >
                Проверить уведомление
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="small">
          {error}
        </p>
      )}
    </section>
  );
}
export function useNotificationPresence(client: "codex" | "gpt", target: string, active: boolean) {
  const tab = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!active) return;
    const update = (hidden = false) => {
      const id = deviceId();
      if (!id) return;
      void api("/push/presence", {
        method: "POST",
        timeoutMs: 5000,
        body: {
          id,
          tab: tab.current,
          client,
          target,
          visible: !hidden && document.visibilityState === "visible" && document.hasFocus(),
        },
      }).catch(() => {});
    };
    const show = () => update(),
      hide = () => update(true);
    show();
    const timer = setInterval(show, 10000);
    document.addEventListener("visibilitychange", show);
    window.addEventListener("focus", show);
    window.addEventListener("blur", hide);
    window.addEventListener("pagehide", hide);
    window.addEventListener(changed, show);
    return () => {
      clearInterval(timer);
      hide();
      document.removeEventListener("visibilitychange", show);
      window.removeEventListener("focus", show);
      window.removeEventListener("blur", hide);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener(changed, show);
    };
  }, [active, client, target]);
}
export type NotificationTarget = {
  id: string;
  client: "codex" | "gpt";
  threadId?: string;
  projectId?: string;
  nativeId?: string;
  jobId?: string;
};
