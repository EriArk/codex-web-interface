import type { TeamUser } from "@codex-web/shared";
import { useCallback, useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import "./team.css";

type AuditEntry = {
  seq: number;
  actorName: string;
  target: string;
  action: string;
  outcome: string;
  createdAt: number;
};
const auditLabels: Record<string, string> = {
  "user.invited": "Создано приглашение",
  "invite.revoked": "Приглашение отозвано",
  "user.activated": "Участник зарегистрирован",
  "user.disabled": "Доступ закрыт",
  "user.enabled": "Доступ восстановлен",
  "user.role_changed": "Изменена роль",
  "recovery.issued": "Создана ссылка восстановления",
  "recovery.host_issued": "Восстановление с сервера",
  "team.request_denied": "Изменение доступа отклонено",
};

export function TeamAccess() {
  const [me, setMe] = useState<TeamUser | null>(null),
    [users, setUsers] = useState<TeamUser[]>([]),
    [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [name, setName] = useState(""),
    [link, setLink] = useState<{ url: string; expires: number } | null>(null);
  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    user: TeamUser;
    action: "recovery" | "state" | "role";
  } | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]),
    [auditOpen, setAuditOpen] = useState(false),
    [auditMore, setAuditMore] = useState(false);
  const [invitations, setInvitations] = useState<
    { id: string; name: string; state: string; expires: number }[]
  >([]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const { user } = await api<{ user: TeamUser }>("/team/me", { signal });
    setMe(user);
    if (user.role === "admin") {
      const data = await api<{ items: TeamUser[]; registrationEnabled?: boolean }>("/team/users", {
        signal,
      });
      setUsers(data.items);
      setRegistrationEnabled(data.registrationEnabled !== false);
      setInvitations(
        (await api<{ items: typeof invitations }>("/team/invitations", { signal })).items.filter(
          (invite) => invite.state === "pending" && invite.expires > Date.now(),
        ),
      );
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal).catch((error) => {
      if (!abort.signal.aborted) setNotice(messageOf(error));
    });
    return () => abort.abort();
  }, [refresh]);
  const loadAudit = async (more = false) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const next = await api<{ items: AuditEntry[] }>(
        `/team/audit${more && audit.length ? `?before=${audit[audit.length - 1]!.seq}` : ""}`,
      );
      setAudit(more ? [...audit, ...next.items] : next.items);
      setAuditMore(next.items.length === 50);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const invite = async () => {
    if (busy || !name.trim() || !registrationEnabled) return;
    setBusy(true);
    setNotice("");
    setLink(null);
    try {
      setLink(await api("/team/invitations", { method: "POST", body: { name: name.trim() } }));
      setName("");
      await refresh();
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api(`/team/invitations/${id}`, { method: "DELETE" });
      setLink(null);
      await refresh();
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const change = async () => {
    if (!confirm || busy) return;
    const selected = confirm;
    setBusy(true);
    setNotice("");
    setLink(null);
    try {
      if (selected.action === "recovery")
        setLink(await api(`/team/users/${selected.user.id}/recovery`, { method: "POST" }));
      else if (selected.action === "role")
        await api(`/team/users/${selected.user.id}/role`, {
          method: "POST",
          body: {
            expectedRole: selected.user.role,
            role: selected.user.role === "admin" ? "member" : "admin",
          },
        });
      else
        await api(`/team/users/${selected.user.id}/state`, {
          method: "POST",
          body: { disabled: selected.user.state === "active" },
        });
      setConfirm(null);
      await refresh();
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="team-access" aria-label="Участники установки">
      {me && (
        <div className="team-account">
          <strong>{me.name}</strong>
          <span className="muted">
            {me.login} · {me.role === "admin" ? "Администратор" : "Участник"}
          </span>
        </div>
      )}
      {me?.role === "admin" && (
        <>
          <h3>Участники</h3>
          <ul className="team-people">
            {users.map((user) => (
              <li key={user.id}>
                <div>
                  <strong>{user.name}</strong>
                  <small>
                    {user.login} ·{" "}
                    {user.state === "disabled"
                      ? "Доступ закрыт"
                      : user.role === "admin"
                        ? "Администратор"
                        : "Участник"}
                  </small>
                </div>
                {user.id !== me.id && (
                  <div className="team-person-actions">
                    {user.state === "active" && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => setConfirm({ user, action: "recovery" })}
                      >
                        Восстановить вход
                      </button>
                    )}
                    {user.state === "active" && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => setConfirm({ user, action: "role" })}
                      >
                        {user.role === "admin"
                          ? "Снять роль администратора"
                          : "Назначить администратором"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => setConfirm({ user, action: "state" })}
                    >
                      {user.state === "active" ? "Закрыть доступ" : "Вернуть доступ"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <form
            className="team-invite"
            onSubmit={(event) => {
              event.preventDefault();
              void invite();
            }}
          >
            <label htmlFor="team-invite-name">Пригласить участника</label>
            <div>
              <input
                id="team-invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="Имя"
                required
                disabled={busy || !registrationEnabled}
              />
              <button
                className="secondary"
                type="submit"
                disabled={busy || !name.trim() || !registrationEnabled}
              >
                <Icon name="link" /> Приглашение
              </button>
            </div>
          </form>
          {!registrationEnabled && (
            <p className="review-caption">
              Совместные проекты доступны. Подключение новых участников будет включено отдельно.
            </p>
          )}
          {invitations.length > 0 && (
            <details>
              <summary>Ожидают входа · {invitations.length}</summary>
              <ul className="team-people">
                {invitations.map((invite) => (
                  <li key={invite.id}>
                    <span>{invite.name}</span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => void revoke(invite.id)}
                    >
                      Отозвать ссылку
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {confirm && (
            <fieldset className="team-confirm" aria-label="Подтверждение изменения доступа">
              <p>
                {confirm.action === "recovery"
                  ? "Создать одноразовую ссылку восстановления для"
                  : confirm.action === "role"
                    ? confirm.user.role === "admin"
                      ? "Снять права администратора у"
                      : "Дать управление доступом и подключениями участнику"
                    : confirm.user.state === "active"
                      ? "Закрыть доступ к сайту для"
                      : "Вернуть доступ к сайту для"}{" "}
                <strong>{confirm.user.name}</strong>?
              </p>
              {confirm.action === "role" && (
                <p>
                  После изменения роли потребуется повторный вход. Личные чаты и машины других
                  участников остаются закрытыми.
                </p>
              )}
              <div>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void change()}
                >
                  Подтвердить
                </button>
              </div>
            </fieldset>
          )}
          {link && (
            <div className="team-link">
              <p>
                Передай ссылку участнику лично. Она действует до{" "}
                {new Date(link.expires).toLocaleString("ru-RU")}.
              </p>
              <div>
                <input readOnly aria-label="Одноразовая ссылка" value={link.url} />
                <CopyButton text={link.url} label="Скопировать приглашение" />
              </div>
            </div>
          )}
          <details
            onToggle={(event) => {
              setAuditOpen(event.currentTarget.open);
              if (event.currentTarget.open) void loadAudit();
            }}
          >
            <summary>История доступа</summary>
            {auditOpen && (
              <>
                <ul className="team-people">
                  {audit.map((entry) => (
                    <li key={entry.seq}>
                      <div>
                        <strong>{auditLabels[entry.action] ?? "Изменение доступа"}</strong>
                        <span>
                          {entry.actorName}
                          {users.find((user) => user.id === entry.target)
                            ? ` → ${users.find((user) => user.id === entry.target)!.name}`
                            : ""}
                        </span>
                        <small>{new Date(entry.createdAt).toLocaleString("ru-RU")}</small>
                      </div>
                    </li>
                  ))}
                </ul>
                {!audit.length && <p className="muted">Пока нет записей.</p>}
                {auditMore && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void loadAudit(true)}
                  >
                    Ранее
                  </button>
                )}
              </>
            )}
          </details>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
