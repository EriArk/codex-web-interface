import type {
  GitHubIdentity,
  GitHubWorkInput,
  GitHubWorkObservation,
  GitHubWorkQuery,
  GitHubWorkRecord,
  SharedItem,
  SharedProjectDetail,
  TeamGitHubLink,
  TeamGitHubOperation,
  TeamGitHubPrepare,
  TeamGitHubSource,
} from "@codex-web/shared";
import { githubWorkInputSchema } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api } from "./api";
import { CopyButton } from "./CopyButton";
import { SharedMarkdown as Markdown } from "./SharedMaterialEditor";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";
import { openSharedProjects } from "./TeamProjectsHost";

type Observed = { id: string; value: GitHubWorkObservation };
type GitHubPage = {
  items: TeamGitHubLink[];
  nextOffset: number | null;
  operations: TeamGitHubOperation[];
  accounts: { userId: string; name: string; identity: GitHubIdentity; checkedAt: number }[];
};
type Draft = {
  kind: GitHubWorkInput["kind"];
  title: string;
  body: string;
  memberId: string;
  login: string;
  permission: "pull" | "push";
  number: number;
  type: "issue" | "pr";
  state: "open" | "closed";
  source?: TeamGitHubSource;
  pending?: { id: string; request: TeamGitHubPrepare };
};
const empty = (): Draft => ({
  kind: "issue-create",
  title: "",
  body: "",
  memberId: "",
  login: "",
  permission: "pull",
  number: 1,
  type: "issue",
  state: "closed",
});
const names = {
  "issue-create": "Новый issue",
  comment: "Комментарий",
  "issue-state": "Состояние issue",
  invite: "Пригласить в репозиторий",
  remove: "Отозвать доступ к репозиторию",
  "request-review": "Запросить ревью PR",
};
const states = {
  preparing: "Подготовка",
  prepared: "Готово к подтверждению",
  running: "Отправляется",
  unknown: "Исход пока неизвестен",
  completed: "Выполнено",
  failed: "Не выполнено",
};
const accessNames = {
  admin: "Администратор",
  maintain: "Сопровождение",
  write: "Запись",
  triage: "Разбор issues",
  read: "Чтение",
  unavailable: "Репозиторий недоступен",
};

