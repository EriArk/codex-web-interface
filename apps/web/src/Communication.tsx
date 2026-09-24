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
function CommunicationWindow({
  catalog,
  initial,
  onClose,
}: {
  catalog: ReturnType<typeof useHumanConversations>;
  initial: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(ref);
  const [selected, setSelected] = useState(initial),
    [creating, setCreating] = useState(false),
    [members, setMembers] = useState<TeamContact[]>([]),
    [title, setTitle] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [visited, setVisited] = useState(initial ? [initial] : []);
  const select = useCallback((id: string) => {
    setSelected(id);
    setCreating(false);
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
  const create = async () => {
    if (busy || !members.length) return;
    setBusy(true);
    setError("");
    const body = { title, members: members.map((m) => m.id).sort() };
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
      setMembers([]);
      setTitle("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
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
          <strong>{current && !creating ? current.title : "Общение"}</strong>
          <small>
            {current && !creating
              ? current.members.map((m) => m.name).join(", ")
              : "Личные и групповые разговоры"}
          </small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть общение"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="communication-body" data-selected={!!selected && !creating}>
        <aside className="communication-list">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setCreating(true);
              setSelected("");
            }}
          >
            Новый разговор
          </button>
          {catalog.items.map((c) => (
            <button
              type="button"
              className="secondary"
              aria-pressed={c.id === selected}
              key={c.id}
              onClick={() => select(c.id)}
            >
              <span>{c.title}</span>
              {c.unread > 0 && <small>{c.unread}</small>}
            </button>
          ))}
          {!catalog.items.length && <p className="muted">Выбери людей и начни разговор.</p>}
        </aside>
        <section className="communication-content">
          {(error || catalog.error) && <p role="alert">{error || catalog.error}</p>}
          {creating ? (
            <div className="communication-create shared-form">
              <label>
                Название группы
                <input
                  value={title}
                  maxLength={120}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Для разговора с несколькими людьми"
                />
              </label>
              <div className="communication-members">
                {members.map((m) => (
                  <button
                    type="button"
                    className="secondary"
                    key={m.id}
                    onClick={() => setMembers((old) => old.filter((v) => v.id !== m.id))}
                  >
                    {m.name} ×
                  </button>
                ))}
              </div>
              <TeamContactPicker
                value={null}
                exclude={[pageWorkspace, ...members.map((m) => m.id)]}
                disabled={busy || members.length >= 7}
                onChange={(m) => setMembers((old) => [...old, m])}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || !members.length}
                onClick={() => void create()}
              >
                Начать разговор
              </button>
            </div>
          ) : current ? (
            <>
              <div className="communication-toolbar">
                <button type="button" className="secondary" onClick={() => setSelected("")}>
                  Разговоры
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-pressed={current.muted}
                  aria-label={current.muted ? "Включить уведомления" : "Отключить уведомления"}
                  onClick={() =>
                    void api(`/team/conversations/${current.id}`, {
                      method: "PUT",
                      body: { muted: !current.muted },
                    })
                      .then(catalog.refresh)
                      .catch((e) => setError(messageOf(e)))
                  }
                >
                  <Icon name="bell" />
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Покинуть разговор? Доступ к сообщениям и материалам этого разговора будет закрыт.",
                      )
                    )
                      void api(`/team/conversations/${current.id}`, { method: "DELETE" })
                        .then(() => {
                          setVisited((old) => old.filter((id) => id !== current.id));
                          setSelected("");
                          return catalog.refresh();
                        })
                        .catch((e) => setError(messageOf(e)));
                  }}
                >
                  Покинуть
                </button>
              </div>
            </>
          ) : (
            <p className="nav-empty">Выбери разговор или создай новый.</p>
          )}
          {visited
            .filter((id) => catalog.items.some((c) => c.id === id))
            .map((id) => (
              <div className="communication-chat" key={id} hidden={id !== selected || creating}>
                <SpaceChat
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
