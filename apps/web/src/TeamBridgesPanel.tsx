import type {
  ProjectScope,
  SharedMaterial,
  SharedProject,
  TeamBridge,
  TeamBridgeDetail,
  TeamBridgeEntry,
  TeamBridgeFields,
  TeamBridgeRun,
  TeamLink,
} from "@codex-web/shared";
import { useState } from "react";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api } from "./api";
import { SharedMarkdown as Markdown, MaterialContent } from "./SharedMaterialEditor";
import { PersonalProjectPicker } from "./SharedPublication";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";
import { openSharedProjects } from "./TeamProjectsHost";

const stateLabel: Record<TeamBridge["state"], string> = {
  active: "Обсуждаем",
  waiting: "Координация",
  needs_owner: "Нужно решение",
  resolved: "Решено",
  stopped: "Остановлено",
};
const runLabel: Record<TeamBridgeRun["state"], string> = {
  prepared: "Проверь запрос перед запуском",
  waiting: "Ждёт свободного чата",
  running: "Координатор работает",
  consulting: "Вопрос участнику",
  unknown: "Отправка не подтверждена",
  resolved: "Завершено",
  needs_owner: "Нужно твоё решение",
  stopped: "Остановлено",
};
const entryLabel: Record<TeamBridgeEntry["kind"], string> = {
  finding: "Вывод",
  question: "Вопрос",
  decision: "Решение",
  work: "Предложение работы",
  coordinator: "Координатор",
  consultation: "Ответ проекта",
  status: "Состояние",
};
const base = "/team/bridges";