export function TeamGitHubPanel({
  detail,
  source,
  refresh,
}: {
  detail: SharedProjectDetail;
  source?: TeamGitHubSource;
  refresh: () => void;
}) {
  const base = `/team/projects/${detail.project.id}/github`,
    draftKey = "workspace-github-draft:" + detail.project.id;
  const [revision, revise] = useState(0),
    [offset, setOffset] = useState(0);
  const page = useSharedResource<GitHubPage>(base + "?offset=" + offset, revision);
  const [observed, setObserved] = useState<Observed>(),
    [mode, setMode] = useState<"issue" | "pr" | "collaborators">("issue"),
    [query, setQuery] = useState(""),
    [state, setState] = useState<"open" | "closed" | "all">("open");
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      return JSON.parse(storage.getItem(draftKey) ?? "null") ?? empty();
    } catch {
      return empty();
    }
  });
  const [showDraft, setShowDraft] = useState(!!draft.pending || !!draft.body),
    [operation, setOperation] = useState<TeamGitHubOperation>();
  const a = useSharedAction(),
    write = detail.project.role !== "viewer" && !detail.project.archived && !!detail.checkout;
  const update = () => {
    revise((n) => n + 1);
    refresh();
  };
  const change = (v: Draft) => {
    try {
      storage.setItem(draftKey, JSON.stringify(v));
      setDraft(v);
      return true;
    } catch {
      a.setError("Не удалось сохранить черновик на устройстве.");
      return false;
    }
  };
  useEffect(() => {
    if (!draft.pending) return;
    const controller = new AbortController();
    void api<TeamGitHubOperation>(base + "/operations/" + draft.pending.id, {
      signal: controller.signal,
    })
      .then((v) => {
        if (!controller.signal.aborted) setOperation(v);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [base, draft.pending]);
  const observe = (q: GitHubWorkQuery) =>
    void a
      .run(() => api<Observed>(base + "/observe", { method: "POST", body: q }))
      .then((v) => {
        if (v) setObserved(v);
      });
  const start = (value: Partial<Draft>) => {
    if (draft.pending) {
      setShowDraft(true);
      a.setError("Сначала заверши или отмени уже подготовленное действие.");
      return;
    }
    if (change({ ...draft, ...value })) {
      setOperation(undefined);
      setShowDraft(true);
    }
  };
  const pickSource = () => {
    if (!source) return;
    if (draft.pending || draft.body.trim()) {
      a.setError("В редакторе уже есть текст. Сохрани его перед переносом другого материала.");
      setShowDraft(true);
      return;
    }
    void a
      .run(() =>
        api<{ title: string; text: string; truncated: boolean }>(base + "/source", {
          method: "POST",
          body: source,
        }),
      )
      .then((v) => {
        if (v)
          start({
            kind: "issue-create",
            source,
            title: v.title.slice(0, 200),
            body:
              v.text.slice(0, 15950) +
              (v.truncated || v.text.length > 15950 ? "\n[Материал сокращён.]" : ""),
          });
      });
  };
  const requestOperation = async (id: string, method: string, suffix: string, body: unknown) => {
    try {
      return await api<TeamGitHubOperation>(`${base}/operations/${id}${suffix}`, { method, body });
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 0 || error.status >= 500 || error.status === 408)
      ) {
        try {
          return await api<TeamGitHubOperation>(`${base}/operations/${id}`);
        } catch {}
      }
      throw error;
    }
  };
  const action = (id: string, kind: "confirm" | "status" | "discard") =>
    void a
      .run(() => requestOperation(id, "POST", "/" + kind, { confirm: true }))
      .then((v) => {
        if (v) {
          if (id === draft.pending?.id) setOperation(v);
          update();
        }
      });
  const link = (v: Observed) =>
    void a
      .run(() =>
        sharedMutation<TeamGitHubLink>(base + "/links", "POST", {
          observationId: v.id,
          ...(source ? { source } : {}),
        }),
      )
      .then((v) => {
        if (v) update();
      });
  const work = (v: TeamGitHubLink) =>
    void a
      .run(() =>
        sharedMutation<SharedItem>(`${base}/links/${v.id}/work`, "POST", {
          confirm: true,
          fingerprint: v.fingerprint,
        }),
      )
      .then((v) => {
        if (v) openSharedProjects({ projectId: detail.project.id, kind: "plan", itemId: v.id });
      });
  if (!detail.project.repository)
    return <p className="notice">У этого проекта нет репозитория GitHub.</p>;
  const account = observed?.value;
  return (
    <section className="shared-form github-workspace" aria-label="GitHub проекта">
      <article className="shared-card shared-form">
        <div className="shared-row">
          <div>
            <h3>GitHub</h3>
            <a href={detail.project.repository} target="_blank" rel="noreferrer">
              {detail.project.repository.replace("https://github.com/", "")}
            </a>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={a.busy || !detail.checkout}
            onClick={() => observe({ kind: "identity" })}
          >
            Проверить мой доступ
          </button>
        </div>
        {!detail.checkout && <p>Подключи свою рабочую папку во вкладке «Моя рабочая папка».</p>}
        {account ? (
          <div>
            <strong>@{account.identity.login}</strong> · {accessNames[account.access]}
            <small>
              Проверено {new Date(account.checkedAt).toLocaleString("ru")}. Доступ участников
              проекта и доступ GitHub настраиваются отдельно.
            </small>
            <button
              type="button"
              className="secondary"
              disabled={a.busy}
              onClick={() =>
                void a
                  .run(() =>
                    sharedMutation(base + "/identity", "POST", {
                      observationId: observed.id,
                      confirm: true,
                    }),
                  )
                  .then((v) => {
                    if (v) update();
                  })
              }
            >
              Это мой GitHub — показать участникам
            </button>
          </div>
        ) : (
          <p className="muted">
            Используется GitHub-аккаунт на твоём компьютере. Проверка не запускает Codex.
          </p>
        )}
      </article>
      {(a.error || page.error) && (
        <p role="alert" className="notice">
          {a.error || page.error}
        </p>
      )}
      {source && write && (
        <article className="shared-card">
          <strong>Выбран материал проекта</strong>
          <p>Можно перенести его в черновик issue и отредактировать перед отправкой.</p>
          <button
            type="button"
            className="secondary"
            disabled={a.busy || !!draft.pending}
            onClick={pickSource}
          >
            Просмотреть и подготовить issue
          </button>
        </article>
      )}
      <nav className="shared-tabs" aria-label="Раздел GitHub">
        {(
          [
            ["issue", "Issues"],
            ["pr", "Pull requests"],
            ["collaborators", "Доступ GitHub"],
          ] as const
        ).map(([v, label]) => (
          <button
            type="button"
            key={v}
            disabled={a.busy}
            aria-pressed={mode === v}
            onClick={() => setMode(v)}
          >
            {label}
          </button>
        ))}
      </nav>
      <form
        className="shared-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          observe(
            mode === "collaborators"
              ? { kind: "collaborators", page: 1 }
              : { kind: "list", type: mode, state, query, page: 1 },
          );
        }}
      >
        {mode !== "collaborators" && (
          <>
            <input
              type="search"
              aria-label="Поиск GitHub"
              placeholder="Поиск в репозитории…"
              maxLength={120}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Состояние GitHub"
              value={state}
              onChange={(e) => setState(e.target.value as typeof state)}
            >
              <option value="open">Открытые</option>
              <option value="closed">Закрытые</option>
              <option value="all">Все</option>
            </select>
          </>
        )}
        <button type="submit" className="secondary" disabled={a.busy || !detail.checkout}>
          Загрузить {mode === "issue" ? "issues" : mode === "pr" ? "PR" : "доступ"}
        </button>
        {write && (mode !== "collaborators" || detail.project.role === "owner") && (
          <button
            type="button"
            className="primary"
            disabled={a.busy}
            onClick={() => start({ kind: mode === "collaborators" ? "invite" : "issue-create" })}
          >
            {mode === "collaborators" ? "Настроить доступ" : "Новый issue"}
          </button>
        )}
        {(draft.pending || draft.body.trim()) && !showDraft && (
          <button type="button" className="secondary" onClick={() => setShowDraft(true)}>
            Открыть мой черновик
          </button>
        )}
      </form>
      {observed?.value.items?.map((r) => (
        <button
          type="button"
          className="shared-card github-record-button"
          key={r.url}
          disabled={a.busy}
          onClick={() => observe({ kind: "detail", type: r.type, number: r.number, page: 1 })}
        >
          <strong>
            #{r.number} · {r.title}
          </strong>
          <small>
            @{r.author.login} · {r.state} · {new Date(r.updatedAt).toLocaleString("ru")}
          </small>
        </button>
      ))}
      {observed?.value.items?.length === 0 && <p>По этому запросу записей нет.</p>}
      {observed?.value.collaborators && (
        <article className="shared-card shared-form">
          <h3>Доступ к репозиторию</h3>
          {!observed.value.collaborators.length && <p>Участников и приглашений нет.</p>}
          {observed.value.collaborators.map((v) => (
            <div className="shared-row" key={v.login + v.state}>
              <strong>@{v.login}</strong>
              <span>
                {v.state === "pending" ? "Приглашён" : "Доступ есть"} · {v.permission}
              </span>
            </div>
          ))}
          <small>Этот список не меняет участников проекта в приложении.</small>
        </article>
      )}
      {observed?.value.record && (
        <article className="shared-card shared-form">
          <GitHubRecord record={observed.value.record} />
          <div className="shared-actions">
            <button
              type="button"
              className="secondary"
              disabled={a.busy || !write}
              onClick={() => link(observed)}
            >
              Связать с проектом{source ? " и выбранным материалом" : ""}
            </button>
            {write && (
              <button
                type="button"
                className="secondary"
                disabled={a.busy}
                onClick={() =>
                  start({
                    kind: "comment",
                    number: observed.value.record!.number,
                    type: observed.value.record!.type,
                  })
                }
              >
                Написать комментарий
              </button>
            )}
            {write && observed.value.record.type === "issue" && (
              <button
                type="button"
                className="secondary"
                disabled={a.busy}
                onClick={() =>
                  start({
                    kind: "issue-state",
                    number: observed.value.record!.number,
                    type: "issue",
                    state: observed.value.record!.state === "open" ? "closed" : "open",
                  })
                }
              >
                {observed.value.record.state === "open" ? "Закрыть issue" : "Открыть issue заново"}
              </button>
            )}
            {write && observed.value.record.type === "pr" && (
              <button
                type="button"
                className="secondary"
                disabled={a.busy}
                onClick={() =>
                  start({
                    kind: "request-review",
                    number: observed.value.record!.number,
                    type: "pr",
                  })
                }
              >
                Запросить ревью
              </button>
            )}
          </div>
          {observed.value.commentsPage?.map((c) => (
            <details key={c.id} className="github-comment">
              <summary>
                @{c.author.login} · {new Date(c.createdAt).toLocaleString("ru")}
              </summary>
              <Markdown text={c.body} />
              {c.truncated && <p>Комментарий сокращён.</p>}
              <a href={c.url} target="_blank" rel="noreferrer">
                В GitHub
              </a>
            </details>
          ))}
        </article>
      )}
      {observed?.value.nextPage && "page" in observed.value.query && (
        <button
          type="button"
          className="secondary"
          disabled={a.busy}
          onClick={() =>
            observe({ ...observed.value.query, page: observed.value.nextPage! } as GitHubWorkQuery)
          }
        >
          Следующая страница GitHub
        </button>
      )}
      {showDraft && write && (
        <article
          className="shared-card shared-form github-compose"
          aria-label="Подготовка GitHub-действия"
        >
          <div className="shared-row">
            <h3>{names[draft.kind]}</h3>
            <button type="button" className="secondary" onClick={() => setShowDraft(false)}>
              Свернуть черновик
            </button>
          </div>
          {draft.pending ? (
            <>
              {operation ? (
                <Operation value={operation} busy={a.busy} action={action} />
              ) : (
                <p>Проверяем подготовленное действие…</p>
              )}
              {!operation && (
                <button
                  type="button"
                  className="secondary"
                  disabled={a.busy}
                  onClick={() =>
                    void a
                      .run(() =>
                        requestOperation(draft.pending!.id, "PUT", "", draft.pending!.request),
                      )
                      .then((v) => {
                        if (v) {
                          setOperation(v);
                          update();
                        }
                      })
                  }
                >
                  Проверить подготовку
                </button>
              )}
              {operation && ["failed", "completed"].includes(operation.state) && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const next =
                      operation.state === "completed" ? empty() : { ...draft, pending: undefined };
                    if (change(next)) setOperation(undefined);
                  }}
                >
                  {" "}
                  {operation.state === "completed"
                    ? "Новый черновик"
                    : "Вернуться к редактированию"}
                </button>
              )}
            </>
          ) : (
            <form
              className="shared-form"
              onSubmit={(e) => {
                e.preventDefault();
                let input: GitHubWorkInput;
                if (draft.kind === "issue-create")
                  input = { kind: draft.kind, title: draft.title, body: draft.body };
                else if (draft.kind === "comment")
                  input = {
                    kind: draft.kind,
                    number: draft.number,
                    type: draft.type,
                    body: draft.body,
                  };
                else if (draft.kind === "issue-state")
                  input = { kind: draft.kind, number: draft.number, state: draft.state };
                else if (draft.kind === "request-review")
                  input = { kind: draft.kind, number: draft.number, login: draft.login };
                else if (draft.kind === "invite")
                  input = { kind: draft.kind, login: draft.login, permission: draft.permission };
                else input = { kind: "remove", login: draft.login };
                const validated = githubWorkInputSchema.safeParse(input);
                if (!validated.success || ("body" in input && !input.body.trim())) {
                  a.setError(
                    "Проверь название, текст и GitHub-аккаунт. Пустое действие отправить нельзя.",
                  );
                  return;
                }
                const request: TeamGitHubPrepare = {
                  input: validated.data,
                  ...("login" in input ? { memberId: draft.memberId } : {}),
                  ...(draft.source ? { source: draft.source } : {}),
                };
                const pending = { id: crypto.randomUUID(), request };
                if (!change({ ...draft, pending })) return;
                void a
                  .run(() => requestOperation(pending.id, "PUT", "", request))
                  .then((v) => {
                    if (v) {
                      setOperation(v);
                      update();
                    }
                  });
              }}
            >
              <fieldset disabled={a.busy}>
                {draft.kind === "issue-create" && (
                  <label>
                    Название issue
                    <input
                      required
                      maxLength={200}
                      value={draft.title}
                      onChange={(e) => change({ ...draft, title: e.target.value })}
                    />
                  </label>
                )}
                {["issue-create", "comment"].includes(draft.kind) && (
                  <label>
                    Текст для GitHub
                    <textarea
                      required
                      aria-label="Текст для GitHub"
                      rows={7}
                      maxLength={16000}
                      value={draft.body}
                      onChange={(e) => change({ ...draft, body: e.target.value })}
                    />
                  </label>
                )}
                {draft.kind === "issue-state" && (
                  <p>
                    Issue #{draft.number}: {draft.state === "closed" ? "закрыть" : "открыть заново"}
                    .
                  </p>
                )}
                {["invite", "remove", "request-review"].includes(draft.kind) && (
                  <>
                    {draft.kind !== "request-review" && (
                      <label>
                        Действие
                        <select
                          value={draft.kind}
                          onChange={(e) =>
                            change({ ...draft, kind: e.target.value as Draft["kind"] })
                          }
                        >
                          <option value="invite">Пригласить</option>
                          <option value="remove">Отозвать доступ</option>
                        </select>
                      </label>
                    )}
                    <label>
                      Участник проекта
                      <select
                        required
                        value={draft.memberId}
                        onChange={(e) =>
                          change({
                            ...draft,
                            memberId: e.target.value,
                            login:
                              page.value?.accounts.find((a) => a.userId === e.target.value)
                                ?.identity.login ?? "",
                          })
                        }
                      >
                        <option value="">Выбери человека</option>
                        {[
                          ...detail.members.map((m) => ({ userId: m.userId, name: m.name })),
                          ...(draft.kind === "remove"
                            ? (page.value?.accounts ?? []).filter(
                                (a) => !detail.members.some((m) => m.userId === a.userId),
                              )
                            : []),
                        ]
                          .filter((m) => m.userId !== pageWorkspace)
                          .map((m) => (
                            <option key={m.userId} value={m.userId}>
                              {m.name}
                              {detail.members.some((v) => v.userId === m.userId)
                                ? ""
                                : " · прежний участник"}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Его GitHub-аккаунт
                      <input
                        required
                        maxLength={39}
                        pattern="[a-zA-Z0-9][a-zA-Z0-9-]*"
                        autoCapitalize="none"
                        autoCorrect="off"
                        value={draft.login}
                        onChange={(e) => change({ ...draft, login: e.target.value })}
                      />
                    </label>
                    <small>
                      Проверь именно GitHub-аккаунт выбранного человека перед подтверждением.
                    </small>
                    {draft.kind === "invite" && (
                      <label>
                        Доступ
                        <select
                          value={draft.permission}
                          onChange={(e) =>
                            change({ ...draft, permission: e.target.value as Draft["permission"] })
                          }
                        >
                          <option value="pull">Чтение</option>
                          <option value="push">Чтение и запись</option>
                        </select>
                      </label>
                    )}
                  </>
                )}
              </fieldset>
              <button type="submit" className="primary" disabled={a.busy}>
                Проверить перед отправкой
              </button>
            </form>
          )}
        </article>
      )}
      <section className="shared-form">
        <h3>Связано с проектом</h3>
        {page.value?.items.length === 0 && (
          <p className="muted">
            Выбери issue или PR и свяжи его с проектом. Здесь останется снимок проверенной версии.
          </p>
        )}
        {page.value?.items.map((v) => (
          <article className="shared-card" key={v.id}>
            <strong>
              {v.record.type === "pr" ? "PR" : "Issue"} #{v.record.number} · {v.record.title}
            </strong>
            <small>
              Связал {v.userName} · {new Date(v.checkedAt).toLocaleString("ru")} · @
              {v.record.author.login}
            </small>
            <div className="shared-actions">
              <button
                type="button"
                className="secondary"
                disabled={a.busy}
                onClick={() =>
                  observe({ kind: "detail", type: v.record.type, number: v.record.number, page: 1 })
                }
              >
                Проверить актуальное
              </button>
              {write && (
                <button type="button" className="primary" disabled={a.busy} onClick={() => work(v)}>
                  В мой план работы
                </button>
              )}
            </div>
            <details>
              <summary>Сохранённая версия</summary>
              <GitHubRecord record={v.record} />
            </details>
          </article>
        ))}
        <div className="shared-actions">
          {offset > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              Назад
            </button>
          )}
          {page.value?.nextOffset != null && (
            <button
              type="button"
              className="secondary"
              onClick={() => setOffset(page.value!.nextOffset!)}
            >
              Ещё связи
            </button>
          )}
        </div>
      </section>
      {!!page.value?.operations.length && (
        <details>
          <summary>Мои GitHub-действия</summary>
          <div className="shared-form">
            {page.value.operations
              .filter((v) => v.id !== draft.pending?.id || !showDraft)
              .map((v) => (
                <article className="shared-card" key={v.id}>
                  <Operation value={v} busy={a.busy} action={action} />
                </article>
              ))}
          </div>
        </details>
      )}
    </section>
  );
}

