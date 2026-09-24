import type { CodexSchedule, CodexScheduleInput, CodexScheduleList } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AutoTextarea } from "./AutoTextarea";
import { accountLocalStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./codexSchedules.css";

type Target = { projectId: string; threadId: string; chatRole?: "work" | "intake" };
type Draft = CodexScheduleInput & { id: string; revision?: number };
const labels: Record<string, string> = {
  scheduled: "Запланировано",
  paused: "Приостановлено",
  cancelled: "Отменено",
  finished: "Завершено",
  waiting: "Ожидает свободного чата",
  running: "Отправляется",
  sent: "Отправлено",
  failed: "Не отправлено",
  unknown: "Подтверждение не получено",
};
const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const dateTime = (n: number) =>
  new Date(n).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const wall = (n: number, timezone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(n)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const fresh = (): Draft => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    id: crypto.randomUUID(),
    text: "",
    rule: { ...wall(Date.now() + 3600000, timezone), timezone, weekdays: [] },
  };
};
export function CodexScheduleButton(props: Target) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label="Сообщения по расписанию"
        title="Сообщения по расписанию"
        onClick={() => setOpen(true)}
      >
        <Icon name="schedule" />
      </button>
      {open && <CodexScheduleWindow {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
export function CodexScheduleWindow({
  projectId,
  threadId,
  chatRole: role = "work",
  onClose,
}: Target & { onClose(): void }) {
  const path = `/projects/${encodeURIComponent(projectId)}/schedules/${role}/${encodeURIComponent(threadId)}`;
  const storageKey = `codex-schedule:${projectId}:${role}:${threadId}`;
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true);
  const [data, setData] = useState<CodexScheduleList | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(() => {
    try {
      const saved = JSON.parse(storage.getItem(storageKey) || "null");
      return saved?.id && saved?.rule ? saved : null;
    } catch {
      return null;
    }
  });
  useWorkspaceDialog(dialog);
  const load = useCallback(async () => {
    const value = await api<CodexScheduleList>(path);
    if (alive.current) setData(value);
    return value;
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => {
      if (alive.current) setError(messageOf(e));
    });
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 15000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);
  const edit = (value: Draft | null) => {
    setDraft(value);
    try {
      if (value) {
        const keys = Object.keys(storage).filter((k) => k.startsWith("codex-schedule:"));
        if (keys.length >= 32 && !keys.includes(storageKey)) storage.removeItem(keys[0]!);
        storage.setItem(storageKey, JSON.stringify(value));
      } else storage.removeItem(storageKey);
    } catch {
      /* The mounted editor retains its draft when device storage is full. */
    }
  };
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      if (alive.current) setError(messageOf(e));
      void load().catch(() => {});
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const change = (s: CodexSchedule, action: "pause" | "resume" | "cancel") =>
    run(() => api(path + "/" + s.id, { method: "PATCH", body: { revision: s.revision, action } }));
  const save = () => {
    if (!draft || !data) return;
    const { id, revision, ...input } = draft;
    void run(async () => {
      await api(revision ? path + "/" + id : path, {
        method: revision ? "PATCH" : "POST",
        key: id,
        body: revision
          ? { revision, action: "edit", input }
          : { ...input, targetRevision: data.target.revision },
      });
      edit(null);
    });
  };
  const rule = (patch: Partial<CodexScheduleInput["rule"]>) =>
    draft && edit({ ...draft, rule: { ...draft.rule, ...patch } });
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-window codex-schedule-window"
      aria-label="Сообщения по расписанию"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading notebook-heading">
        <div>
          <h2>По расписанию</h2>
          <small title={data?.target.name}>
            {data?.target.name || "Сообщения Codex"} ·{" "}
            {role === "intake" ? "Разбор входящего" : "Текущий чат"}
          </small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть расписание"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="shared-scroll schedule-content">
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p role="status">Загружаем расписание…</p>}
        {draft ? (
          <fieldset disabled={busy} className="schedule-editor">
            <label>
              Сообщение
              <AutoTextarea
                rows={5}
                maxLength={12000}
                value={draft.text}
                onChange={(e) => edit({ ...draft, text: e.target.value })}
                placeholder="Что отправить Codex позже?"
              />
            </label>
            <div className="schedule-pair">
              <label>
                Повтор
                <select
                  aria-label="Повтор"
                  value={draft.rule.weekdays.length ? "repeat" : "once"}
                  onChange={(e) =>
                    rule({ weekdays: e.target.value === "once" ? [] : [0, 1, 2, 3, 4, 5, 6] })
                  }
                >
                  <option value="once">Один раз</option>
                  <option value="repeat">По дням недели</option>
                </select>
              </label>
              <label>
                Часовой пояс
                <input
                  list="schedule-zones"
                  value={draft.rule.timezone}
                  onChange={(e) => rule({ timezone: e.target.value })}
                />
              </label>
            </div>
            <datalist id="schedule-zones">
              {[
                Intl.DateTimeFormat().resolvedOptions().timeZone,
                "UTC",
                "Europe/Moscow",
                "Asia/Jerusalem",
              ]
                .filter((x, i, a) => a.indexOf(x) === i)
                .map((zone) => (
                  <option key={zone} value={zone} />
                ))}
            </datalist>
            <div className="schedule-pair">
              <label>
                {draft.rule.weekdays.length ? "Начиная с" : "Дата"}
                <input
                  type="date"
                  value={draft.rule.date}
                  onChange={(e) => rule({ date: e.target.value })}
                />
              </label>
              <label>
                Время
                <input
                  type="time"
                  value={draft.rule.time}
                  onChange={(e) => rule({ time: e.target.value })}
                />
              </label>
            </div>
            {draft.rule.weekdays.length > 0 ? (
              <fieldset className="schedule-days" aria-label="Дни недели">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <button
                    type="button"
                    className="secondary"
                    key={day}
                    aria-pressed={draft.rule.weekdays.includes(day)}
                    onClick={() => {
                      const next = draft.rule.weekdays.includes(day)
                        ? draft.rule.weekdays.filter((d) => d !== day)
                        : [...draft.rule.weekdays, day].sort();
                      if (next.length) rule({ weekdays: next });
                    }}
                  >
                    {days[day]}
                  </button>
                ))}
              </fieldset>
            ) : (
              <div className="schedule-pair">
                {[1, 3].map((hours) => (
                  <button
                    type="button"
                    className="secondary"
                    key={hours}
                    onClick={() => {
                      try {
                        rule(wall(Date.now() + hours * 3600000, draft.rule.timezone));
                      } catch {
                        setError("Выбери часовой пояс.");
                      }
                    }}
                  >
                    Через {hours} ч
                  </button>
                ))}
              </div>
            )}
            <small>
              Время закреплено за выбранным часовым поясом. При переводе часов повтор запускается
              один раз; несуществующее время пропускается.
            </small>
          </fieldset>
        ) : (
          <div className="schedule-list">
            {data && !data.items.length && (
              <p>Запланируй сообщение, и Codex получит его в выбранное время.</p>
            )}
            {data?.items.map((s) => (
              <article className="schedule-card" key={s.id}>
                <div className="schedule-card-meta">
                  <strong>
                    {s.rule.weekdays.length
                      ? s.rule.weekdays.map((d) => days[d]).join(", ") + " · " + s.rule.time
                      : s.nextAt || s.last?.dueAt
                        ? dateTime((s.nextAt ?? s.last?.dueAt)!)
                        : s.rule.date + " · " + s.rule.time}
                  </strong>
                  <small>{labels[s.state]}</small>
                </div>
                <p>{s.text}</p>
                <small>
                  {s.rule.timezone}
                  {s.nextAt ? " · Далее: " + dateTime(s.nextAt) : ""}
                </small>
                {s.last && (
                  <small role="status">
                    {dateTime(s.last.dueAt)} · {labels[s.last.state]}
                    {s.last.error ? ". " + s.last.error : ""}
                  </small>
                )}
                {s.state !== "cancelled" && (
                  <div className="schedule-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || s.last?.state === "running"}
                      onClick={() =>
                        edit({ id: s.id, revision: s.revision, text: s.text, rule: s.rule })
                      }
                    >
                      Изменить
                    </button>
                    {s.state !== "finished" && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || s.last?.state === "running"}
                        onClick={() => void change(s, s.state === "paused" ? "resume" : "pause")}
                      >
                        {s.state === "paused" ? "Продолжить" : "Пауза"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || s.last?.state === "running"}
                      onClick={() => void change(s, "cancel")}
                    >
                      Отменить
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
      <footer className="schedule-footer">
        {draft ? (
          <>
            <button type="button" className="secondary" disabled={busy} onClick={() => edit(null)}>
              Отмена
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !data || !draft.text.trim()}
              onClick={save}
            >
              {busy ? "Сохраняем…" : "Сохранить"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!data || busy}
            onClick={() => edit(fresh())}
          >
            <Icon name="plus" /> Новое сообщение
          </button>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
