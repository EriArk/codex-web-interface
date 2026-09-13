import {
  coreFields,
  coreLabels,
  emptyCore,
  type SharedItem,
  type SharedItemKind,
  type SharedMaterial,
  type SharedMaterialWrite,
  type SharedProjectDetail,
  sharedMaterialWriteSchema,
} from "@codex-web/shared";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { accountLocalStorage as storage } from "./accountStorage";
import { api } from "./api";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { MarkdownTable } from "./MarkdownTable";
import { SharedExecutionPanel } from "./SharedExecution";
import { SharedFiles } from "./SharedPublication";
import { sharedMutation, useSharedAction } from "./sharedRequests";

export const materialLabels: Record<SharedItemKind, string> = {
  note: "Заметки",
  task: "Задачи",
  plan: "Планы",
  report: "Отчёты",
  core: "Основа",
  review: "Приёмка",
  result: "Результаты",
};
const titles: Record<SharedItemKind, string> = {
  note: "Новая заметка",
  task: "Новая задача",
  plan: "Новый план",
  report: "Новый отчёт",
  core: "Основа проекта",
  review: "Приёмка работы",
  result: "Результат работы",
};
export function newMaterial(kind: SharedItemKind): SharedMaterial {
  const title = titles[kind];
  if (kind === "core") return { kind, title, value: { ...emptyCore } };
  if (kind === "plan") return { kind, title, description: "", sections: [], status: "draft" };
  if (kind === "task") return { kind, title, body: "", status: "todo", priority: 1, dueAt: null };
  if (kind === "report")
    return { kind, title, body: "", periodFrom: Date.now(), periodTo: Date.now() };
  if (kind === "review") return { kind, title, body: "", outcome: "pending", feedback: "" };
  if (kind === "result") return { kind, title, body: "", outcome: "info" };
  return { kind, title, body: "" };
}
const markdown = (text: string) => (
  <Markdown
    remarkPlugins={[remarkGfm]}
    components={{
      pre: CollapsibleCode,
      table: MarkdownTable,
      img: ({ alt }) => <span>{alt || "Изображение"}</span>,
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
    }}
  >
    {text}
  </Markdown>
);
export function SharedMarkdown({ text }: { text: string }) {
  return <div className="shared-body notebook-markdown">{markdown(text)}</div>;
}
export function MaterialContent({ content }: { content: SharedMaterial }) {
  return (
    <div className="shared-body notebook-markdown">
      {content.kind === "task" && (
        <p className="muted">
          {
            { todo: "Нужно сделать", doing: "В работе", blocked: "Ждёт", done: "Готово" }[
              content.status
            ]
          }{" "}
          · Приоритет: {["низкий", "обычный", "высокий"][content.priority]}
          {content.dueAt ? ` · До ${content.dueAt}` : ""}
        </p>
      )}
      {content.kind === "report" && (
        <p className="muted">
          {new Date(content.periodFrom).toLocaleDateString("ru")} —{" "}
          {new Date(content.periodTo).toLocaleDateString("ru")}
        </p>
      )}
      {content.kind === "review" && (
        <p className="muted">
          {
            { pending: "На проверке", accepted: "Принято", needs_fixes: "Нужны правки" }[
              content.outcome
            ]
          }
        </p>
      )}
      {content.kind === "result" && (
        <p className="muted">
          {{ info: "Информация", success: "Успешно", error: "Ошибка" }[content.outcome]}
        </p>
      )}
      {content.kind === "core" ? (
        coreFields.map(
          (field) =>
            content.value[field] && (
              <section key={field}>
                <h3>{coreLabels[field]}</h3>
                {markdown(content.value[field])}
              </section>
            ),
        )
      ) : content.kind === "plan" ? (
        <>
          {markdown(content.description)}
          {content.sections.map((section) => (
            <section key={section.id}>
              <h3>{section.title}</h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item.id}>
                    {item.checked ? "✓ " : "○ "}
                    {item.text}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      ) : (
        <>
          {markdown(content.body)}
          {content.kind === "review" && content.feedback && (
            <blockquote>{content.feedback}</blockquote>
          )}
        </>
      )}
    </div>
  );
}
type Draft = SharedMaterialWrite & { id: string };
export function SharedMaterialEditor({
  detail,
  item,
  kind,
  onBack,
  onSaved,
}: {
  detail: SharedProjectDetail;
  item: SharedItem | null;
  kind: SharedItemKind;
  onBack: () => void;
  onSaved: (item: SharedItem) => void;
}) {
  const projectId = detail.project.id,
    draftKey = "workspace-shared-draft:" + projectId + ":" + (item?.id ?? "new-" + kind);
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const raw = JSON.parse(storage.getItem(draftKey) ?? "null");
      if (
        raw &&
        /^[a-f0-9-]{36}$/.test(raw.id) &&
        (!item || raw.id === item.id) &&
        raw.content?.kind === kind
      ) {
        const { id, ...body } = raw;
        // Empty titles and points are valid unfinished editing states. Validate a
        // normalized copy while retaining the user's exact incomplete text.
        const content = {
          ...body.content,
          title: body.content.title === "" ? titles[kind] : body.content.title,
        };
        if (content.kind === "plan" && Array.isArray(content.sections))
          content.sections = content.sections.map((s: Record<string, unknown>) => ({
            ...s,
            title: s.title === "" ? "Раздел" : s.title,
            items: Array.isArray(s.items)
              ? s.items.map((p) => ({ ...p, text: p.text === "" ? "Пункт" : p.text }))
              : s.items,
          }));
        if (sharedMaterialWriteSchema.safeParse({ ...body, content }).success) return raw;
      }
    } catch {}
    return {
      id: item?.id ?? crypto.randomUUID(),
      revision: item?.revision ?? 0,
      content: item?.content ?? newMaterial(kind),
      assigneeId: item?.assigneeId ?? null,
    };
  });
  const [preview, setPreview] = useState(!!item),
    [current, setCurrent] = useState<SharedItem | null>(null),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState<
    { revision: number; actorName: string; createdAt: number; content: SharedMaterial }[] | null
  >(null);
  const { run, busy, error, setError, active } = useSharedAction();
  const readonly =
    detail.project.archived ||
    detail.project.role === "viewer" ||
    (kind === "core" && detail.project.role !== "owner");
  const path = `/team/projects/${projectId}/materials/${draft.id}`;
  const keep = (next: Draft) => {
    setDraft(next);
    try {
      storage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError("Не удалось сохранить черновик на устройстве. Сохрани его перед закрытием.");
    }
  };
  const change = (content: SharedMaterial) => keep({ ...draft, content });
  const save = () =>
    void run(async () => {
      const { id, ...input } = draft;
      if (!sharedMaterialWriteSchema.safeParse(input).success)
        throw Error("Проверь название, заполнение пунктов и размер материала. Черновик сохранён.");
      // Save before dispatch; a closed window or lost response can retry this exact record.
      storage.setItem(draftKey, JSON.stringify(draft));
      try {
        const saved = await sharedMutation<SharedItem>(path, "PUT", input);
        if (storage.getItem(draftKey) === JSON.stringify(draft)) storage.removeItem(draftKey);
        return saved;
      } catch (error) {
        try {
          const value = await api<SharedItem>(path);
          if (active()) setCurrent(value);
        } catch {}
        throw error;
      }
    }).then((saved) => {
      if (saved) onSaved(saved);
    });
  const c = draft.content;
  const reorder = <T,>(items: T[], i: number, delta: number) => {
    const next = [...items],
      other = i + delta;
    if (other >= 0 && other < next.length) [next[i], next[other]] = [next[other]!, next[i]!];
    return next;
  };
  return (
    <div className="shared-editor-layout">
      <section className="shared-form">
        <div className="shared-toolbar">
          <button type="button" className="secondary" onClick={onBack}>
            <Icon name="back" />К списку
          </button>
          <strong>{materialLabels[kind]} · Общий материал</strong>
        </div>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        {current && current.revision !== draft.revision && (
          <div className="shared-warning" role="alert">
            <strong>На сервере уже версия {current.revision}</strong>
            <MaterialContent content={current.content} />
            <div className="shared-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  keep({ ...draft, revision: current.revision });
                  setCurrent(null);
                }}
              >
                Продолжить с моим текстом
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  keep({
                    id: current.id,
                    revision: current.revision,
                    content: current.content,
                    assigneeId: current.assigneeId,
                  });
                  setCurrent(null);
                }}
              >
                Взять сохранённую версию
              </button>
            </div>
            <small>Следующее сохранение будет отдельным подтверждением правки.</small>
          </div>
        )}
        <nav className="shared-toolbar" aria-label="Режим материала">
          <button
            type="button"
            disabled={readonly}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Редактор
          </button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
            Просмотр
          </button>
        </nav>
        {preview || readonly ? (
          <>
            <h2>{c.title}</h2>
            <MaterialContent content={c} />
            {item && <SharedFiles projectId={projectId} files={item.files} />}
          </>
        ) : (
          <fieldset disabled={busy || readonly}>
            <label>
              Название
              <input
                value={c.title}
                maxLength={120}
                onChange={(e) => change({ ...c, title: e.target.value })}
              />
            </label>
            {c.kind === "core" ? (
              coreFields.map((field) => (
                <label key={field}>
                  {coreLabels[field]}
                  <textarea
                    value={c.value[field]}
                    maxLength={3000}
                    onChange={(e) =>
                      change({ ...c, value: { ...c.value, [field]: e.target.value } })
                    }
                  />
                </label>
              ))
            ) : c.kind === "plan" ? (
              <>
                <label>
                  Описание
                  <textarea
                    value={c.description}
                    maxLength={6000}
                    onChange={(e) => change({ ...c, description: e.target.value })}
                  />
                </label>
                {c.sections.map((section, index) => (
                  <section className="shared-plan-section" key={section.id}>
                    <label>
                      Раздел {index + 1}
                      <input
                        value={section.title}
                        maxLength={120}
                        onChange={(e) =>
                          change({
                            ...c,
                            sections: c.sections.map((s) =>
                              s.id === section.id ? { ...s, title: e.target.value } : s,
                            ),
                          })
                        }
                      />
                    </label>
                    <div className="shared-actions">
                      <button
                        type="button"
                        disabled={!index}
                        onClick={() => change({ ...c, sections: reorder(c.sections, index, -1) })}
                      >
                        Выше
                      </button>
                      <button
                        type="button"
                        disabled={index === c.sections.length - 1}
                        onClick={() => change({ ...c, sections: reorder(c.sections, index, 1) })}
                      >
                        Ниже
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          change({ ...c, sections: c.sections.filter((s) => s.id !== section.id) })
                        }
                      >
                        Удалить раздел
                      </button>
                    </div>
                    {section.items.map((point, n) => (
                      <div className="shared-plan-item" key={point.id}>
                        <label className="shared-check">
                          <input
                            type="checkbox"
                            aria-label={`Выполнено: ${point.text}`}
                            checked={point.checked}
                            onChange={(e) =>
                              change({
                                ...c,
                                sections: c.sections.map((s) =>
                                  s.id === section.id
                                    ? {
                                        ...s,
                                        items: s.items.map((p) =>
                                          p.id === point.id
                                            ? { ...p, checked: e.target.checked }
                                            : p,
                                        ),
                                      }
                                    : s,
                                ),
                              })
                            }
                          />
                        </label>
                        <textarea
                          aria-label={`Пункт ${n + 1} раздела ${index + 1}`}
                          value={point.text}
                          maxLength={1000}
                          onChange={(e) =>
                            change({
                              ...c,
                              sections: c.sections.map((s) =>
                                s.id === section.id
                                  ? {
                                      ...s,
                                      items: s.items.map((p) =>
                                        p.id === point.id ? { ...p, text: e.target.value } : p,
                                      ),
                                    }
                                  : s,
                              ),
                            })
                          }
                        />
                        <div className="shared-actions">
                          <button
                            type="button"
                            aria-label="Поднять пункт"
                            disabled={!n}
                            onClick={() =>
                              change({
                                ...c,
                                sections: c.sections.map((s) =>
                                  s.id === section.id
                                    ? { ...s, items: reorder(s.items, n, -1) }
                                    : s,
                                ),
                              })
                            }
                          >
                            <Icon name="arrow-up" size={16} />
                          </button>
                          <button
                            type="button"
                            aria-label="Опустить пункт"
                            disabled={n === section.items.length - 1}
                            onClick={() =>
                              change({
                                ...c,
                                sections: c.sections.map((s) =>
                                  s.id === section.id ? { ...s, items: reorder(s.items, n, 1) } : s,
                                ),
                              })
                            }
                          >
                            <Icon
                              name="arrow-up"
                              size={16}
                              style={{ transform: "rotate(180deg)" }}
                            />
                          </button>
                          <button
                            type="button"
                            aria-label="Удалить пункт"
                            onClick={() =>
                              change({
                                ...c,
                                sections: c.sections.map((s) =>
                                  s.id === section.id
                                    ? { ...s, items: s.items.filter((p) => p.id !== point.id) }
                                    : s,
                                ),
                              })
                            }
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="secondary"
                      disabled={section.items.length >= 50}
                      onClick={() =>
                        change({
                          ...c,
                          sections: c.sections.map((s) =>
                            s.id === section.id
                              ? {
                                  ...s,
                                  items: [
                                    ...s.items,
                                    {
                                      id: crypto.randomUUID(),
                                      text: "Новый пункт",
                                      checked: false,
                                    },
                                  ],
                                }
                              : s,
                          ),
                        })
                      }
                    >
                      Добавить пункт
                    </button>
                  </section>
                ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={c.sections.length >= 20}
                  onClick={() =>
                    change({
                      ...c,
                      sections: [
                        ...c.sections,
                        { id: crypto.randomUUID(), title: "Новый раздел", items: [] },
                      ],
                    })
                  }
                >
                  Добавить раздел
                </button>
                <label className="shared-check">
                  <input
                    type="checkbox"
                    checked={c.status === "done"}
                    onChange={(e) => change({ ...c, status: e.target.checked ? "done" : "draft" })}
                  />
                  План завершён
                </label>
              </>
            ) : (
              <label>
                Текст
                <textarea
                  aria-label="Текст"
                  value={c.body}
                  maxLength={65536}
                  onChange={(e) => change({ ...c, body: e.target.value })}
                />
              </label>
            )}
            {c.kind === "task" && (
              <div className="shared-form">
                <label>
                  Состояние
                  <select
                    value={c.status}
                    onChange={(e) => change({ ...c, status: e.target.value as typeof c.status })}
                  >
                    <option value="todo">Нужно сделать</option>
                    <option value="doing">В работе</option>
                    <option value="blocked">Ждёт</option>
                    <option value="done">Готово</option>
                  </select>
                </label>
                <label>
                  Приоритет
                  <select
                    value={c.priority}
                    onChange={(e) => change({ ...c, priority: Number(e.target.value) })}
                  >
                    <option value={0}>Низкий</option>
                    <option value={1}>Обычный</option>
                    <option value={2}>Высокий</option>
                  </select>
                </label>
                <label>
                  Срок
                  <input
                    type="date"
                    value={c.dueAt ?? ""}
                    onChange={(e) => change({ ...c, dueAt: e.target.value || null })}
                  />
                </label>
              </div>
            )}
            {c.kind === "report" && (
              <div className="shared-row">
                Период: {new Date(c.periodFrom).toLocaleDateString("ru")} —{" "}
                {new Date(c.periodTo).toLocaleDateString("ru")}
              </div>
            )}
            {c.kind === "review" && (
              <>
                <label>
                  Решение
                  <select
                    value={c.outcome}
                    onChange={(e) => change({ ...c, outcome: e.target.value as typeof c.outcome })}
                  >
                    <option value="pending">На проверке</option>
                    <option value="accepted">Принято</option>
                    <option value="needs_fixes">Нужны правки</option>
                  </select>
                </label>
                <label>
                  Замечания
                  <textarea
                    maxLength={6000}
                    value={c.feedback}
                    onChange={(e) => change({ ...c, feedback: e.target.value })}
                  />
                </label>
              </>
            )}
            {c.kind === "result" && (
              <label>
                Итог
                <select
                  value={c.outcome}
                  onChange={(e) => change({ ...c, outcome: e.target.value as typeof c.outcome })}
                >
                  <option value="info">Информация</option>
                  <option value="success">Успешно</option>
                  <option value="error">Ошибка</option>
                </select>
              </label>
            )}
          </fieldset>
        )}
        {!readonly && (
          <div className="shared-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !c.title.trim()}
              onClick={save}
            >
              Сохранить для участников
            </button>
          </div>
        )}
      </section>
      <aside className="shared-form shared-card">
        <strong>Доступен участникам проекта</strong>
        {item && (
          <small>
            Автор: {item.authorName}
            <br />
            Последняя правка: {item.editorName}
            <br />
            Версия {item.revision} · {new Date(item.updatedAt).toLocaleString("ru")}
          </small>
        )}
        {item?.hasPrivateSource && (
          <p className="muted">
            Опубликованная копия. Исходный личный материал и чат остаются у автора.
          </p>
        )}
        {(kind === "task" || kind === "plan") && (
          <label>
            Исполнитель
            <select
              disabled={busy || readonly}
              value={draft.assigneeId ?? ""}
              onChange={(e) => keep({ ...draft, assigneeId: e.target.value || null })}
            >
              <option value="">Не назначен</option>
              {detail.members
                .filter((m) => m.role !== "viewer" && m.state === "active")
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              {draft.assigneeId &&
                !detail.members.some(
                  (m) =>
                    m.userId === draft.assigneeId && m.state === "active" && m.role !== "viewer",
                ) && <option value={draft.assigneeId}>Исполнитель недоступен</option>}
            </select>
          </label>
        )}
        {item?.kind === "plan" && (
          <SharedExecutionPanel
            key={item.id}
            item={item}
            detail={detail}
            dirty={
              JSON.stringify(draft.content) !== JSON.stringify(item.content) ||
              draft.assigneeId !== item.assigneeId ||
              draft.revision !== item.revision
            }
          />
        )}
        <CopyButton
          text={
            c.kind === "core"
              ? coreFields.map((f) => coreLabels[f] + "\n" + c.value[f]).join("\n\n")
              : c.kind === "plan"
                ? [
                    c.title,
                    c.description,
                    ...c.sections.flatMap((s) => [
                      s.title,
                      ...s.items.map((i) => (i.checked ? "[x] " : "[ ] ") + i.text),
                    ]),
                  ].join("\n")
                : c.body
          }
          label="Копировать материал"
        />
        {item && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(() => api<{ items: NonNullable<typeof history> }>(path + "/history")).then(
                (value) => {
                  if (value) setHistory(value.items);
                },
              )
            }
          >
            История версий
          </button>
        )}
        {history?.map((version) => (
          <details key={version.revision}>
            <summary>
              Версия {version.revision} · {version.actorName}
            </summary>
            <MaterialContent content={version.content} />
            {!readonly && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  keep({ ...draft, content: version.content });
                  setPreview(false);
                }}
              >
                Восстановить в черновик
              </button>
            )}
          </details>
        ))}
        {history &&
          history.length > 0 &&
          history.length < 40 &&
          history.length % 10 === 0 &&
          history.at(-1)!.revision > 1 && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api<{ items: NonNullable<typeof history> }>(
                    path + "/history?before=" + history.at(-1)!.revision,
                  ),
                ).then((value) => {
                  if (value) setHistory([...history, ...value.items]);
                })
              }
            >
              Более ранние версии
            </button>
          )}
        {item && !readonly && (
          <button
            type="button"
            className="text-button danger"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Удалить общий материал
          </button>
        )}
        {confirmDelete && (
          <div className="shared-warning">
            <p>Удалить «{item?.title}» из общего проекта?</p>
            <div className="shared-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await sharedMutation(path, "DELETE", {
                      revision: item!.revision,
                      confirm: true,
                    });
                    storage.removeItem(draftKey);
                    return true;
                  }).then((done) => {
                    if (done) onBack();
                  })
                }
              >
                Удалить
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
