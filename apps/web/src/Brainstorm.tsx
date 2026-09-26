import { DownloadLink } from "./DownloadLink";
import { AutoTextarea } from "./AutoTextarea";
import "./project-gpt.css";
import type {
  BrainstormCard,
  BrainstormConversion,
  BrainstormRoom,
  BrainstormState,
  ProjectGpt,
  SpaceChatFile,
  SpaceChatPage,
  TeamContact,
} from "@codex-web/shared";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { pageWorkspace, accountLocalStorage as storage, workspaceUrl } from "./accountStorage";
import { api, messageOf } from "./api";
import {
  BoardMove,
  type CardPosition,
  DrawingPad,
  drawingPath,
  WirePin,
} from "./BrainstormGestures";
import { BrainstormVoice } from "./BrainstormVoice";
import { Icon } from "./icons";
import { ProjectDialog, type ProjectSetupSeed } from "./ProjectDialog";
import { ResultFilePreview } from "./ResultFilePreview";
import { SpaceChat } from "./SpaceChat";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { TeamContactPicker } from "./TeamContactPicker";
import type { Machine, Result } from "./types";
import type { SpacesController } from "./useCollaborationSpaces";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./brainstorm.css";

const Workspace = lazy(() => import("./GptWorkspace").then((m) => ({ default: m.GptWorkspace })));
const root = "/team/brainstorm";
function saved<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(storage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function persist(key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage availability must not discard the mounted editor's in-memory draft.
  }
}
function forget(key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // A disabled browser store must not prevent closing or saving a room.
  }
}
function RoomDialog({
  title,
  onClose,
  children,
  large = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  large?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  return (
    <dialog
      data-help-context="brainstorm"
      ref={dialog}
      tabIndex={-1}
      className={`workspace-window brainstorm-dialog${large ? " brainstorm-large project-gpt-window" : ""}`}
      aria-label={title}
      onCancel={onClose}
    >
      <header className="panel-heading notebook-heading brainstorm-heading">
        <h2 title={title}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function BrainstormCards({ spaces, query }: { spaces: SpacesController; query: string }) {
  const [rooms, setRooms] = useState<BrainstormRoom[]>([]),
    [next, setNext] = useState<number | null>(null),
    [ready, setReady] = useState(false),
    [create, setCreate] = useState(false);
  const [title, setTitle] = useState(() => saved("brainstorm-new-title", ""));
  const action = useSharedAction();
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const update = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const d = await api<{ rooms: BrainstormRoom[]; nextOffset: number | null }>(root, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setRooms((old) =>
            [...new Map([...old, ...d.rooms].map((r) => [r.id, r])).values()].sort(
              (a, b) => Number(a.closed) - Number(b.closed) || b.updatedAt - a.updatedAt,
            ),
          );
          setNext((n) => (n === null ? d.nextOffset : n));
          setReady(true);
        }
      } catch (e) {
        if (!controller.signal.aborted) action.setError(messageOf(e));
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [action.setError]);
  return (
    <section className="brainstorm-catalog">
      <div className="nav-label">
        Комнаты{" "}
        <button
          type="button"
          className="icon-button"
          aria-label="Новая комната"
          onClick={() => setCreate(true)}
        >
          <Icon name="plus" />
        </button>
      </div>
      {!ready && <p className="nav-empty">Загружаем комнаты…</p>}
      {action.error && (
        <p className="notice" role="alert">
          {action.error}
        </p>
      )}
      {ready && !rooms.length && (
        <p className="nav-empty">
          Место для идей до начала проекта. Комнаты видны всем участникам.
        </p>
      )}
      {rooms
        .filter((r) => r.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .map((r) => (
          <button
            type="button"
            className="brainstorm-room-entry"
            key={r.id}
            onClick={() => spaces.open({ kind: "brainstorm", id: r.id })}
          >
            <strong>{r.title}</strong>
            <small>
              {r.closed ? "Завершена" : r.following ? "Вы участвуете" : r.owner.name}
              {r.unread > 0 ? ` · Новых: ${r.unread}` : ""}
            </small>
          </button>
        ))}
      {next !== null && (
        <button
          className="secondary"
          type="button"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const d = await api<{ rooms: BrainstormRoom[]; nextOffset: number | null }>(
                `${root}?offset=${next}`,
              );
              setRooms((old) => [...new Map([...old, ...d.rooms].map((r) => [r.id, r])).values()]);
              setNext(d.nextOffset);
            })
          }
        >
          Ещё комнаты
        </button>
      )}
      {create && (
        <RoomDialog title="Новая комната" onClose={() => setCreate(false)}>
          <form
            className="brainstorm-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const r = await sharedMutation<BrainstormRoom>(root, "POST", {
                  title: title.trim(),
                  description: "",
                });
                forget("brainstorm-new-title");
                forget("workspace-shared-request:" + root);
                setCreate(false);
                setTitle("");
                spaces.open({ kind: "brainstorm", id: r.id });
              });
            }}
          >
            <p>
              Доска, общий чат и ваш личный GPT. Комната доступна всем пользователям этой установки.
            </p>
            <label>
              Название
              <input
                value={title}
                maxLength={160}
                required
                onChange={(e) => {
                  setTitle(e.target.value);
                  persist("brainstorm-new-title", e.target.value);
                }}
              />
            </label>
            {action.error && <p role="alert">{action.error}</p>}
            <button type="submit" className="primary" disabled={action.busy || !title.trim()}>
              Создать комнату
            </button>
          </form>
        </RoomDialog>
      )}
    </section>
  );
}
type CardDraft = Omit<BrainstormCard, "author" | "updatedAt">;
const newCard = (count: number, text = ""): CardDraft => ({
  id: crypto.randomUUID(),
  kind: "note",
  title: "",
  text: text.slice(0, 16000),
  url: "",
  fileId: null,
  x: 24 + (count % 3) * 340,
  y: 24 + Math.floor(count / 3) * 300,
  width: 310,
  points: [],
  group: "",
  links: [],
  revision: 0,
});
const bodyOf = ({
  id: _id,
  author: _a,
  updatedAt: _u,
  file: _f,
  ...value
}:
  | BrainstormCard
  | (CardDraft & { author?: never; updatedAt?: never; file?: BrainstormCard["file"] })) => value;