function useDraft<T>(name: string, initial: T) {
  const [draft, setDraft] = useState<T>(() => {
    try {
      return JSON.parse(storage.getItem(name) ?? "null")?.body ?? initial;
    } catch {
      return initial;
    }
  });
  const [pending, setPending] = useState<{ key: string; body: T } | null>(() => {
    try {
      return JSON.parse(storage.getItem(name) ?? "null")?.pending ?? null;
    } catch {
      return null;
    }
  });
  const action = useSharedAction();
  const change = (body: T) => {
    try {
      storage.setItem(name, JSON.stringify({ body }));
      setDraft(body);
    } catch {
      action.setError("Не удалось сохранить черновик на устройстве.");
    }
  };
  const submit = (send: (key: string, body: T) => Promise<unknown>, done: () => void) =>
    void action
      .run(async () => {
        const saved = pending ?? { key: crypto.randomUUID(), body: draft };
        storage.setItem(name, JSON.stringify({ body: saved.body, pending: saved }));
        setPending(saved);
        let result: unknown;
        try {
          result = await send(saved.key, saved.body);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            ![408, 429].includes(error.status)
          ) {
            storage.setItem(name, JSON.stringify({ body: saved.body }));
            setPending(null);
          }
          throw error;
        }
        storage.removeItem(name);
        setPending(null);
        setDraft(initial);
        return result;
      })
      .then((v) => {
        if (v) done();
      });
  return { ...action, draft, pending, change, submit };
}
export function TeamBridgeInvitations({
  revision,
  refresh,
}: {
  revision: number;
  refresh: () => void;
}) {
  const page = useSharedResource<{
      items: {
        id: string;
        revision: number;
        title: string;
        goal: string;
        criteria: string;
        ownerName: string;
        projectTitle: string;
        targetTitle: string;
      }[];
    }>(base + "/invitations", revision),
    a = useSharedAction();
  return (
    <>
      {(a.error || page.error) && <p role="alert">{a.error || page.error}</p>}
      {page.value?.items.map((v) => (
        <article key={v.id} className="shared-card shared-form">
          <h3>Приглашение в Bridge · {v.title}</h3>
          <p>
            {v.ownerName} · {v.projectTitle} → {v.targetTitle}
          </p>
          <Markdown text={v.goal} />
          <details>
            <summary>Критерии и доступ</summary>
            <Markdown text={v.criteria} />
            <p>
              После принятия ты увидишь общие записи этого обсуждения. Личные чаты и остальные
              материалы проектов остаются личными.
            </p>
          </details>
          <div className="shared-actions">
            {[true, false].map((accept) => (
              <button
                type="button"
                className={accept ? "primary" : "secondary"}
                key={String(accept)}
                disabled={a.busy}
                onClick={() =>
                  void a
                    .run(() =>
                      sharedMutation(`${base}/${v.id}/answer`, "POST", {
                        revision: v.revision,
                        accept,
                      }),
                    )
                    .then((r) => {
                      if (r) refresh();
                    })
                }
              >
                {accept ? "Принять участие" : "Отклонить"}
              </button>
            ))}
          </div>
        </article>
      ))}
    </>
  );
}
export function TeamBridgesPanel({
  project,
  revision,
  refresh,
}: {
  project: SharedProject;
  revision: number;
  refresh: () => void;
}) {
  const [selected, select] = useState(""),
    [creating, setCreating] = useState(false),
    [offset, setOffset] = useState(0);
  const page = useSharedResource<{ items: TeamBridge[]; nextOffset: number | null }>(
    selected || creating ? null : `${base}?projectId=${project.id}&offset=${offset}`,
    revision,
  );
  if (selected)
    return (
      <BridgeRoom
        key={selected}
        id={selected}
        revision={revision}
        refresh={refresh}
        back={() => select("")}
      />
    );
  return (
    <section className="shared-form">
      <TeamBridgeInvitations revision={revision} refresh={refresh} />
      {creating ? (
        <NewBridge
          project={project}
          cancel={() => setCreating(false)}
          created={(id) => {
            select(id);
            setCreating(false);
            refresh();
          }}
        />
      ) : (
        <>
          <div className="shared-row">
            <div>
              <h2>Bridges</h2>
              <p className="muted">Отдельное обсуждение для каждой общей цели.</p>
            </div>
            {project.role !== "viewer" && !project.archived && (
              <button type="button" className="primary" onClick={() => setCreating(true)}>
                Новое обсуждение
              </button>
            )}
          </div>
          {page.error && <p role="alert">{page.error}</p>}
          {page.value?.items.map((v) => (
            <button
              type="button"
              className="shared-card bridge-card"
              key={v.id}
              onClick={() => select(v.id)}
            >
              <span>
                <strong>{v.title}</strong>
                <small>{v.goal.slice(0, 180)}</small>
              </span>
              <span className="bridge-state">{stateLabel[v.state]}</span>
              <small>Координатор · {v.ownerName}</small>
            </button>
          ))}
          {page.value && !page.value.items.length && (
            <p className="muted">
              Пока нет обсуждений. Выбери одну задачу, для которой нужно согласовать работу.
            </p>
          )}
          <div className="shared-actions">
            {offset > 0 && (
              <button
                className="secondary"
                type="button"
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Назад
              </button>
            )}
            {page.value?.nextOffset != null && (
              <button
                className="secondary"
                type="button"
                onClick={() => setOffset(page.value!.nextOffset!)}
              >
                Ещё обсуждения
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
function NewBridge({
  project,
  cancel,
  created,
}: {
  project: SharedProject;
  cancel: () => void;
  created: (id: string) => void;
}) {
  const d = useDraft<TeamBridgeFields>("bridge-new:" + project.id, {
    title: "",
    goal: "",
    criteria: "",
    budget: 3,
  });
  return (
    <form
      className="shared-card shared-form"
      onSubmit={(e) => {
        e.preventDefault();
        d.submit(
          (key, body) =>
            api(`${base}/${key}`, { method: "PUT", body: { ...body, projectId: project.id } }).then(
              (v) => {
                if (d.active()) created(key);
                return v;
              },
            ),
          () => {},
        );
      }}
    >
      <h2>Новое обсуждение</h2>
      {d.error && <p role="alert">{d.error}</p>}
      <fieldset disabled={d.busy || !!d.pending}>
        <label>
          Название
          <input
            required
            maxLength={120}
            value={d.draft.title}
            onChange={(e) => d.change({ ...d.draft, title: e.target.value })}
          />
        </label>
        <label>
          Что нужно согласовать
          <textarea
            required
            rows={4}
            maxLength={6000}
            value={d.draft.goal}
            onChange={(e) => d.change({ ...d.draft, goal: e.target.value })}
          />
        </label>
        <label>
          Как поймём, что готово
          <textarea
            required
            rows={3}
            maxLength={4000}
            value={d.draft.criteria}
            onChange={(e) => d.change({ ...d.draft, criteria: e.target.value })}
          />
        </label>
        <label>
          Запросов за один запуск: {d.draft.budget}
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={d.draft.budget}
            onChange={(e) => d.change({ ...d.draft, budget: Number(e.target.value) })}
          />
        </label>
        <small>
          Общий предел включает координатора и ответы связанных проектов. Раннее решение
          останавливает обмен.
        </small>
      </fieldset>
      <div className="shared-actions">
        <button type="submit" className="primary" disabled={d.busy}>
          {d.pending ? "Повторить подтверждение" : "Создать обсуждение"}
        </button>
        <button type="button" className="secondary" disabled={d.busy} onClick={cancel}>
          Назад
        </button>
      </div>
    </form>
  );
}
function EditBridge({ bridge, done }: { bridge: TeamBridge; done: () => void }) {
  const d = useDraft("bridge-edit:" + bridge.id, {
    title: bridge.title,
    goal: bridge.goal,
    criteria: bridge.criteria,
    budget: bridge.budget,
    revision: bridge.revision,
  });
  return (
    <form
      className="shared-card shared-form"
      onSubmit={(e) => {
        e.preventDefault();
        d.submit((key, body) => api(`${base}/${bridge.id}`, { method: "PATCH", key, body }), done);
      }}
    >
      <h3>Цель и бюджет</h3>
      <p className="muted">Изменения доступны между запусками координации.</p>
      {d.error && <p role="alert">{d.error}</p>}
      <fieldset disabled={d.busy || !!d.pending}>
        <label>
          Название
          <input
            required
            maxLength={120}
            value={d.draft.title}
            onChange={(e) => d.change({ ...d.draft, title: e.target.value })}
          />
        </label>
        <label>
          Что нужно согласовать
          <textarea
            required
            rows={4}
            maxLength={6000}
            value={d.draft.goal}
            onChange={(e) => d.change({ ...d.draft, goal: e.target.value })}
          />
        </label>
        <label>
          Как поймём, что готово
          <textarea
            required
            rows={3}
            maxLength={4000}
            value={d.draft.criteria}
            onChange={(e) => d.change({ ...d.draft, criteria: e.target.value })}
          />
        </label>
        <label>
          Запросов за один запуск: {d.draft.budget}
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={d.draft.budget}
            onChange={(e) => d.change({ ...d.draft, budget: Number(e.target.value) })}
          />
        </label>
        {d.draft.revision !== bridge.revision && (
          <>
            <p role="status">
              Обсуждение изменилось. Черновик сохранён; проверь текущую цель перед заменой.
            </p>
            <details>
              <summary>Текущая цель и критерии</summary>
              <Markdown text={bridge.goal + "\n\n" + bridge.criteria} />
            </details>
            <button
              type="button"
              className="secondary"
              onClick={() => d.change({ ...d.draft, revision: bridge.revision })}
            >
              Применить черновик поверх этой версии
            </button>
          </>
        )}
      </fieldset>
      <div className="shared-actions">
        <button
          type="submit"
          className="primary"
          disabled={d.busy || (!d.pending && d.draft.revision !== bridge.revision)}
        >
          {d.pending ? "Повторить подтверждение" : "Сохранить цель"}
        </button>
        <button type="button" className="secondary" disabled={d.busy} onClick={done}>
          Закрыть
        </button>
      </div>
    </form>
  );
}
function BridgeRoom({
  id,
  revision,
  refresh,
  back,
}: {
  id: string;
  revision: number;
  refresh: () => void;
  back: () => void;
}) {
  const [before, setBefore] = useState<number | null>(null),
    [filter, setFilter] = useState("all"),
    [editing, setEditing] = useState(false),
    [invite, setInvite] = useState(false),
    [linkOffset, setLinkOffset] = useState(0),
    [linkId, setLinkId] = useState("");
  const resource = useSharedResource<TeamBridgeDetail>(
      `${base}/${id}?filter=${filter}${before ? "&before=" + before : ""}`,
      revision,
    ),
    a = useSharedAction(),
    d = resource.value,
    v = d?.bridge,
    r = d?.run;
  const links = useSharedResource<{ items: TeamLink[]; nextOffset: number | null }>(
    invite && v ? `/team/projects/${v.projectId}/links?offset=${linkOffset}` : null,
    revision,
  );
  const mutate = (path: string, body: unknown) =>
    void a
      .run(() => sharedMutation(`${base}/${id}/${path}`, "POST", body))
      .then((result) => {
        if (result) refresh();
      });
  return (
    <section className="shared-form bridge-room">
      <button type="button" className="secondary" onClick={back}>
        К обсуждениям
      </button>
      {(a.error || resource.error) && <p role="alert">{a.error || resource.error}</p>}
      {!d ? (
        <p role="status">Открываем обсуждение…</p>
      ) : (
        <>
          <div className="bridge-heading">
            <h2>{v!.title}</h2>
            <strong className="bridge-state">{stateLabel[v!.state]}</strong>
          </div>
          {d.canWrite && (
            <button
              type="button"
              className="secondary"
              onClick={() =>
                openSharedProjects({
                  projectId: d.myProjectId,
                  github: { source: { kind: "bridge", id } },
                })
              }
            >
              Связать с GitHub
            </button>
          )}
          <div className="bridge-summary">
            <section className="shared-card">
              <h3>Цель</h3>
              <Markdown text={v!.goal} />
            </section>
            <section className="shared-card">
              <h3>Готово, когда</h3>
              <Markdown text={v!.criteria} />
            </section>
          </div>
          {d.canCoordinate && (
            <button type="button" className="secondary" onClick={() => setEditing(!editing)}>
              Цель и бюджет
            </button>
          )}
          {editing && d.canCoordinate && (
            <EditBridge
              key={"edit:" + id}
              bridge={v!}
              done={() => {
                setEditing(false);
                refresh();
              }}
            />
          )}
          <div className="shared-card shared-form">
            <strong>Координатор · {v!.ownerName}</strong>
            <small>
              {v!.projectTitle} · до {v!.budget} запросов за запуск
            </small>
            {v!.participants.map((p) => (
              <div key={p.linkId} className="shared-row">
                <span>
                  {p.userName} · {p.projectTitle}
                </span>
                <small>
                  {p.state === "accepted"
                    ? "Участвует"
                    : p.state === "invited"
                      ? "Приглашён"
                      : "Приглашение закрыто"}
                </small>
              </div>
            ))}
            {d.canAdopt && (
              <button
                type="button"
                className="primary"
                disabled={a.busy}
                onClick={() => mutate("action", { revision: v!.revision, action: "adopt" })}
              >
                Принять координацию своего проекта
              </button>
            )}
            {d.canCoordinate && (
              <button type="button" className="secondary" onClick={() => setInvite(!invite)}>
                Пригласить связанный проект
              </button>
            )}
            {invite && (
              <div className="shared-form">
                <label>
                  Принятая связь
                  <select
                    aria-label="Принятая связь"
                    value={linkId}
                    onChange={(e) => setLinkId(e.target.value)}
                  >
                    <option value="">Выбери проект</option>
                    {links.value?.items
                      .filter(
                        (l) =>
                          l.state === "accepted" &&
                          l.policy.bridge &&
                          (l.source.id === v!.projectId || l.policy.direction === "both"),
                      )
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.source.id === v!.projectId ? l.target?.title : l.source.title}
                        </option>
                      ))}
                  </select>
                </label>
                {links.error && <p role="alert">{links.error}</p>}
                <div className="shared-actions">
                  {linkOffset > 0 && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setLinkOffset(Math.max(0, linkOffset - 30));
                        setLinkId("");
                      }}
                    >
                      Предыдущие связи
                    </button>
                  )}
                  {links.value?.nextOffset != null && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setLinkOffset(links.value!.nextOffset!);
                        setLinkId("");
                      }}
                    >
                      Ещё связи
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="primary"
                  disabled={a.busy || !linkId}
                  onClick={() => mutate("invite", { revision: v!.revision, linkId })}
                >
                  Предложить участие
                </button>
              </div>
            )}
          </div>
          {r && (
            <section className="shared-card shared-form" aria-label="Координация Bridge">
              <strong>
                {runLabel[r.state]} · {r.consumed}/{r.budget}
              </strong>
              {r.reason && <p role="status">{r.reason}</p>}
              {r.preview && (
                <>
                  <small>
                    {r.preview.project} · {r.preview.chat} · {r.preview.machine}
                  </small>
                  <details>
                    <summary>Запрос координатору</summary>
                    <pre>{r.preview.prompt}</pre>
                  </details>
                  <button
                    type="button"
                    className="secondary"
                    disabled={a.busy}
                    onClick={() =>
                      void a
                        .run(() => api(`${base}/${id}/source`))
                        .then((target) => {
                          if (target)
                            window.dispatchEvent(
                              new CustomEvent("open-delivery-target", { detail: target }),
                            );
                        })
                    }
                  >
                    Открыть свой чат
                  </button>
                </>
              )}
              {r.state === "prepared" && d.canCoordinate && (
                <button
                  className="primary"
                  type="button"
                  disabled={a.busy}
                  onClick={() => mutate("confirm", { runId: r.id, confirm: true })}
                >
                  Запустить координацию
                </button>
              )}
            </section>
          )}
          <div className="shared-actions">
            {d.canCoordinate &&
              !["stopped", "resolved"].includes(v!.state) &&
              (!r ||
                !["prepared", "waiting", "running", "consulting", "unknown"].includes(r.state)) && (
                <button
                  className="primary"
                  type="button"
                  disabled={a.busy}
                  onClick={() => mutate("prepare", { revision: v!.revision })}
                >
                  Подготовить координацию
                </button>
              )}
            {d.canWrite && (
              <>
                {!["stopped", "resolved"].includes(v!.state) ? (
                  <>
                    <button
                      className="secondary"
                      type="button"
                      disabled={a.busy}
                      onClick={() => mutate("action", { revision: v!.revision, action: "stop" })}
                    >
                      Остановить
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      disabled={a.busy}
                      onClick={() => mutate("action", { revision: v!.revision, action: "resolve" })}
                    >
                      Цель достигнута
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary"
                    type="button"
                    disabled={a.busy}
                    onClick={() => mutate("action", { revision: v!.revision, action: "reopen" })}
                  >
                    Открыть обсуждение
                  </button>
                )}
              </>
            )}
          </div>
          <nav className="shared-tabs" aria-label="Записи обсуждения">
            {[
              ["all", "Все записи"],
              ["question", "Вопросы"],
              ["decision", "Решения"],
              ["work", "Работа"],
            ].map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={filter === key}
                onClick={() => {
                  setFilter(key!);
                  setBefore(null);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          {d.entries.map((e) => (
            <article key={e.id} className="shared-card bridge-entry">
              <div className="shared-row">
                <strong>{entryLabel[e.kind]}</strong>
                <small>
                  {e.userName} · {new Date(e.createdAt).toLocaleString("ru")}
                </small>
              </div>
              <Markdown text={e.text} />
              {d.canWrite && e.kind !== "status" && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    openSharedProjects({
                      projectId: d.myProjectId,
                      github: { source: { kind: "bridge", id, entryId: e.id } },
                    })
                  }
                >
                  Эту запись в GitHub
                </button>
              )}
              {e.source && <BridgePrivateSource bridgeId={id} entry={e} />}
              {e.reference && (
                <a href={e.reference} target="_blank" rel="noreferrer">
                  Открыть {e.reference.includes("/pull/") ? "PR" : "Issue"} #
                  {e.reference.split("/").at(-1)}
                </a>
              )}
              {e.kind === "work" &&
                d.canWrite &&
                (e.targetProjectId === d.myProjectId ||
                  v!.participants.some(
                    (p) =>
                      p.projectId === e.targetProjectId &&
                      p.userId === pageWorkspace &&
                      p.state === "accepted",
                  )) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={a.busy}
                    onClick={() =>
                      void a
                        .run(() =>
                          sharedMutation<{ id: string; projectId: string }>(
                            `${base}/${id}/entries/${e.id}/plan`,
                            "POST",
                            { confirm: true },
                          ),
                        )
                        .then((p) => {
                          if (p)
                            openSharedProjects({
                              projectId: p.projectId,
                              kind: "plan",
                              itemId: p.id,
                            });
                        })
                    }
                  >
                    {e.planId ? "Открыть план" : "Сохранить предложение в план"}
                  </button>
                )}
            </article>
          ))}
          <div className="shared-actions">
            {before && (
              <button type="button" className="secondary" onClick={() => setBefore(null)}>
                К последним записям
              </button>
            )}
            {d.nextBefore && (
              <button type="button" className="secondary" onClick={() => setBefore(d.nextBefore)}>
                Раньше
              </button>
            )}
          </div>
          {d.canWrite && <NewFinding key={"finding:" + id} detail={d} refresh={refresh} />}
        </>
      )}
    </section>
  );
}
function NewFinding({ detail, refresh }: { detail: TeamBridgeDetail; refresh: () => void }) {
  const v = detail.bridge,
    d = useDraft("bridge-finding:" + v.id, {
      kind: "finding",
      text: "",
      reference: "",
      targetProjectId: detail.myProjectId,
      sourceId: "",
      sourceTitle: "",
    });
  const [picking, pick] = useState(false);
  return (
    <form
      className="shared-card shared-form"
      onSubmit={(e) => {
        e.preventDefault();
        d.submit(
          (key, body) =>
            api(`${base}/${v.id}/entries`, {
              method: "POST",
              key,
              body: {
                kind: body.kind,
                text: body.text,
                ...(body.sourceId ? { sourceId: body.sourceId } : {}),
                ...(body.reference ? { reference: body.reference } : {}),
                ...(body.kind === "work" ? { targetProjectId: body.targetProjectId } : {}),
              },
            }),
          refresh,
        );
      }}
    >
      <h3>Добавить в обсуждение</h3>
      <button
        type="button"
        className="secondary"
        disabled={d.busy || !!d.pending}
        onClick={() => pick(!picking)}
      >
        Выбрать личный материал
      </button>
      {picking && (
        <BridgeSourcePicker
          bridgeId={v.id}
          selected={(source) => {
            d.change({
              ...d.draft,
              text: source.text,
              sourceId: source.id,
              sourceTitle: source.title,
            });
            pick(false);
          }}
        />
      )}
      {d.draft.sourceId && (
        <small>Личный источник: {d.draft.sourceTitle}. Участники увидят только текст ниже.</small>
      )}
      <p className="muted">
        Этот текст увидят участники Bridge. Передай только выбранный вывод или вопрос.
      </p>
      {d.error && <p role="alert">{d.error}</p>}
      <fieldset disabled={d.busy || !!d.pending}>
        <label>
          Тип записи
          <select
            aria-label="Тип записи"
            value={d.draft.kind}
            onChange={(e) => d.change({ ...d.draft, kind: e.target.value })}
          >
            {["finding", "question", "decision", "work"].map((k) => (
              <option key={k} value={k}>
                {entryLabel[k as TeamBridgeEntry["kind"]]}
              </option>
            ))}
          </select>
        </label>
        {d.draft.kind === "work" && (
          <label>
            Кому предложить работу
            <select
              aria-label="Кому предложить работу"
              value={d.draft.targetProjectId}
              onChange={(e) => d.change({ ...d.draft, targetProjectId: e.target.value })}
            >
              <option value={v.projectId}>{v.projectTitle}</option>
              {v.participants
                .filter((p) => p.state === "accepted")
                .map((p) => (
                  <option value={p.projectId} key={p.linkId}>
                    {p.projectTitle} · {p.userName}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Текст
          <textarea
            aria-label="Текст"
            rows={4}
            required
            maxLength={d.draft.kind === "work" ? 6000 : 8000}
            value={d.draft.text}
            onChange={(e) => d.change({ ...d.draft, text: e.target.value })}
          />
        </label>
        <label>
          Issue или PR · необязательно
          <input
            type="url"
            maxLength={500}
            value={d.draft.reference}
            placeholder="https://github.com/owner/repository/issues/123"
            onChange={(e) => d.change({ ...d.draft, reference: e.target.value })}
          />
        </label>
      </fieldset>
      <button type="submit" className="primary" disabled={d.busy || !d.draft.text.trim()}>
        {d.pending ? "Повторить подтверждение" : "Опубликовать запись"}
      </button>
    </form>
  );
}

function BridgeSourcePicker({
  bridgeId,
  selected,
}: {
  bridgeId: string;
  selected: (v: { id: string; title: string; text: string }) => void;
}) {
  const [scope, setScope] = useState<ProjectScope | null>(null),
    [kind, setKind] = useState("note"),
    [offset, setOffset] = useState(0),
    [preview, setPreview] = useState<{
      id: string;
      title: string;
      text: string;
      truncated: boolean;
    } | null>(null),
    a = useSharedAction();
  const sources = useSharedResource<{
    items: { id: string; title: string }[];
    nextOffset: number | null;
  }>(
    scope
      ? `${base}/${bridgeId}/sources?` +
          new URLSearchParams({ ...scope, kind, offset: String(offset) })
      : null,
  );
  return (
    <div className="shared-form">
      <PersonalProjectPicker
        value={scope}
        disabled={a.busy}
        onChange={(v) => {
          setScope(v);
          setOffset(0);
          setPreview(null);
        }}
      />
      <label>
        Личный материал
        <select
          aria-label="Личный материал"
          value={kind}
          disabled={a.busy}
          onChange={(e) => {
            setKind(e.target.value);
            setOffset(0);
            setPreview(null);
          }}
        >
          {[
            ["note", "Заметки / сохранённые сообщения"],
            ["plan", "Планы"],
            ["review", "Проверки работы"],
            ["report", "Отчёты"],
          ].map(([v, l]) => (
            <option value={v} key={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {(a.error || sources.error) && <p role="alert">{a.error || sources.error}</p>}
      {sources.value?.items.map((s) => (
        <button
          className="secondary"
          type="button"
          key={s.id}
          disabled={a.busy}
          onClick={() =>
            void a
              .run(() =>
                sharedMutation<{ id: string; title: string; text: string; truncated: boolean }>(
                  `${base}/${bridgeId}/source-preview`,
                  "POST",
                  { scope, kind, id: s.id },
                ),
              )
              .then((v) => {
                if (v) setPreview(v);
              })
          }
        >
          {s.title}
        </button>
      ))}
      <div className="shared-actions">
        {offset > 0 && (
          <button
            className="secondary"
            type="button"
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Предыдущие материалы
          </button>
        )}
        {sources.value?.nextOffset != null && (
          <button
            className="secondary"
            type="button"
            onClick={() => setOffset(sources.value!.nextOffset!)}
          >
            Ещё материалы
          </button>
        )}
      </div>
      {preview && (
        <div className="shared-card shared-form">
          <strong>{preview.title}</strong>
          {preview.truncated && (
            <p>
              Материал длиннее 8000 символов. Ниже начальный фрагмент; отредактируй выбранный вывод
              перед публикацией.
            </p>
          )}
          <Markdown text={preview.text} />
          <button type="button" className="primary" onClick={() => selected(preview)}>
            Вставить в черновик
          </button>
        </div>
      )}
    </div>
  );
}
function BridgePrivateSource({ bridgeId, entry }: { bridgeId: string; entry: TeamBridgeEntry }) {
  const [open, setOpen] = useState(false);
  const resource = useSharedResource<{
    title: string;
    snapshot: { content: SharedMaterial };
    input: { kind: string; id: string };
  }>(open ? `${base}/${bridgeId}/entries/${entry.id}/source` : null);
  if (entry.source !== "own") return <small>Личный источник автора</small>;
  return (
    <div className="shared-form">
      <button type="button" className="secondary" onClick={() => setOpen(!open)}>
        {open ? "Скрыть личный источник" : "Мой сохранённый источник"}
      </button>
      {open && (
        <>
          {resource.error && <p role="alert">{resource.error}</p>}
          {resource.value ? (
            <section className="shared-card">
              <strong>{resource.value.title} · личная копия при публикации</strong>
              <MaterialContent content={resource.value.snapshot.content} />
            </section>
          ) : (
            !resource.error && <p role="status">Загружаем личную копию…</p>
          )}
        </>
      )}
    </div>
  );
}
