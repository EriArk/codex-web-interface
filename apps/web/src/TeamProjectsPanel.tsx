import type {
  ProjectScope,
  SharedInvitation,
  SharedItem,
  SharedItemKind,
  SharedItemSummary,
  SharedMember,
  SharedProject,
  SharedProjectDetail,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { accountLocalStorage as storage } from "./accountStorage";
import { api } from "./api";
import { Icon } from "./icons";
import { materialLabels, SharedMaterialEditor } from "./SharedMaterialEditor";
import { PersonalProjectPicker, SharedPublication } from "./SharedPublication";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";
import type { SharedWorkspaceTarget } from "./TeamProjectsHost";
import "./notebook.css";

const roleLabels = { owner: "Владелец", collaborator: "Участник", viewer: "Читатель" };
const activityLabels: Record<string, string> = {
  "project.created": "Создал проект",
  "project.updated": "Изменил проект",
  "project.archived": "Отправил проект в архив",
  "membership.invited": "Пригласил участника",
  "membership.joined": "Принял приглашение",
  "membership.declined": "Отклонил приглашение",
  "membership.removed": "Отозвал доступ",
  "membership.role_changed": "Изменил роль участника",
  "membership.invite_revoked": "Отозвал приглашение",
  "ownership.offered": "Предложил передачу владения",
  "ownership.accepted": "Принял владение проектом",
  "checkout.connected": "Подключил свою рабочую папку",
  "material.created": "Добавил общий материал",
  "material.updated": "Изменил общий материал",
  "material.removed": "Удалил общий материал",
};
type Page = { items: SharedProject[]; nextOffset: number | null };

export default function TeamProjectsPanel({
  target,
  onClose,
  onPersonal,
}: {
  target: SharedWorkspaceTarget;
  onClose: () => void;
  onPersonal?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [id, setId] = useState(target.projectId ?? "");
  const [revision, refresh] = useState(0),
    [offset, setOffset] = useState(0),
    [create, setCreate] = useState(false);
  const association = useSharedResource<{ project: SharedProject | null }>(
    !target.projectId && target.scope?.client === "codex"
      ? "/team/project-association?personalProjectId=" + encodeURIComponent(target.scope.projectId)
      : null,
  );
  const projects = useSharedResource<Page>(id ? null : `/team/projects?offset=${offset}`, revision);
  const invites = useSharedResource<{ items: SharedInvitation[] }>(
    id ? null : "/team/project-invitations",
    revision,
  );
  const { run, busy, error } = useSharedAction();
  useEffect(() => {
    if (association.value?.project) setId(association.value.project.id);
  }, [association.value]);
  useEffect(() => {
    const element = dialog.current,
      focus = document.activeElement as HTMLElement | null;
    element?.showModal();
    element?.focus();
    return () => {
      element?.close();
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible") refresh((n) => n + 1);
    };
    const timer = setInterval(update, 15000);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, []);
  const update = () => refresh((n) => n + 1);
  return (
    <dialog
      ref={dialog}
      className="notebook-dialog shared-projects-dialog"
      aria-labelledby="shared-project-heading"
      tabIndex={-1}
      onCancel={onClose}
    >
      <header className="notebook-heading">
        <div className="shared-toolbar">
          {id && (
            <button
              type="button"
              className="icon-button"
              aria-label="К совместным проектам"
              onClick={() => {
                setId("");
                setCreate(false);
              }}
            >
              <Icon name="back" />
            </button>
          )}
          <h2 id="shared-project-heading">Совместные проекты</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть совместные проекты"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {onPersonal && (
        <div className="shared-audience-bar">
          <strong>Общие материалы</strong>
          <button type="button" className="secondary" onClick={onPersonal}>
            Мои личные материалы
          </button>
        </div>
      )}
      {id ? (
        <SharedProjectWorkspace
          key={id}
          id={id}
          initialKind={target.kind}
          initialScope={target.scope ?? undefined}
          itemId={target.itemId}
          refreshToken={revision}
          refresh={update}
        />
      ) : (
        <div className="shared-scroll shared-form">
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          {invites.value?.items.map((invite) => (
            <article key={invite.id} className="shared-card shared-invitation">
              <h3>{invite.projectTitle}</h3>
              <p>
                {invite.ownerName}{" "}
                {invite.role === "owner"
                  ? "предлагает тебе стать владельцем проекта"
                  : "приглашает в проект"}
                . Роль: {roleLabels[invite.role]}.
              </p>
              <small>До {new Date(invite.expires).toLocaleString("ru")}</small>
              <div className="shared-actions">
                <button
                  type="button"
                  disabled={busy}
                  className="primary"
                  onClick={() =>
                    void run(() =>
                      sharedMutation<{ projectId: string }>(
                        `/team/project-invitations/${invite.id}`,
                        "POST",
                        { accept: true },
                      ),
                    ).then((value) => {
                      if (value) {
                        update();
                        setId(value.projectId);
                      }
                    })
                  }
                >
                  {invite.role === "owner" ? "Принять владение" : "Принять приглашение"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="secondary"
                  onClick={() =>
                    void run(() =>
                      sharedMutation(`/team/project-invitations/${invite.id}`, "POST", {
                        accept: false,
                      }),
                    ).then((value) => {
                      if (value) update();
                    })
                  }
                >
                  Отклонить
                </button>
              </div>
            </article>
          ))}
          {create ? (
            <NewSharedProject
              initialScope={target.scope ?? undefined}
              onCreated={(value) => {
                setCreate(false);
                setId(value.project.id);
                update();
              }}
              onCancel={() => setCreate(false)}
            />
          ) : (
            <button type="button" className="primary" onClick={() => setCreate(true)}>
              <Icon name="plus" />
              Создать совместный проект
            </button>
          )}
          {projects.error && <p role="alert">{projects.error}</p>}
          {projects.loading && !projects.value && <p role="status">Загружаем проекты…</p>}
          {projects.value?.items.length === 0 && !create && (
            <p className="muted">
              Здесь появятся твои общие проекты и принятые приглашения. У каждого участника остаются
              собственные рабочая папка и чаты.
            </p>
          )}
          <div className="shared-cards">
            {projects.value?.items.map((project) => (
              <article className="shared-card" key={project.id}>
                <h3>{project.title}</h3>
                <small>
                  {roleLabels[project.role]} ·{" "}
                  {project.archived
                    ? "В архиве"
                    : project.visibility === "private"
                      ? "Пока только для тебя"
                      : "Общий"}
                </small>
                {project.repository && (
                  <p>{project.repository.replace("https://github.com/", "")}</p>
                )}
                <button type="button" className="secondary" onClick={() => setId(project.id)}>
                  Открыть проект
                </button>
              </article>
            ))}
          </div>
          <div className="shared-actions">
            {offset > 0 && (
              <button
                type="button"
                className="secondary"
                onClick={() => setOffset(Math.max(0, offset - 30))}
              >
                Предыдущие
              </button>
            )}
            {projects.value?.nextOffset != null && (
              <button
                type="button"
                className="secondary"
                onClick={() => setOffset(projects.value!.nextOffset!)}
              >
                Следующие
              </button>
            )}
            <button type="button" className="secondary" onClick={update}>
              <Icon name="refresh" />
              Обновить
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
function NewSharedProject({
  initialScope,
  onCreated,
  onCancel,
}: {
  initialScope?: ProjectScope;
  onCreated: (d: SharedProjectDetail) => void;
  onCancel: () => void;
}) {
  const draftKey = "workspace-shared-project-create";
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(storage.getItem(draftKey) ?? "null");
      if (
        saved &&
        typeof saved.id === "string" &&
        typeof saved.title === "string" &&
        typeof saved.repository === "string" &&
        ["private", "shared"].includes(saved.visibility)
      )
        return saved as {
          id: string;
          title: string;
          repository: string;
          visibility: "private" | "shared";
        };
    } catch {}
    return {
      id: crypto.randomUUID(),
      title: initialScope?.name ?? "",
      repository: "",
      visibility: "shared" as "private" | "shared",
    };
  });
  const { run, busy, error, setError } = useSharedAction();
  const change = (next: typeof draft) => {
    setDraft(next);
    try {
      storage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError("Не удалось сохранить черновик на устройстве.");
    }
  };
  return (
    <form
      className="shared-card shared-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          storage.setItem(draftKey, JSON.stringify(draft));
          const value = await api<SharedProjectDetail>(`/team/projects/${draft.id}`, {
            method: "PUT",
            body: {
              title: draft.title.trim(),
              visibility: draft.visibility,
              repository:
                draft.repository
                  .trim()
                  .replace(/\.git\/?$/, "")
                  .replace(/\/$/, "") || null,
            },
          });
          if (storage.getItem(draftKey) === JSON.stringify(draft)) storage.removeItem(draftKey);
          return value;
        }).then((value) => {
          if (value) onCreated(value);
        });
      }}
    >
      <h2>Новый совместный проект</h2>
      <p>Ты будешь единственным владельцем. Участники получат доступ после принятия приглашения.</p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy}>
        <label>
          Название
          <input
            required
            maxLength={120}
            value={draft.title}
            onChange={(e) => change({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          Репозиторий GitHub
          <input
            type="url"
            placeholder="https://github.com/owner/repository"
            value={draft.repository}
            maxLength={260}
            onChange={(e) => change({ ...draft, repository: e.target.value })}
          />
        </label>
        <small>
          Можно оставить пустым для проекта без Git. Рабочие папки участников проверяются по этому
          репозиторию.
        </small>
        <label className="shared-check">
          <input
            type="checkbox"
            checked={draft.visibility === "private"}
            onChange={(e) =>
              change({ ...draft, visibility: e.target.checked ? "private" : "shared" })
            }
          />
          Пока подготовить только для себя
        </label>
      </fieldset>
      <div className="shared-actions">
        <button type="submit" className="primary" disabled={busy || !draft.title.trim()}>
          Создать проект
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
function SharedProjectWorkspace({
  id,
  initialKind,
  initialScope,
  itemId,
  refreshToken,
  refresh,
}: {
  id: string;
  initialKind?: SharedItemKind;
  initialScope?: ProjectScope;
  itemId?: string;
  refreshToken: number;
  refresh: () => void;
}) {
  const detail = useSharedResource<SharedProjectDetail>(`/team/projects/${id}`, refreshToken);
  const [tab, setTab] = useState<"materials" | "members" | "checkout" | "activity" | "publication">(
    "materials",
  );
  const [kind, setKind] = useState<SharedItemKind | "all">(initialKind ?? "all");
  const d = detail.value;
  if (!d)
    return (
      <div className="shared-scroll">
        <p role={detail.error ? "alert" : "status"}>{detail.error ?? "Открываем проект…"}</p>
        <button type="button" className="secondary" onClick={refresh}>
          Повторить
        </button>
      </div>
    );
  return (
    <>
      <div className="shared-project-identity">
        <strong>{d.project.title}</strong>
        <small>
          Владелец: {d.members.find((m) => m.role === "owner")?.name} · {roleLabels[d.project.role]}
          {d.project.archived ? " · Архив" : ""}
        </small>
      </div>
      <nav className="shared-tabs" aria-label="Совместный проект">
        {(
          [
            ["materials", "Материалы"],
            ["members", "Участники"],
            ["checkout", "Моя рабочая папка"],
            ["activity", "История"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="shared-scroll">
        {tab === "materials" && (
          <SharedMaterials
            detail={d}
            kind={kind}
            setKind={setKind}
            initialItemId={itemId}
            refreshToken={refreshToken}
            refresh={refresh}
            onPublish={() => setTab("publication")}
          />
        )}
        {tab === "members" && <SharedMembers detail={d} refresh={refresh} />}
        {tab === "checkout" && (
          <SharedCheckout detail={d} initialScope={initialScope} refresh={refresh} />
        )}
        {tab === "activity" && <SharedActivity id={id} revision={refreshToken} />}
        {tab === "publication" && d.project.role !== "viewer" && !d.project.archived && (
          <>
            <button type="button" className="secondary" onClick={() => setTab("materials")}>
              К материалам
            </button>
            <SharedPublication
              projectId={id}
              initialScope={initialScope}
              owner={d.project.role === "owner"}
              onDone={() => {
                refresh();
                setTab("materials");
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
function SharedMaterials({
  detail,
  kind,
  setKind,
  initialItemId,
  refreshToken,
  refresh,
  onPublish,
}: {
  detail: SharedProjectDetail;
  kind: SharedItemKind | "all";
  setKind: (k: SharedItemKind | "all") => void;
  initialItemId?: string;
  refreshToken: number;
  refresh: () => void;
  onPublish: () => void;
}) {
  const [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [edit, setEdit] = useState<{ item: SharedItem | null; kind: SharedItemKind } | null>(null);
  const base = `/team/projects/${detail.project.id}/materials`,
    { run, busy, error } = useSharedAction();
  useEffect(() => {
    if (!initialItemId) return;
    const controller = new AbortController();
    void api<SharedItem>(base + "/" + initialItemId, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setEdit({ item: value, kind: value.kind });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [base, initialItemId]);
  const page = useSharedResource<{ items: SharedItemSummary[]; nextOffset: number | null }>(
    edit ? null : base + "?" + new URLSearchParams({ kind, q: query, offset: String(offset) }),
    refreshToken,
  );
  const readonly = detail.project.role === "viewer" || detail.project.archived;
  if (edit)
    return (
      <SharedMaterialEditor
        key={edit.item?.id ?? "new-" + edit.kind}
        detail={detail}
        item={edit.item}
        kind={edit.kind}
        onBack={() => {
          setEdit(null);
          refresh();
        }}
        onSaved={() => {
          setEdit(null);
          refresh();
        }}
      />
    );
  return (
    <div className="shared-form">
      <nav className="shared-tabs" aria-label="Общие материалы">
        <button
          type="button"
          aria-pressed={kind === "all"}
          onClick={() => {
            setKind("all");
            setOffset(0);
          }}
        >
          Все
        </button>
        {Object.entries(materialLabels).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value as SharedItemKind);
              setOffset(0);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      <form
        className="shared-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q);
          setOffset(0);
        }}
      >
        <input
          type="search"
          aria-label="Найти общий материал"
          placeholder="Найти в материалах…"
          value={q}
          maxLength={200}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="secondary" type="submit">
          <Icon name="search" />
          Найти
        </button>
      </form>
      {!readonly && (
        <div className="shared-actions">
          <label>
            Создать
            <select
              value=""
              aria-label="Создать общий материал"
              onChange={(e) => setEdit({ item: null, kind: e.target.value as SharedItemKind })}
            >
              <option value="" disabled>
                Выбери тип
              </option>
              {Object.entries(materialLabels)
                .filter(([k]) => k !== "core" || detail.project.role === "owner")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <button type="button" className="secondary" onClick={onPublish}>
            Опубликовать из личного
          </button>
        </div>
      )}
      {page.error && <p role="alert">{page.error}</p>}
      {page.loading && !page.value && <p role="status">Загружаем материалы…</p>}
      {!page.value?.items.length && page.value && (
        <p className="muted">
          {query
            ? "Ничего не найдено."
            : "Общих материалов пока нет. Создай новую запись или выбери личные материалы для публикации."}
        </p>
      )}
      <div className="shared-material-list">
        {page.value?.items.map((item) => (
          <button
            type="button"
            key={item.id}
            disabled={busy}
            onClick={() =>
              void run(() => api<SharedItem>(base + "/" + item.id)).then((value) => {
                if (value) setEdit({ item: value, kind: value.kind });
              })
            }
          >
            <strong>{item.title}</strong>
            <small>
              {materialLabels[item.kind]} · {item.editorName} ·{" "}
              {new Date(item.updatedAt).toLocaleDateString("ru")}
              {item.assigneeId
                ? " · " +
                  (detail.members.find((m) => m.userId === item.assigneeId)?.name ??
                    "Исполнитель недоступен")
                : ""}
            </small>
            {item.excerpt && <p>{item.excerpt}</p>}
          </button>
        ))}
      </div>
      <div className="shared-actions">
        {offset > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Предыдущие
          </button>
        )}
        {page.value?.nextOffset != null && (
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(page.value!.nextOffset!)}
          >
            Следующие
          </button>
        )}
        <button type="button" className="secondary" onClick={refresh}>
          Обновить
        </button>
      </div>
    </div>
  );
}
function SharedMembers({ detail, refresh }: { detail: SharedProjectDetail; refresh: () => void }) {
  const { project, members } = detail,
    base = `/team/projects/${project.id}`;
  const [login, setLogin] = useState(""),
    [role, setRole] = useState<"collaborator" | "viewer">("collaborator"),
    [confirmation, setConfirmation] = useState<{
      member: SharedMember;
      action: "remove" | "owner";
    } | null>(null),
    [title, setTitle] = useState(project.title),
    [message, setMessage] = useState("");
  const { run, busy, error } = useSharedAction();
  const mutate = (path: string, method: string, body: unknown) =>
    void run(() => sharedMutation(path, method, body)).then((value) => {
      if (value) {
        setConfirmation(null);
        setMessage("Сохранено");
        refresh();
      }
    });
  return (
    <div className="shared-form">
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {members.map((member) => (
        <div className="shared-row" key={member.userId}>
          <div>
            <strong>{member.name}</strong>
            <small>
              {member.login} · {roleLabels[member.role]}
              {member.state === "disabled" ? " · Доступ к приложению отключён" : ""} ·{" "}
              {member.checkoutReady ? "Рабочая папка подключена" : "Рабочая папка не подключена"}
            </small>
          </div>
          {project.role === "owner" && member.role !== "owner" && (
            <div className="shared-actions">
              <select
                aria-label={`Роль ${member.name}`}
                value={member.role}
                disabled={busy}
                onChange={(e) =>
                  mutate(base + "/members/" + member.userId, "PATCH", {
                    revision: member.revision,
                    role: e.target.value,
                    remove: false,
                  })
                }
              >
                <option value="viewer">Читатель</option>
                <option value="collaborator">Участник</option>
              </select>
              <button
                type="button"
                disabled={busy}
                className="secondary"
                onClick={() => setConfirmation({ member, action: "owner" })}
              >
                Передать владение
              </button>
              <button
                type="button"
                disabled={busy}
                className="danger"
                onClick={() => setConfirmation({ member, action: "remove" })}
              >
                Отозвать доступ
              </button>
            </div>
          )}
        </div>
      ))}
      {confirmation && (
        <div className="shared-card" role="alert">
          <p>
            {confirmation.action === "owner"
              ? `Предложить ${confirmation.member.name} стать единственным владельцем «${project.title}»? После принятия приглашения ты останешься участником.`
              : `Отозвать у ${confirmation.member.name} доступ к «${project.title}»? Сохранённые материалы и авторство останутся.`}
          </p>
          <div className="shared-actions">
            <button
              type="button"
              disabled={busy}
              className="secondary"
              onClick={() => setConfirmation(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={busy}
              className="primary"
              onClick={() =>
                confirmation.action === "owner"
                  ? mutate(base + "/invitations", "POST", {
                      login: confirmation.member.login,
                      role: "owner",
                      revision: project.revision,
                    })
                  : mutate(base + "/members/" + confirmation.member.userId, "PATCH", {
                      revision: confirmation.member.revision,
                      role: confirmation.member.role,
                      remove: true,
                    })
              }
            >
              Подтвердить
            </button>
          </div>
        </div>
      )}
      {project.role === "owner" && (
        <>
          {!!detail.invitations?.length && (
            <section className="shared-card">
              <h3>Ожидают ответа</h3>
              {detail.invitations.map((invite) => (
                <div className="shared-row" key={invite.id}>
                  <div>
                    <strong>{invite.name}</strong>
                    <small>
                      {roleLabels[invite.role]} · До{" "}
                      {new Date(invite.expires).toLocaleDateString("ru")}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => mutate(base + "/invitations/" + invite.id, "DELETE", undefined)}
                  >
                    Отозвать приглашение
                  </button>
                </div>
              ))}
            </section>
          )}
          {!project.archived && project.visibility === "shared" && (
            <form
              className="shared-card shared-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  sharedMutation(base + "/invitations", "POST", {
                    login: login.trim().toLowerCase(),
                    role,
                    revision: project.revision,
                  }),
                ).then((value) => {
                  if (value) {
                    setLogin("");
                    setMessage("Приглашение появится у участника в совместных проектах.");
                    refresh();
                  }
                });
              }}
            >
              <h3>Пригласить участника</h3>
              <label>
                Логин в CodexWeb
                <input
                  required
                  value={login}
                  maxLength={40}
                  disabled={busy}
                  onChange={(e) => setLogin(e.target.value)}
                />
              </label>
              <label>
                Роль
                <select
                  value={role}
                  disabled={busy}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                >
                  <option value="collaborator">Участник — читает и редактирует</option>
                  <option value="viewer">Читатель — только просмотр</option>
                </select>
              </label>
              <button type="submit" disabled={busy || !login.trim()} className="primary">
                Отправить приглашение
              </button>
            </form>
          )}
          <form
            className="shared-card shared-form"
            onSubmit={(e) => {
              e.preventDefault();
              mutate(base, "PATCH", {
                title: title.trim(),
                revision: project.revision,
                archived: project.archived,
                visibility: project.visibility,
              });
            }}
          >
            <h3>Настройки проекта</h3>
            <label>
              Название
              <input
                maxLength={120}
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="shared-actions">
              <button type="submit" className="primary" disabled={busy || !title.trim()}>
                Сохранить название
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  mutate(base, "PATCH", {
                    title: project.title,
                    revision: project.revision,
                    archived: !project.archived,
                    visibility: project.visibility,
                  })
                }
              >
                {project.archived ? "Вернуть из архива" : "В архив"}
              </button>
              {project.visibility === "private" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    mutate(base, "PATCH", {
                      title: project.title,
                      revision: project.revision,
                      archived: project.archived,
                      visibility: "shared",
                    })
                  }
                >
                  Открыть приглашения
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}
function SharedCheckout({
  detail,
  initialScope,
  refresh,
}: {
  detail: SharedProjectDetail;
  initialScope?: ProjectScope;
  refresh: () => void;
}) {
  const [scope, setScope] = useState<ProjectScope | null>(
    initialScope?.client === "codex" ? initialScope : null,
  );
  const { run, busy, error } = useSharedAction(),
    readonly = detail.project.role === "viewer" || detail.project.archived;
  return (
    <section className="shared-card shared-form">
      <h2>Моя рабочая папка</h2>
      <p>
        Каждый участник подключает свой проект Codex. Код, Git и текущий чат остаются на его
        стороне.
      </p>
      {detail.project.repository && (
        <a href={detail.project.repository} target="_blank" rel="noopener noreferrer">
          {detail.project.repository.replace("https://github.com/", "")}
        </a>
      )}
      <p>
        {detail.checkout
          ? "Рабочая папка подключена. Можно выбрать другую после завершения своей работы по общим материалам."
          : "Рабочая папка пока не подключена."}
      </p>
      {error && <p role="alert">{error}</p>}
      {!readonly && (
        <>
          <PersonalProjectPicker codexOnly value={scope} disabled={busy} onChange={setScope} />
          <button
            type="button"
            className="primary"
            disabled={busy || !scope}
            onClick={() =>
              void run(() =>
                sharedMutation(`/team/projects/${detail.project.id}/checkout`, "PUT", {
                  revision: detail.checkout?.revision ?? 0,
                  personalProjectId: scope!.projectId,
                }),
              ).then((value) => {
                if (value) refresh();
              })
            }
          >
            {busy ? "Проверяем папку и репозиторий…" : "Проверить и подключить"}
          </button>
          <small>
            Если папки ещё нет, сначала создай или подключи её обычным мастером «Новый проект» в
            Codex.
          </small>
        </>
      )}
    </section>
  );
}
function SharedActivity({ id, revision }: { id: string; revision: number }) {
  const [before, setBefore] = useState<number | null>(null);
  const page = useSharedResource<{
    items: { seq: number; actorName: string; action: string; createdAt: number }[];
  }>(`/team/projects/${id}/activity${before ? "?before=" + before : ""}`, revision);
  return (
    <section className="shared-form">
      <h2>История общего проекта</h2>
      {page.error && <p role="alert">{page.error}</p>}
      {page.value?.items.map((entry) => (
        <div key={entry.seq} className="shared-row">
          <div>
            <strong>{entry.actorName}</strong>
            <p>{activityLabels[entry.action] ?? "Изменил состояние проекта"}</p>
            <small>{new Date(entry.createdAt).toLocaleString("ru")}</small>
          </div>
        </div>
      ))}
      <div className="shared-actions">
        {before && (
          <button type="button" className="secondary" onClick={() => setBefore(null)}>
            К последним событиям
          </button>
        )}
        {page.value?.items.length === 40 && (
          <button
            type="button"
            className="secondary"
            onClick={() => setBefore(page.value!.items.at(-1)!.seq)}
          >
            Раньше
          </button>
        )}
      </div>
    </section>
  );
}