export function BrainstormWindow({
  id,
  spaces,
  onProject,
}: {
  id: string;
  spaces: SpacesController;
  onProject: (id: string) => void;
}) {
  const path = `${root}/${id}`;
  const [filter, setFilter] = useState(() =>
    saved(`brainstorm-filter:${id}`, { text: "", group: "" }),
  );
  const [filtersOpen, setFiltersOpen] = useState(!!(filter.text || filter.group));
  const [focusedCard, setFocusedCard] = useState<string | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const [movement, setMovement] = useState<CardPosition | null>(null);
  const [wire, setWire] = useState<{
    source: BrainstormCard;
    point: { x: number; y: number } | null;
  } | null>(null);
  const [state, setState] = useState<BrainstormState | null>(null),
    [cards, setCards] = useState<BrainstormCard[]>([]),
    [tab, setTab] = useState<"board" | "chat" | "gpt">("board");
  const [chatMounted, setChatMounted] = useState(false),
    [gptMounted, setGptMounted] = useState(false),
    [gpt, setGpt] = useState<ProjectGpt | null>(null);
  const [edit, setEdit] = useState<CardDraft | null>(() =>
      saved(`brainstorm-card-draft:${id}`, null),
    ),
    [settings, setSettings] = useState(false),
    [convert, setConvert] = useState(false),
    [preview, setPreview] = useState<Result | null>(null);
  const action = useSharedAction(),
    version = useRef<number | undefined>(undefined),
    current = useRef<BrainstormState | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const d = await api<BrainstormState>(
        path + (version.current === undefined ? "" : `?since=${version.current}`),
        { signal },
      );
      if (signal?.aborted) return;
      version.current = d.version;
      current.current = d;
      setState(d);
      setCards((old) =>
        d.reset
          ? d.cards
          : [
              ...new Map(
                [...old.filter((c) => !d.removed.includes(c.id)), ...d.cards].map((c) => [c.id, c]),
              ).values(),
            ],
      );
    },
    [path],
  );
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const update = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) action.setError(messageOf(e));
      } finally {
        busy = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh, action.setError]);
  useEffect(() => {
    if (edit) persist(`brainstorm-card-draft:${id}`, edit);
    else forget(`brainstorm-card-draft:${id}`);
  }, [edit, id]);
  const saveCard = async (value: CardDraft) => {
    const result = await sharedMutation<BrainstormCard>(
      `${path}/cards/${value.id}`,
      "PUT",
      bodyOf(value),
    );
    setCards((old) =>
      old.some((c) => c.id === result.id)
        ? old.map((c) => (c.id === result.id ? result : c))
        : [...old, result],
    );
  };
  const moveCard = (value: BrainstormCard) => {
    setMovement({ id: value.id, x: value.x, y: value.y });
    void action.run(async () => {
      try {
        await saveCard(value);
      } finally {
        setMovement(null);
      }
    });
  };
  const connect = (source: BrainstormCard, target: string | null) => {
    setWire(null);
    if (
      !target ||
      target === source.id ||
      !cards.some((c) => c.id === target) ||
      source.links?.includes(target)
    )
      return;
    void action.run(async () => {
      if ((source.links?.length ?? 0) >= 20)
        throw Error("У карточки уже 20 связей. Удалите ненужную в редакторе.");
      await saveCard({ ...source, links: [...(source.links ?? []), target] });
    });
  };
  const placedCards = cards.map((c) =>
    movement?.id === c.id ? { ...c, x: movement.x, y: movement.y } : c,
  );
  const placedById = new Map(placedCards.map((c) => [c.id, c]));
  const room = state?.room;
  const groups = [...new Set(cards.map((c) => c.group || "").filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  const search = filter.text.trim().normalize("NFKC").toLocaleLowerCase();
  const filtered = !!(search || filter.group);
  const visibleCards = placedCards.filter(
    (c) =>
      (!filter.group || (filter.group === "none" ? !c.group : c.group === filter.group.slice(6))) &&
      (!search ||
        [c.title, c.text, c.url, c.group, c.file?.name]
          .filter(Boolean)
          .join("\n")
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(search)),
  );
  useEffect(() => persist(`brainstorm-filter:${id}`, filter), [id, filter]);
  useEffect(() => {
    if (!focusedCard) return;
    const target = board.current?.querySelector<HTMLElement>(`[data-card="${focusedCard}"]`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", inline: "center" });
    setFocusedCard(null);
  }, [focusedCard]);
  const openCard = (cardId: string) => {
    setFilter({ text: "", group: "" });
    setFocusedCard(cardId);
  };
  const openFile = (file: { id: string; name: string; mime?: string; bytes?: number }) =>
    setPreview({
      id: file.id,
      title: file.name,
      type: "file",
      turnId: null,
      createdAt: new Date().toISOString(),
      payload: { url: `/api${path}/chat/files/${file.id}`, mime: file.mime, bytes: file.bytes },
    });
  const selectTab = (value: typeof tab) => {
    setWire(null);
    setTab(value);
    if (value === "chat") setChatMounted(true);
    if (value === "gpt") {
      setGptMounted(true);
      if (!gpt) void action.run(async () => setGpt(await api<ProjectGpt>(path + "/gpt")));
    }
  };
  return (
    <RoomDialog title={room?.title ?? "Брейншторм"} large onClose={() => spaces.open(null)}>
      {room && (
        <>
          <div className="brainstorm-context">
            <span>
              {room.closed ? "Комната завершена" : "Открытая комната"} · {state.people.length}{" "}
              онлайн
            </span>
            <BrainstormVoice roomId={id} closed={room.closed} />
            <button
              type="button"
              className="icon-button"
              aria-label="Настройки комнаты"
              onClick={() => setSettings(true)}
            >
              <Icon name="settings" />
            </button>
          </div>
          <nav className="brainstorm-tabs" aria-label="Раздел комнаты">
            {(
              [
                ["board", "Доска"],
                ["chat", "Общий чат"],
                ["gpt", "Мой GPT"],
              ] as const
            ).map(([key, label]) => (
              <button
                className="secondary"
                type="button"
                key={key}
                aria-pressed={tab === key}
                onClick={() => selectTab(key)}
              >
                {label}
                {key === "chat" && room.unread ? ` · ${room.unread}` : ""}
              </button>
            ))}
          </nav>
          {action.error && (
            <p className="notice" role="alert">
              {action.error}
            </p>
          )}
          <div className="brainstorm-pane" hidden={tab !== "board"}>
            <div className="brainstorm-toolbar" data-owner={room.owner.id === pageWorkspace}>
              <button
                className="secondary"
                type="button"
                disabled={room.closed}
                onClick={() =>
                  setEdit({
                    ...newCard(cards.length),
                    group: filter.group.startsWith("group:") ? filter.group.slice(6) : "",
                  })
                }
              >
                <Icon name="plus" /> Материал
              </button>
              {room.owner.id === pageWorkspace && (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setConvert(true)}
                  disabled={room.closed}
                >
                  <Icon name="folder" /> Создать проект
                </button>
              )}
              <button
                type="button"
                className="secondary icon-button"
                aria-label="Поиск и группы"
                aria-expanded={filtersOpen}
                aria-pressed={filtered}
                onClick={() => setFiltersOpen((v) => !v)}
              >
                <Icon name="search" />
              </button>
            </div>
            {filtersOpen && (
              <div className="brainstorm-filters">
                <input
                  type="search"
                  aria-label="Поиск по доске"
                  placeholder="Найти на доске…"
                  maxLength={240}
                  value={filter.text}
                  onChange={(e) => setFilter({ ...filter, text: e.target.value })}
                />
                <select
                  aria-label="Группа карточек"
                  value={filter.group}
                  onChange={(e) => setFilter({ ...filter, group: e.target.value })}
                >
                  <option value="">Все группы</option>
                  <option value="none">Без группы</option>
                  {groups.map((g) => (
                    <option key={g} value={`group:${g}`}>
                      {g}
                    </option>
                  ))}
                  {filter.group.startsWith("group:") && !groups.includes(filter.group.slice(6)) && (
                    <option value={filter.group}>{filter.group.slice(6)}</option>
                  )}
                </select>
                {filtered && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setFilter({ text: "", group: "" })}
                  >
                    Сбросить · {visibleCards.length} из {cards.length}
                  </button>
                )}
              </div>
            )}
            {wire && (
              <div className="brainstorm-wire-tools">
                <span>Выберите вторую карточку</span>
                <button type="button" className="secondary" onClick={() => setWire(null)}>
                  Отмена
                </button>
              </div>
            )}
            <section
              aria-label="Доска идей"
              className="brainstorm-board-scroll shared-scroll"
              onKeyDown={(e) => {
                if (e.key === "Escape" && wire) {
                  e.preventDefault();
                  e.stopPropagation();
                  setWire(null);
                }
              }}
            >
              <div
                ref={board}
                className={`brainstorm-board${filtered ? " brainstorm-filtered" : ""}`}
                style={{
                  minHeight: Math.max(600, ...placedCards.map((c) => c.y + 330)),
                  minWidth: Math.max(1060, ...placedCards.map((c) => c.x + c.width + 24)),
                }}
              >
                {!filtered && (
                  <svg className="brainstorm-connections" aria-hidden="true">
                    <defs>
                      <marker
                        id={`arrow-${id}`}
                        markerWidth="8"
                        markerHeight="8"
                        refX="7"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0,0 L8,4 L0,8" fill="currentColor" />
                      </marker>
                    </defs>
                    {placedCards.flatMap((c) =>
                      (c.links ?? []).flatMap((target) => {
                        const to = placedById.get(target);
                        if (!to) return [];
                        const direction = to.x + to.width / 2 >= c.x + c.width / 2 ? 1 : -1;
                        const fromX = direction === 1 ? c.x + c.width : c.x,
                          toX = direction === 1 ? to.x : to.x + to.width;
                        const lane = Math.max(0, Math.min(c.y, to.y) - 12);
                        return [
                          <path
                            key={`${c.id}:${target}`}
                            d={`M${fromX},${c.y + 28} H${fromX + direction * 12} V${lane} H${toX - direction * 12} V${to.y + 28} H${toX}`}
                            markerEnd={`url(#arrow-${id})`}
                          />,
                        ];
                      }),
                    )}
                    {wire?.point && (
                      <path
                        className="brainstorm-wire-preview"
                        d={`M${wire.source.x + wire.source.width / 2},${wire.source.y + 28} Q${wire.point.x},${wire.source.y + 28} ${wire.point.x},${wire.point.y}`}
                      />
                    )}
                  </svg>
                )}
                {!!cards.length && !visibleCards.length && (
                  <p className="brainstorm-empty">Карточек по этому запросу нет.</p>
                )}
                {!cards.length && (
                  <div className="brainstorm-empty">
                    <h3>С чего начнём?</h3>
                    <p>
                      Добавьте мысль, ссылку, рисунок или файл. Их увидят все участники комнаты.
                    </p>
                  </div>
                )}
                {visibleCards.map((c) => (
                  <article
                    key={c.id}
                    className="brainstorm-card"
                    style={{ left: c.x, top: c.y, width: c.width }}
                    data-card={c.id}
                    data-wire-target={!!wire && wire.source.id !== c.id}
                    data-moving={movement?.id === c.id}
                    tabIndex={-1}
                  >
                    <header>
                      <BoardMove
                        card={c}
                        disabled={room.closed || action.busy || filtered}
                        onPreview={setMovement}
                        onMove={moveCard}
                      />
                      <WirePin
                        card={c}
                        disabled={room.closed || action.busy}
                        selected={wire?.source.id === c.id}
                        onSelect={() =>
                          wire ? connect(wire.source, c.id) : setWire({ source: c, point: null })
                        }
                        onDrag={(source, x, y) => {
                          const rect = board.current!.getBoundingClientRect();
                          setWire({ source, point: { x: x - rect.left, y: y - rect.top } });
                        }}
                        onDrop={connect}
                        onCancel={() => setWire(null)}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Изменить ${c.title || "материал"}`}
                        disabled={room.closed}
                        onClick={() => setEdit(c)}
                      >
                        <Icon name="edit" />
                      </button>
                    </header>
                    {c.group && (
                      <button
                        type="button"
                        className="brainstorm-group"
                        onClick={() => {
                          setFilter({ text: "", group: `group:${c.group}` });
                          setFiltersOpen(true);
                        }}
                      >
                        {c.group}
                      </button>
                    )}
                    {c.kind === "drawing" && (
                      <svg viewBox="0 0 1000 600" role="img" aria-label={c.title || "Рисунок"}>
                        <path
                          d={drawingPath(c.points)}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="5"
                        />
                      </svg>
                    )}
                    {c.text && <p className="brainstorm-card-text">{c.text}</p>}
                    {c.url && (
                      <a
                        className="secondary"
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Открыть источник <Icon name="external" size={16} />
                      </a>
                    )}
                    {c.fileId && c.file?.mime.startsWith("image/") && (
                      <button
                        type="button"
                        className="brainstorm-image"
                        onClick={() => openFile({ id: c.fileId!, name: c.file!.name, ...c.file })}
                      >
                        <img
                          src={workspaceUrl(`/api${path}/chat/files/${c.fileId}`)}
                          alt={c.file.name}
                          loading="lazy"
                        />
                      </button>
                    )}
                    {c.fileId && (
                      <button
                        className="secondary"
                        type="button"
                        onClick={() =>
                          openFile({ id: c.fileId!, name: c.file?.name ?? c.title, ...c.file })
                        }
                      >
                        <Icon name="file" /> Просмотр файла
                      </button>
                    )}
                    <small>{c.author.name}</small>
                    {cards.some(
                      (v) => (c.links ?? []).includes(v.id) || (v.links ?? []).includes(c.id),
                    ) && (
                      <details className="brainstorm-card-links">
                        <summary>Связанные идеи</summary>
                        <div>
                          {cards
                            .filter(
                              (v) =>
                                (c.links ?? []).includes(v.id) || (v.links ?? []).includes(c.id),
                            )
                            .map((v) => (
                              <button
                                type="button"
                                className="secondary"
                                key={v.id}
                                onClick={() => openCard(v.id)}
                              >
                                {(c.links ?? []).includes(v.id) ? "→" : "←"} {v.title || "Материал"}
                              </button>
                            ))}
                        </div>
                      </details>
                    )}
                  </article>
                ))}
              </div>
            </section>
            {!!room.projects.length && (
              <div className="brainstorm-projects">
                {room.projects.map((p) => (
                  <button
                    className="secondary"
                    key={p.id}
                    type="button"
                    onClick={() => {
                      if (p.spaceId) {
                        const space = spaces.catalog.spaces.find((s) => s.id === p.spaceId);
                        const project = space?.projects.find((v) => v.repository === p.repository);
                        if (!space || !project) return;
                        spaces.select(p.spaceId);
                        spaces.open({ kind: "project", id: space.id, projectId: project.id });
                      } else if (room.owner.id === pageWorkspace) {
                        spaces.open(null);
                        onProject(p.id);
                      }
                    }}
                    disabled={
                      p.spaceId
                        ? !spaces.catalog.spaces.some((s) => s.id === p.spaceId)
                        : room.owner.id !== pageWorkspace
                    }
                  >
                    <Icon name="folder" />
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {chatMounted && (
            <div className="brainstorm-pane" hidden={tab !== "chat"}>
              <SpaceChat
                space={room}
                spaces={spaces}
                endpoint={path + "/chat"}
                visible={tab === "chat"}
                readOnly={room.closed}
                onFile={openFile}
              />
            </div>
          )}
          {gptMounted && (
            <div className="brainstorm-pane brainstorm-gpt" hidden={tab !== "gpt"}>
              <small className="brainstorm-private">
                Личный чат. На общую доску попадает только то, что вы опубликуете.
              </small>
              {gpt ? (
                <Suspense fallback={<p>Загружаем GPT…</p>}>
                  <Workspace
                    projectChat={gpt}
                    roomEndpoint={path + "/gpt"}
                    onPublishToRoom={
                      room.closed ? undefined : (text) => setEdit(newCard(cards.length, text))
                    }
                    onProjectChatChange={setGpt}
                    settings={false}
                    overlayOpen={tab !== "gpt" || !!edit || settings || convert}
                    onCodex={() => setTab("board")}
                    onSettings={() => {}}
                    onRemote={() => {}}
                    onNotificationHandled={() => {}}
                  />
                </Suspense>
              ) : (
                <p>Загружаем личный чат…</p>
              )}
            </div>
          )}
          {edit && (
            <CardEditor
              roomId={id}
              cards={cards}
              value={edit}
              current={cards.find((c) => c.id === edit.id)}
              onChange={setEdit}
              onClose={() => setEdit(null)}
              onSave={async () => {
                await saveCard(edit);
                setEdit(null);
              }}
              onDelete={
                edit.revision
                  ? async () => {
                      await sharedMutation(`${path}/cards/${edit.id}`, "DELETE", {
                        revision: edit.revision,
                      });
                      setCards((old) => old.filter((c) => c.id !== edit.id));
                      setEdit(null);
                    }
                  : undefined
              }
            />
          )}
          {settings && (
            <RoomSettings
              room={room}
              onClose={() => setSettings(false)}
              onSave={async () => {
                await refresh();
                setSettings(false);
              }}
            />
          )}
          {convert && (
            <RoomConversion
              room={room}
              cards={cards}
              onClose={() => setConvert(false)}
              onDone={async () => {
                await refresh();
                await spaces.refresh(true);
              }}
            />
          )}
          {preview && <ResultFilePreview result={preview} onClose={() => setPreview(null)} />}
        </>
      )}
      {!room && <p role="status">{action.error || "Открываем комнату…"}</p>}
    </RoomDialog>
  );
}
function CardEditor({
  roomId,
  cards,
  value,
  current,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  roomId: string;
  cards: BrainstormCard[];
  value: CardDraft;
  current?: BrainstormCard;
  onChange: (value: CardDraft) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const action = useSharedAction(),
    [confirm, setConfirm] = useState(false),
    [linkQuery, setLinkQuery] = useState("");
  const patch = (d: Partial<CardDraft>) => onChange({ ...value, ...d });
  return (
    <RoomDialog
      title={value.revision ? "Материал на доске" : "Добавить на общую доску"}
      onClose={onClose}
    >
      <form
        className="brainstorm-form shared-scroll"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(onSave);
        }}
      >
        {current && current.revision !== value.revision && (
          <section className="notice">
            <p>На доске уже новая версия. Ваш черновик сохранён.</p>
            <details>
              <summary>Текущий текст на доске</summary>
              <p>{current.title}</p>
              <p>{current.text}</p>
            </details>
            <button
              className="secondary"
              type="button"
              onClick={() => onChange({ ...value, revision: current.revision })}
            >
              Сохранить мой текст поверх этой версии
            </button>
          </section>
        )}
        <label>
          Тип
          <select
            value={value.kind}
            onChange={(e) => patch({ kind: e.target.value as CardDraft["kind"] })}
          >
            <option value="note">Мысль</option>
            <option value="link">Ссылка</option>
            <option value="file">Файл</option>
            <option value="drawing">Рисунок</option>
          </select>
        </label>
        <label>
          Название
          <input
            value={value.title}
            maxLength={180}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <details>
          <summary>
            Группа и связи{value.group ? ` · ${value.group}` : ""}
            {value.links?.length ? ` · ${value.links.length}` : ""}
          </summary>
          <label>
            Группа
            <input
              aria-label="Название группы"
              maxLength={80}
              list={`groups-${roomId}`}
              value={value.group ?? ""}
              onChange={(e) => patch({ group: e.target.value })}
              placeholder="Без группы"
            />
          </label>
          <datalist id={`groups-${roomId}`}>
            {[...new Set(cards.map((c) => c.group).filter(Boolean))].map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <label>
            Связать с идеями
            <input
              type="search"
              aria-label="Найти связанную идею"
              maxLength={240}
              value={linkQuery}
              onChange={(e) => setLinkQuery(e.target.value)}
            />
          </label>
          <div className="brainstorm-link-choices">
            {cards
              .filter(
                (c) =>
                  c.id !== value.id &&
                  `${c.title}\n${c.text}`
                    .toLocaleLowerCase()
                    .includes(linkQuery.toLocaleLowerCase()),
              )
              .map((c) => (
                <label className="brainstorm-check" key={c.id}>
                  <input
                    type="checkbox"
                    checked={(value.links ?? []).includes(c.id)}
                    disabled={
                      !(value.links ?? []).includes(c.id) && (value.links?.length ?? 0) >= 20
                    }
                    onChange={(e) =>
                      patch({
                        links: e.target.checked
                          ? [...(value.links ?? []), c.id]
                          : (value.links ?? []).filter((id) => id !== c.id),
                      })
                    }
                  />
                  {c.title || "Материал"}
                </label>
              ))}
            {(value.links ?? [])
              .filter((id) => !cards.some((c) => c.id === id))
              .map((id) => (
                <label className="brainstorm-check" key={id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => patch({ links: value.links!.filter((v) => v !== id) })}
                  />
                  Удалённая карточка
                </label>
              ))}
          </div>
        </details>
        {value.kind === "link" && (
          <label>
            Адрес
            <input
              type="url"
              required
              value={value.url}
              maxLength={4000}
              onChange={(e) => patch({ url: e.target.value })}
            />
          </label>
        )}
        {value.kind === "file" && (
          <label>
            Файл до 32 МБ
            <input
              type="file"
              disabled={action.busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void action.run(async () => {
                  if (file.size > 32 * 1024 ** 2) throw Error("Файл должен быть не больше 32 МБ.");
                  const f = await api<SpaceChatFile>(
                    `${root}/${roomId}/chat/files?${new URLSearchParams({ name: file.name, mime: file.type })}`,
                    { method: "POST", raw: file },
                  );
                  patch({ fileId: f.id, title: f.name });
                });
              }}
            />
            {value.fileId && <small>{value.title}</small>}
          </label>
        )}
        {value.kind === "drawing" && (
          <>
            <DrawingPad points={value.points} onChange={(points) => patch({ points })} />
            <div className="brainstorm-grid">
              <button
                className="secondary"
                type="button"
                disabled={!value.points.length}
                onClick={() => {
                  let start = value.points.length - 1;
                  while (start > 0 && value.points[start]?.[0] !== -1) start--;
                  patch({ points: value.points.slice(0, start) });
                }}
              >
                Отменить штрих
              </button>
              <button
                className="secondary"
                type="button"
                disabled={!value.points.length}
                onClick={() => patch({ points: [] })}
              >
                Очистить рисунок
              </button>
            </div>
          </>
        )}
        <label>
          Текст
          <AutoTextarea
            rows={6}
            value={value.text}
            maxLength={16000}
            onChange={(e) => patch({ text: e.target.value })}
          />
        </label>
        <label>
          Размер карточки
          <select value={value.width} onChange={(e) => patch({ width: Number(e.target.value) })}>
            <option value={220}>Компактная</option>
            <option value={310}>Обычная</option>
            <option value={480}>Широкая</option>
            {![220, 310, 480].includes(value.width) && (
              <option value={value.width}>Текущий размер</option>
            )}
          </select>
        </label>
        {action.error && (
          <p role="alert" className="notice">
            {action.error}
          </p>
        )}
        <div className="brainstorm-grid">
          <button
            type="submit"
            className="primary"
            disabled={action.busy || (value.kind === "file" && !value.fileId)}
          >
            {value.revision ? "Сохранить" : "Опубликовать"}
          </button>
          {onDelete && (
            <button
              className="secondary"
              type="button"
              disabled={action.busy}
              onClick={() => setConfirm(true)}
            >
              Удалить
            </button>
          )}
        </div>
        {confirm && (
          <div>
            <p>Удалить этот материал с общей доски?</p>
            <div className="brainstorm-grid">
              <button
                className="secondary"
                type="button"
                disabled={action.busy}
                onClick={() => void action.run(onDelete!)}
              >
                Удалить материал
              </button>
              <button className="secondary" type="button" onClick={() => setConfirm(false)}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </form>
    </RoomDialog>
  );
}
function RoomSettings({
  room,
  onClose,
  onSave,
}: {
  room: BrainstormRoom;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [title, setTitle] = useState(room.title),
    [description, setDescription] = useState(room.description),
    [closed, setClosed] = useState(room.closed),
    action = useSharedAction();
  return (
    <RoomDialog title="Комната" onClose={onClose}>
      <div className="brainstorm-form shared-scroll">
        <p>Видна всем пользователям. Создатель: {room.owner.name}.</p>
        <div className="brainstorm-grid">
          <button
            className="secondary"
            type="button"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`${root}/${room.id}/follow`, {
                  method: "PUT",
                  body: { following: !room.following, muted: room.muted },
                });
                await onSave();
              })
            }
          >
            {room.following ? "Покинуть" : "Участвовать"}
          </button>
          <button
            className="secondary"
            type="button"
            disabled={action.busy || !room.following}
            onClick={() =>
              void action.run(async () => {
                await api(`${root}/${room.id}/follow`, {
                  method: "PUT",
                  body: { following: true, muted: !room.muted },
                });
                await onSave();
              })
            }
          >
            {room.muted ? "Включить уведомления" : "Без уведомлений"}
          </button>
        </div>
        {room.owner.id === pageWorkspace && (
          <>
            <label>
              Название
              <input maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Описание
              <AutoTextarea
                rows={4}
                maxLength={4000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="brainstorm-check">
              <input
                type="checkbox"
                checked={closed}
                onChange={(e) => setClosed(e.target.checked)}
              />{" "}
              Завершить комнату — оставить доступной для чтения
            </label>
            <button
              className="secondary"
              type="button"
              disabled={action.busy || !title.trim()}
              onClick={() =>
                void action.run(async () => {
                  await sharedMutation(`${root}/${room.id}`, "PUT", {
                    title: title.trim(),
                    description,
                    closed,
                    revision: room.revision,
                  });
                  await onSave();
                })
              }
            >
              Сохранить
            </button>
          </>
        )}
        {action.error && <p role="alert">{action.error}</p>}
      </div>
    </RoomDialog>
  );
}
function RoomConversion({
  room,
  cards,
  onClose,
  onDone,
}: {
  room: BrainstormRoom;
  cards: BrainstormCard[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const draftKey = `brainstorm-conversion-draft:${room.id}`;
  const [draft] = useState(() =>
    saved(draftKey, {
      title: room.title,
      selected: cards.map((c) => c.id),
      selectedMessages: [] as string[],
      summary: "",
      participants: [] as (TeamContact & { access: "collaborate" | "direct" })[],
    }),
  );
  const [title, setTitle] = useState(draft.title),
    [selected, setSelected] = useState(draft.selected),
    [messages, setMessages] = useState<SpaceChatPage["messages"]>([]),
    [selectedMessages, setSelectedMessages] = useState(draft.selectedMessages),
    [summary, setSummary] = useState(draft.summary);
  const [participants, setParticipants] = useState<
      (TeamContact & { access: "collaborate" | "direct" })[]
    >(draft.participants),
    [person, setPerson] = useState<TeamContact | null>(null),
    [conversion, setConversion] = useState<BrainstormConversion | null>(null),
    [machines, setMachines] = useState<Machine[]>([]),
    [setup, setSetup] = useState(false);
  const action = useSharedAction(),
    storageKey = `brainstorm-conversion:${room.id}`;
  useEffect(() => {
    if (!conversion)
      persist(draftKey, { title, selected, selectedMessages, summary, participants });
  }, [conversion, draftKey, title, selected, selectedMessages, summary, participants]);
  useEffect(() => {
    const controller = new AbortController();
    void api<SpaceChatPage>(`${root}/${room.id}/chat`, { signal: controller.signal })
      .then((d) => setMessages(d.messages))
      .catch(() => {});
    void (async () => {
      const list = await api<{ items: { id: string; projectId: string | null }[] }>(
        `${root}/${room.id}/snapshots`,
        { signal: controller.signal },
      );
      const old =
        list.items.find((v) => !v.projectId)?.id ?? saved<string | null>(storageKey, null);
      if (old) {
        const v = await api<BrainstormConversion>(`/team/brainstorm-conversions/${old}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setConversion(v);
      }
    })().catch(() => {});
    return () => controller.abort();
  }, [room.id, storageKey]);
  const startSetup = async () => {
    const d = await api<{ machines: Machine[] }>("/machines");
    setMachines(d.machines);
    setSetup(true);
  };
  const seed = useMemo<ProjectSetupSeed | undefined>(
    () =>
      conversion
        ? {
            name: conversion.title,
            repository: "",
            scope: `brainstorm:${conversion.id}`,
            receiptId: conversion.id,
            resetReview: (fingerprint: string) =>
              api(`/team/brainstorm-conversions/${conversion.id}/reset-review`, {
                method: "POST",
                body: { fingerprint },
              }).then(() => {}),
          }
        : undefined,
    [conversion],
  );
  return (
    <RoomDialog title="Проект из комнаты" onClose={onClose}>
      <div className="brainstorm-form shared-scroll">
        {!conversion ? (
          <>
            <p>Сохраним снимок выбранных материалов. Комната и личные GPT останутся на месте.</p>
            <label>
              Название проекта
              <input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <details open>
              <summary>Материалы · {selected.length}</summary>
              {cards.map((c) => (
                <label className="brainstorm-check" key={c.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked ? [...old, c.id] : old.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {c.title || c.text.slice(0, 60) || "Материал"}
                </label>
              ))}
            </details>
            <details>
              <summary>Сообщения общего чата · {selectedMessages.length}</summary>
              {messages.map((m) => (
                <label className="brainstorm-check" key={m.id}>
                  <input
                    type="checkbox"
                    checked={selectedMessages.includes(m.id)}
                    onChange={(e) =>
                      setSelectedMessages((old) =>
                        e.target.checked ? [...old, m.id] : old.filter((id) => id !== m.id),
                      )
                    }
                  />
                  {m.author.name}: {m.text.slice(0, 120)}
                </label>
              ))}
            </details>
            <details>
              <summary>Мои выводы для GPT проекта</summary>
              <label>
                Личное резюме
                <AutoTextarea
                  value={summary}
                  maxLength={8000}
                  rows={5}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </label>
              <small>Только для вашего GPT проекта. В общий архив не попадёт.</small>
            </details>
            <details>
              <summary>Пригласить в проект · {participants.length}</summary>
              <TeamContactPicker
                value={person}
                onChange={setPerson}
                exclude={[pageWorkspace, ...participants.map((p) => p.id)]}
              />
              <button
                className="secondary"
                type="button"
                disabled={!person || participants.length >= 20}
                onClick={() => {
                  if (person)
                    setParticipants((old) => [...old, { ...person, access: "collaborate" }]);
                  setPerson(null);
                }}
              >
                Добавить участника
              </button>
              {participants.map((p) => (
                <div className="brainstorm-participant" key={p.id}>
                  <span>{p.name}</span>
                  <select
                    aria-label={`Доступ ${p.name}`}
                    value={p.access}
                    onChange={(e) =>
                      setParticipants((old) =>
                        old.map((v) =>
                          v.id === p.id
                            ? { ...v, access: e.target.value as "direct" | "collaborate" }
                            : v,
                        ),
                      )
                    }
                  >
                    <option value="collaborate">Совместная работа</option>
                    <option value="direct">Полный доступ · GitHub Write</option>
                  </select>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Убрать ${p.name}`}
                    onClick={() => setParticipants((old) => old.filter((v) => v.id !== p.id))}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              <p>
                Для совместного проекта понадобится GitHub-репозиторий. Участники получат обычные
                приглашения в «Общие».
              </p>
            </details>
            <button
              type="button"
              className="primary"
              disabled={action.busy || !title.trim()}
              onClick={() =>
                void action.run(async () => {
                  const d = await sharedMutation<BrainstormConversion>(
                    `${root}/${room.id}/snapshots`,
                    "POST",
                    {
                      title: title.trim(),
                      cardIds: selected,
                      messageIds: selectedMessages,
                      summary,
                      participants: participants.map((p) => ({ userId: p.id, access: p.access })),
                    },
                  );
                  persist(storageKey, d.id);
                  setConversion(d);
                })
              }
            >
              Сохранить снимок
            </button>
          </>
        ) : (
          <>
            <h3>{conversion.title}</h3>
            <p>
              {conversion.snapshot.cards.length} материалов · {conversion.snapshot.messages.length}{" "}
              сообщений
            </p>
            <DownloadLink
              href={`/api/team/brainstorm-conversions/${conversion.id}/export`}
              name={conversion.title + ".zip"}
              directDownload
            >
              Скачать архив комнаты
            </DownloadLink>
            {conversion.projectId ? (
              <p>Проект создан. Ссылка находится на доске комнаты.</p>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={action.busy}
                onClick={() => void action.run(startSetup)}
              >
                Продолжить создание проекта
              </button>
            )}
            <button
              className="secondary"
              type="button"
              disabled={action.busy || !conversion.projectId}
              onClick={() => {
                forget(storageKey);
                forget("workspace-shared-request:" + `${root}/${room.id}/snapshots`);
                setConversion(null);
              }}
            >
              Новый снимок
            </button>
          </>
        )}
        {action.error && (
          <p className="notice" role="alert">
            {action.error}
          </p>
        )}
        {setup && seed && conversion && (
          <ProjectDialog
            open
            machines={machines}
            seed={seed}
            onClose={() => setSetup(false)}
            onCreated={async (project) => {
              const d = await api<BrainstormConversion>(
                `/team/brainstorm-conversions/${conversion.id}/complete`,
                { method: "POST", body: { projectId: project.id } },
              );
              setConversion(d);
              setSetup(false);
              await onDone();
            }}
          />
        )}
      </div>
    </RoomDialog>
  );
}