function Operation({
  value: v,
  busy,
  action,
}: {
  value: TeamGitHubOperation;
  busy: boolean;
  action: (id: string, kind: "confirm" | "status" | "discard") => void;
}) {
  const n = v.native;
  return (
    <div className="shared-form">
      <strong>{states[v.state]}</strong>
      {n && (
        <>
          <p>
            {names[n.input.kind]} · @{n.snapshot.identity.login} · {n.snapshot.repository} ·{" "}
            {v.machineName}
          </p>
          <details open={v.state === "prepared"}>
            <summary>Точное действие</summary>
            {"title" in n.input && <h4>{n.input.title}</h4>}
            {"body" in n.input && <Markdown text={n.input.body} />}
            {"login" in n.input && (
              <p>
                GitHub: @{n.input.login}
                {n.input.kind === "invite"
                  ? ` · ${n.input.permission === "pull" ? "Чтение" : "Чтение и запись"}`
                  : ""}
              </p>
            )}
            {"number" in n.input && (
              <p>
                #{n.input.number}
                {n.input.kind === "issue-state" ? ` → ${n.input.state}` : ""}
              </p>
            )}
            {n.baseline?.head && (
              <p>
                SHA: <code>{n.baseline.head.sha}</code>
              </p>
            )}
          </details>
        </>
      )}
      {v.error && <p role="status">{v.error}</p>}
      {n?.result?.url && (
        <a href={n.result.url} target="_blank" rel="noreferrer">
          Открыть результат в GitHub
        </a>
      )}
      <div className="shared-actions">
        {v.state === "prepared" && (
          <>
            <button
              type="button"
              className={n?.input.kind === "remove" ? "danger" : "primary"}
              disabled={busy}
              onClick={() => action(v.id, "confirm")}
            >
              Подтвердить в GitHub
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => action(v.id, "discard")}
            >
              Отменить подготовку
            </button>
          </>
        )}
        {["running", "unknown", "preparing"].includes(v.state) && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => action(v.id, "status")}
          >
            Проверить исход
          </button>
        )}
      </div>
    </div>
  );
}
function GitHubRecord({ record: r }: { record: GitHubWorkRecord }) {
  return (
    <div className="shared-form">
      <h3>
        {r.type === "pr" ? "PR" : "Issue"} #{r.number} · {r.title}
      </h3>
      <p>
        @{r.author.login} · {r.state}
        {r.draft ? " · Черновик" : ""} · {new Date(r.updatedAt).toLocaleString("ru")}
      </p>
      {r.labels.length > 0 && <p>{r.labels.join(" · ")}</p>}
      {r.assignees.length > 0 && <p>Назначено: {r.assignees.map((v) => "@" + v).join(", ")}</p>}
      {r.head && (
        <div>
          <p>
            {r.head.branch} → {r.base}
          </p>
          <div className="github-sha">
            <code>{r.head.sha}</code>
            <CopyButton text={r.head.sha} label="Скопировать SHA" />
          </div>
        </div>
      )}
      <Markdown text={r.body} />
      {r.truncated && <p>Описание сокращено. Полный текст доступен в GitHub.</p>}
      {r.type === "pr" && (
        <details>
          <summary>Ревью и проверки</summary>
          <p>Запрошены: {r.reviewers?.map((v) => "@" + v).join(", ") || "нет"}</p>
          {[...new Map(r.reviews?.map((v) => [JSON.stringify(v), v])).values()].map((v) => (
            <p key={JSON.stringify(v)}>
              @{v.author} · {v.state} · <code>{v.sha.slice(0, 12)}</code>
              {v.sha !== r.head?.sha ? " · прежняя версия" : ""}
            </p>
          ))}
          {r.checksKnown ? (
            r.checks?.length ? (
              [...new Map(r.checks.map((v) => [JSON.stringify(v), v])).values()].map((v) => (
                <p key={JSON.stringify(v)}>
                  {v.name} · {v.state} · <code>{v.sha.slice(0, 12)}</code>
                </p>
              ))
            ) : (
              <p>Для этого SHA проверок нет.</p>
            )
          ) : (
            <p>Сведения о проверках недоступны.</p>
          )}
        </details>
      )}
      <a href={r.url} target="_blank" rel="noreferrer">
        Открыть в GitHub
      </a>
    </div>
  );
}
