import { useEffect, useState } from "react";
import { api, messageOf } from "./api";
import type { Machine } from "./types";
import "./usageLimits.css";

interface Window {
  minutes: number;
  remainingPercent: number;
  resetsAt: number | null;
}
interface Group {
  id: string;
  name: string;
  windows: Window[];
}
const label = (minutes: number) =>
  minutes === 10080
    ? "Неделя"
    : minutes === 300
      ? "5 часов"
      : minutes >= 1440
        ? Math.round(minutes / 1440) + " дн."
        : minutes % 60 === 0
          ? minutes / 60 + " ч."
          : minutes + " мин.";
function Windows({ group }: { group: Group }) {
  return (
    <>
      {group.windows.map((w) => (
        <div className="usage-window" key={w.minutes}>
          <div>
            <span>{label(w.minutes)}</span>
            <strong>{w.remainingPercent}% осталось</strong>
          </div>
          <progress
            max={100}
            value={w.remainingPercent}
            aria-label={
              group.name + ": " + label(w.minutes) + ", осталось " + w.remainingPercent + "%"
            }
          />
          {w.resetsAt !== null && (
            <small className="muted">
              Обновление{" "}
              {new Date(w.resetsAt * 1000).toLocaleString("ru", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          )}
        </div>
      ))}
    </>
  );
}
function Usage({ machine, open }: { machine: Machine; open: boolean }) {
  const [groups, setGroups] = useState<Group[]>([]),
    [message, setMessage] = useState("Загружаю лимиты…");
  useEffect(() => {
    if (!open) return;
    let disposed = false,
      pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const data = await api<{ available: boolean; groups: Group[] }>(
          `/machines/${encodeURIComponent(machine.id)}/limits`,
          { signal: controller.signal },
        );
        if (!disposed) {
          setGroups(data.groups);
          setMessage(data.available ? "" : "Данные пока недоступны.");
        }
      } catch (e) {
        if (!disposed) setMessage(messageOf(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [machine.id, open]);
  return (
    <section className="usage-limits" aria-label={"Лимиты Codex: " + machine.name}>
      <div className="usage-heading">
        <strong>Лимиты Codex</strong>
        <span className="muted">{machine.name}</span>
      </div>
      {message && (
        <p className="small muted" role="status">
          {message}
        </p>
      )}
      {groups.map((group, i) =>
        i === 0 ? (
          <div key={group.id}>
            {group.id !== "codex" && <strong>{group.name}</strong>}
            <Windows group={group} />
          </div>
        ) : (
          <details key={group.id}>
            <summary>{group.name}</summary>
            <Windows group={group} />
          </details>
        ),
      )}
    </section>
  );
}
export function UsageLimits({ machines, open }: { machines: Machine[]; open: boolean }) {
  return (
    <>
      {machines.map((machine) => (
        <Usage key={machine.id} machine={machine} open={open} />
      ))}
    </>
  );
}
