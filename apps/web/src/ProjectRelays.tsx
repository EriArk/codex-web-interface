import type {
  NotebookLink,
  ProjectLink,
  ProjectPlan,
  ProjectRelay,
  RelayPage,
  RelayState,
} from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import type { NotebookRequest } from "./Notebook";
import "./project-relays.css";

const labels: Record<RelayState, string> = {
  proposed: "Готово к отправке",
  waiting: "Ожидает доставки",
  running: "Обмен идёт",
  unknown: "Отправка не подтверждена",
  needs_owner: "Нужно твоё решение",
  resolved: "Вопрос решён",
  limit: "Достигнут лимит",
  stopped: "Остановлено",
  failed: "Ответ не завершён",
};
export function ProjectRelays({
  projectId,
  onTarget,
  onNotebook,
}: {
  projectId: string;
  onTarget: (target: NotebookLink) => void;
  onNotebook: (request: NotebookRequest) => void;
}) {
  const draftKey = "codexweb-relay-draft:" + projectId;
  const [saved] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const [page, setPage] = useState<RelayPage | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [adding, setAdding] = useState(false),
    [target, setTarget] = useState(""),
    [request, setRequest] = useState<string>(
      typeof saved.request === "string" ? saved.request : "",
    );
  const [title, setTitle] = useState<string>(typeof saved.title === "string" ? saved.title : ""),
    [question, setQuestion] = useState<string>(
      typeof saved.question === "string" ? saved.question : "",
    ),
    [kind, setKind] = useState<"consult" | "work">(saved.kind === "work" ? "work" : "consult"),
    [filter, setFilter] = useState("all"),
    [offset, setOffset] = useState(0);
  const alive = useRef(true),
    sendId = useRef<string | null>(typeof saved.id === "string" ? saved.id : null);
  const actionKeys = useRef(new Map<string, string>());
  const actionKey = (id: string, revision: number, action: string, extra?: number) => {
    const signature = JSON.stringify([id, revision, action, extra]);
    if (!actionKeys.current.has(signature)) actionKeys.current.set(signature, crypto.randomUUID());
    return actionKeys.current.get(signature)!;
  };
  const remember = () => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ request, title, question, kind, id: sendId.current }),
      );
    } catch {}
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Save only this project's edited request fields.
  useEffect(() => {
    remember();
  }, [request, title, question, kind]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const value = await api<RelayPage>(
      `/workspace/relays?projectId=${encodeURIComponent(projectId)}&offset=${offset}`,
    );
    if (alive.current) setPage(value);
  }, [projectId, offset]);
  useEffect(() => {
    void refresh().catch((e) => setError(messageOf(e)));
    const timer = setInterval(() => {
      if (!document.hidden) void refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const mutate = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const name = (id: string) =>
    page?.projects.find((p) => p.id === id)?.name ?? (id === projectId ? "Этот проект" : id);
  return (
    <section className="overview-card project-relays" aria-label="Связанные проекты">
      <header>
        <h2>Связанные проекты</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Связать проект"
          onClick={() => setAdding(!adding)}
        >
          <Icon name="plus" />
        </button>
      </header>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!page && (
        <p role="status">
          <span className="spinner" /> Загружаем связи…
        </p>
      )}
      {adding && (
        <form
          className="relay-form"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate(async () => {
              await api(`/workspace/project-links/${crypto.randomUUID()}`, {
                method: "PUT",
                body: { sourceId: projectId, targetId: target, revision: 0 },
              });
              setAdding(false);
              setTarget("");
            });
          }}
        >
          <label>
            Проект
            <select required value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Выбрать…</option>
              {page?.projects
                .filter((p) => !page.links.some((l) => l.sourceId === p.id || l.targetId === p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" className="secondary" disabled={busy || !target}>
            Связать
          </button>
        </form>
      )}
      {page?.links.map((link) => (
        <LinkCard
          key={`${link.id}:${link.revision}`}
          link={link}
          name={name(link.sourceId === projectId ? link.targetId : link.sourceId)}
          disabled={busy}
          save={(body) =>
            mutate(() => api(`/workspace/project-links/${link.id}`, { method: "PUT", body }))
          }
          request={() => {
            setRequest(link.id);
            sendId.current = null;
          }}
          canRequest={link.enabled && (link.sourceId === projectId || link.bidirectional)}
        />
      ))}
      {!!page?.links.length &&
        page.currents
          .filter((c) => !c.explicit && c.threadId)
          .map((c) => (
            <div className="relay-current" key={c.projectId}>
              <small>{name(c.projectId)}</small>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    api("/workspace/relays/current", {
                      method: "POST",
                      body: {
                        projectId: c.projectId,
                        threadId: c.threadId,
                        revision: c.revision,
                        confirm: true,
                      },
                    }),
                  )
                }
              >
                Рабочий чат: {c.title} <Icon name="check" size={14} />
              </button>
            </div>
          ))}
      {page && !page.links.length && !adding && (
        <p className="muted">Свяжи проекты, между которыми нужно передавать вопросы.</p>
      )}
      {request && (
        <form
          className="relay-form"
          aria-label="Новый запрос"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate(async () => {
              sendId.current ??= crypto.randomUUID();
              remember();
              await api(`/workspace/relays/${sendId.current}`, {
                method: "PUT",
                body: { linkId: request, sourceId: projectId, title, question, kind },
              });
              setRequest("");
              setQuestion("");
              setTitle("");
              sendId.current = null;
            });
          }}
        >
          <label>
            Тема
            <input
              required
              maxLength={160}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                sendId.current = null;
              }}
            />
          </label>
          <label>
            Запрос
            <textarea
              required
              rows={4}
              maxLength={12000}
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                sendId.current = null;
              }}
            />
          </label>
          <label>
            Тип
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as "consult" | "work");
                sendId.current = null;
              }}
            >
              <option value="consult">Консультация</option>
              <option value="work">Предложить работу</option>
            </select>
          </label>
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => setRequest("")}>
              Отмена
            </button>
            <button type="submit" className="primary" disabled={busy}>
              Отправить
            </button>
          </div>
        </form>
      )}
      {!!page?.items.length && (
        <>
          <div className="relay-filters">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              Все
            </button>
            <button type="button" aria-pressed={filter === "out"} onClick={() => setFilter("out")}>
              Исходящие
            </button>
            <button type="button" aria-pressed={filter === "in"} onClick={() => setFilter("in")}>
              Входящие
            </button>
          </div>
          {page.items
            .filter(
              (r) =>
                filter === "all" ||
                (filter === "out" ? r.sourceId === projectId : r.targetId === projectId),
            )
            .map((relay) => (
              <RelayCard
                key={relay.id}
                relay={relay}
                counterpart={name(relay.sourceId === projectId ? relay.targetId : relay.sourceId)}
                disabled={busy}
                onTarget={onTarget}
                action={(action, extra) =>
                  mutate(() =>
                    api(`/workspace/relays/${relay.id}/action`, {
                      method: "POST",
                      key: actionKey(relay.id, relay.revision, action, extra),
                      body: { revision: relay.revision, action, extra },
                    }),
                  )
                }
                plan={() =>
                  mutate(async () => {
                    const p = await api<ProjectPlan>(`/workspace/relays/${relay.id}/plan`, {
                      method: "POST",
                      body: { confirm: true },
                    });
                    onNotebook({ scope: p.scope, mode: "plans", itemId: p.id });
                  })
                }
              />
            ))}
        </>
      )}
      {(offset > 0 || page?.nextOffset !== null) && page && (
        <div className="button-row">
          <button
            type="button"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Назад
          </button>
          <button
            type="button"
            disabled={page.nextOffset === null}
            onClick={() => setOffset(page.nextOffset ?? offset)}
          >
            Далее
          </button>
        </div>
      )}
    </section>
  );
}
function LinkCard({
  link,
  name,
  disabled,
  save,
  request,
  canRequest,
}: {
  link: ProjectLink;
  name: string;
  disabled: boolean;
  save: (body: unknown) => Promise<void>;
  request: () => void;
  canRequest: boolean;
}) {
  const [depth, setDepth] = useState(link.depth),
    [auto, setAuto] = useState(link.autoConsult),
    [enabled, setEnabled] = useState(link.enabled),
    [both, setBoth] = useState(link.bidirectional);
  return (
    <div className="relay-link">
      <strong>{name}</strong>
      <span className="muted">
        {link.enabled
          ? `${link.bidirectional ? "↔" : "→"} ${link.depth} раунд${link.depth === 1 ? "" : link.depth < 5 ? "а" : "ов"}`
          : "Связь отключена"}
      </span>
      <details>
        <summary>Настроить</summary>
        <form
          className="relay-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save({
              sourceId: link.sourceId,
              targetId: link.targetId,
              label: link.label,
              revision: link.revision,
              depth,
              autoConsult: auto,
              enabled,
              bidirectional: both,
            });
          }}
        >
          <label>
            Глубина обмена <strong>{depth}</strong>
            <input
              aria-label={`Глубина обмена: ${name}`}
              type="range"
              min="1"
              max="10"
              step="1"
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            />
          </label>
          <label className="relay-check">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Автоматически передавать консультации
          </label>
          <label className="relay-check">
            <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />В
            обе стороны
          </label>
          <label className="relay-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Связь включена
          </label>
          <button type="submit" className="secondary" disabled={disabled}>
            Сохранить
          </button>
        </form>
      </details>
      <button
        type="button"
        className="secondary"
        disabled={disabled || !canRequest}
        onClick={request}
      >
        Новый запрос
      </button>
    </div>
  );
}
function RelayCard({
  relay,
  counterpart,
  disabled,
  action,
  plan,
  onTarget,
}: {
  relay: ProjectRelay;
  counterpart: string;
  disabled: boolean;
  action: (action: "send" | "stop" | "continue", extra?: number) => Promise<void>;
  plan: () => Promise<void>;
  onTarget: (target: NotebookLink) => void;
}) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<ProjectRelay | null>(null),
    [error, setError] = useState("");
  const [extra, setExtra] = useState(1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revalidate the opened detail when its server revision changes.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<ProjectRelay>(`/workspace/relays/${relay.id}`, { signal: controller.signal })
      .then(setDetail)
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [open, relay.id, relay.revision]);
  const t = detail ?? relay;
  return (
    <details className="relay-entry" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span>
          <strong>{relay.title}</strong>
          <small>
            {counterpart} · {labels[relay.state]} · {relay.consumed}/{relay.limit}
          </small>
        </span>
        {relay.state === "running" && <span className="spinner" />}
        {relay.state === "resolved" && <Icon name="check" />}
      </summary>
      {relay.reason && <p className="muted">{relay.reason}</p>}
      {error && <p role="alert">{error}</p>}
      <p className="relay-text">{t.question}</p>
      {t.steps.map((step) => (
        <div className="relay-step" key={step.id}>
          <small>
            Раунд {step.round} ·{" "}
            {step.phase === "question" ? "Запрос" : step.phase === "terminal" ? "Итог" : "Ответ"}
          </small>
          <p className="relay-text">
            {step.decision?.summary ?? step.answer ?? labels[relay.state]}
          </p>
          {step.threadId && (
            <button
              type="button"
              onClick={() =>
                onTarget({
                  client: "codex",
                  kind: "thread",
                  id: step.threadId!,
                  threadId: step.threadId,
                  turnId: step.turnId,
                  messageId: step.messageId,
                  projectId: step.projectId,
                  title: relay.title,
                  availability: "available",
                })
              }
            >
              К сообщению <Icon name="chevron" size={14} />
            </button>
          )}
        </div>
      ))}
      <div className="button-row">
        {relay.state === "proposed" && (
          <button type="button" disabled={disabled} onClick={() => void action("send")}>
            Передать
          </button>
        )}
        {["proposed", "waiting", "running", "unknown", "needs_owner"].includes(relay.state) && (
          <button type="button" disabled={disabled} onClick={() => void action("stop")}>
            Остановить обмен
          </button>
        )}
        {(relay.kind === "work" || relay.state === "needs_owner" || relay.planId) && (
          <button type="button" disabled={disabled} onClick={() => void plan()}>
            {relay.planId ? "Открыть план" : "Подготовить план"}
          </button>
        )}
      </div>
      {["limit", "needs_owner"].includes(relay.state) && t.steps.at(-1)?.decision?.question && (
        <div className="relay-form">
          <label>
            Дополнительные раунды: {extra}
            <input
              aria-label="Дополнительные раунды"
              type="range"
              min="1"
              max="10"
              value={extra}
              onChange={(e) => setExtra(Number(e.target.value))}
            />
          </label>
          <button type="button" disabled={disabled} onClick={() => void action("continue", extra)}>
            Продолжить обмен
          </button>
        </div>
      )}
    </details>
  );
}
