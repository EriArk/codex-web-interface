import type { GptModels, NotebookLink, ProjectPreparation as Package } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ActivitySourceTarget, ActivitySourceWindow } from "./ActivitySourceWindow";
import { accountLocalStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { gptCache } from "./gptCache";
import { IssueDrawerButton } from "./IssueDrawer";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./workspace-window.css";
import "./project-preparation.css";

const labels: Record<Package["state"], string> = {
  generating: "Готовим предложение",
  draft: "Редактирование",
  review: "Проверка перед записью",
  running: "Публикуем пакет",
  paused: "Проверка результата",
  complete: "Пакет готов",
  failed: "Запрос не завершён",
  cancelled: "Пакет отменён",
};
const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
};
const decode = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
const textual = (path: string) => /\.(md|txt|json|csv|svg)$/i.test(path);
type Choices = { messages: { id: string; text: string }[]; plans: Package[] };
export function ProjectPreparation({
  projectId,
  name,
  onClose,
  onOpen,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
  onOpen: (target: NotebookLink) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const base = `/projects/${encodeURIComponent(projectId)}/preparation`,
    key = `preparation-draft:${projectId}`;
  const saved = useRef<{
    brief?: string;
    selected?: string[];
    edit?: Package;
    request?: { id: string; body: unknown };
  } | null>(null);
  if (saved.current === null) {
    try {
      saved.current = JSON.parse(storage.getItem(key) ?? "{}");
    } catch {
      saved.current = {};
    }
  }
  const [choices, setChoices] = useState<Choices>({ messages: [], plans: [] }),
    [value, setValue] = useState<Package | null>(null),
    [edit, setEdit] = useState<Package | null>(null);
  const [brief, setBrief] = useState(saved.current?.brief ?? ""),
    [selected, setSelected] = useState<string[]>(saved.current?.selected ?? []);
  const [models, setModels] = useState<GptModels | null>(gptCache.models),
    [model, setModel] = useState(gptCache.model),
    [effort, setEffort] = useState(gptCache.effort);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [source, setSource] = useState<ActivitySourceTarget | null>(null);
  const [request, setRequest] = useState(saved.current?.request),
    alive = useRef(true),
    lock = useRef(false);
  const editable = !!value && ["draft", "review"].includes(value.state);
  const accept = useCallback((p: Package, restore = false) => {
    setValue(p);
    setEdit(
      restore && saved.current?.edit?.id === p.id && saved.current.edit.revision === p.revision
        ? saved.current.edit
        : structuredClone(p),
    );
  }, []);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void api<Choices>(base, { signal: controller.signal })
      .then(async (data) => {
        if (!alive.current) return;
        setChoices(data);
        const latest = saved.current?.edit?.id
          ? data.plans.find((p) => p.id === saved.current?.edit?.id)
          : data.plans[0];
        if (latest) {
          const p = await api<Package>(`${base}/${latest.id}`, { signal: controller.signal });
          if (alive.current) accept(p, true);
        }
        if (alive.current) setReady(true);
      })
      .catch((e) => {
        if (alive.current) setError(messageOf(e));
      });
    void api<GptModels>("/gpt/models", { signal: controller.signal })
      .then((m) => {
        if (!alive.current) return;
        setModels(m);
        setModel((old) => (m.models.some((v) => v.id === old) ? old : m.currentModel));
        setEffort((old) => old || m.currentEffort);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [base, accept]);
  useEffect(() => {
    if (ready)
      storage.setItem(
        key,
        JSON.stringify({ brief, selected, edit: editable ? edit : undefined, request }),
      );
  }, [key, ready, brief, selected, edit, editable, request]);
  const pollingId = value?.id,
    pollingState = value?.state;
  useEffect(() => {
    if (!pollingId || !pollingState || !["generating", "running"].includes(pollingState)) return;
    let cancelled = false,
      pending = false;
    const refresh = async () => {
      if (pending || document.hidden || lock.current) return;
      pending = true;
      try {
        const p = await api<Package>(`${base}/${pollingId}`);
        if (!cancelled) accept(p);
      } catch (e) {
        if (!cancelled) setError(messageOf(e));
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(refresh, 2500);
    void refresh();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [base, pollingId, pollingState, accept]);
  const efforts = models?.effortsByModel?.[model] ?? models?.efforts ?? [];
  const modifyFile = (index: number, patch: Partial<Package["files"][number]>) =>
    setEdit(
      (p) => p && { ...p, files: p.files.map((f, n) => (n === index ? { ...f, ...patch } : f)) },
    );
  const save = async () => {
    if (!edit) throw Error("Пакет не загружен");
    const p = await api<Package>(`${base}/${edit.id}`, {
      method: "PUT",
      body: {
        revision: edit.revision,
        title: edit.title,
        files: edit.files.map(({ path, content, choice }) => ({ path, content, choice })),
        issues: edit.issues,
      },
    });
    accept(p);
    return p;
  };
  const create = async () => {
    const r = request ?? {
      id: crypto.randomUUID(),
      body: { messages: selected, brief, model, effort },
    };
    setRequest(r);
    storage.setItem(key, JSON.stringify({ brief, selected, request: r }));
    const p = await api<Package>(`${base}/${r.id}`, { method: "POST", body: r.body });
    accept(p);
    setChoices((c) => ({ ...c, plans: [p, ...c.plans.filter((v) => v.id !== p.id)].slice(0, 5) }));
    setRequest(undefined);
  };
  const upload = async (files: FileList | null) => {
    if (!files || !edit) return;
    if (files.length + edit.files.length > 16) throw Error("В пакете может быть до 16 файлов.");
    const additions: Package["files"] = [];
    for (const f of Array.from(files)) {
      if (f.size > 98304)
        throw Error("Материал больше 96 КБ. Добавь ссылку на него в документ references/.");
      const bytes = new Uint8Array(await f.arrayBuffer());
      additions.push({
        path: `references/${f.name}`,
        content: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")),
        previous: null,
        oldText: null,
        choice: "create",
      });
    }
    if ([...edit.files, ...additions].reduce((n, f) => n + f.content.length, 0) > 131072)
      throw Error("Общий размер документов и материалов пакета — до 96 КБ.");
    setEdit((p) => p && { ...p, files: [...p.files, ...additions] });
  };
  return (
    <dialog
      ref={dialog}
      className="workspace-window preparation-window"
      aria-label={`Подготовить для Codex · ${name}`}
      onCancel={onClose}
      tabIndex={-1}
    >
      <header className="notebook-heading">
        <div>
          <strong>Подготовить для Codex</strong>
          <small title={name}>{name}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть подготовку"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="shared-scroll preparation-content">
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {!ready && !error && <p role="status">Загружаю материалы…</p>}
        {!value && ready && (
          <>
            <p>
              Выбери согласованные ответы GPT. Контекст проекта и переданный снимок брейншторма уже
              учитываются. Сначала получишь редактируемое предложение документов и Issues.
            </p>
            <div className="preparation-sources">
              {choices.messages.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    disabled={!!request || (!selected.includes(m.id) && selected.length >= 8)}
                    checked={selected.includes(m.id)}
                    onChange={(e) =>
                      setSelected((v) =>
                        e.target.checked ? [...v, m.id] : v.filter((id) => id !== m.id),
                      )
                    }
                  />
                  <span>{m.text || "Ответ без текста"}</span>
                </label>
              ))}
            </div>
            <label>
              Согласованная идея и пожелания
              <textarea
                rows={5}
                maxLength={8000}
                value={brief}
                disabled={!!request}
                onChange={(e) => setBrief(e.target.value)}
              />
            </label>
            <div className="preparation-grid">
              <label>
                Модель
                <select
                  value={model}
                  disabled={!!request}
                  onChange={(e) => {
                    setModel(e.target.value);
                    const list = models?.effortsByModel?.[e.target.value] ?? models?.efforts ?? [];
                    if (!list.some((v) => v.id === effort)) setEffort(list[0]?.id ?? "");
                  }}
                >
                  {models?.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Размышление
                <select
                  value={effort}
                  disabled={!!request}
                  onChange={(e) => setEffort(e.target.value)}
                >
                  {efforts.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!!choices.plans.length && (
              <details>
                <summary>Сохранённые пакеты</summary>
                {choices.plans.map((p) => (
                  <button
                    className="secondary preparation-history"
                    type="button"
                    key={p.id}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => accept(await api<Package>(`${base}/${p.id}`)))
                    }
                  >
                    {p.title} · {labels[p.state]}
                  </button>
                ))}
              </details>
            )}
          </>
        )}
        {value && (
          <>
            <div className="preparation-state">
              <strong>{labels[value.state]}</strong>
              <small>
                {value.repository} · @{value.identity.login}
              </small>
            </div>
            {value.error && (
              <p className="notice" role="status">
                {value.error}
              </p>
            )}
            {value.state === "generating" && (
              <p>GPT готовит предложение в чате проекта. Можно закрыть окно и вернуться позже.</p>
            )}
            {edit && !!edit.files.length && (
              <>
                <label>
                  Название пакета
                  <input
                    value={edit.title}
                    readOnly={!editable}
                    maxLength={200}
                    onChange={(e) => setEdit((p) => p && { ...p, title: e.target.value })}
                  />
                </label>
                <h3>Документы и материалы</h3>
                {edit.files.map((f, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Controlled editors keep positional identity while their editable path/title changes.
                  <details className="preparation-file" key={n} open={n === 0}>
                    <summary>
                      {f.path}{" "}
                      <small>
                        {f.choice === "skip"
                          ? "Пропустить"
                          : f.previous
                            ? "Изменение"
                            : "Новый файл"}
                      </small>
                    </summary>
                    <label>
                      Путь файла
                      <input
                        aria-label={`Путь файла ${n + 1}`}
                        value={f.path}
                        readOnly={!editable}
                        onChange={(e) => modifyFile(n, { path: e.target.value, choice: "create" })}
                      />
                    </label>
                    {editable && (
                      <label>
                        При совпадении
                        <select
                          aria-label={`Действие с файлом ${n + 1}`}
                          value={f.choice}
                          onChange={(e) =>
                            modifyFile(n, { choice: e.target.value as typeof f.choice })
                          }
                        >
                          <option value="create">Сохранить под этим именем</option>
                          <option value="ask">Выбрать действие</option>
                          <option value="replace" disabled={!f.previous}>
                            Заменить просмотренную версию
                          </option>
                          <option value="skip">Пропустить</option>
                        </select>
                      </label>
                    )}
                    {editable && f.previous && (
                      <p className="muted">
                        Чтобы оставить оба файла, укажи другое имя. Сохранение проверит, свободно ли
                        оно.
                      </p>
                    )}
                    {textual(f.path) ? (
                      <div className={`preparation-diff ${f.previous ? "with-original" : ""}`}>
                        {f.previous && (
                          <div className="preparation-original">
                            Было<pre>{f.oldText ?? "Текст недоступен для сравнения"}</pre>
                          </div>
                        )}
                        <label>
                          {f.previous ? "Будет" : "Содержимое"}
                          <textarea
                            aria-label={`Содержимое файла ${n + 1}`}
                            spellCheck={false}
                            rows={10}
                            value={decode(f.content)}
                            readOnly={!editable}
                            onChange={(e) => modifyFile(n, { content: encode(e.target.value) })}
                          />
                        </label>
                      </div>
                    ) : (
                      <p>Двоичный материал · {Math.round(atob(f.content).length / 1024)} КБ</p>
                    )}
                  </details>
                ))}
                {editable && (
                  <div className="preparation-grid">
                    <button
                      type="button"
                      className="secondary"
                      disabled={edit.files.length >= 16}
                      onClick={() =>
                        setEdit(
                          (p) =>
                            p && {
                              ...p,
                              files: [
                                ...p.files,
                                {
                                  path: "docs/NEW.md",
                                  content: "",
                                  previous: null,
                                  oldText: null,
                                  choice: "create",
                                },
                              ],
                            },
                        )
                      }
                    >
                      Добавить документ
                    </button>
                    <label className="secondary preparation-upload">
                      Добавить материал
                      <input
                        type="file"
                        multiple
                        disabled={busy || edit.files.length >= 16}
                        accept=".md,.txt,.json,.csv,.svg,.png,.jpg,.jpeg,.webp,.pdf"
                        onChange={(e) => {
                          const files = e.target.files;
                          void act(() => upload(files));
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                )}
                {(editable || !!edit.issues.length) && (
                  <>
                    <h3>Issues</h3>
                    {editable && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={edit.issues.length >= 10}
                        onClick={() =>
                          setEdit(
                            (p) => p && { ...p, issues: [...p.issues, { title: "", body: "" }] },
                          )
                        }
                      >
                        Добавить Issue
                      </button>
                    )}
                    {edit.issues.map((issue, n) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Controlled editors keep positional identity while their editable path/title changes.
                      <details className="preparation-file" key={n}>
                        <summary>{issue.title || "Новый Issue"}</summary>
                        <label>
                          Название Issue
                          <input
                            value={issue.title}
                            readOnly={!editable}
                            onChange={(e) =>
                              setEdit(
                                (p) =>
                                  p && {
                                    ...p,
                                    issues: p.issues.map((i, k) =>
                                      k === n ? { ...i, title: e.target.value } : i,
                                    ),
                                  },
                              )
                            }
                          />
                        </label>
                        <label>
                          Описание Issue
                          <textarea
                            rows={6}
                            value={issue.body}
                            readOnly={!editable}
                            onChange={(e) =>
                              setEdit(
                                (p) =>
                                  p && {
                                    ...p,
                                    issues: p.issues.map((i, k) =>
                                      k === n ? { ...i, body: e.target.value } : i,
                                    ),
                                  },
                              )
                            }
                          />
                        </label>
                        {editable && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              setEdit(
                                (p) => p && { ...p, issues: p.issues.filter((_, k) => k !== n) },
                              )
                            }
                          >
                            Не публиковать этот Issue
                          </button>
                        )}
                      </details>
                    ))}
                  </>
                )}
              </>
            )}
            {value.state === "review" && (
              <section className="preparation-confirm">
                <strong>
                  Записать в {value.repository} от @{value.identity.login}?
                </strong>
                <p>
                  {value.base.head
                    ? "Будут созданы отдельная ветка с документами и PR."
                    : "Будет создан первый коммит репозитория."}{" "}
                  Issues: {value.issues.length}. AGENTS.md и CODEXWEB.md сохраняются. Рабочая папка
                  компьютера не переключается.
                </p>
              </section>
            )}
            {value.result && (
              <section className="preparation-result">
                <h3>Результат</h3>
                <p>
                  Ветка: <code>{value.result.branch}</code>
                </p>
                <p>
                  Коммит: <code>{value.result.sha}</code>
                </p>
                {value.issueResults?.map((i, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Frozen publication order never changes.
                  <p key={n}>
                    {i.title} · {i.state === "completed" ? "Опубликован" : "В подборке"}
                  </p>
                ))}
                <p>
                  План Codex сохранит точную ветку и коммит. Запуск реализации — отдельное действие.
                </p>
                <div className="preparation-grid">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setSource({
                        projectId,
                        repositoryId: value.repositoryId,
                        source: {
                          kind: value.result!.pr ? "pr" : "commit",
                          key: value.result!.pr
                            ? `pr:${value.result!.pr}`
                            : `commit:${value.result!.sha}`,
                          title: value.title,
                          author: value.identity,
                          authorName: value.identity.login,
                          at: "",
                          number: value.result!.pr,
                          sha: value.result!.sha,
                          url: value.result!.url!,
                        },
                      })
                    }
                  >
                    Открыть {value.result.pr ? "PR" : "коммит"}
                  </button>
                  <IssueDrawerButton targetId={projectId} />
                </div>
              </section>
            )}
          </>
        )}
      </div>
      <footer className="preparation-actions">
        {!value && (
          <button
            type="button"
            className="primary"
            disabled={
              busy ||
              !ready ||
              (!request && (!model || !effort || (!selected.length && !brief.trim())))
            }
            onClick={() => void act(create)}
          >
            {request ? "Проверить отправку" : "Подготовить предложение"}
          </button>
        )}
        {editable && (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await save();
                })
              }
            >
              Сохранить
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const p = await save();
                  accept(
                    await api<Package>(`${base}/${p.id}/review`, {
                      method: "POST",
                      body: { revision: p.revision },
                    }),
                  );
                })
              }
            >
              Проверить пакет
            </button>
          </>
        )}
        {value?.state === "review" && (
          <button
            type="button"
            className="primary preparation-full"
            disabled={busy || JSON.stringify(edit) !== JSON.stringify(value)}
            onClick={() =>
              void act(async () =>
                accept(
                  await api<Package>(`${base}/${value.id}/confirm`, {
                    method: "POST",
                    body: { fingerprint: value.fingerprint },
                  }),
                ),
              )
            }
          >
            Подтвердить публикацию
          </button>
        )}
        {value?.state === "paused" && (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () =>
                  accept(await api<Package>(`${base}/${value.id}/status`, { method: "POST" })),
                )
              }
            >
              Проверить результат
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () =>
                  accept(
                    await api<Package>(`${base}/${value.id}/confirm`, {
                      method: "POST",
                      body: { fingerprint: value.fingerprint },
                    }),
                  ),
                )
              }
            >
              Продолжить пакет
            </button>
          </>
        )}
        {value?.state === "complete" && (
          <button
            type="button"
            className="primary preparation-full"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const target = await api<NotebookLink>(`${base}/${value.id}/handoff`, {
                  method: "POST",
                });
                onOpen(target);
              })
            }
          >
            Открыть план в Codex
          </button>
        )}
        {value && ["draft", "review", "failed"].includes(value.state) && (
          <button
            type="button"
            className="secondary preparation-full"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                accept(
                  await api<Package>(`${base}/${value.id}/cancel`, {
                    method: "POST",
                    body: { revision: value.revision },
                  }),
                ),
              )
            }
          >
            Отменить пакет
          </button>
        )}
        {value && ["complete", "cancelled"].includes(value.state) && (
          <button
            type="button"
            className="secondary preparation-full"
            onClick={() => {
              setValue(null);
              setEdit(null);
            }}
          >
            Новый пакет
          </button>
        )}
      </footer>
      {source && (
        <ActivitySourceWindow
          personalProjectId={projectId}
          target={source}
          onClose={() => setSource(null)}
        />
      )}
    </dialog>
  );
}
