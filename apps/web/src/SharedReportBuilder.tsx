import type { SharedReportDraft } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { accountLocalStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { SharedMarkdown } from "./SharedMaterialEditor";
import { useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";

export function SharedReportBuilder({
  projectId,
  onBack,
  onPublished,
}: {
  projectId: string;
  onBack: () => void;
  onPublished: (id: string) => void;
}) {
  const pointer = "workspace-shared-report:" + projectId,
    base = "/team/projects/" + projectId + "/report-drafts";
  const [id, setId] = useState(() => {
      try {
        return storage.getItem(pointer) ?? crypto.randomUUID();
      } catch {
        return crypto.randomUUID();
      }
    }),
    [value, setValue] = useState<SharedReportDraft | null>(null),
    [draft, setDraft] = useState({ title: "", body: "" }),
    [preview, setPreview] = useState(false),
    [tick, setTick] = useState(0);
  const selected = useRef(id);
  selected.current = id;
  const { run, busy, error, setError } = useSharedAction(),
    history = useSharedResource<{
      items: { id: string; state: string; createdAt: number; title: string }[];
    }>(base, tick),
    draftKey = pointer + ":" + id;
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError("");
    void (async () => {
      storage.setItem(pointer, id); // Persist before creating an immutable snapshot.
      const result = await api<SharedReportDraft>(base + "/" + id, {
        method: "PUT",
        body: {},
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      let saved: { title: string; body: string } | null = null;
      try {
        const raw = JSON.parse(storage.getItem(draftKey) ?? "null");
        if (
          typeof raw?.title === "string" &&
          raw.title.length <= 120 &&
          typeof raw?.body === "string" &&
          raw.body.length <= 32000
        )
          saved = raw;
      } catch {}
      setDraft(saved ?? { title: result.content.title, body: result.content.body });
      setValue(result);
      setTick((n) => n + 1);
    })().catch((error) => {
      if (!controller.signal.aborted) setError(messageOf(error));
    });
    return () => controller.abort();
  }, [base, id, pointer, draftKey, setError]);
  const change = (next: typeof draft) => {
    setDraft(next);
    try {
      storage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError("Не удалось сохранить черновик на устройстве. Скопируй текст перед закрытием.");
    }
  };
  const publish = () =>
    void run(async () => {
      storage.setItem(draftKey, JSON.stringify(draft));
      const result = await api<SharedReportDraft>(base + "/" + id + "/publish", {
        method: "POST",
        body: { ...draft, confirm: true },
      });
      if (storage.getItem(pointer) === id) storage.removeItem(pointer);
      return result;
    }).then((result) => {
      if (result && selected.current === result.id) {
        setValue(result);
        setTick((n) => n + 1);
      }
    });
  const select = (next: string) => {
    try {
      storage.setItem(pointer, next);
      setId(next);
      setPreview(false);
    } catch {
      setError("Не удалось сохранить подготовку на устройстве.");
    }
  };
  return (
    <section className="shared-form shared-report-builder" aria-label="Сводка общего проекта">
      <div className="shared-toolbar">
        <button type="button" className="secondary" onClick={onBack}>
          К материалам
        </button>
        <strong>Общий отчёт</strong>
      </div>
      <p>Сводка из общего журнала. Проверь и дополни её перед публикацией участникам проекта.</p>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Другие подготовки отчёта</summary>
        <div className="shared-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => select(crypto.randomUUID())}
          >
            Новая сводка
          </button>
          {!!history.value?.items.length && (
            <label>
              Мои подготовки
              <select
                disabled={busy}
                aria-label="Мои подготовки отчётов"
                value={history.value.items.some((r) => r.id === id) ? id : ""}
                onChange={(e) => select(e.target.value)}
              >
                <option value="" disabled>
                  Текущая подготовка
                </option>
                {history.value.items.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} ·{" "}
                    {r.state === "published"
                      ? "опубликован"
                      : r.state === "cancelled"
                        ? "отменён"
                        : "черновик"}{" "}
                    · {new Date(r.createdAt).toLocaleString("ru")}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </details>
      {!value && !error && <p role="status">Собираем сохранённые изменения…</p>}
      {value && (
        <>
          <p className="muted">
            {new Date(value.content.periodFrom).toLocaleString("ru")} —{" "}
            {new Date(value.content.periodTo).toLocaleString("ru")} · {value.authorName}
          </p>
          <small>
            События: {value.checkpoint.includedEvents} из {value.checkpoint.observedEvents}.{" "}
            {value.checkpoint.truncated
              ? "Часть периода сокращена; это отмечено в сводке."
              : "Личная история не включается."}
          </small>
          {value.state === "prepared" ? (
            <>
              <nav className="shared-toolbar" aria-label="Режим отчёта">
                <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                  Редактор
                </button>
                <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                  Просмотр
                </button>
              </nav>
              {preview ? (
                <>
                  <h2>{draft.title}</h2>
                  <SharedMarkdown text={draft.body} />
                </>
              ) : (
                <fieldset disabled={busy}>
                  <label>
                    Название отчёта
                    <input
                      maxLength={120}
                      value={draft.title}
                      onChange={(e) => change({ ...draft, title: e.target.value })}
                    />
                  </label>
                  <label>
                    Текст отчёта
                    <textarea
                      aria-label="Текст отчёта"
                      rows={14}
                      maxLength={32000}
                      value={draft.body}
                      onChange={(e) => change({ ...draft, body: e.target.value })}
                    />
                  </label>
                </fieldset>
              )}
              <div className="shared-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !draft.title.trim() || !draft.body.trim()}
                  onClick={publish}
                >
                  Опубликовать общий отчёт
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api<SharedReportDraft>(base + "/" + id + "/cancel", {
                        method: "POST",
                        body: { confirm: true },
                      });
                      if (storage.getItem(pointer) === id) storage.removeItem(pointer);
                      return result;
                    }).then((result) => {
                      if (result && selected.current === result.id) {
                        setValue(result);
                        setTick((n) => n + 1);
                      }
                    })
                  }
                >
                  Отменить подготовку
                </button>
              </div>
            </>
          ) : (
            <>
              <p role="status">
                {value.state === "published" ? "Отчёт опубликован" : "Подготовка отменена"}
              </p>
              {value.itemId && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => onPublished(value.itemId!)}
                >
                  Открыть общий отчёт
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
