import type { HumanConversation, TeamContact } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pageWorkspace } from "./accountStorage";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { durableKey } from "./ResultSharing";
import { SpaceChat } from "./SpaceChat";
import { TeamContactPicker } from "./TeamContactPicker";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./communication.css";

const openEvent = "open-human-conversation";
export const openHumanConversation = (id = "") =>
  window.dispatchEvent(new CustomEvent(openEvent, { detail: id }));
export function useHumanConversations() {
  const [items, setItems] = useState<HumanConversation[]>([]),
    [error, setError] = useState("");
  const active = useRef(true),
    pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (!pageWorkspace) return Promise.resolve();
    if (pending.current) return pending.current;
    pending.current = api<{ items: HumanConversation[] }>("/team/conversations")
      .then((r) => {
        if (active.current) {
          setItems(r.items);
          setError("");
        }
      })
      .catch((e) => {
        if (active.current) setError(messageOf(e));
      })
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return { items, error, refresh };
}
export function CommunicationLauncher() {
  const catalog = useHumanConversations(),
    [opened, setOpened] = useState(false),
    [initial, setInitial] = useState("");
  useEffect(() => {
    const show = (e: Event) => {
      const claimed = e as Event & { communicationHandled?: boolean };
      if (claimed.communicationHandled) return;
      claimed.communicationHandled = true;
      setInitial((e as CustomEvent<string>).detail || "");
      setOpened(true);
      void catalog.refresh();
    };
    window.addEventListener(openEvent, show);
    return () => window.removeEventListener(openEvent, show);
  }, [catalog.refresh]);
  if (!pageWorkspace) return null;
  const count = catalog.items.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0);
  return (
    <>
      <button
        type="button"
        className="communication-launch"
        onClick={() => openHumanConversation()}
      >
        <Icon name="chat" size={17} />
        <span>Общение</span>
        {count > 0 && <small>{count}</small>}
      </button>
      {opened && (
        <CommunicationWindow catalog={catalog} initial={initial} onClose={() => setOpened(false)} />
      )}
    </>
  );
}
export function CommunicationNotices() {
  const { items } = useHumanConversations();
  return (
    <>
      {items
        .filter((c) => c.unread && !c.muted)
        .map((c) => (
          <button
            type="button"
            className="space-card"
            key={c.id}
            onClick={() => openHumanConversation(c.id)}
          >
            <strong>{c.title}</strong>
            <span>Новые сообщения: {c.unread}</span>
          </button>
        ))}
    </>
  );
}
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((v) => Array.from(v)[0] ?? "")
    .join("")
    .toLocaleUpperCase("ru");
