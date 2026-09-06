import { type FormEvent, useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Session } from "./types";
export function Login({
  requiresSetup,
  onLogin,
}: {
  requiresSetup: boolean;
  onLogin: (session: Session) => void;
}) {
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [token, setToken] = useState(() =>
    new URLSearchParams(location.hash.slice(1)).get("setup"),
  );
  useEffect(() => {
    const update = () => setToken(new URLSearchParams(location.hash.slice(1)).get("setup"));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (requiresSetup && password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    try {
      const session = await api<Session>(requiresSetup ? "/auth/setup" : "/auth/login", {
        method: "POST",
        body: requiresSetup ? { token, password } : { password },
      });
      setPassword("");
      setConfirmation("");
      history.replaceState(null, "", location.pathname);
      onLogin(session);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-brand">
        <img src="/icon.svg" alt="" width="38" height="38" />
        <span>
          codex<span className="brand-light"> / workspace</span>
        </span>
      </div>
      <section className="login-card">
        <div className="eyebrow">
          <Icon name="lock" size={14} /> Личное пространство
        </div>
        <h1>{requiresSetup ? "Начнём с твоего пароля." : "Твои проекты ждут."}</h1>
        <p className="muted">
          {requiresSetup
            ? "Задай пароль для входа с телефона, планшета и компьютера."
            : "Один пароль — и ты снова в работе."}
        </p>
        {requiresSetup && !token ? (
          <div className="notice">Открой личную ссылку первого входа, чтобы задать пароль.</div>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="password">{requiresSetup ? "Придумай пароль" : "Пароль"}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={requiresSetup ? "new-password" : "current-password"}
              required
              minLength={requiresSetup ? 12 : 1}
              maxLength={1024}
              placeholder={requiresSetup ? "Не менее 12 символов" : "Введи свой пароль"}
            />
            {requiresSetup && (
              <>
                <label htmlFor="confirm-password">Повтори пароль</label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={1024}
                />
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="primary login-submit" disabled={busy}>
              {busy ? "Подключаемся…" : requiresSetup ? "Сохранить и войти" : "Войти"}
              <Icon name="chevron" />
            </button>
          </form>
        )}
        <div className="login-footer">
          <span className="status-dot" /> Windows · сервер · твой браузер
        </div>
      </section>
      <p className="login-caption">Меньше переключений. Больше законченных дел.</p>
    </main>
  );
}
