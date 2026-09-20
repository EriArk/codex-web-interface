import type { MachineEnrollment, TeamUser } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountSessionStorage as sessionStorage } from "./accountStorage";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import "./team.css";

const stateNames: Record<MachineEnrollment["state"], string> = {
  pending: "Ожидает запуска установщика",
  reported: "Ожидает подтверждения администратора",
  approved: "Подтверждён",
  revoked: "Отключён",
  expired: "Пакет подключения истёк",
};
type EnrollmentAttempt = { name: string; request: { id: string; token: string }; expires: number };
const attemptKey = "codex-machine-enrollment";
function savedAttempt(): EnrollmentAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(attemptKey) ?? "null");
    if (
      value &&
      typeof value.name === "string" &&
      /^[a-f0-9-]{36}$/.test(value.request?.id) &&
      /^[A-Za-z0-9_-]{43}$/.test(value.request?.token) &&
      value.expires > Date.now()
    )
      return value;
    sessionStorage.removeItem(attemptKey);
  } catch {}
  return null;
}
export function TeamMachines({ visible }: { visible: boolean }) {
  const [attempt, setAttempt] = useState<EnrollmentAttempt | null>(savedAttempt);
  const running = useRef(false);
  const [items, setItems] = useState<MachineEnrollment[]>([]),
    [reviews, setReviews] = useState<MachineEnrollment[]>([]);
  const [active, setActive] = useState<string[]>([]),
    [enabled, setEnabled] = useState(false);
  const [name, setName] = useState(attempt?.name ?? "Мой компьютер"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ enrollment: MachineEnrollment; token: string } | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState<{
    item: MachineEnrollment;
    action: "approve" | "revoke";
  } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [result, me] = await Promise.all([
      api<{ items: MachineEnrollment[]; enabled: boolean; activeMachineIds: string[] }>(
        "/team/machines",
        { signal },
      ),
      api<{ user: TeamUser }>("/team/me", { signal }),
    ]);
    setItems(result.items);
    setEnabled(result.enabled);
    setActive(result.activeMachineIds);
    setReviews(
      me.user.role === "admin"
        ? (await api<{ items: MachineEnrollment[] }>("/team/machine-reviews", { signal })).items
        : [],
    );
  }, []);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const tick = () =>
      void refresh(abort.signal).catch((error) => {
        if (!abort.signal.aborted) setNotice(messageOf(error));
      });
    tick();
    const timer = setInterval(tick, 12000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [visible, refresh]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const clearAttempt = () => {
    setCreated(null);
    setAttempt(null);
    try {
      sessionStorage.removeItem(attemptKey);
    } catch {}
  };
  useEffect(() => {
    if (
      attempt &&
      (attempt.expires <= Date.now() ||
        items.some(
          (item) => item.id === attempt.request.id && ["revoked", "expired"].includes(item.state),
        ))
    ) {
      setAttempt(null);
      setCreated(null);
      try {
        sessionStorage.removeItem(attemptKey);
      } catch {}
    }
  }, [attempt, items]);
  const download = async () => {
    const input = attempt ?? {
      name: name.trim(),
      expires: Date.now() + 86400000,
      request: {
        id: crypto.randomUUID(),
        token: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, ""),
      },
    };
    setAttempt(input);
    try {
      sessionStorage.setItem(attemptKey, JSON.stringify(input));
    } catch {}
    const selected =
      created ??
      (await api<{ enrollment: MachineEnrollment; token: string }>("/team/machines", {
        method: "POST",
        body: { name: input.name, request: input.request },
      }));
    setCreated(selected);
    const archive = await api<{ filename: string; base64: string }>(
      `/team/machines/${selected.enrollment.id}/bundle`,
      { method: "POST", body: { token: selected.token } },
    );
    const bytes = Uint8Array.from(atob(archive.base64), (c) => c.charCodeAt(0)),
      url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = archive.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setNotice(
      "Распакуй архив на своём Windows ПК и открой Connect.cmd. Мастер запросит подтверждение Windows и поможет войти в аккаунты.",
    );
  };
  const confirm = async () => {
    if (!confirmation) return;
    const { item, action } = confirmation;
    await api(`/team/machines/${item.id}${action === "approve" ? "/approve" : ""}`, {
      method: action === "approve" ? "POST" : "DELETE",
      ...(action === "approve" ? { body: { fingerprint: item.fingerprint } } : {}),
    });
    if (attempt?.request.id === item.id) clearAttempt();
    setConfirmation(null);
  };
  return (
    <section className="team-access team-machines" aria-label="Личные компьютеры">
      <h3>Мои компьютеры</h3>
      <p className="muted">
        Каждый компьютер использует твои аккаунты и выбранные на нём папки проектов.
      </p>
      {!enabled && (
        <p role="status">
          Администратору нужно завершить подключение Hub к Tailscale. Существующий компьютер
          продолжает работать.
        </p>
      )}
      {enabled && (
        <form
          className="team-invite"
          onSubmit={(event) => {
            event.preventDefault();
            void run(download);
          }}
        >
          <label htmlFor="enrollment-name">Название компьютера</label>
          <input
            id="enrollment-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            disabled={busy || !!attempt}
          />
          <button className="secondary" type="submit" disabled={busy || !name.trim()}>
            <Icon name="remote" />
            {attempt ? "Скачать установщик ещё раз" : "Подключить Windows ПК"}
          </button>
          <small className="muted">
            Подготовка → проверка администратора → активация. Пакет действует сутки.
          </small>
          {attempt &&
            items.some((item) => item.id === attempt.request.id && item.state !== "pending") && (
              <button className="text-button" type="button" disabled={busy} onClick={clearAttempt}>
                Подключить другой компьютер
              </button>
            )}
        </form>
      )}
      <ul className="team-people">
        {items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <small>
                {item.machineId && active.includes(item.machineId) && item.state === "approved"
                  ? "Подключён к твоему пространству"
                  : stateNames[item.state]}
              </small>
              {item.readiness && (
                <small>
                  Codex {item.readiness.codex ? "✓" : "—"} · Git {item.readiness.git ? "✓" : "—"} ·
                  GitHub CLI {item.readiness.github ? "✓" : "—"} · Remote{" "}
                  {item.readiness.remote ? "✓" : "не настроен"}
                </small>
              )}
            </div>
            <div className="team-person-actions">
              {item.state === "approved" && !active.includes(item.machineId!) && (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api("/team/machines/apply", { method: "POST" });
                      setNotice("Компьютер активирован. Можно создавать проекты.");
                    })
                  }
                >
                  Активировать
                </button>
              )}
              {!["revoked", "expired"].includes(item.state) && (
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmation({ item, action: "revoke" })}
                >
                  {item.state === "approved" ? "Отключить" : "Отозвать"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {reviews.length > 0 && (
        <div>
          <h3>Подтвердить компьютеры</h3>
          <ul className="team-people">
            {reviews.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {item.name} · {item.ownerName}
                  </strong>
                  <small>{item.address}</small>
                  <code className="team-fingerprint">{item.fingerprint}</code>
                </div>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmation({ item, action: "approve" })}
                >
                  Проверить
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {confirmation && (
        <fieldset className="team-confirm">
          <legend>
            {confirmation.action === "approve"
              ? "Подтверждение компьютера"
              : "Отключение компьютера"}
          </legend>
          <p>
            <strong>{confirmation.item.name}</strong> · {confirmation.item.ownerName}
          </p>
          {confirmation.action === "approve" ? (
            <>
              <p>
                Сверь отпечаток с владельцем ПК. Сервер затем проверит приватное соединение, профиль
                Windows, разрешённые папки и выбранный Remote. Экран ПК при проверке не открывается.
              </p>
              <code className="team-fingerprint">{confirmation.item.fingerprint}</code>
            </>
          ) : (
            <p>
              Локальные файлы и аккаунты сохранятся. Для изменения активного подключения сначала
              должны завершиться задачи; свободные терминалы переподключатся.
            </p>
          )}
          <div>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Отмена
            </button>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => void run(confirm)}
            >
              {confirmation.action === "approve" ? "Проверить и подтвердить" : "Отключить"}
            </button>
          </div>
        </fieldset>
      )}
      {notice && (
        <p className="team-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
