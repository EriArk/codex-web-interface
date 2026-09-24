import type {
  GitHubActivitySource,
  IssueDraft,
  IssuePackage,
  IssueSource,
} from "@codex-web/shared";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivitySourceWindow } from "./ActivitySourceWindow";
import { messageCode } from "./ArtifactMarkdown";
import { AutoTextarea } from "./AutoTextarea";
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { SharedMarkdown } from "./SharedMaterialEditor";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./issue-drawer.css";

/** Keep block controls and their open dialogs mounted through background history refresh. */
export function useIssueCode(
  text: string,
  onOpen: ((source: string) => void) | undefined,
  complete: boolean | undefined,
  source: IssueSource | undefined,
) {
  const handler = useRef(onOpen);
  useLayoutEffect(() => {
    handler.current = onOpen;
  }, [onOpen]);
  const open = useCallback((source: string) => handler.current?.(source), []);
  const key = JSON.stringify(source),
    available = !!onOpen;
  return useMemo(() => {
    const original = key ? (JSON.parse(key) as IssueSource) : undefined;
    return messageCode(
      text,
      available ? open : undefined,
      complete,
      original
        ? (text, start, end) => (
            <IssueCollect
              text={text}
              source={{ ...original, start, end }}
              targetId={original.projectId}
            />
          )
        : undefined,
    );
  }, [text, available, open, complete, key]);
}
type Capture = { source: IssueSource; text: string; targetId?: string };
type Page = { version?: string; unchanged?: boolean; items: IssueDraft[]; batches: IssuePackage[] };
export function IssueCollect({
  source,
  text,
  targetId,
}: {
  source: IssueSource;
  text: string;
  targetId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary issue-collect" onClick={() => setOpen(true)}>
        В Issues
      </button>
      {open && (
        <IssueDrawerWindow capture={{ source, text, targetId }} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
export function IssueDrawerButton({
  targetId,
  className = "secondary",
}: {
  targetId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label="Подборка Issues"
        title="Подборка Issues"
        onClick={() => setOpen(true)}
      >
        <Icon name="plan" size={16} />
        <span>Подборка Issues</span>
      </button>
      {open && <IssueDrawerWindow targetId={targetId} onClose={() => setOpen(false)} />}
    </>
  );
}
export function IssueDrawerWindow({
  capture,
  targetId = "",
  onClose,
}: {
  capture?: Capture;
  targetId?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const [data, setData] = useState<Page>({ items: [], batches: [] }),
    [targets, setTargets] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [incoming, setIncoming] = useState(capture),
    [editing, setEditing] = useState<IssueDraft | null>(null),
    [form, setForm] = useState({ title: "", body: "", targetId });
  const [checked, setChecked] = useState<string[]>([]),
    [packet, setPacket] = useState<IssuePackage | null>(null),
    [source, setSource] = useState<{ text: string; original: string } | null>(null);
  const [result, setResult] = useState<{
    projectId: string;
    repositoryId: number;
    source: GitHubActivitySource;
  } | null>(null);
  const live = useRef(true),
    lock = useRef(false),
    version = useRef("");
  const refresh = useCallback(async () => {
    const next = await api<Page>("/issue-drawer?since=" + version.current);
    if (live.current && !next.unchanged) {
      version.current = next.version ?? "";
      setData(next);
      setPacket((old) =>
        old
          ? (next.batches.find((b) => b.id === old.id) ?? old)
          : (next.batches.find((b) => b.state === "prepared" || b.state === "running") ?? null),
      );
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void refresh().catch((e) => setError(messageOf(e)));
    void api<{ id: string; name: string }[]>("/issue-drawer/targets")
      .then(setTargets)
      .catch((e) => setError(messageOf(e)));
    let polling = false;
    const timer = setInterval(() => {
      if (document.hidden || polling) return;
      polling = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, 2500);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const edit = (i: IssueDraft) => {
    setEditing(i);
    let saved: { revision?: number; form: typeof form } | null = null;
    try {
      saved = JSON.parse(storage.getItem("codex-issue-edit:" + i.id) ?? "null");
    } catch {}
    setForm(
      saved?.revision === i.revision
        ? saved.form
        : { title: i.title, body: i.body, targetId: i.targetId },
    );
  };
  useEffect(() => {
    if (editing)
      try {
        storage.setItem(
          "codex-issue-edit:" + editing.id,
          JSON.stringify({ revision: editing.revision, form }),
        );
      } catch {
        setError("Не удалось сохранить черновик на устройстве. Сохрани изменения кнопкой ниже.");
      }
  }, [form, editing]);
  const keyFor = (name: string, value: unknown) => {
    const text = JSON.stringify(value);
    let saved: { value: string; key: string } | null = null;
    try {
      saved = JSON.parse(storage.getItem(name) ?? "null");
    } catch {}
    const key = saved?.value === text ? saved.key : crypto.randomUUID();
    storage.setItem(name, JSON.stringify({ key, value: text }));
    if (JSON.parse(storage.getItem(name) ?? "null")?.key !== key)
      throw Error("Не удалось сохранить квитанцию.");
    return key;
  };
  const add = () =>
    act(async () => {
      if (!incoming) return;
      const body = {
        source: incoming.source,
        text: incoming.text,
        targetId: incoming.targetId ?? targetId,
      };
      const id = keyFor("codex-issue-capture", body);
      let saved: IssueDraft;
      try {
        saved = await api<IssueDraft>(`/issue-drawer/items/${id}`, { method: "PUT", body });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "ISSUE_DRAWER_REMOVED") throw e;
        // Only a definitive removed receipt permits a fresh capture ID. Transport
        // failures keep the original ID, including a lost acknowledgement of this retry.
        if (JSON.parse(storage.getItem("codex-issue-capture") ?? "null")?.key === id)
          storage.removeItem("codex-issue-capture");
        const nextId = keyFor("codex-issue-capture", body);
        saved = await api<IssueDraft>(`/issue-drawer/items/${nextId}`, { method: "PUT", body });
      }
      setIncoming(undefined);
      edit(saved);
      await refresh();
    });
  const prepare = () =>
    act(async () => {
      const items = data.items
        .filter((i) => checked.includes(i.id) && i.state === "draft")
        .map((i) => ({ id: i.id, revision: i.revision }));
      const id = keyFor("codex-issue-package", items);
      const b = await api<IssuePackage>(`/issue-drawer/packages/${id}`, {
        method: "PUT",
        body: { items },
      });
      setPacket(b);
      await refresh();
    });
  const reorder = (i: IssueDraft, delta: number) =>
    act(async () => {
      const ids = data.items.map((x) => x.id),
        at = ids.indexOf(i.id),
        to = at + delta;
      if (to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to]!, ids[at]!];
      await api("/issue-drawer/order", { method: "POST", body: { ids } });
      await refresh();
    });
  const labels = {
    draft: "Черновик",
    prepared: "Готово к отправке",
    running: "Публикуется",
    completed: "Создано",
    failed: "Не отправлено",
    unknown: "Нужна проверка",
    cancelled: "Отменено",
  };
  return (
    <dialog
      ref={dialog}
      className="workspace-window issue-drawer-window"
      aria-label="Подборка Issues"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading notebook-heading">
        <h2>Подборка Issues</h2>
        <button
          className="icon-button"
          type="button"
          aria-label="Закрыть подборку"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="shared-scroll issue-drawer-scroll">
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {incoming && (
          <section className="issue-capture">
            <h3>Добавить выбранный текст</h3>
            <div className="issue-exact">
              <SharedMarkdown text={incoming.text} />
            </div>
            <button
              type="button"
              disabled={busy || incoming.text.length > 16000}
              onClick={() => void add()}
            >
              Добавить в подборку
            </button>
            {incoming.text.length > 16000 && <p>Выбери отдельный блок до 16 000 символов.</p>}
          </section>
        )}
        {!incoming && !data.items.length && (
          <p className="muted">
            Добавляй готовые блоки из обсуждения с GPT или разбора Codex. Публикация — после
            проверки всей подборки.
          </p>
        )}
        {data.items.map((i, index) => (
          <article className="issue-draft-card" key={i.id}>
            <header>
              <div className="issue-draft-title">
                {i.state === "draft" && (
                  <label className="issue-draft-pick" htmlFor={`issue-pick-${i.id}`}>
                    <input
                      id={`issue-pick-${i.id}`}
                      type="checkbox"
                      aria-label={`Выбрать: ${i.title}`}
                      checked={checked.includes(i.id)}
                      onChange={(e) =>
                        setChecked((old) =>
                          e.target.checked ? [...old, i.id] : old.filter((id) => id !== i.id),
                        )
                      }
                    />
                  </label>
                )}
                <strong>{i.title}</strong>
              </div>
              <small>{labels[i.state]}</small>
            </header>
            <p className="muted">
              {targets.find((p) => p.id === i.targetId)?.name ?? "Выбери проект"}
            </p>
            {i.error && <p role="status">{i.error}</p>}
            <div className="issue-actions">
              <button className="secondary" type="button" onClick={() => edit(i)}>
                {["draft", "failed", "cancelled"].includes(i.state) ? "Изменить" : "Просмотреть"}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void act(async () => {
                    const v = await api<{ text: string }>(`/issue-drawer/items/${i.id}/source`);
                    setSource({ text: v.text, original: i.original });
                  })
                }
              >
                Исходное сообщение
              </button>
              <CopyButton text={i.body} />
              {i.result && (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    if (i.result)
                      setResult({
                        projectId: i.targetId,
                        repositoryId: i.result.repositoryId,
                        source: {
                          kind: "issue",
                          key: "issue:" + i.result!.number,
                          number: i.result!.number,
                          url: i.result!.url,
                          title: i.title,
                          author: null,
                          authorName: "",
                          at: "",
                        },
                      });
                  }}
                >
                  Открыть Issue #{i.result.number}
                </button>
              )}
              {i.state === "unknown" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(`/issue-drawer/items/${i.id}/reconcile`, {
                        method: "POST",
                        body: {},
                      });
                      await refresh();
                    })
                  }
                >
                  Проверить исход
                </button>
              )}
              {i.state === "draft" && (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Поднять: ${i.title}`}
                    disabled={busy || index === 0}
                    onClick={() => void reorder(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Опустить: ${i.title}`}
                    disabled={busy || index === data.items.length - 1}
                    onClick={() => void reorder(i, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              {!["prepared", "running", "unknown"].includes(i.state) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(`/issue-drawer/items/${i.id}`, {
                        method: "DELETE",
                        body: { revision: i.revision, confirm: true },
                      });
                      storage.removeItem("codex-issue-edit:" + i.id);
                      if (editing?.id === i.id) setEditing(null);
                      await refresh();
                    })
                  }
                >
                  Убрать
                </button>
              )}
            </div>
            {editing?.id === i.id && (
              <section className="issue-editor">
                <label>
                  Проект
                  <select
                    aria-label="Проект для Issue"
                    value={form.targetId}
                    disabled={!["draft", "failed", "cancelled"].includes(i.state)}
                    onChange={(e) => setForm({ ...form, targetId: e.target.value })}
                  >
                    <option value="">Выбери проект</option>
                    {targets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Название
                  <input
                    aria-label="Название Issue"
                    value={form.title}
                    maxLength={200}
                    readOnly={!["draft", "failed", "cancelled"].includes(i.state)}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </label>
                <label>
                  Текст
                  <AutoTextarea
                    aria-label="Текст Issue"
                    rows={10}
                    value={form.body}
                    maxLength={16000}
                    readOnly={!["draft", "failed", "cancelled"].includes(i.state)}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                  />
                </label>
                <details>
                  <summary>Предпросмотр</summary>
                  <SharedMarkdown text={form.body} />
                </details>
                <div className="issue-actions">
                  {["draft", "failed", "cancelled"].includes(i.state) && (
                    <button
                      type="button"
                      disabled={busy || !form.targetId || !form.title.trim() || !form.body.trim()}
                      onClick={() =>
                        void act(async () => {
                          await api(`/issue-drawer/items/${i.id}`, {
                            method: "PATCH",
                            body: { ...form, revision: editing.revision },
                          });
                          storage.removeItem("issue-edit:" + i.id);
                          setEditing(null);
                          await refresh();
                        })
                      }
                    >
                      Сохранить
                    </button>
                  )}
                  <button className="secondary" type="button" onClick={() => setEditing(null)}>
                    Закрыть текст
                  </button>
                </div>
              </section>
            )}
          </article>
        ))}
        {packet && (
          <section className="issue-package" aria-label="Пакет Issues">
            <h3>{packet.state === "prepared" ? "Проверь публикацию" : "Результат отправки"}</h3>
            {[...new Set(packet.items.map((i) => i.projectId))].map((id) => {
              const group = packet.items.filter((i) => i.projectId === id);
              return (
                <section key={id}>
                  <strong>
                    {group[0]!.projectName} · {group[0]!.repository}
                  </strong>
                  <p>
                    От GitHub: @{group[0]!.identity.login} · Issues: {group.length}
                  </p>
                  {group.map((i) => (
                    <details key={i.id}>
                      <summary>{i.title}</summary>
                      <SharedMarkdown text={i.body} />
                    </details>
                  ))}
                </section>
              );
            })}
            <div className="issue-actions">
              {packet.state === "prepared" && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api(`/issue-drawer/packages/${packet.id}/confirm`, {
                          method: "POST",
                          body: { fingerprint: packet.fingerprint, confirm: true },
                        });
                        setChecked([]);
                        await refresh();
                      })
                    }
                  >
                    Отправить {packet.items.length} Issues
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api(`/issue-drawer/packages/${packet.id}/cancel`, {
                          method: "POST",
                          body: {},
                        });
                        setPacket(null);
                        await refresh();
                      })
                    }
                  >
                    Отменить пакет
                  </button>
                </>
              )}
              {packet.state === "running" && (
                <p role="status">Публикация продолжается. Окно можно закрыть.</p>
              )}
              {!["prepared", "running"].includes(packet.state) && (
                <button type="button" className="secondary" onClick={() => setPacket(null)}>
                  Свернуть пакет
                </button>
              )}
            </div>
          </section>
        )}
      </div>
      <footer className="issue-drawer-footer">
        <span>
          {
            checked.filter((id) => data.items.some((i) => i.id === id && i.state === "draft"))
              .length
          }{" "}
          выбрано
        </span>
        <button
          type="button"
          disabled={
            busy ||
            !checked.length ||
            packet?.state === "running" ||
            packet?.state === "prepared" ||
            !!editing
          }
          onClick={() => void prepare()}
        >
          Проверить пакет
        </button>
      </footer>
      {source && <IssueSourceWindow value={source} onClose={() => setSource(null)} />}
      {result && (
        <ActivitySourceWindow
          personalProjectId={result.projectId}
          target={result}
          onClose={() => setResult(null)}
        />
      )}
    </dialog>
  );
}
function IssueSourceWindow({
  value,
  onClose,
}: {
  value: { text: string; original: string };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  return (
    <dialog
      ref={dialog}
      className="workspace-window issue-drawer-window"
      aria-label="Исходное сообщение Issue"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading notebook-heading">
        <h2>Исходное сообщение</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть источник"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="shared-scroll issue-drawer-scroll">
        <details>
          <summary>Выбранный блок</summary>
          <pre>{value.original}</pre>
        </details>
        <SharedMarkdown text={value.text} />
      </div>
    </dialog>
  );
}
