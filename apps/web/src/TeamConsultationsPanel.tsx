import type {
  NotebookTarget,
  SharedItem,
  SharedProject,
  TeamConsultation,
  TeamConsultState,
  TeamLink,
} from "@codex-web/shared";
import { teamConsultRequestSchema } from "@codex-web/shared";
import { useState } from "react";
import { AutoTextarea } from "./AutoTextarea";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api } from "./api";
import { SharedMarkdown as Markdown } from "./SharedMaterialEditor";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";
import { openSharedProjects } from "./TeamProjectsHost";

const states: Record<TeamConsultState, string> = {
  proposed: "Ждёт согласия владельцев",
  waiting: "Ждёт свободного чата",
  running: "Консультация идёт",
  unknown: "Проверь отправку в своём чате",
  needs_owner: "Нужно решение участника",
  resolved: "Вопрос решён",
  limit: "Глубина исчерпана",
  stopped: "Остановлено",
  failed: "Ответ не завершён",
};
export function TeamConsultationsPanel({
  project,
  revision,
  refresh,
}: {
  project: SharedProject;
  revision: number;
  refresh: () => void;
}) {
  const [selected, setSelected] = useState(""),
    [creating, setCreating] = useState(false),
    [offset, setOffset] = useState(0);
  const base = `/team/projects/${project.id}/consultations`,
    readonly = project.role === "viewer" || project.archived;
  const page = useSharedResource<{ items: TeamConsultation[]; nextOffset: number | null }>(
    selected || creating ? null : `${base}?offset=${offset}`,
    revision,
  );
  const detail = useSharedResource<TeamConsultation>(
    selected ? base + "/" + selected : null,
    revision,
  );
  const { run, busy, error } = useSharedAction();
  const mutate = (action: "approve" | "stop" | "retry") => {
    if (!detail.value) return;
    void run(() =>
      sharedMutation(`${base}/${selected}/action`, "POST", {
        action,
        revision: detail.value!.revision,
      }),
    ).then((v) => {
      if (v) refresh();
    });
  };
  const v = detail.value,
    last = v?.steps.at(-1);
  return (
    <section className="shared-form">
      {(selected || creating) && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setSelected("");
            setCreating(false);
          }}
        >
          К консультациям
        </button>
      )}
      {(error || detail.error || page.error) && (
        <p role="alert">{error || detail.error || page.error}</p>
      )}
      {creating ? (
        <NewConsultation
          key={project.id}
          project={project}
          onCreated={(value) => {
            setCreating(false);
            setSelected(value.id);
            refresh();
          }}
        />
      ) : selected ? (
        v ? (
          <>
            <h3>{v.title}</h3>
            <p role="status">
              {states[v.state]} · Раунд {v.consumed} из {v.limit}
            </p>
            <p className="muted">Запросил {v.initiatorName}</p>
            <Markdown text={v.question} />
            {v.reason && <p className="notice">{v.reason}</p>}
            {v.steps.map((step) => (
              <article className="shared-card" key={step.id}>
                <strong>
                  {step.userName} · {step.phase === "question" ? "Ответ проекта" : "Уточнение"} ·{" "}
                  {step.round}/{v.limit}
                </strong>
                <details>
                  <summary>Переданный вопрос</summary>
                  <Markdown text={step.question} />
                </details>
                {step.answer ? (
                  <Markdown text={step.answer} />
                ) : (
                  <p className="muted">
                    {step.state === "waiting"
                      ? "Ожидает отправки"
                      : step.state === "completed"
                        ? "Передача ответа остановлена"
                        : "Ответ ещё не передан"}
                  </p>
                )}
              </article>
            ))}
            {!readonly && (
              <div className="shared-actions">
                {v.state === "proposed" &&
                  project.role === "owner" &&
                  [v.sourceOwnerId, v.targetOwnerId].includes(pageWorkspace) &&
                  !v.approvals.includes(pageWorkspace) && (
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => mutate("approve")}
                    >
                      Разрешить консультацию моему проекту
                    </button>
                  )}
                {!["resolved", "stopped", "failed"].includes(v.state) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => mutate("stop")}
                  >
                    Остановить обмен
                  </button>
                )}
                {v.state === "needs_owner" &&
                  last?.state === "waiting" &&
                  last.userId === pageWorkspace &&
                  last.projectId === project.id && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => mutate("retry")}
                    >
                      Повторить проверку отправки
                    </button>
                  )}
                {v.kind === "work" && v.targetId === project.id && !v.planId && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        sharedMutation<SharedItem>(`${base}/${selected}/plan`, "POST", {
                          confirm: true,
                        }),
                      ).then((item) => {
                        if (item)
                          openSharedProjects({
                            projectId: project.id,
                            kind: "plan",
                            itemId: item.id,
                          });
                      })
                    }
                  >
                    Сохранить предложенный план
                  </button>
                )}
              </div>
            )}
            {v.planId && v.targetId === project.id && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  openSharedProjects({ projectId: project.id, kind: "plan", itemId: v.planId })
                }
              >
                Открыть план
              </button>
            )}
            {v.steps.some(
              (s) =>
                s.userId === pageWorkspace && s.projectId === project.id && s.state !== "waiting",
            ) && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => api<NotebookTarget>(`${base}/${selected}/source`)).then(
                    (target) => {
                      if (target)
                        window.dispatchEvent(
                          new CustomEvent("open-delivery-target", { detail: target }),
                        );
                    },
                  )
                }
              >
                Открыть мой исходный чат
              </button>
            )}
          </>
        ) : (
          <p role="status">Открываем обсуждение…</p>
        )
      ) : (
        <>
          <h3>Консультации проектов</h3>
          <p className="muted">
            Вопросы и выбранные ответы доступны участникам обоих проектов. Личные чаты остаются у их
            владельцев.
          </p>
          {!readonly && (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              Новый запрос
            </button>
          )}
          {page.value?.items.length === 0 && (
            <p className="muted">Обсуждений пока нет. Сначала прими связь с другим проектом.</p>
          )}
          <div className="shared-material-list">
            {page.value?.items.map((item) => (
              <button type="button" key={item.id} onClick={() => setSelected(item.id)}>
                <strong>{item.title}</strong>
                <small>
                  {states[item.state]} · {item.initiatorName}
                </small>
                <p>{item.question}</p>
              </button>
            ))}
          </div>
          <div className="shared-actions">
            {offset > 0 && (
              <button
                type="button"
                className="secondary"
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Предыдущие обсуждения
              </button>
            )}
            {page.value?.nextOffset != null && (
              <button
                type="button"
                className="secondary"
                onClick={() => setOffset(page.value!.nextOffset!)}
              >
                Ещё обсуждения
              </button>
            )}
          </div>
        </>
      )}
      <button type="button" className="secondary" disabled={busy} onClick={refresh}>
        Обновить обсуждения
      </button>
    </section>
  );
}
function NewConsultation({
  project,
  onCreated,
}: {
  project: SharedProject;
  onCreated: (v: TeamConsultation) => void;
}) {
  const key = "workspace-consult-proposal:" + project.id;
  const [restored] = useState(() => {
    try {
      const s = JSON.parse(storage.getItem(key) ?? "null");
      if (s && /^[a-f0-9-]{36}$/.test(s.id) && s.body?.projectId === project.id)
        return { id: s.id as string, body: teamConsultRequestSchema.parse(s.body) };
    } catch {}
    return null;
  });
  const [linkId, setLinkId] = useState(restored?.body.linkId ?? ""),
    [title, setTitle] = useState(restored?.body.title ?? ""),
    [question, setQuestion] = useState(restored?.body.question ?? ""),
    [kind, setKind] = useState<"consult" | "work">(restored?.body.kind ?? "consult"),
    [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(restored);
  const links = useSharedResource<{ items: TeamLink[]; nextOffset: number | null }>(
    `/team/projects/${project.id}/links?offset=${offset}`,
  );
  const { run, busy, error, active } = useSharedAction();
  const submit = () =>
    void run(async () => {
      const attempt = pending ?? {
        id: crypto.randomUUID(),
        body: { projectId: project.id, linkId, title, question, kind },
      };
      storage.setItem(key, JSON.stringify(attempt));
      setPending(attempt);
      try {
        const { projectId: _projectId, ...body } = attempt.body;
        const result = await api<TeamConsultation>(
          `/team/projects/${project.id}/consultations/${attempt.id}`,
          { method: "PUT", body },
        );
        storage.removeItem(key);
        return result;
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) {
          storage.removeItem(key);
          if (active()) setPending(null);
        }
        throw e;
      }
    }).then((v) => {
      if (v) onCreated(v);
    });
  return (
    <div className="shared-form shared-card">
      <h3>Новый запрос</h3>
      {(error || links.error) && <p role="alert">{error || links.error}</p>}
      <label>
        Связь
        <select
          aria-label="Связь для запроса"
          value={linkId}
          disabled={busy || !!pending}
          onChange={(e) => setLinkId(e.target.value)}
        >
          <option value="">Выбери связанный проект</option>
          {links.value?.items
            .filter(
              (l) =>
                l.state === "accepted" &&
                l.policy.consult &&
                (l.source.id === project.id || l.policy.direction === "both"),
            )
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.source.id === project.id ? l.target?.title : l.source.title} · До{" "}
                {l.policy.depth} раундов
              </option>
            ))}
        </select>
      </label>
      <div className="shared-actions">
        {offset > 0 && (
          <button
            type="button"
            className="secondary"
            disabled={busy || !!pending}
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Предыдущие связи
          </button>
        )}
        {links.value?.nextOffset != null && (
          <button
            type="button"
            className="secondary"
            disabled={busy || !!pending}
            onClick={() => setOffset(links.value!.nextOffset!)}
          >
            Ещё связи
          </button>
        )}
      </div>
      <label>
        Тип запроса
        <select
          value={kind}
          disabled={busy || !!pending}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="consult">Консультация: только анализ и чтение</option>
          <option value="work">Предложение работы: без запуска</option>
        </select>
      </label>
      <label>
        Тема
        <input
          value={title}
          maxLength={160}
          disabled={busy || !!pending}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Вопрос и общий контекст
        <AutoTextarea
          value={question}
          maxLength={12000}
          rows={6}
          disabled={busy || !!pending}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>
      <p className="muted">
        Вопрос будет передан другой стороне. Автоматическая консультация возможна только по уже
        согласованным условиям связи; иначе потребуется согласие владельцев.
      </p>
      <button
        type="button"
        className="primary"
        disabled={busy || !linkId || !title.trim() || !question.trim()}
        onClick={submit}
      >
        {pending ? "Повторить подтверждение запроса" : "Передать запрос"}
      </button>
    </div>
  );
}
