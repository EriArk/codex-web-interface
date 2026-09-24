import type {
  HumanConversation,
  ResultItem,
  ResultShareDestination,
  SharedResultCard,
  TeamContact,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pageWorkspace, accountLocalStorage as storage, workspaceMediaUrl } from "./accountStorage";
import { api, messageOf } from "./api";
import { DownloadLink } from "./DownloadLink";
import { FileViewerDialog } from "./FileViewerDialog";
import { Icon } from "./icons";
import { ResultFilePreview } from "./ResultFilePreview";
import { TeamContactPicker } from "./TeamContactPicker";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./communication.css";

export function ResultShareButton({ result }: { result: ResultItem }) {
  const [open, setOpen] = useState(false);
  if (
    !pageWorkspace ||
    !result.threadId ||
    !["file", "image", "artifact", "preview"].includes(result.type) ||
    !result.payload.url
  )
    return null;
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        Отправить
      </button>
      {open && <ResultShareWindow result={result} onClose={() => setOpen(false)} />}
    </>
  );
}
type Snapshot = Omit<SharedResultCard, "snapshotId" | "revoked">;
export function durableKey(scope: string, input: unknown) {
  const value = JSON.stringify(input),
    name = "result-share-pending:" + scope + ":" + value;
  try {
    const old = JSON.parse(storage.getItem(name) || "null");
    if (old?.value === value)
      return { key: old.key as string, clear: () => storage.removeItem(name) };
  } catch {}
  const key = crypto.randomUUID();
  try {
    storage.setItem(name, JSON.stringify({ value, key }));
  } catch {}
  return {
    key,
    clear: () => {
      try {
        storage.removeItem(name);
      } catch {}
    },
  };
}
function ResultShareWindow({ result, onClose }: { result: ResultItem; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(ref);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [query, setQuery] = useState("");
  const [destinations, setDestinations] = useState<
      { destination: ResultShareDestination; title: string }[]
    >([]),
    [destination, setDestination] = useState<ResultShareDestination | null>(null),
    [person, setPerson] = useState<TeamContact | null>(null),
    [publicRoom, setPublicRoom] = useState(false),
    [sent, setSent] = useState(false);
  const [ai, setAi] = useState<{ id: string; title: string } | null>(null),
    [aiChats, setAiChats] = useState<{ id: string; title: string }[] | null>(null),
    [aiOffset, setAiOffset] = useState<number | null>(0);
  const loadAi = async () => {
    try {
      const data = await api<{ items: { id: string; title: string }[]; nextOffset: number | null }>(
        "/gpt/conversations?offset=" + (aiOffset ?? 0),
      );
      setAiChats((old) => [
        ...new Map([...(old ?? []), ...data.items].map((v) => [v.id, v])).values(),
      ]);
      setAiOffset(data.nextOffset);
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const [grants, setGrants] = useState<
    { id: string; kind: string; destinationId: string; revoked: number }[]
  >([]);
  const live = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry repeats the exact capture request.
  useEffect(() => {
    live.current = true;
    const source = {
      client: result.payload.url?.startsWith("/api/team/conversations/")
        ? "human"
        : result.payload.url?.startsWith("/api/gpt/")
          ? "gpt"
          : "codex",
      threadId: result.threadId,
      resultId: result.id,
    };
    const request = durableKey("capture", source);
    setError("");
    void api<Snapshot>("/team/result-snapshots", {
      method: "POST",
      key: request.key,
      body: source,
      timeoutMs: 60000,
    })
      .then((s) => {
        request.clear();
        if (live.current) {
          setSnapshot(s);
          return api<{ items: typeof grants }>(`/team/result-snapshots/${s.id}/grants`).then(
            (g) => {
              if (live.current) setGrants(g.items);
            },
          );
        }
      })
      .catch((e) => {
        if (live.current) setError(messageOf(e));
      });
    void Promise.all([
      api<{ items: HumanConversation[] }>("/team/conversations"),
      api<{ rooms: { id: string; title: string }[] }>("/team/brainstorm"),
      api<{ spaces: { id: string; title: string }[] }>("/team/spaces"),
    ])
      .then(([chats, rooms, spaces]) => {
        if (live.current)
          setDestinations([
            ...chats.items.map((c) => ({
              destination: { kind: "conversation" as const, id: c.id },
              title: c.title,
            })),
            ...rooms.rooms.map((c) => ({
              destination: { kind: "brainstorm" as const, id: c.id },
              title: "Брейншторм · " + c.title,
            })),
            ...spaces.spaces.map((c) => ({
              destination: { kind: "space" as const, id: c.id },
              title: "Пространство · " + c.title,
            })),
          ]);
      })
      .catch((e) => {
        if (live.current) setError(messageOf(e));
      });
    return () => {
      live.current = false;
    };
  }, [result.id, result.threadId, result.payload.url, retry]);
  const send = async () => {
    if (!snapshot || busy || (!destination && !person && !ai)) return;
    setBusy(true);
    setError("");
    try {
      if (ai) {
        const body = { snapshotId: snapshot.id, threadId: ai.id },
          op = durableKey("ai", body);
        await api("/team/result-handoffs", { method: "POST", key: op.key, body });
        op.clear();
        if (live.current) setSent(true);
        return;
      }
      let target = destination;
      if (person) {
        const body = { title: "", members: [person.id] },
          op = durableKey("direct", body);
        const chat = await api<HumanConversation>("/team/conversations", {
          method: "POST",
          key: op.key,
          body,
        });
        op.clear();
        target = { kind: "conversation", id: chat.id };
      }
      if (!target) throw Error("Выбери получателя.");
      const body = { snapshotId: snapshot.id, destination: target, publicRoom },
        op = durableKey("send", body);
      await api("/team/result-shares", { method: "POST", key: op.key, body });
      op.clear();
      if (live.current) {
        setSent(true);
        const g = await api<{ items: typeof grants }>(
          `/team/result-snapshots/${snapshot.id}/grants`,
        );
        if (live.current) setGrants(g.items);
      }
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="workspace-window result-share-window"
      aria-label="Отправить результат"
    >
      <header className="notebook-heading">
        <div>
          <strong>Отправить результат</strong>
          <small title={result.title}>{result.title}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть отправку"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <section className="result-share-body shared-form">
        {error && (
          <p role="alert">
            {error}
            <button type="button" className="secondary" onClick={() => setRetry((n) => n + 1)}>
              Повторить
            </button>
          </p>
        )}
        {!snapshot && !error && <p role="status">Сохраняем точную версию материала…</p>}
        {sent ? (
          <div>
            <p role="status">
              {ai ? "Результат подготовлен в выбранном чате GPT." : "Результат отправлен."}
            </p>
            {ai && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(
                    new CustomEvent("open-delivery-target", {
                      detail: {
                        client: "gpt",
                        kind: "thread",
                        id: ai.id,
                        title: ai.title,
                        availability: "available",
                      },
                    }),
                  );
                }}
              >
                Открыть чат GPT
              </button>
            )}
          </div>
        ) : (
          <>
            <TeamContactPicker
              value={person}
              disabled={busy}
              exclude={[pageWorkspace]}
              onChange={(p) => {
                setPerson(p);
                setAi(null);
                setDestination(null);
                setPublicRoom(false);
              }}
            />
            <label>
              Или выбрать разговор
              <input
                type="search"
                value={query}
                placeholder="Название разговора или комнаты"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="result-share-destinations">
              {destinations
                .filter((d) => d.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
                .map((d) => (
                  <button
                    type="button"
                    className="secondary"
                    key={d.destination.kind + d.destination.id}
                    aria-pressed={
                      destination?.kind === d.destination.kind &&
                      destination.id === d.destination.id
                    }
                    disabled={busy}
                    onClick={() => {
                      setDestination(d.destination);
                      setAi(null);
                      setPerson(null);
                      setPublicRoom(false);
                    }}
                  >
                    {d.title}
                  </button>
                ))}
            </div>
            {destination?.kind === "brainstorm" && (
              <label className="result-share-audience">
                <input
                  type="checkbox"
                  checked={publicRoom}
                  onChange={(e) => setPublicRoom(e.target.checked)}
                />
                Эта комната доступна всем пользователям CodexWeb. Разрешаю им открыть этот
                результат.
              </label>
            )}
            <details>
              <summary>Мои чаты GPT</summary>
              <p className="muted">
                Материал появится рядом с черновиком выбранного чата. Отправка GPT — отдельно.
              </p>
              {aiChats?.map((c) => (
                <button
                  type="button"
                  className="secondary"
                  key={c.id}
                  disabled={busy}
                  aria-pressed={ai?.id === c.id}
                  onClick={() => {
                    setAi(c);
                    setDestination(null);
                    setPerson(null);
                    setPublicRoom(false);
                  }}
                >
                  {c.title}
                </button>
              ))}
              {aiOffset !== null && (
                <button type="button" className="secondary" onClick={() => void loadAi()}>
                  {aiChats ? "Ещё чаты" : "Выбрать чат GPT"}
                </button>
              )}
            </details>
            <p className="muted">
              Получатели увидят только выбранный материал. Исходный личный чат остаётся приватным.
            </p>
          </>
        )}
        {grants.length > 0 && (
          <details>
            <summary>Куда отправлен · {grants.length}</summary>
            {grants.map((g) => (
              <div className="result-share-grant" key={g.id}>
                <span>
                  {destinations.find(
                    (d) => d.destination.kind === g.kind && d.destination.id === g.destinationId,
                  )?.title ?? "Разговор"}
                </span>
                {g.revoked ? (
                  <small>Доступ отозван</small>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void api(`/team/result-shares/${g.id}`, { method: "DELETE" })
                        .then(() =>
                          setGrants((old) =>
                            old.map((v) => (v.id === g.id ? { ...v, revoked: 1 } : v)),
                          ),
                        )
                        .catch((e) => setError(messageOf(e)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Отозвать
                  </button>
                )}
              </div>
            ))}
          </details>
        )}
      </section>
      <footer className="communication-toolbar">
        <button type="button" className="secondary" onClick={onClose}>
          {sent ? "Готово" : "Отмена"}
        </button>
        {!sent && (
          <button
            type="button"
            className="primary"
            disabled={
              busy ||
              !snapshot ||
              (!destination && !person && !ai) ||
              (destination?.kind === "brainstorm" && !publicRoom)
            }
            onClick={() => void send()}
          >
            Отправить
          </button>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
export function SharedResult({ card }: { card: SharedResultCard }) {
  const [opened, setOpened] = useState(false),
    [current, setCurrent] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    let live = true;
    const refresh = () =>
      void api<Snapshot>(`/team/result-shares/${card.id}`)
        .then((s) => {
          if (live) {
            setCurrent(s);
            setError("");
          }
        })
        .catch((e) => {
          if (live) {
            setCurrent(null);
            setError(messageOf(e));
          }
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [opened, card.id]);
  const url = `/api/team/result-shares/${card.id}/content`,
    html = /\.html?$/i.test(card.title) || card.mime === "text/html";
  return (
    <div className="shared-result-card">
      <strong>{card.title}</strong>
      <small>{Math.max(1, Math.ceil(card.bytes / 1024))} КБ · Источник: личный материал</small>
      {card.revoked ? (
        <span>Доступ отозван</span>
      ) : (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setOpened(true);
            setError("");
          }}
        >
          Открыть результат
        </button>
      )}
      {opened && (error || !current || html) ? (
        <FileViewerDialog
          name={card.title}
          source={!error && current ? url : undefined}
          onClose={() => setOpened(false)}
          actions={
            !error && current ? (
              <DownloadLink directDownload href={url} name={card.title}>
                Скачать
              </DownloadLink>
            ) : null
          }
        >
          {error ? (
            <p role="alert">{error}</p>
          ) : current ? (
            <iframe
              className="shared-result-html"
              title={card.title}
              src={workspaceMediaUrl(`/api/team/result-shares/${card.id}/preview`)}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          ) : (
            <p role="status">Открываем результат…</p>
          )}
        </FileViewerDialog>
      ) : opened && current ? (
        <ResultFilePreview
          result={{
            id: card.id,
            title: card.title,
            type: "file",
            turnId: null,
            createdAt: new Date(card.createdAt).toISOString(),
            payload: { url, mime: card.mime, bytes: card.bytes, sha256: card.sha256 },
          }}
          onClose={() => setOpened(false)}
        />
      ) : null}
    </div>
  );
}
