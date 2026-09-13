import { type FormEvent, useId, useState } from "react";
import { pageWorkspace } from "./accountStorage.ts";
import { api, changePassword, messageOf } from "./api";
import { Icon } from "./icons";
import { TeamAccess } from "./TeamAccess";
import type { Session } from "./types";
import "./accountControls.css";
export function AccountControls({
  onSession,
  onLogout,
}: {
  onSession: (session: Session) => void;
  onLogout: () => void;
}) {
  const id = useId(),
    [open, setOpen] = useState(false),
    [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await changePassword(current, password, onSession);
      setCurrent("");
      setPassword("");
      setOpen(false);
      setNotice("Пароль изменён");
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  async function logout(all: boolean) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api(all ? "/auth/logout-all" : "/auth/logout", { method: "POST" });
      onLogout();
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-controls" aria-label="Доступ к сайту">
      {!!pageWorkspace && <TeamAccess />}
      <button
        type="button"
        className="secondary account-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setNotice("");
          setCurrent("");
          setPassword("");
        }}
        disabled={busy}
      >
        <Icon name="lock" size={17} />
        Сменить пароль
      </button>
      {open && (
        <form onSubmit={save}>
          <label htmlFor={id + "-current"}>Текущий пароль</label>
          <input
            id={id + "-current"}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            minLength={1}
            maxLength={1024}
            required
            disabled={busy}
          />
          <label htmlFor={id + "-new"}>Новый пароль</label>
          <input
            id={id + "-new"}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            maxLength={1024}
            required
            disabled={busy}
          />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="account-exit">
        <button
          type="button"
          className="text-button"
          onClick={() => void logout(false)}
          disabled={busy}
        >
          <Icon name="logout" size={17} />
          Выйти
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => void logout(true)}
          disabled={busy}
        >
          Выйти со всех устройств
        </button>
      </div>
    </section>
  );
}
