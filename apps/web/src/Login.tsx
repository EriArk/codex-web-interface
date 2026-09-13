import { type FormEvent, useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Session } from "./types";

const readLink = () => {
  const hash = new URLSearchParams(location.hash.slice(1));
  return {
    token: hash.get("recover") ?? hash.get("join") ?? hash.get("setup"),
    recovery: hash.has("recover"),
    joining: hash.has("join"),
  };
};
export function Login({
  requiresSetup,
  team = false,
  onLogin,
}: {
  requiresSetup: boolean;
  team?: boolean;
  onLogin: (session: Session) => void;
}) {
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [login, setLogin] = useState(""),
    [name, setName] = useState("");
  const [link, setLink] = useState(readLink);
  const { token, recovery, joining } = link,
    settingPassword = requiresSetup || recovery || joining;
  useEffect(() => {
    const update = () => setLink(readLink());
    window.addEventListener("hashchange", update);
    // A same-document invitation may arrive between render and subscription,
    // especially immediately after logout in WebKit.
    update();
    return () => window.removeEventListener("hashchange", update);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (settingPassword && password !== confirmation) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    try {
      const session = await api<Session>(
        recovery
          ? "/auth/recover"
          : joining
            ? "/auth/join"
            : requiresSetup
              ? "/auth/setup"
              : "/auth/login",
        {
          method: "POST",
          body: joining
            ? { token, password, login, name }
            : settingPassword
              ? { token, password }
              : team
                ? { login, password }
                : { password },
        },
      );
      setPassword("");
      setConfirmation("");
      const notification = new URLSearchParams(location.hash.slice(1)).get("notification") || "";
      history.replaceState(
        null,
        "",
        location.pathname +
          (/^[a-f0-9]{32}$/.test(notification) ? "#notification=" + notification : ""),
      );
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
        <h1>
          {joining
            ? "Твоё личное пространство."
            : recovery
              ? "Новый пароль."
              : requiresSetup
                ? "Начнём с твоего пароля."
                : "Твои проекты ждут."}
        </h1>
        <p className="muted">
          {settingPassword
            ? "Задай пароль для входа с телефона, планшета и компьютера."
            : team
              ? "Войди в свой аккаунт."
              : "Один пароль — и ты снова в работе."}
        </p>
        {settingPassword && !token ? (
          <div className="notice">
            {recovery
              ? "Открой действующую ссылку восстановления."
              : "Открой личную ссылку первого входа, чтобы задать пароль."}
          </div>
        ) : (
          <form onSubmit={submit}>
            {team && !recovery && (
              <>
                <label htmlFor="account-login">Логин</label>
                <input
                  id="account-login"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  minLength={3}
                  maxLength={40}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*"
                />
              </>
            )}
            {joining && (
              <>
                <label htmlFor="account-name">Твоё имя</label>
                <input
                  id="account-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                  maxLength={80}
                />
              </>
            )}
            <label htmlFor="password">{settingPassword ? "Придумай пароль" : "Пароль"}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={settingPassword ? "new-password" : "current-password"}
              required
              minLength={settingPassword ? 12 : 1}
              maxLength={1024}
              placeholder={settingPassword ? "Не менее 12 символов" : "Введи свой пароль"}
            />
            {settingPassword && (
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
              {busy ? "Подключаемся…" : settingPassword ? "Сохранить и войти" : "Войти"}
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