function CommunicationWindow({
  catalog,
  initial,
  onClose,
}: {
  catalog: ReturnType<typeof useHumanConversations>;
  initial: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    gate = useRef(false);
  useWorkspaceDialog(ref);
  const [selected, setSelected] = useState(initial),
    [creating, setCreating] = useState(false),
    [members, setMembers] = useState<TeamContact[]>([]),
    [title, setTitle] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<"chats" | "people">("chats"),
    [query, setQuery] = useState(""),
    [settings, setSettings] = useState(false),
    [visited, setVisited] = useState(initial ? [initial] : []);
  const select = useCallback((id: string) => {
    setSelected(id);
    setCreating(false);
    setSettings(false);
    setError("");
    setVisited((old) => [...old.filter((v) => v !== id), id].slice(-5));
  }, []);
  useEffect(() => {
    if (initial) select(initial);
  }, [initial, select]);
  const open = useCallback(() => {
    setSelected("");
    void catalog.refresh();
  }, [catalog.refresh]);
  const current = catalog.items.find((c) => c.id === selected);
  const create = async (people: TeamContact[], kind: "direct" | "group") => {
    if (gate.current || !people.length || (kind === "group" && !title.trim())) return;
    if (kind === "direct") {
      const existing = catalog.items.find(
        (c) => c.kind === "direct" && c.members.some((m) => m.id === people[0]!.id),
      );
      if (existing) {
        select(existing.id);
        return;
      }
    }
    gate.current = true;
    setBusy(true);
    setError("");
    const body = {
      title: kind === "group" ? title.trim() : "",
      members: people.map((m) => m.id).sort(),
      kind,
    };
    try {
      const request = durableKey("conversation", body);
      const c = await api<HumanConversation>("/team/conversations", {
        method: "POST",
        key: request.key,
        body,
      });
      await catalog.refresh();
      select(c.id);
      request.clear();
      if (kind === "group") {
        setMembers([]);
        setTitle("");
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };
  const back = () => {
    if (creating) setCreating(false);
    else setSelected("");
    setSettings(false);
  };
  const chats = catalog.items.filter((c) =>
    `${c.title} ${c.members.map((m) => m.name).join(" ")}`
      .toLocaleLowerCase("ru")
      .includes(query.toLocaleLowerCase("ru")),
  );
  return createPortal(
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="workspace-window communication-window"
      aria-label="Общение"
    >
      <header className="notebook-heading">
        <div>
          <strong>Общение</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Создать группу"
          onClick={() => {
            setCreating(true);
            setSettings(false);
            setError("");
          }}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть общение"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div
        className="communication-body"
        data-selected={!!current || creating}
        data-creating={creating}
      >
        <aside className="communication-list" aria-label="Чаты и люди">
          <nav className="communication-tabs" aria-label="Раздел общения">
            <button
              type="button"
              className="secondary"
              aria-pressed={tab === "chats"}
              onClick={() => setTab("chats")}
            >
              Чаты
            </button>
            <button
              type="button"
              className="secondary"
              aria-pressed={tab === "people"}
              onClick={() => setTab("people")}
            >
              Люди
            </button>
          </nav>
          {tab === "chats" ? (
            <>
              <input
                type="search"
                aria-label="Найти чат"
                placeholder="Поиск"
                value={query}
                maxLength={120}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="communication-rows">
                {chats.map((c) => (
                  <button
                    type="button"
                    className="communication-row"
                    aria-label={c.title}
                    aria-pressed={c.id === selected && !creating}
                    key={c.id}
                    onClick={() => select(c.id)}
                  >
                    <span className="communication-avatar" aria-hidden="true">
                      {c.kind === "group" ? <Icon name="people" /> : initials(c.title)}
                    </span>
                    <span className="communication-row-copy">
                      <strong>{c.title}</strong>
                      <small>
                        {c.preview ??
                          (c.kind === "group"
                            ? `${c.members.length} участников`
                            : "Личный разговор")}
                      </small>
                    </span>
                    <span className="communication-row-meta">
                      <time dateTime={new Date(c.updatedAt).toISOString()}>
                        {new Date(c.updatedAt).toLocaleDateString() ===
                        new Date().toLocaleDateString()
                          ? new Date(c.updatedAt).toLocaleTimeString("ru", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : new Date(c.updatedAt).toLocaleDateString("ru", {
                              day: "numeric",
                              month: "short",
                            })}
                      </time>
                      {c.unread > 0 ? (
                        <span className="communication-badge" data-muted={c.muted}>
                          {c.unread}
                        </span>
                      ) : c.muted ? (
                        <Icon name="bell" size={14} />
                      ) : null}
                    </span>
                  </button>
                ))}
                {!chats.length && (
                  <div className="communication-empty">
                    <Icon name="chat" size={32} />
                    <p>{query ? "Чат не найден" : "Начни с разговора"}</p>
                    <button type="button" className="secondary" onClick={() => setTab("people")}>
                      Выбрать человека
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="communication-people">
              <TeamContactPicker
                value={null}
                exclude={[pageWorkspace]}
                disabled={busy}
                onChange={(m) => void create([m], "direct")}
              />
            </div>
          )}
          {(error || catalog.error) && !creating && (
            <p className="communication-error" role="alert">
              {error || catalog.error}
            </p>
          )}
        </aside>
        <section className="communication-content">
          {creating ? (
            <>
              <header className="communication-chat-heading">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Назад к разговорам"
                  onClick={back}
                >
                  <Icon name="back" />
                </button>
                <div>
                  <strong>Новая группа</strong>
                  <small>Выбери участников и название</small>
                </div>
              </header>
              <div className="communication-create shared-form">
                <label>
                  Название группы
                  <input
                    value={title}
                    maxLength={120}
                    disabled={busy}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Как назовём группу?"
                  />
                </label>
                <div className="communication-members">
                  {members.map((m) => (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-label={`Убрать ${m.name}`}
                      key={m.id}
                      onClick={() => setMembers((old) => old.filter((v) => v.id !== m.id))}
                    >
                      {m.name}
                      <Icon name="close" size={14} />
                    </button>
                  ))}
                </div>
                <TeamContactPicker
                  value={null}
                  exclude={[pageWorkspace, ...members.map((m) => m.id)]}
                  disabled={busy || members.length >= 7}
                  onChange={(m) =>
                    setMembers((old) => (old.some((v) => v.id === m.id) ? old : [...old, m]))
                  }
                />
                {error && <p role="alert">{error}</p>}
              </div>
              <footer className="communication-create-actions">
                <button type="button" className="secondary" onClick={back}>
                  Назад
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !members.length || !title.trim()}
                  onClick={() => void create(members, "group")}
                >
                  {busy ? "Создаём…" : "Создать группу"}
                </button>
              </footer>
            </>
          ) : current ? (
            <>
              <header className="communication-chat-heading">
                <button
                  type="button"
                  className="icon-button communication-back"
                  aria-label="К списку чатов"
                  onClick={back}
                >
                  <Icon name="back" />
                </button>
                <span className="communication-avatar" aria-hidden="true">
                  {current.kind === "group" ? <Icon name="people" /> : initials(current.title)}
                </span>
                <div>
                  <strong title={current.title}>{current.title}</strong>
                  <small>
                    {current.kind === "group"
                      ? `${current.members.length} участников`
                      : "Личный разговор"}
                  </small>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Настройки разговора"
                  aria-expanded={settings}
                  onClick={() => setSettings(!settings)}
                >
                  <Icon name="settings" />
                </button>
              </header>
              {settings && (
                <div className="communication-settings">
                  <p>{current.members.map((m) => m.name).join(", ")}</p>
                  <div>
                    <button
                      type="button"
                      className="secondary"
                      aria-pressed={current.muted}
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        void api(`/team/conversations/${current.id}`, {
                          method: "PUT",
                          body: { muted: !current.muted },
                        })
                          .then(catalog.refresh)
                          .catch((e) => setError(messageOf(e)))
                          .finally(() => setBusy(false));
                      }}
                    >
                      {current.muted ? "Включить уведомления" : "Без уведомлений"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Покинуть разговор? Доступ к сообщениям и материалам этого разговора будет закрыт.",
                          )
                        ) {
                          setBusy(true);
                          void api(`/team/conversations/${current.id}`, { method: "DELETE" })
                            .then(() => {
                              setVisited((old) => old.filter((id) => id !== current.id));
                              setSelected("");
                              setSettings(false);
                              return catalog.refresh();
                            })
                            .catch((e) => setError(messageOf(e)))
                            .finally(() => setBusy(false));
                        }
                      }}
                    >
                      Покинуть
                    </button>
                  </div>
                </div>
              )}
              {error && <p role="alert">{error}</p>}
            </>
          ) : (
            <div className="communication-empty">
              <Icon name="chat" size={44} />
              <p>Выбери чат или человека</p>
              <small>Здесь можно общаться и делиться материалами</small>
            </div>
          )}
          {visited
            .filter((id) => catalog.items.some((c) => c.id === id))
            .map((id) => (
              <div className="communication-chat" key={id} hidden={id !== selected || creating}>
                <SpaceChat
                  compactComposer
                  space={{ id }}
                  endpoint={`/team/conversations/${id}/chat`}
                  members={catalog.items.find((c) => c.id === id)?.members}
                  spaces={{ open, refresh: catalog.refresh }}
                  visible={id === selected && !creating}
                />
              </div>
            ))}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
