import {
  type NotebookLink,
  type NotebookTarget,
  type PlanPage,
  type PlanWrite,
  type ProjectAction,
  type ProjectPlan,
  type ProjectReport,
  type ProjectScope,
  planWriteSchema,
  type ReportPage,
  type TaskProjectsPage,
} from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api, messageOf } from "./api";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import type { NotebookRequest } from "./Notebook";
import { actionLabels, ProjectActionPanel } from "./ProjectAction";
import { WorkspaceTabs } from "./WorkspaceTabs";
import "./notebook.css";
import "./project-work.css";

type Draft = Omit<PlanWrite, "scope"> & {
  scope: ProjectScope | null;
  id: string;
  changedAt: number;
};
const sk = (scope: ProjectScope | null) => (scope ? `${scope.client}:${scope.projectId}` : "all");
const draftKey = (id: string) => "workspace-plan-draft:" + id;
const date = (n: number) =>
  new Date(n).toLocaleString("ru", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
function localDrafts(): Draft[] {
  const values: Draft[] = [];
  for (let n = 0; n < localStorage.length; n++) {
    const key = localStorage.key(n);
    if (!key?.startsWith("workspace-plan-draft:")) continue;
    try {
      const d = JSON.parse(localStorage.getItem(key) ?? "");
      if (
        typeof d.id === "string" &&
        Array.isArray(d.sections) &&
        Array.isArray(d.links) &&
        typeof d.title === "string"
      )
        values.push(d);
    } catch {}
  }
  return values.sort((a, b) => b.changedAt - a.changedAt);
}
const move = <T,>(items: T[], index: number, delta: number) => {
  const next = [...items];
  if (index + delta < 0 || index + delta >= items.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item!);
  return next;
};
export function ProjectWorkPanel({
  request,
  onClose,
  onOpen,
  onRequest,
}: {
  request: NotebookRequest;
  onClose: () => void;
  onOpen: (target: NotebookLink) => void;
  onRequest: (request: NotebookRequest) => void;
}) {
  const mode = request.mode === "reports" ? "reports" : "plans";
  const dialog = useRef<HTMLDialogElement>(null),
    mounted = useRef(true),
    generation = useRef(0),
    editor = useRef<HTMLElement>(null),
    loadedFilter = useRef("");
  const [scope, setScope] = useState(request.allProjects ? "all" : sk(request.scope)),
    [projects, setProjects] = useState<TaskProjectsPage>({ items: [], nextOffset: null }),
    [plans, setPlans] = useState<PlanPage>({ items: [], nextOffset: null }),
    [reports, setReports] = useState<ReportPage>({ items: [], nextOffset: null }),
    [actions, setActions] = useState<ProjectAction[]>([]),
    [query, setQuery] = useState(""),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [draft, setDraft] = useState<Draft | null>(null),
    [drafts, setDrafts] = useState<Draft[]>([]),
    [dirty, setDirty] = useState(false),
    [report, setReport] = useState<ProjectReport | null>(null),
    [action, setAction] = useState<ProjectAction | null>(null),
    [conflict, setConflict] = useState<ProjectPlan | null>(null),
    [confirm, setConfirm] = useState<{
      kind: "plan" | "section";
      id: string;
      title: string;
    } | null>(null),
    [references, setReferences] = useState<NotebookTarget[] | null>(null),
    [filePath, setFilePath] = useState("");
  const selectedScope =
    projects.items.find((p) => sk(p.scope) === scope)?.scope ??
    (sk(request.scope) === scope ? request.scope : null);
  const refreshDrafts = useCallback(() => {
    try {
      setDrafts(localDrafts());
    } catch {
      setError("Не удалось прочитать черновики на устройстве.");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    refreshDrafts();
    return () => {
      mounted.current = false;
      generation.current++;
      dialog.current?.close();
    };
  }, [refreshDrafts]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Page refresh reads bounded Hub metadata; it never touches a native writer.
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void Promise.all([
        api<TaskProjectsPage>("/workspace/projects", { signal: abort.signal }),
        api<PlanPage | ReportPage>(
          `/workspace/${mode}?scope=${encodeURIComponent(scope)}${mode === "plans" ? "&q=" + encodeURIComponent(query) : ""}`,
          { signal: abort.signal },
        ),
        api<{ items: ProjectAction[] }>("/workspace/actions?scope=" + encodeURIComponent(scope), {
          signal: abort.signal,
        }),
      ])
        .then(([catalog, page, runs]) => {
          if (abort.signal.aborted) return;
          setProjects((old) => ({
            items: [
              ...catalog.items,
              ...old.items.filter((p) => !catalog.items.some((n) => sk(n.scope) === sk(p.scope))),
            ],
            nextOffset: old.items.length > 100 ? old.nextOffset : catalog.nextOffset,
          }));
          const filter = mode + ":" + scope + ":" + query;
          const same = loadedFilter.current === filter;
          loadedFilter.current = filter;
          const merge = <T extends { id: string }>(
            old: { items: T[]; nextOffset: number | null },
            next: { items: T[]; nextOffset: number | null },
          ) => {
            const tail = same
              ? old.items.slice(30).filter((item) => !next.items.some((n) => n.id === item.id))
              : [];
            return {
              items: [...next.items, ...tail],
              nextOffset: tail.length ? old.nextOffset : next.nextOffset,
            };
          };
          if (mode === "plans") setPlans((old) => merge(old, page as PlanPage));
          else setReports((old) => merge(old, page as ReportPage));
          setActions(runs.items);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(messageOf(e));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 120);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [scope, mode, query, revision]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) setRevision((n) => n + 1);
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("workspace-change", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("workspace-change", refresh);
      window.removeEventListener("online", refresh);
    };
  }, []);
  const keep = (next: Draft) => {
    setDraft(next);
    setDirty(true);
    setStatus("");
    try {
      localStorage.setItem(draftKey(next.id), JSON.stringify(next));
      refreshDrafts();
    } catch {
      setError("Черновик не удалось сохранить на устройстве. Сохрани план перед закрытием.");
    }
  };
  const change = (patch: Partial<Draft>) => {
    if (draft) keep({ ...draft, ...patch, changedAt: Date.now() });
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const version = generation.current;
    try {
      await fn();
    } catch (e) {
      if (mounted.current && generation.current === version) setError(messageOf(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const load = async (id: string) => {
    const version = ++generation.current;
    setAction(null);
    setConfirm(null);
    setConflict(null);
    setReferences(null);
    setError("");
    if (mode === "reports") {
      const value = await api<ProjectReport>("/workspace/reports/" + id);
      if (mounted.current && generation.current === version) setReport(value);
      return;
    }
    let local: Draft | undefined;
    try {
      local = localDrafts().find((d) => d.id === id);
    } catch {}
    if (local) {
      setDraft(local);
      setDirty(true);
    }
    try {
      const value = await api<ProjectPlan>("/workspace/plans/" + id);
      if (!mounted.current || generation.current !== version) return;
      if (!local) {
        setDraft({ ...value, changedAt: value.updatedAt });
        setDirty(false);
      } else if (value.revision !== local.revision) setConflict(value);
    } catch (e) {
      if (!local) throw e;
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit source selection is consumed once, not on each metadata poll.
  useEffect(() => {
    if (request.itemId) void load(request.itemId).catch((e) => setError(messageOf(e)));
  }, [request.itemId]);
  const create = () => {
    setReport(null);
    setAction(null);
    setConflict(null);
    setConfirm(null);
    setReferences(null);
    const value: Draft = {
      id: crypto.randomUUID(),
      scope: selectedScope ?? request.scope,
      title: "",
      description: "",
      sections: [{ id: crypto.randomUUID(), title: "Что сделать", items: [] }],
      links: [],
      status: "draft",
      revision: 0,
      changedAt: Date.now(),
    };
    keep(value);
  };
  const save = async (overwrite?: number, asNew = false): Promise<ProjectPlan> => {
    if (!draft) throw Error("Открой план.");
    const sent = planWriteSchema.parse({
      scope: draft.scope,
      title: draft.title,
      description: draft.description,
      sections: draft.sections.map((s) => ({ ...s, items: s.items.filter((i) => i.text.trim()) })),
      links: draft.links,
      status: draft.status,
      revision: asNew ? 0 : (overwrite ?? draft.revision),
    });
    const id = asNew ? crypto.randomUUID() : draft.id;
    const submittedDraft = { ...draft, ...sent, id };
    const beforeSave = JSON.stringify(draft);
    const version = generation.current;
    keep(submittedDraft);
    try {
      const value = await api<ProjectPlan>("/workspace/plans/" + id, { method: "PUT", body: sent });
      try {
        if (localStorage.getItem(draftKey(id)) === JSON.stringify(submittedDraft))
          localStorage.removeItem(draftKey(id));
        if (asNew && localStorage.getItem(draftKey(draft.id)) === beforeSave)
          localStorage.removeItem(draftKey(draft.id));
      } catch {}
      if (mounted.current && generation.current === version) {
        setDraft({ ...value, changedAt: value.updatedAt });
        setDirty(false);
        setConflict(null);
        setStatus("Сохранено");
        refreshDrafts();
        setRevision((n) => n + 1);
      }
      return value;
    } catch (e) {
      if (e instanceof ApiError && e.code === "PLAN_CONFLICT") {
        const current = await api<ProjectPlan>("/workspace/plans/" + id);
        if (mounted.current) setConflict(current);
      }
      throw e;
    }
  };
  const prepare = async (kind: "plan" | "report", plan?: ProjectPlan) => {
    const target = plan?.scope ?? selectedScope ?? request.scope;
    if (!target) throw Error("Выбери проект.");
    const body = {
      scope: target,
      kind,
      ...(plan ? { planId: plan.id, planRevision: plan.revision } : {}),
    };
    const key = `workspace-prepare:${sk(target)}:${kind}:${plan?.id ?? ""}`,
      signature = JSON.stringify(body);
    let id = crypto.randomUUID();
    try {
      const old = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      if (old.signature === signature && old.id) id = old.id;
      else sessionStorage.setItem(key, JSON.stringify({ signature, id }));
    } catch {}
    let next = await api<ProjectAction>("/workspace/actions/" + id, { method: "PUT", body });
    if (["completed", "cancelled", "failed"].includes(next.state)) {
      id = crypto.randomUUID();
      try {
        sessionStorage.setItem(key, JSON.stringify({ signature, id }));
      } catch {}
      next = await api<ProjectAction>("/workspace/actions/" + id, { method: "PUT", body });
    }
    if (mounted.current) {
      setAction(next);
      requestAnimationFrame(() => editor.current?.scrollTo({ top: 0 }));
    }
  };
  const actionChanged = useCallback((value: ProjectAction) => {
    if (mounted.current) {
      setAction(value);
      setActions((old) => [value, ...old.filter((a) => a.id !== value.id)]);
      setRevision((n) => n + 1);
    }
  }, []);
  const openLink = async (target: NotebookTarget) => {
    const value = await api<NotebookLink>("/workspace/resolve", { method: "POST", body: target });
    if (value.availability === "missing") throw Error("Источник удалён. Ссылка сохранена.");
    onOpen(value);
  };
  const editing = !!draft || !!report || !!action;
  const choices = new Map(projects.items.map((p) => [sk(p.scope), p.scope]));
  if (request.scope && !choices.has(sk(request.scope)))
    choices.set(sk(request.scope), request.scope);
  if (draft?.scope && !choices.has(sk(draft.scope))) choices.set(sk(draft.scope), draft.scope);
  const setSections = (sections: PlanWrite["sections"]) => change({ sections });
  const orderMenu = (
    label: string,
    index: number,
    count: number,
    onMove: (delta: number) => void,
    onDelete: () => void,
  ) => (
    <details className="plan-order">
      <summary aria-label={label}>
        <Icon name="more" />
      </summary>
      <div>
        <button type="button" disabled={busy || index === 0} onClick={() => onMove(-1)}>
          <Icon name="arrow-up" size={16} />
          Поднять
        </button>
        <button type="button" disabled={busy || index === count - 1} onClick={() => onMove(1)}>
          <Icon name="arrow-up" size={16} style={{ transform: "rotate(180deg)" }} />
          Опустить
        </button>
        <button type="button" className="danger" disabled={busy} onClick={onDelete}>
          <Icon name="trash" size={16} />
          Удалить
        </button>
      </div>
    </details>
  );
  return createPortal(
    <dialog
      ref={dialog}
      className="notebook-dialog project-work-dialog"
      aria-label={mode === "plans" ? "Планы" : "Отчёты"}
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="notebook-heading">
        <Icon name={mode === "plans" ? "plan" : "report"} />
        <strong>{mode === "plans" ? "Планы" : "Отчёты"}</strong>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label="Закрыть рабочий раздел"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <WorkspaceTabs
        mode={mode}
        disabled={busy}
        onChange={(next) =>
          onRequest({
            ...request,
            mode: next,
            itemId: undefined,
            scope: selectedScope ?? request.scope,
            allProjects: scope === "all",
          })
        }
      />
      <div className="notebook-task-controls" data-editing={editing}>
        <fieldset className="task-project-filters" aria-label="Проекты рабочего раздела">
          {[
            ["all", "Все"],
            ...[...choices].map(([key, p]) => [
              key,
              `${p.name} · ${p.client === "gpt" ? "GPT" : "Codex"}`,
            ]),
          ].map(([key, name]) => (
            <button
              type="button"
              key={key}
              aria-pressed={scope === key}
              disabled={busy}
              onClick={() => setScope(key!)}
            >
              {name}
            </button>
          ))}
          {projects.nextOffset !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await api<TaskProjectsPage>(
                    "/workspace/projects?offset=" + projects.nextOffset,
                  );
                  setProjects((old) => ({
                    items: [...old.items, ...next.items],
                    nextOffset: next.nextOffset,
                  }));
                })
              }
            >
              Ещё проекты
            </button>
          )}
        </fieldset>
        <button
          type="button"
          className="icon-button"
          aria-label={mode === "plans" ? "Новый план" : "Подготовить отчёт"}
          disabled={busy}
          onClick={() => (mode === "plans" ? create() : void run(() => prepare("report")))}
        >
          <Icon name={mode === "plans" ? "plus" : "report"} />
        </button>
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {status && (
        <p className="notebook-status" role="status">
          {status}
        </p>
      )}
      <div className="notebook-layout" data-editing={editing}>
        <aside
          className="notebook-list"
          aria-label={mode === "plans" ? "Список планов" : "История отчётов"}
        >
          {mode === "plans" ? (
            <>
              <input
                type="search"
                placeholder="Найти план…"
                aria-label="Найти план"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {drafts
                .filter(
                  (d) =>
                    (scope === "all" || sk(d.scope) === scope) &&
                    d.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                )
                .map((d) => (
                  <div className="notebook-row" key={d.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        generation.current++;
                        setDraft(d);
                        setDirty(true);
                        setAction(null);
                        setConflict(null);
                      }}
                    >
                      {d.title || "Без названия"}
                      <small>Черновик · {d.scope?.name ?? "Выбери проект"}</small>
                    </button>
                  </div>
                ))}
              {plans.items
                .filter((p) => !drafts.some((d) => d.id === p.id))
                .map((p) => (
                  <div
                    className="notebook-row plan-list-row"
                    data-selected={draft?.id === p.id}
                    key={p.id}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => load(p.id))}
                    >
                      <span className="work-row-heading">
                        <b>{p.title}</b>
                        {p.latestAction &&
                          ["running", "queued", "dispatching"].includes(p.latestAction.state) && (
                            <span className="spinner" />
                          )}
                      </span>
                      <small>
                        {p.scope.name} · {p.checked}/{p.total}
                        {p.status === "done" ? " · Выполнен" : ""}
                      </small>
                      <span className="plan-meter">
                        <span style={{ width: `${p.total ? (100 * p.checked) / p.total : 0}%` }} />
                      </span>
                      {p.latestAction && <small>{actionLabels[p.latestAction.state]}</small>}
                    </button>
                  </div>
                ))}
            </>
          ) : (
            <>
              {actions
                .filter(
                  (a) =>
                    a.kind === "report" &&
                    !(["completed", "cancelled"] as string[]).includes(a.state),
                )
                .map((a) => (
                  <div className="notebook-row" key={a.id}>
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          setAction(await api<ProjectAction>("/workspace/actions/" + a.id));
                          setReport(null);
                        })
                      }
                    >
                      <b>{a.scope.name}</b>
                      <small>{actionLabels[a.state]}</small>
                    </button>
                  </div>
                ))}
              {reports.items.map((item) => (
                <div className="notebook-row" key={item.id} data-selected={report?.id === item.id}>
                  <button type="button" onClick={() => void run(() => load(item.id))}>
                    <span className="report-date">{date(item.createdAt)}</span>
                    <b>{item.scope.name}</b>
                    <small>{item.periodFrom ? `С ${date(item.periodFrom)}` : "Первый отчёт"}</small>
                  </button>
                </div>
              ))}
            </>
          )}
          {loading && (
            <p role="status">
              <span className="spinner" /> Загружаю…
            </p>
          )}
          {!loading &&
            !(mode === "plans"
              ? plans.items.length || drafts.length
              : reports.items.length || actions.some((a) => a.kind === "report")) && (
              <p className="muted">
                {mode === "plans" ? "Пока нет планов." : "Здесь будет история отчётов."}
              </p>
            )}
          {(mode === "plans" ? plans.nextOffset : reports.nextOffset) !== null && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const offset = mode === "plans" ? plans.nextOffset : reports.nextOffset;
                  const next = await api<PlanPage | ReportPage>(
                    `/workspace/${mode}?scope=${encodeURIComponent(scope)}&offset=${offset}${mode === "plans" ? "&q=" + encodeURIComponent(query) : ""}`,
                  );
                  if (mode === "plans")
                    setPlans((old) => ({
                      items: [...old.items, ...(next as PlanPage).items],
                      nextOffset: next.nextOffset,
                    }));
                  else
                    setReports((old) => ({
                      items: [...old.items, ...(next as ReportPage).items],
                      nextOffset: next.nextOffset,
                    }));
                })
              }
            >
              Загрузить ещё
            </button>
          )}
        </aside>
        <section
          className="notebook-editor work-editor"
          ref={editor}
          aria-label={mode === "plans" ? "Редактор плана" : "Просмотр отчёта"}
        >
          {editing && (
            <button
              type="button"
              className="icon-button notebook-back"
              aria-label="К списку"
              disabled={busy}
              onClick={() => {
                generation.current++;
                setDraft(null);
                setReport(null);
                setAction(null);
                setConflict(null);
                setReferences(null);
                setConfirm(null);
              }}
            >
              <Icon name="back" />
            </button>
          )}
          {action && (
            <ProjectActionPanel
              initial={action}
              onChange={actionChanged}
              onOpen={onOpen}
              onClose={() => setAction(null)}
            />
          )}
          {mode === "plans" && draft ? (
            <>
              <div className="notebook-editor-tools">
                <select
                  aria-label="Проект плана"
                  value={draft.scope ? sk(draft.scope) : ""}
                  disabled={busy || draft.revision > 0}
                  onChange={(e) => change({ scope: choices.get(e.target.value) ?? null })}
                >
                  <option value="">Выбери проект</option>
                  {[...choices].map(([key, p]) => (
                    <option key={key} value={key}>
                      {p.name} · {p.client === "gpt" ? "GPT" : "Codex"}
                    </option>
                  ))}
                </select>
                <CopyButton
                  text={[
                    draft.title,
                    draft.description,
                    ...draft.sections.map(
                      (s) =>
                        s.title +
                        "\n" +
                        s.items.map((i) => `${i.checked ? "[x]" : "[ ]"} ${i.text}`).join("\n"),
                    ),
                  ].join("\n\n")}
                  label="Копировать план"
                />
              </div>
              <input
                className="notebook-title"
                aria-label="Название плана"
                placeholder="Название плана"
                maxLength={120}
                value={draft.title}
                disabled={busy}
                onChange={(e) => change({ title: e.target.value })}
              />
              <textarea
                className="plan-description"
                aria-label="Описание плана"
                placeholder="Контекст и цель…"
                rows={2}
                maxLength={6000}
                value={draft.description}
                disabled={busy}
                onChange={(e) => change({ description: e.target.value })}
              />
              <div className="plan-sections">
                {draft.sections.map((section, si) => (
                  <section className="plan-section" key={section.id} aria-label={section.title}>
                    <header>
                      <input
                        aria-label="Название раздела"
                        value={section.title}
                        maxLength={120}
                        disabled={busy}
                        onChange={(e) =>
                          setSections(
                            draft.sections.map((s) =>
                              s.id === section.id ? { ...s, title: e.target.value } : s,
                            ),
                          )
                        }
                      />
                      {orderMenu(
                        "Действия раздела " + section.title,
                        si,
                        draft.sections.length,
                        (d) => setSections(move(draft.sections, si, d)),
                        () => setConfirm({ kind: "section", id: section.id, title: section.title }),
                      )}
                    </header>
                    {section.items.map((item, ii) => (
                      <div className="plan-item" key={item.id} data-checked={item.checked}>
                        <label className="plan-check">
                          <input
                            type="checkbox"
                            aria-label={"Выполнено: " + item.text}
                            checked={item.checked}
                            disabled={busy}
                            onChange={(e) =>
                              setSections(
                                draft.sections.map((s) =>
                                  s.id === section.id
                                    ? {
                                        ...s,
                                        items: s.items.map((i) =>
                                          i.id === item.id
                                            ? { ...i, checked: e.target.checked }
                                            : i,
                                        ),
                                      }
                                    : s,
                                ),
                              )
                            }
                          />
                          <span>{item.checked && <Icon name="check" size={14} />}</span>
                        </label>
                        <textarea
                          aria-label="Пункт плана"
                          rows={1}
                          maxLength={1000}
                          placeholder="Что сделать…"
                          value={item.text}
                          disabled={busy}
                          onChange={(e) =>
                            setSections(
                              draft.sections.map((s) =>
                                s.id === section.id
                                  ? {
                                      ...s,
                                      items: s.items.map((i) =>
                                        i.id === item.id ? { ...i, text: e.target.value } : i,
                                      ),
                                    }
                                  : s,
                              ),
                            )
                          }
                        />
                        {orderMenu(
                          "Действия пункта " + (ii + 1),
                          ii,
                          section.items.length,
                          (d) =>
                            setSections(
                              draft.sections.map((s) =>
                                s.id === section.id ? { ...s, items: move(s.items, ii, d) } : s,
                              ),
                            ),
                          () =>
                            setSections(
                              draft.sections.map((s) =>
                                s.id === section.id
                                  ? { ...s, items: s.items.filter((i) => i.id !== item.id) }
                                  : s,
                              ),
                            ),
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="plan-add-item"
                      disabled={busy || section.items.length >= 50}
                      onClick={() =>
                        setSections(
                          draft.sections.map((s) =>
                            s.id === section.id
                              ? {
                                  ...s,
                                  items: [
                                    ...s.items,
                                    { id: crypto.randomUUID(), text: "", checked: false },
                                  ],
                                }
                              : s,
                          ),
                        )
                      }
                    >
                      <Icon name="plus" size={16} /> Добавить пункт
                    </button>
                  </section>
                ))}
              </div>
              <button
                type="button"
                className="secondary plan-add-section"
                disabled={busy || draft.sections.length >= 20}
                onClick={() =>
                  setSections([
                    ...draft.sections,
                    { id: crypto.randomUUID(), title: "Новый раздел", items: [] },
                  ])
                }
              >
                <Icon name="plus" />
                Добавить раздел
              </button>
              <div className="plan-references">
                {draft.links.map((link, i) => (
                  <div key={link.kind + link.id}>
                    <button type="button" onClick={() => void run(() => openLink(link))}>
                      <Icon name="file" size={16} />
                      {link.title}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={"Убрать ссылку " + link.title}
                      onClick={() => change({ links: draft.links.filter((_, n) => n !== i) })}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !draft.scope || draft.links.length >= 8}
                  onClick={() =>
                    void run(async () => {
                      const target = draft.scope!;
                      const q = new URLSearchParams({
                        client: target.client,
                        projectId: target.projectId,
                      });
                      setReferences(
                        (await api<{ items: NotebookTarget[] }>("/workspace/references?" + q))
                          .items,
                      );
                    })
                  }
                >
                  <Icon name="plus" size={16} />
                  Добавить контекст
                </button>
                {references && (
                  <section className="reference-picker" aria-label="Контекст плана">
                    <header>
                      <strong>Заметки, отчёты и результаты</strong>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Закрыть выбор контекста"
                        onClick={() => setReferences(null)}
                      >
                        <Icon name="close" />
                      </button>
                    </header>
                    {references
                      .filter(
                        (link) =>
                          !draft.links.some((l) => l.id === link.id && l.kind === link.kind),
                      )
                      .map((link) => (
                        <button
                          type="button"
                          key={link.kind + link.id}
                          onClick={() => {
                            change({ links: [...draft.links, link] });
                            setReferences(null);
                          }}
                        >
                          <Icon
                            name={
                              link.kind === "report"
                                ? "report"
                                : link.kind === "thread"
                                  ? "chat"
                                  : "file"
                            }
                            size={16}
                          />
                          {link.title}
                        </button>
                      ))}
                    {draft.scope?.client === "codex" && (
                      <div className="reference-file">
                        <input
                          aria-label="Путь к файлу проекта"
                          placeholder="Путь к файлу проекта"
                          value={filePath}
                          onChange={(e) => setFilePath(e.target.value)}
                          maxLength={2048}
                        />
                        <button
                          type="button"
                          className="icon-button"
                          disabled={!filePath.trim()}
                          aria-label="Добавить файл в контекст"
                          onClick={() => {
                            change({
                              links: [
                                ...draft.links,
                                {
                                  client: "codex",
                                  kind: "file",
                                  id: filePath.trim(),
                                  title: filePath.trim().split(/[\\/]/).at(-1)!.slice(0, 200),
                                  projectId: draft.scope!.projectId,
                                },
                              ],
                            });
                            setReferences(null);
                            setFilePath("");
                          }}
                        >
                          <Icon name="plus" />
                        </button>
                      </div>
                    )}
                  </section>
                )}
              </div>
              {conflict && (
                <div className="notice" role="alert">
                  <p>На другом устройстве есть новая версия плана.</p>
                  <details>
                    <summary>Посмотреть её</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          title: conflict.title,
                          description: conflict.description,
                          sections: conflict.sections.map((s) => ({
                            title: s.title,
                            items: s.items.map((i) => `${i.checked ? "[x]" : "[ ]"} ${i.text}`),
                          })),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await save(conflict.revision);
                      })
                    }
                  >
                    Сохранить мой вариант
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await save(undefined, true);
                      })
                    }
                  >
                    Сохранить как новый
                  </button>
                </div>
              )}
              <label className="plan-owner-status">
                <input
                  type="checkbox"
                  checked={draft.status === "done"}
                  disabled={busy}
                  onChange={(e) => change({ status: e.target.checked ? "done" : "draft" })}
                />
                План выполнен
              </label>
              {confirm ? (
                <div className="notice" role="alert">
                  <p>
                    Удалить {confirm.kind === "plan" ? "план" : "раздел"} «
                    {confirm.title || "Без названия"}»?
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (confirm.kind === "section")
                          setSections(draft.sections.filter((s) => s.id !== confirm.id));
                        else {
                          if (draft.revision)
                            await api("/workspace/plans/" + draft.id, {
                              method: "DELETE",
                              body: { revision: draft.revision, confirm: true },
                            });
                          try {
                            localStorage.removeItem(draftKey(draft.id));
                          } catch {}
                          setDraft(null);
                          refreshDrafts();
                          setRevision((n) => n + 1);
                        }
                        setConfirm(null);
                      })
                    }
                  >
                    Удалить
                  </button>
                </div>
              ) : (
                <footer className="notebook-save plan-save">
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label="Удалить план"
                    disabled={busy}
                    onClick={() => setConfirm({ kind: "plan", id: draft.id, title: draft.title })}
                  >
                    <Icon name="trash" />
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !draft.title.trim() || !draft.scope || !!conflict}
                    onClick={() =>
                      void run(async () => {
                        await save();
                      })
                    }
                  >
                    <Icon name="check" size={16} />
                    {dirty ? "Сохранить" : "Сохранено"}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      busy ||
                      !draft.title.trim() ||
                      !draft.scope ||
                      !!conflict ||
                      draft.status === "done" ||
                      !draft.sections.some((s) => s.items.some((i) => !i.checked && i.text.trim()))
                    }
                    onClick={() =>
                      void run(async () => {
                        const p =
                          dirty || !draft.revision
                            ? await save()
                            : await api<ProjectPlan>("/workspace/plans/" + draft.id);
                        await prepare("plan", p);
                      })
                    }
                  >
                    <Icon name="play" size={16} />
                    Реализовать
                  </button>
                </footer>
              )}
              {draft.revision > 0 &&
                !action &&
                plans.items.find((p) => p.id === draft.id)?.latestAction && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(async () =>
                        setAction(
                          await api<ProjectAction>(
                            "/workspace/actions/" +
                              plans.items.find((p) => p.id === draft.id)!.latestAction!.id,
                          ),
                        ),
                      )
                    }
                  >
                    Открыть выполнение <Icon name="chevron" size={16} />
                  </button>
                )}
            </>
          ) : mode === "reports" && report ? (
            <>
              <header className="report-heading">
                <span className="report-date">{date(report.createdAt)}</span>
                <h2>{report.scope.name}</h2>
                <small>
                  {report.periodFrom
                    ? `${date(report.periodFrom)} — ${date(report.periodTo)}`
                    : "Первый отчёт о проекте"}
                </small>
                <CopyButton text={report.body} label="Копировать отчёт" />
              </header>
              <div className="notebook-markdown report-body">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre: CollapsibleCode,
                    img: ({ alt }) => <span>{alt || "Изображение"}</span>,
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {report.body}
                </Markdown>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => void run(() => openLink(report.source))}
              >
                Открыть исходный ответ <Icon name="chevron" size={16} />
              </button>
            </>
          ) : !action ? (
            <div className="notebook-empty">
              <Icon name={mode === "plans" ? "plan" : "report"} size={40} />
              <h2>{mode === "plans" ? "От идеи к выполнению" : "История работы над проектом"}</h2>
              <p>
                {mode === "plans"
                  ? "Разделы, пункты и один запуск в рабочем чате."
                  : "Что изменилось, что проверено и что дальше."}
              </p>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => (mode === "plans" ? create() : void run(() => prepare("report")))}
              >
                {mode === "plans" ? "Создать план" : "Подготовить отчёт"}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
