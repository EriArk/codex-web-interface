import type {
  DeliveryInput,
  DeliveryObservation,
  DeliveryOperation,
  NotebookLink,
  ProjectAction,
  ProjectDiff,
} from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { ProjectActionPanel } from "./ProjectAction";
import type { DeliveryRequest } from "./ProjectDeliveryHost";
import { openWorkReview } from "./WorkReviewLink";
import "./project-delivery.css";

const labels = {
  prepared: "Проверь перед запуском",
  running: "Выполняется",
  completed: "Готово",
  failed: "Не выполнено",
  unknown: "Нужно проверить",
};
const names = { commit: "Коммит", push: "Push", pr: "Pull request" };
const checks = {
  passed: "Успешно",
  failed: "Ошибка",
  pending: "В процессе",
  cancelled: "Отменено",
  skipped: "Пропущено",
};
type Draft = {
  paths: string[];
  message: string;
  title: string;
  body: string;
  pending?: { id: string; input: DeliveryInput };
  operationId?: string;
};
const empty: Draft = { paths: [], message: "", title: "", body: "" };
const load = (key: string): Draft => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      v &&
      Array.isArray(v.paths) &&
      v.paths.every((p: unknown) => typeof p === "string") &&
      [v.message, v.title, v.body].every((t) => typeof t === "string") &&
      JSON.stringify(v).length < 120000
    )
      return v;
  } catch {}
  return empty;
};
const short = (s: string | null | undefined) => s?.slice(0, 9) ?? "—";
export default function ProjectDelivery({
  request,
  onClose,
  onOpen,
}: {
  request: DeliveryRequest;
  onClose: () => void;
  onOpen: (t: NotebookLink) => void;
}) {
  const key = "delivery-draft:" + request.projectId,
    base = "/projects/" + encodeURIComponent(request.projectId) + "/delivery";
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    serial = useRef(0),
    busyRef = useRef(false),
    ciKey = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState(() => load(key)),
    [observation, setObservation] = useState<DeliveryObservation | null>(null),
    [ops, setOps] = useState<DeliveryOperation[]>([]),
    [op, setOp] = useState<DeliveryOperation | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [diff, setDiff] = useState<ProjectDiff | null>(null),
    [action, setAction] = useState<ProjectAction | null>(null);
  const persist = (v: Draft) => {
    setDraft(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {}
  };
  const refresh = useCallback(async () => {
    const n = ++serial.current;
    const [s, list] = await Promise.all([
      api<DeliveryObservation>(base, { timeoutMs: 180000 }),
      api<{ items: DeliveryOperation[] }>(base + "/operations"),
    ]);
    if (alive.current && n === serial.current) {
      setObservation(s);
      ciKey.current = undefined;
      setOps(list.items);
      setLoading(false);
    }
  }, [base]);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    void refresh().catch((e) => {
      if (alive.current) {
        setError(messageOf(e));
        setLoading(false);
      }
    });
    const saved = load(key);
    if (saved.operationId)
      void api<DeliveryOperation>(base + "/" + saved.operationId)
        .then((v) => {
          if (alive.current) setOp(v);
        })
        .catch(() => {});
    return () => {
      alive.current = false;
      serial.current++;
      dialog.current?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [base, key, refresh]);
  const operationId = op?.id,
    operationState = op?.state;
  useEffect(() => {
    if (!operationId || !operationState || !["running", "unknown"].includes(operationState)) return;
    let pending = false,
      live = true;
    const check = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const v = await api<DeliveryOperation>(base + "/" + operationId, { timeoutMs: 180000 });
        if (live) {
          setOp(v);
          if (v.state === "completed") void refresh().catch(() => {});
        }
      } catch {
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(check, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [base, operationId, operationState, refresh]);
  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const prepare = (kind: DeliveryInput["kind"]) =>
    run(async () => {
      const pending = draft.pending ?? {
        id: crypto.randomUUID(),
        input: {
          kind,
          paths:
            kind === "commit"
              ? draft.paths.filter((p) => observation?.state.paths.some((file) => file.path === p))
              : [],
          message: kind === "commit" ? draft.message : "",
          title: kind === "pr" ? draft.title : "",
          body: kind === "pr" ? draft.body : "",
          ...(request.reviewId ? { reviewId: request.reviewId } : {}),
        },
      };
      persist({ ...draft, pending });
      const value = await api<DeliveryOperation>(base + "/" + pending.id, {
        method: "PUT",
        body: pending.input,
        timeoutMs: 180000,
      });
      if (alive.current) {
        setOp(value);
        persist({ ...draft, pending: undefined, operationId: value.id });
      }
    });
  const execute = () =>
    run(async () => {
      if (!op) return;
      const v = await api<DeliveryOperation>(base + "/" + op.id + "/execute", {
        method: "POST",
        body: { confirm: true, fingerprint: op.fingerprint },
      });
      if (alive.current) {
        setOp(v);
        if (v.state === "completed") await refresh();
      }
    });
  const verify = () =>
    run(async () => {
      if (!op) return;
      const v = await api<DeliveryOperation>(base + "/" + op.id, { timeoutMs: 180000 });
      if (alive.current) {
        setOp(v);
        await refresh();
      }
    });
  const reset = () => {
    setOp(null);
    persist({
      ...draft,
      paths:
        op?.state === "completed" && op.kind === "commit"
          ? draft.paths.filter((p) => !op.input.paths.includes(p))
          : draft.paths,
      pending: undefined,
      operationId: undefined,
    });
  };
  const inspect = (path: string, staged: boolean) =>
    run(async () => {
      const value = await api<ProjectDiff>(
        `/projects/${encodeURIComponent(request.projectId)}/git/diff?path=${encodeURIComponent(path)}&staged=${staged ? 1 : 0}`,
      );
      if (alive.current) setDiff(value);
    });
  const fix = () =>
    run(async () => {
      if (!observation) return;
      ciKey.current ??= crypto.randomUUID();
      const value = await api<ProjectAction>("/workspace/actions/" + ciKey.current, {
        method: "PUT",
        body: {
          scope: { client: "codex", projectId: request.projectId, name: request.projectName },
          kind: "ci_fix",
          observationId: observation.id,
        },
      });
      if (alive.current) setAction(value);
    });
  const state = observation?.state,
    g = state?.github,
    locked = busy || !!draft.pending;
  const review = (id: string) => {
    onClose();
    openWorkReview(
      { client: "codex", projectId: request.projectId, name: request.projectName },
      id,
    );
  };
  return (
    <dialog
      ref={dialog}
      className="delivery-dialog"
      aria-label="Доставка проекта"
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <small>{request.projectName}</small>
          <h2>
            <Icon name="branch" size={21} />
            Доставка
          </h2>
        </div>
        <div>
          <button
            type="button"
            className="icon-button"
            disabled={busy || loading}
            aria-label="Обновить доставку"
            onClick={() => void run(refresh)}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть доставку"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="delivery-scroll">
        {error && (
          <p className="delivery-error" role="alert">
            {error}
          </p>
        )}
        {loading && (
          <p role="status">
            <span className="spinner" aria-hidden="true" />
            Проверяем Git и GitHub…
          </p>
        )}
        {state && !state.repository && <p>В папке проекта нет Git-репозитория.</p>}
        {state?.repository && (
          <>
            <section className="delivery-summary">
              <div>
                <strong>{state.branch ?? "Detached HEAD"}</strong>
                <span>{g?.repository ?? "Локальный репозиторий"}</span>
              </div>
              <div className="delivery-sha">
                <code>{short(state.head)}</code>
                {state.head && <CopyButton text={state.head} label="Копировать HEAD" />}
              </div>
              <dl>
                <div>
                  <dt>Изменено</dt>
                  <dd>{state.changed}</dd>
                </div>
                <div>
                  <dt>В индексе</dt>
                  <dd>{state.staged}</dd>
                </div>
                <div>
                  <dt>Новых</dt>
                  <dd>{state.untracked}</dd>
                </div>
                <div>
                  <dt>Впереди / позади</dt>
                  <dd>
                    {state.ahead ?? "—"} / {state.behind ?? "—"}
                  </dd>
                </div>
              </dl>
              <small>
                {state.upstream ?? "Upstream не задан"} ·{" "}
                {new Date(state.checkedAt).toLocaleString("ru")}
              </small>
            </section>
            <div className="delivery-columns">
              <div className="delivery-main">
                {op ? (
                  <section className="delivery-card delivery-operation" data-state={op.state}>
                    <header>
                      <h3>{names[op.kind]}</h3>
                      <span role="status">{labels[op.state]}</span>
                    </header>
                    <p>
                      <strong>{op.snapshot.branch}</strong> · {short(op.snapshot.head)}
                    </p>
                    {op.kind === "commit" ? (
                      <>
                        <p>{op.input.message}</p>
                        <details>
                          <summary>Файлы · {op.input.paths.length}</summary>
                          <ul>
                            {op.input.paths.map((p) => (
                              <li key={p}>{p}</li>
                            ))}
                          </ul>
                        </details>
                      </>
                    ) : (
                      <p>
                        {op.snapshot.github.repository} · {op.snapshot.branch}
                        {op.kind === "pr" ? " → " + op.snapshot.github.defaultBranch : ""}
                      </p>
                    )}
                    {op.kind === "pr" && (
                      <>
                        <h4>{op.input.title}</h4>
                        <CollapsibleCode label="Описание PR">{op.input.body}</CollapsibleCode>
                      </>
                    )}
                    {op.commit && (
                      <div className="delivery-sha">
                        <code>{short(op.commit)}</code>
                        <CopyButton text={op.commit} label="Копировать коммит" />
                      </div>
                    )}
                    {op.pr && (
                      <a href={op.pr.url} target="_blank" rel="noreferrer">
                        Открыть PR #{op.pr.number}
                      </a>
                    )}
                    {op.error && <p role="alert">{op.error}</p>}
                    {op.input.reviewId && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => review(op.input.reviewId!)}
                      >
                        К приёмке работы
                      </button>
                    )}
                    <div className="delivery-actions">
                      {op.state === "prepared" && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => void execute()}
                        >
                          Подтвердить{" "}
                          {op.kind === "commit"
                            ? "коммит"
                            : op.kind === "push"
                              ? "push"
                              : "создание PR"}
                        </button>
                      )}
                      {["running", "unknown"].includes(op.state) && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => void verify()}
                        >
                          Проверить состояние
                        </button>
                      )}
                      {["prepared", "failed", "completed"].includes(op.state) && (
                        <button type="button" className="secondary" disabled={busy} onClick={reset}>
                          {op.state === "prepared" ? "Назад" : "Продолжить"}
                        </button>
                      )}
                    </div>
                  </section>
                ) : (
                  <>
                    <section className="delivery-card">
                      <header>
                        <h3>Коммит</h3>
                        <small>Рабочее содержимое выбранных файлов</small>
                      </header>
                      <div className="delivery-paths">
                        {state.paths.length ? (
                          state.paths.map((p) => (
                            <div className="delivery-path" key={p.path}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={draft.paths.includes(p.path)}
                                  disabled={locked}
                                  onChange={(e) =>
                                    persist({
                                      ...draft,
                                      paths: e.target.checked
                                        ? [...draft.paths, p.path]
                                        : draft.paths.filter((x) => x !== p.path),
                                    })
                                  }
                                />
                                <span>
                                  {p.path}
                                  <small>
                                    {p.index}
                                    {p.working} · {Math.ceil(p.size / 1024)} КБ
                                  </small>
                                </span>
                              </label>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={"Посмотреть изменения " + p.path}
                                disabled={busy}
                                onClick={() => void inspect(p.path, false)}
                              >
                                <Icon name="file" size={17} />
                              </button>
                              {p.index !== " " && p.index !== "?" && (
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={"Посмотреть индекс " + p.path}
                                  disabled={busy}
                                  onClick={() => void inspect(p.path, true)}
                                >
                                  <Icon name="branch" size={17} />
                                </button>
                              )}
                            </div>
                          ))
                        ) : (
                          <p>Нет доступных изменений.</p>
                        )}
                      </div>
                      {state.hidden > 0 && (
                        <small>
                          Недоступно для выбора: {state.hidden}. Крупные файлы, ссылки и закрытые
                          служебные пути.
                        </small>
                      )}
                      {diff && (
                        <div className="delivery-diff">
                          <strong>
                            {diff.path}
                            {diff.staged ? " · индекс" : " · рабочие файлы"}
                          </strong>
                          <CollapsibleCode label="Изменения">
                            {diff.text || "Нет текстовой разницы."}
                          </CollapsibleCode>
                          {diff.truncated && <small>Показана часть изменений.</small>}
                        </div>
                      )}
                      <label className="delivery-field">
                        Сообщение коммита
                        <input
                          value={draft.message}
                          maxLength={2000}
                          disabled={locked}
                          onChange={(e) => persist({ ...draft, message: e.target.value })}
                        />
                      </label>
                      <details className="delivery-caption">
                        <summary>Как сохраняется коммит</summary>
                        <p>
                          Выбранные файлы сохраняются из рабочей папки. Остальные изменения в
                          индексе остаются. Настройка подписи Git учитывается; локальные commit
                          hooks не запускаются.
                        </p>
                      </details>
                      <button
                        type="button"
                        className="primary"
                        disabled={
                          locked ||
                          !draft.paths.some((p) => state.paths.some((file) => file.path === p)) ||
                          !draft.message.trim() ||
                          !state.branch
                        }
                        onClick={() => void prepare("commit")}
                      >
                        Просмотреть коммит
                      </button>
                    </section>
                    <section className="delivery-card">
                      <header>
                        <h3>Отправить ветку</h3>
                        <small>{g?.repository ?? "Origin GitHub не найден"}</small>
                      </header>
                      <p>
                        {state.branch} · {short(state.head)}
                      </p>
                      <button
                        type="button"
                        className="secondary"
                        disabled={locked || g?.state !== "ok" || !state.head || !state.branch}
                        onClick={() => void prepare("push")}
                      >
                        Просмотреть push
                      </button>
                    </section>
                    {!g?.pr && (
                      <section className="delivery-card">
                        <header>
                          <h3>Pull request</h3>
                          <small>
                            {state.branch} → {g?.defaultBranch ?? "—"}
                          </small>
                        </header>
                        <label className="delivery-field">
                          Название
                          <input
                            value={draft.title}
                            maxLength={200}
                            disabled={locked}
                            onChange={(e) => persist({ ...draft, title: e.target.value })}
                          />
                        </label>
                        <label className="delivery-field">
                          Описание
                          <textarea
                            rows={4}
                            value={draft.body}
                            maxLength={20000}
                            disabled={locked}
                            onChange={(e) => persist({ ...draft, body: e.target.value })}
                          />
                        </label>
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            locked ||
                            !draft.title.trim() ||
                            g?.state !== "ok" ||
                            !state.head ||
                            g.remoteHead !== state.head ||
                            state.branch === g.defaultBranch
                          }
                          onClick={() => void prepare("pr")}
                        >
                          Просмотреть PR
                        </button>
                      </section>
                    )}
                  </>
                )}
                {draft.pending && !op && (
                  <section className="delivery-card">
                    <p>Подготовка не подтверждена. Текст и выбор сохранены.</p>
                    <div className="delivery-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void prepare(draft.pending!.input.kind)}
                      >
                        Проверить подготовку
                      </button>
                      <button type="button" className="secondary" disabled={busy} onClick={reset}>
                        Изменить
                      </button>
                    </div>
                  </section>
                )}
                {action && (
                  <ProjectActionPanel
                    initial={action}
                    onChange={setAction}
                    onOpen={onOpen}
                    onClose={() => setAction(null)}
                  />
                )}
              </div>
              <aside className="delivery-side">
                <section className="delivery-card">
                  <header>
                    <h3>GitHub / CI</h3>
                    {g?.checksSha && <code>{short(g.checksSha)}</code>}
                  </header>
                  {g?.state === "unavailable" ? (
                    <p>GitHub пока недоступен.</p>
                  ) : g?.state === "no-remote" ? (
                    <p>GitHub origin не подключён.</p>
                  ) : (
                    <>
                      {g?.pr ? (
                        <>
                          <a href={g.pr.url} target="_blank" rel="noreferrer">
                            PR #{g.pr.number} · {g.pr.title}
                          </a>
                          <p>
                            {g.pr.mergeable === true
                              ? "Готов к слиянию"
                              : g.pr.mergeable === false
                                ? "Есть конфликт слияния"
                                : "Совместимость веток ещё не подтверждена"}
                          </p>
                        </>
                      ) : (
                        <p>Открытого PR для этой ветки нет.</p>
                      )}
                      {g?.checksKnown ? (
                        g.checks.length ? (
                          <ul className="delivery-checks">
                            {g.checks.map((c) => (
                              <li key={c.name + ":" + (c.url ?? "")} data-state={c.state}>
                                {c.state === "pending" ? (
                                  <span className="spinner" aria-hidden="true" />
                                ) : (
                                  <Icon
                                    name={
                                      c.state === "passed"
                                        ? "check"
                                        : c.state === "skipped"
                                          ? "minus"
                                          : "help"
                                    }
                                    size={16}
                                  />
                                )}
                                <span>
                                  {c.url ? (
                                    <a href={c.url} target="_blank" rel="noreferrer">
                                      {c.name}
                                    </a>
                                  ) : (
                                    c.name
                                  )}
                                  <small>{checks[c.state]}</small>
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>Для этого коммита проверок нет.</p>
                        )
                      ) : (
                        <p>Проверки пока не получены.</p>
                      )}
                      {g?.checksKnown &&
                        g.checks.some((c) => ["failed", "cancelled"].includes(c.state)) && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void fix()}
                          >
                            Попросить Codex исправить CI
                          </button>
                        )}
                    </>
                  )}
                </section>
                {request.reviewId && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => review(request.reviewId!)}
                  >
                    К приёмке работы
                  </button>
                )}
                {!!ops.length && (
                  <details className="delivery-card">
                    <summary>Последние операции · {ops.length}</summary>
                    <div className="delivery-history">
                      {ops.map((v) => (
                        <button
                          type="button"
                          key={v.id}
                          disabled={busy}
                          onClick={() => {
                            setOp(v);
                            persist({ ...draft, operationId: v.id, pending: undefined });
                          }}
                        >
                          <span>
                            {names[v.kind]} · {short(v.commit ?? v.snapshot.head)}
                          </span>
                          <small>
                            {labels[v.state]} · {new Date(v.createdAt).toLocaleString("ru")}
                          </small>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
