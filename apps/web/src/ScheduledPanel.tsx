import type { GptJob, GptModels, NotebookLink, ScheduledTask } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { NativeWorkspaceDialog, useWorkspaceMutation, WorkspaceReceipts } from "./NativeWorkspace";
import type { NotebookRequest } from "./Notebook";

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const scheduleZone = (task: ScheduledTask) => {
  const zone = task.schedule.match(/DTSTART;TZID=([^:;\r\n]+):/)?.[1] ?? task.timezone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
};
export function scheduleText(time: string, repeat: string, zone: string) {
  const [hour, minute] = time.split(":");
  if (!/^\d{2}:\d{2}$/.test(time) || Number(hour) > 23 || Number(minute) > 59)
    throw Error("Укажи время запуска.");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const date = ["year", "month", "day"].map((k) => parts.find((p) => p.type === k)?.value).join("");
  const rule =
    repeat === "weekdays"
      ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
      : repeat === "weekly"
        ? "FREQ=WEEKLY"
        : "FREQ=DAILY";
  return `BEGIN:VEVENT\nDTSTART;TZID=${zone}:${date}T${hour}${minute}00\nRRULE:${rule};BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)};BYSECOND=0\nEND:VEVENT`;
}
type Draft = {
  title: string;
  prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  revision: string;
};
const fields = (task: ScheduledTask): Draft => ({
  title: task.title,
  prompt: task.prompt,
  schedule: task.schedule,
  timezone: task.timezone,
  enabled: task.enabled,
  revision: task.revision,
});
const loadDraft = (key: string, fallback: Draft) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      typeof value.title === "string" &&
      typeof value.prompt === "string" &&
      typeof value.revision === "string" &&
      typeof value.schedule === "string" &&
      typeof value.timezone === "string" &&
      typeof value.enabled === "boolean"
    )
      return value as Draft;
  } catch {}
  return fallback;
};
function ScheduleEditor({
  task,
  onChanged,
  onBack,
  onOpen,
}: {
  task: ScheduledTask;
  onChanged: () => void;
  onBack: () => void;
  onOpen: (link: NotebookLink) => void;
}) {
  const key = "native-schedule:" + task.id;
  const [draft, setDraft] = useState(() => loadDraft(key, fields(task))),
    [changeSchedule, setChangeSchedule] = useState(false),
    [time, setTime] = useState("09:00"),
    [repeat, setRepeat] = useState("daily"),
    [confirm, setConfirm] = useState(false),
    [localError, setLocalError] = useState("");
  const mutation = useWorkspaceMutation(onChanged);
  useEffect(() => {
    if (!localStorage.getItem(key)) setDraft(fields(task));
  }, [task, key]);
  const keep = (next: Draft) => {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setLocalError("Не удалось сохранить черновик на устройстве.");
    }
  };
  const save = async () => {
    try {
      const next = {
        ...draft,
        schedule: changeSchedule ? scheduleText(time, repeat, draft.timezone) : draft.schedule,
      };
      keep(next);
      await mutation.mutate({ kind: "schedule", id: task.id, action: "save", ...next }, key);
    } catch (e) {
      setLocalError(messageOf(e));
    }
  };
  const action = async (action: "pause" | "resume" | "delete") => {
    await mutation.mutate(
      {
        kind: "schedule",
        id: task.id,
        revision: task.revision,
        action,
        ...(action === "delete" ? { confirm: true } : {}),
      },
      key,
    );
  };
  return (
    <section className="native-workspace-editor" aria-label="Редактор расписания">
      <button type="button" className="secondary native-mobile-back" onClick={onBack}>
        <Icon name="back" />
        Все расписания
      </button>
      <h3>{task.title}</h3>
      <p className="native-caption">
        {task.enabled ? "Включено" : "На паузе"} · {task.displaySchedule || "Расписание ChatGPT"} ·{" "}
        {scheduleZone(task)}
      </p>
      <p className="native-caption">
        {task.nextRuns[0]
          ? `Следующий запуск: ${new Date(task.nextRuns[0]).toLocaleString("ru", { timeZone: scheduleZone(task) })}`
          : "Следующий запуск не указан"}
        {task.lastRun
          ? ` · Последний: ${new Date(task.lastRun).toLocaleString("ru", { timeZone: scheduleZone(task) })}`
          : ""}
      </p>
      <label>
        Название
        <input
          value={draft.title}
          maxLength={500}
          disabled={!task.canEdit || mutation.busy}
          onChange={(e) => keep({ ...draft, title: e.target.value })}
        />
      </label>
      <label>
        Что должен делать ChatGPT
        <textarea
          value={draft.prompt}
          maxLength={100000}
          disabled={!task.canEdit || mutation.busy || task.eventDriven}
          onChange={(e) => keep({ ...draft, prompt: e.target.value })}
        />
      </label>
      {task.eventDriven ? (
        <p>
          Правила событий редактируются в ChatGPT. Здесь можно приостановить или удалить задачу.
        </p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={changeSchedule}
              disabled={!task.canEdit || mutation.busy}
              onChange={(e) => {
                setChangeSchedule(e.target.checked);
                if (e.target.checked) keep({ ...draft, timezone: scheduleZone(task) });
              }}
            />
            Изменить расписание
          </label>
          {changeSchedule && (
            <>
              <div className="native-form-row">
                <label>
                  Повтор
                  <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
                    <option value="daily">Каждый день</option>
                    <option value="weekdays">По будням</option>
                    <option value="weekly">Раз в неделю, в этот день</option>
                  </select>
                </label>
                <label>
                  Время
                  <input
                    type="time"
                    required
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </label>
              </div>
              <label>
                Часовой пояс
                <input
                  value={draft.timezone}
                  maxLength={120}
                  onChange={(e) => keep({ ...draft, timezone: e.target.value })}
                />
              </label>
            </>
          )}
          <details>
            <summary>Точное расписание</summary>
            <pre>{draft.schedule}</pre>
          </details>
        </>
      )}
      {draft.revision !== task.revision && (
        <p role="status">
          Оригинал изменился после сохранения черновика. Сверь изменения перед сохранением.
        </p>
      )}
      {(mutation.error || localError) && <p role="alert">{mutation.error || localError}</p>}
      <footer>
        {task.canEdit && !task.eventDriven && (
          <button
            type="button"
            className="primary"
            disabled={mutation.busy || !draft.title.trim() || !draft.prompt.trim()}
            onClick={() => void save()}
          >
            {mutation.busy ? "Проверяем…" : "Сохранить"}
          </button>
        )}
        {task.canEdit && (
          <button
            type="button"
            className="secondary"
            disabled={mutation.busy}
            onClick={() => void action(task.enabled ? "pause" : "resume")}
          >
            {task.enabled ? "Приостановить" : "Возобновить"}
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={mutation.busy}
          onClick={() => {
            keep(fields(task));
            setChangeSchedule(false);
            setLocalError("");
          }}
        >
          Вернуть данные из ChatGPT
        </button>
      </footer>
      {task.conversationId && (
        <button
          type="button"
          className="secondary"
          onClick={() =>
            onOpen({
              client: "gpt",
              kind: "thread",
              id: task.conversationId!,
              title: task.title.slice(0, 200),
              availability: "unknown",
            })
          }
        >
          <Icon name="chat" />
          Открыть связанный чат
        </button>
      )}
      {task.canDelete && (
        <details open={confirm} onToggle={(e) => setConfirm(e.currentTarget.open)}>
          <summary>Удалить задачу</summary>
          <p>Удалить «{task.title}» из ChatGPT вместе с расписанием?</p>
          <button
            type="button"
            className="danger"
            disabled={mutation.busy}
            onClick={() => void action("delete")}
          >
            Да, удалить задачу
          </button>
        </details>
      )}
    </section>
  );
}
function NewSchedule({
  onChanged,
  onBack,
  onOpen,
}: {
  onChanged: () => void;
  onBack: () => void;
  onOpen: (link: NotebookLink) => void;
}) {
  const key = "native-schedule-create";
  const [draft, setDraft] = useState(() =>
      loadDraft(key, {
        title: "",
        prompt: "",
        schedule: "",
        timezone: timezone(),
        enabled: true,
        revision: "",
      }),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<GptJob | null>(null);
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const keep = (next: Draft) => {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setError("Не удалось сохранить черновик.");
    }
  };
  const submit = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      let saved = JSON.parse(localStorage.getItem(key + ":send") ?? "null");
      if (!saved) {
        const models = await api<GptModels>("/gpt/models");
        saved = {
          id: crypto.randomUUID(),
          body: {
            nativeId: null,
            files: [],
            model: models.currentModel,
            effort: models.currentEffort,
            text: `Создай одну задачу ChatGPT по расписанию. Сейчас её не выполняй. Не изменяй другие задачи.\nНазвание: ${draft.title}\nПоручение: ${draft.prompt}\nКогда: ${draft.schedule}\nЧасовой пояс: ${draft.timezone}\nЕсли данных недостаточно, задай уточняющий вопрос. Подтверди создание только после сохранения нативной задачи.`,
          },
        };
        localStorage.setItem(key + ":send", JSON.stringify(saved));
      }
      const result = await api<{ job: GptJob }>("/gpt/send", {
        method: "POST",
        key: saved.id,
        body: saved.body,
      });
      if (alive.current) {
        setJob(result.job);
        onChanged();
      }
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!job || !["queued", "preparing", "running"].includes(job.status)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ items: GptJob[] }>(`/gpt/jobs?watch=${job.id}`, { signal: controller.signal })
        .then((r) => {
          const next = r.items.find((j) => j.id === job.id);
          if (next && !controller.signal.aborted) {
            setJob(next);
            if (next.status === "completed") onChanged();
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(messageOf(e));
        });
    }, 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [job, onChanged]);
  const submitted = !!localStorage.getItem(key + ":send");
  return (
    <section className="native-workspace-editor">
      <button type="button" className="secondary native-mobile-back" onClick={onBack}>
        <Icon name="back" />
        Все расписания
      </button>
      <h3>Новое расписание</h3>
      <p className="native-caption">
        ChatGPT создаст задачу в отдельном чате. Её сохранённое расписание появится в списке слева.
      </p>
      <label>
        Название
        <input
          value={draft.title}
          disabled={submitted}
          maxLength={200}
          onChange={(e) => keep({ ...draft, title: e.target.value })}
        />
      </label>
      <label>
        Поручение
        <textarea
          value={draft.prompt}
          disabled={submitted}
          maxLength={50000}
          onChange={(e) => keep({ ...draft, prompt: e.target.value })}
        />
      </label>
      <label>
        Когда
        <input
          placeholder="Например, каждый будний день в 9:00"
          value={draft.schedule}
          disabled={submitted}
          maxLength={2000}
          onChange={(e) => keep({ ...draft, schedule: e.target.value })}
        />
      </label>
      <label>
        Часовой пояс
        <input
          value={draft.timezone}
          disabled={submitted}
          maxLength={120}
          onChange={(e) => keep({ ...draft, timezone: e.target.value })}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {job && (
        <p role="status">
          {job.status === "completed"
            ? "Ответ получен. Проверь сохранённую задачу в списке расписаний."
            : job.status === "unknown"
              ? "Отправка не подтверждена. Проверь созданный чат перед новой попыткой."
              : job.error || "ChatGPT обрабатывает запрос…"}
        </p>
      )}
      <footer>
        <button
          type="button"
          className="primary"
          disabled={busy || !draft.title.trim() || !draft.prompt.trim() || !draft.schedule.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Отправляем…" : submitted ? "Проверить отправку" : "Создать через GPT"}
        </button>
        {job?.nativeId && (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              onOpen({
                client: "gpt",
                kind: "thread",
                id: job.nativeId!,
                title: draft.title.slice(0, 200),
                availability: "unknown",
              })
            }
          >
            Открыть ответ GPT
          </button>
        )}
        {job && ["completed", "failed", "cancelled"].includes(job.status) && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              localStorage.removeItem(key + ":send");
              localStorage.removeItem(key);
              setJob(null);
              keep({
                title: "",
                prompt: "",
                schedule: "",
                timezone: timezone(),
                enabled: true,
                revision: "",
              });
            }}
          >
            Другая задача
          </button>
        )}
      </footer>
    </section>
  );
}
export default function ScheduledPanel({
  onClose,
  onRequest,
  onOpen,
}: {
  onClose: () => void;
  onRequest: (r: NotebookRequest) => void;
  onOpen: (link: NotebookLink) => void;
}) {
  const [items, setItems] = useState<ScheduledTask[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const changed = useCallback(() => setRevision((v) => v + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh and completed receipts revalidate this view.
  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setLoading(true);
    void api<{ items: ScheduledTask[]; cursor: string | null }>("/gpt/scheduled", {
      signal: controller.signal,
    })
      .then((r) => {
        if (!controller.signal.aborted) {
          setItems(r.items);
          setCursor(r.cursor);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [revision]);
  const more = async () => {
    const serial = generation.current;
    try {
      const r = await api<{ items: ScheduledTask[]; cursor: string | null }>(
        "/gpt/scheduled?cursor=" + encodeURIComponent(cursor!),
      );
      if (serial !== generation.current) return;
      setItems((v) => [...v, ...r.items.filter((t) => !v.some((n) => n.id === t.id))]);
      setCursor(r.cursor);
    } catch (e) {
      if (serial === generation.current) setError(messageOf(e));
    }
  };
  const task = items.find((t) => t.id === selected);
  return (
    <NativeWorkspaceDialog title="Расписания ChatGPT" onClose={onClose}>
      <div className="native-toolbar">
        <button
          type="button"
          className="secondary"
          onClick={() => onRequest({ mode: "tasks", scope: null, allProjects: true })}
        >
          <Icon name="back" />
          Напоминания
        </button>
        <button
          type="button"
          className="primary"
          aria-label="Новое расписание"
          onClick={() => setSelected("new")}
        >
          <Icon name="plus" />
          Создать
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Обновить расписания"
          disabled={loading}
          onClick={changed}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <WorkspaceReceipts revision={revision} onSettled={changed} />
      {error && <p role="alert">{error}</p>}
      <div className="native-workspace-layout" data-selected={!!selected}>
        <aside className="native-workspace-list" aria-label="Расписания ChatGPT">
          {loading && <p role="status">Загружаем расписания…</p>}
          {!loading && !error && !items.length && <p>Расписаний пока нет.</p>}
          {items.map((t) => (
            <button
              type="button"
              key={t.id}
              aria-pressed={selected === t.id}
              onClick={() => setSelected(t.id)}
            >
              <strong>{t.title}</strong>
              <small>
                {t.enabled ? "Включено" : "На паузе"} · {t.displaySchedule || t.timezone}
              </small>
            </button>
          ))}
          {cursor && (
            <button type="button" onClick={() => void more()}>
              Ещё расписания
            </button>
          )}
        </aside>
        {selected === "new" ? (
          <NewSchedule
            key="new"
            onChanged={changed}
            onBack={() => setSelected("")}
            onOpen={onOpen}
          />
        ) : task ? (
          <ScheduleEditor
            key={task.id}
            task={task}
            onChanged={changed}
            onBack={() => setSelected("")}
            onOpen={onOpen}
          />
        ) : (
          <section className="native-workspace-editor native-empty">
            <h3>Задачи, которые выполняет ChatGPT</h3>
            <p>
              Выбери расписание, чтобы изменить поручение, время запуска или поставить его на паузу.
            </p>
          </section>
        )}
      </div>
    </NativeWorkspaceDialog>
  );
}
