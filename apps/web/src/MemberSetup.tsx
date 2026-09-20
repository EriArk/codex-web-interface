import type { MemberSetupStatus } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { TeamGpt } from "./TeamGpt";
import { TeamMachines } from "./TeamMachines";
import "./member-setup.css";

export const openMemberSetup = "codex-open-member-setup";
export function MemberSetup() {
  const [status, setStatus] = useState<MemberSetupStatus | null>(null),
    [open, setOpen] = useState(false),
    [step, setStep] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const value = await api<MemberSetupStatus>("/team/onboarding", { signal });
    if (!signal?.aborted) {
      setStatus(value);
      setError("");
    }
    return value;
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal)
      .then((value) => {
        if (abort.signal.aborted || value.originalOwner) return;
        if (value.state === "pending" || location.hash === "#setup") {
          setStep(value.machine.stage === "active" ? (value.gpt.stage === "active" ? 2 : 1) : 0);
          setOpen(true);
        }
      })
      .catch(() => {
        /* Settings provides an explicit entry if the initial request fails. */
      });
    const show = () => {
      setOpen(true);
      void refresh().catch((e) => setError(messageOf(e)));
    };
    window.addEventListener(openMemberSetup, show);
    const followReturn = () => {
      if (location.hash === "#setup") show();
    };
    window.addEventListener("hashchange", followReturn);
    return () => {
      abort.abort();
      window.removeEventListener(openMemberSetup, show);
      window.removeEventListener("hashchange", followReturn);
    };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    panel.current?.showModal();
    panel.current?.focus({ preventScroll: true });
    const abort = new AbortController();
    let pending = false;
    const tick = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        await refresh(abort.signal);
      } catch (e) {
        if (!abort.signal.aborted) setError(messageOf(e));
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void tick(), 5000);
    window.addEventListener("focus", tick);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      panel.current?.close();
    };
  }, [open, refresh]);
  const finish = async (state: "deferred" | "complete") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/team/onboarding", { method: "POST", body: { state } });
      if (location.hash === "#setup")
        history.replaceState(history.state, "", location.pathname + location.search);
      setOpen(false);
      if (state === "complete") location.reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  if (!open) return null;
  const machine = status?.machine;
  return (
    <dialog
      ref={panel}
      tabIndex={-1}
      className="member-setup"
      aria-label="Настройка рабочего пространства"
      onCancel={(e) => {
        e.preventDefault();
        void finish("deferred");
      }}
    >
      <header className="dialog-heading settings-heading">
        <h2>Твоё рабочее пространство</h2>
        <button
          type="button"
          className="icon-button panel-close"
          aria-label="Продолжить настройку позже"
          disabled={busy}
          onClick={() => void finish("deferred")}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="member-setup-body">
        <p>
          Аккаунт создан. Подключи свой компьютер и ChatGPT. Можно закрыть мастер и продолжить
          отсюда в настройках доступа.
        </p>
        <nav aria-label="Шаги настройки" className="member-setup-steps">
          {["Компьютер", "ChatGPT", "Готовность"].map((label, index) => (
            <button
              key={label}
              type="button"
              className={step === index ? "primary" : "secondary"}
              aria-current={step === index ? "step" : undefined}
              onClick={() => setStep(index)}
            >
              {index + 1}. {label}
            </button>
          ))}
        </nav>
        {step === 0 && (
          <>
            <p className="review-caption">
              Если ты с телефона или планшета: открой этот же сайт на своём Windows ПК, войди со
              своим логином и скачай установщик здесь. Новый аккаунт не нужен.
            </p>
            <TeamMachines visible />
            {machine?.stage === "reported" && (
              <p role="status">
                Компьютер ждёт подтверждения администратора. Пока можно подключить ChatGPT на
                следующем шаге.
              </p>
            )}
          </>
        )}
        {step === 1 && <TeamGpt visible />}
        {step === 2 && (
          <section aria-label="Готовность подключений">
            <ul className="team-people">
              <li>
                <strong>Компьютер</strong>
                <span>
                  {machine?.stage === "active"
                    ? "Подключён"
                    : machine?.stage === "reported"
                      ? "Ожидает администратора"
                      : "Продолжи первый шаг"}
                </span>
              </li>
              <li>
                <strong>Codex</strong>
                <span>
                  {machine?.codex ? "Вход подтверждён на ПК" : "Вход через установщик на ПК"}
                </span>
              </li>
              <li>
                <strong>Git и GitHub</strong>
                <span>
                  {machine?.git && machine.github
                    ? "Подготовлены на ПК"
                    : "Продолжи установщик на ПК"}
                </span>
              </li>
              <li>
                <strong>ChatGPT</strong>
                <span>{status?.gpt.stage === "active" ? "Подключён" : "Продолжи второй шаг"}</span>
              </li>
            </ul>
            <p className="muted">
              После завершения можно создать первый проект. При работе подключения проверяются
              обычным способом.
            </p>
          </section>
        )}
        {error && <p role="status">{error}</p>}
      </div>
      <footer className="member-setup-actions">
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => void finish("deferred")}
        >
          Позже
        </button>
        {step > 0 && (
          <button type="button" className="secondary" onClick={() => setStep(step - 1)}>
            Назад
          </button>
        )}
        {step < 2 ? (
          <button type="button" className="primary" onClick={() => setStep(step + 1)}>
            Далее
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy || !status?.ready}
            onClick={() => void finish("complete")}
          >
            Начать работу
          </button>
        )}
      </footer>
    </dialog>
  );
}
