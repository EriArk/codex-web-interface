import type { UsageGroup as Group, UsageLimitsData } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import type { Machine } from "./types";
import { UsageResetCredits } from "./UsageResetCredits";
import "./usageLimits.css";

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
  const [data, setData] = useState<UsageLimitsData>({
      available: false,
      groups: [],
      resetCredits: null,
      checkedAt: "",
    }),
    [message, setMessage] = useState("Загружаю лимиты…");
  const active = useRef(false),
    sequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!active.current || document.visibilityState === "hidden") return;
    const request = ++sequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    try {
      const value = await api<UsageLimitsData>(
        `/machines/${encodeURIComponent(machine.id)}/limits`,
        { signal: controller.signal },
      );
      if (active.current && request === sequence.current) {
        setData(value);
        setMessage(value.available ? "" : "Данные пока недоступны.");
      }
    } catch (e) {
      if (active.current && request === sequence.current) setMessage(messageOf(e));
    }
  }, [machine.id]);
  useEffect(() => {
    active.current = open;
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    const changed = () => void refresh();
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("codex-usage-changed", changed);
    return () => {
      active.current = false;
      sequence.current++;
      readController.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("codex-usage-changed", changed);
    };
  }, [refresh, open]);
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
      {data.groups.map((group, i) =>
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
      {open && <UsageResetCredits machineId={machine.id} data={data} refresh={refresh} />}
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
