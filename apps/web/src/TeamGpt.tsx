import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";

type Status = {
  enabled: boolean;
  legacy: boolean;
  native?: boolean;
  activated: boolean;
  state: "absent" | "requested" | "ready" | "failed" | "blocked";
};
export function TeamGpt({ visible }: { visible: boolean }) {
  const [status, setStatus] = useState<Status | null>(null),
    [notice, setNotice] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const value = await api<Status>("/team/gpt", { signal });
    if (!signal?.aborted) {
      setStatus(value);
      setLoadError("");
    }
  }, []);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const tick = () =>
      void refresh(abort.signal).catch((error) => {
        if (!abort.signal.aborted) setLoadError(messageOf(error));
      });
    tick();
    const timer = setInterval(tick, 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [visible, refresh]);
  const run = async (activate = false) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      await api(activate ? "/team/gpt/apply" : "/team/gpt", { method: "POST", body: {} });
      await refresh();
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="team-access team-gpt" aria-label="Личный ChatGPT">
      <h3>Мой ChatGPT</h3>
      <p className="muted">
        Отдельный клиент с твоим аккаунтом, чатами и лимитами. Войди в ChatGPT и активируй
        подключение.
      </p>
      {status?.state === "blocked" ? (
        <p role="status">Администратор сервера проверяет подключения после восстановления.</p>
      ) : status?.state === "ready" ? (
        <>
          {!status.activated && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void run(true)}
            >
              Активировать ChatGPT
            </button>
          )}
          <a
            className="secondary"
            href={status.native ? "/gpt-connect?runtime=native" : "/gpt-connect"}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть мой ChatGPT и войти
          </a>
        </>
      ) : status?.state === "requested" ? (
        <p role="status">
          Сервер готовит твой клиент. Статус обновится автоматически; другие диалоги продолжают
          работать.
        </p>
      ) : status?.enabled ? (
        <>
          {status.state === "failed" && (
            <p role="status">
              Подготовка не завершилась. Сохранённый профиль остаётся на месте; можно повторить
              проверку.
            </p>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={() => void run()}>
            {status.state === "failed" ? "Повторить подготовку" : "Подготовить мой ChatGPT"}
          </button>
        </>
      ) : (
        status && (
          <p className="muted">
            Администратор ещё не включил подготовку личных клиентов на этом сервере.
          </p>
        )
      )}
      {(notice || loadError) && <p role="status">{notice || loadError}</p>}
    </section>
  );
}
