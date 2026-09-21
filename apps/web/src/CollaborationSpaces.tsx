import type {
  CollaborationAccess,
  CollaborationInvitation,
  CollaborationKind,
  CollaborationSpace,
  TeamContact,
} from "@codex-web/shared";
import { useEffect, useId, useRef, useState } from "react";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { Icon } from "./icons";
import { SpaceProjects } from "./SpaceProjects";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { TeamContactPicker } from "./TeamContactPicker";
import type { Project } from "./types";
import type { SpacesController } from "./useCollaborationSpaces";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./collaboration-spaces.css";

const accessLabels = {
  owner: "Владелец",
  collaborate: "Совместная работа",
  direct: "Прямая работа",
};
export function SpaceModeControl({ spaces }: { spaces: SpacesController }) {
  const cap = useId();
  if (!spaces.enabled) return null;
  return (
    <button
      type="button"
      className="icon-button space-mode-toggle"
      aria-label={spaces.mode === "spaces" ? "Личные проекты" : "Общие пространства"}
      aria-pressed={spaces.mode === "spaces"}
      title={spaces.mode === "spaces" ? "Личные проекты" : "Общие пространства"}
      onClick={() => spaces.setMode(spaces.mode === "spaces" ? "personal" : "spaces")}
    >
      <svg viewBox="0 0 64 60" aria-hidden="true" className="space-triangle-cap">
        <defs>
          <linearGradient id={cap} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="space-cap-top" />
            <stop offset="1" className="space-cap-bottom" />
          </linearGradient>
        </defs>
        <path className="space-cap-rim" d="M10 4H54Q62 4 58 12L38 51Q32 62 26 51L6 12Q2 4 10 4Z" />
        <path
          className="space-cap-face"
          fill={`url(#${cap})`}
          transform="translate(32 28) scale(.85) translate(-32 -28)"
          d="M10 4H54Q62 4 58 12L38 51Q32 62 26 51L6 12Q2 4 10 4Z"
        />
        <path className="space-cap-shine" d="M15 10H49" />
      </svg>
      <span className="space-cap-icon">
        <Icon name="people" size={24} />
      </span>
    </button>
  );
}
export function SpaceBell({ spaces }: { spaces: SpacesController }) {
  if (!spaces.enabled) return null;
  const count =
    spaces.catalog.invitations.length +
    spaces.catalog.spaces.reduce(
      (sum, s) =>
        sum +
        s.projects.reduce((n, p) => n + (p.ownerId === pageWorkspace ? p.requests.length : 0), 0),
      0,
    );
  return (
    <button
      type="button"
      className="space-bell"
      aria-label={`Уведомления${count ? `: ${count}` : ""}`}
      onClick={() => spaces.open({ kind: "invitations" })}
    >
      <Icon name="bell" size={17} />
      <span>Уведомления</span>
      {count > 0 && <small>{count}</small>}
    </button>
  );
}
export function SpaceCards({ spaces, query }: { spaces: SpacesController; query: string }) {
  const selected = spaces.catalog.spaces.find((s) => s.id === spaces.selectedId);
  return (
    <div className="space-navigation">
      <div className="nav-label">
        {selected ? (
          <button className="space-back" type="button" onClick={() => spaces.select("")}>
            <Icon name="back" size={16} />
            Общие
          </button>
        ) : (
          "Общие"
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={selected ? "Настройки пространства" : "Создать пространство"}
          onClick={() =>
            spaces.open(selected ? { kind: "settings", id: selected.id } : { kind: "create" })
          }
        >
          <Icon name={selected ? "settings" : "plus"} size={18} />
        </button>
      </div>
      {selected ? (
        <div className="space-selected">
          <strong>{selected.title}</strong>
          <small>{selected.members.map((m) => m.name).join(" · ")}</small>
          {selected.pending.length > 0 && (
            <small>Приглашены: {selected.pending.map((p) => p.name).join(", ")}</small>
          )}
          {selected.projects
            .filter((p) => !p.personalProjectId)
            .map((p) => (
              <div className="space-related" key={p.id}>
                <Icon name="repository" size={16} />
                <span>
                  {p.name}
                  <small>{accessLabels[p.access]}</small>
                </span>
              </div>
            ))}
        </div>
      ) : (
        <>
          {!spaces.ready && <p className="nav-empty">Загружаем пространства…</p>}
          {spaces.catalog.spaces
            .filter((s) =>
              `${s.title} ${s.projects.map((p) => p.name).join(" ")}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            )
            .map((s) => (
              <button
                type="button"
                key={s.id}
                className="space-card"
                onClick={() => spaces.select(s.id)}
              >
                <strong>{s.title}</strong>
                <span>{s.members.map((m) => m.name).join(" · ")}</span>
                <small>{s.projects.map((p) => p.name).join(" / ")}</small>
              </button>
            ))}
          {spaces.ready && !spaces.catalog.spaces.length && (
            <p className="nav-empty">Создай пространство и пригласи участника.</p>
          )}
        </>
      )}
    </div>
  );
}

export function CollaborationWindow({
  spaces,
  projects,
  onNewProject,
  createdProjectId,
}: {
  spaces: SpacesController;
  projects: Project[];
  onNewProject: () => void;
  createdProjectId: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const target = spaces.window!;
  const invitation =
    "id" in target ? spaces.catalog.invitations.find((i) => i.spaceId === target.id) : undefined;
  const space = "id" in target ? spaces.catalog.spaces.find((s) => s.id === target.id) : undefined;
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="space-dialog workspace-window"
      aria-label={target.kind === "create" ? "Новое пространство" : "Общее пространство"}
      onCancel={() => spaces.open(null)}
    >
      <header className="panel-heading notebook-heading">
        <h2>
          {target.kind === "create"
            ? "Новое пространство"
            : target.kind === "invitations"
              ? "Уведомления"
              : (space?.title ?? invitation?.title ?? "Общее пространство")}
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть пространство"
          onClick={() => spaces.open(null)}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="space-dialog-body shared-scroll">
        {target.kind === "invitations" && (
          <>
            {spaces.catalog.invitations.length === 0 &&
              !spaces.catalog.spaces.some((s) =>
                s.projects.some((p) => p.ownerId === pageWorkspace && p.requests.length),
              ) && <p>Новых уведомлений нет.</p>}
            {spaces.catalog.spaces.flatMap((s) =>
              s.projects
                .filter((p) => p.ownerId === pageWorkspace)
                .flatMap((p) =>
                  p.requests.map((userId) => (
                    <button
                      type="button"
                      className="space-card"
                      key={p.id + userId}
                      onClick={() => spaces.open({ kind: "settings", id: s.id })}
                    >
                      <strong>{p.name}</strong>
                      <span>
                        {s.members.find((m) => m.id === userId)?.name} просит прямой доступ
                      </span>
                    </button>
                  )),
                ),
            )}
            {spaces.catalog.invitations.map((i) => (
              <button
                type="button"
                className="space-card"
                key={i.spaceId}
                onClick={() => spaces.open({ kind: "accept", id: i.spaceId })}
              >
                <strong>{i.title}</strong>
                <span>{i.from.name} приглашает тебя</span>
                <small>{i.project.name}</small>
              </button>
            ))}
          </>
        )}
        {(target.kind === "create" || (target.kind === "accept" && invitation)) && (
          <SpaceWizard
            key={target.kind === "accept" ? target.id : "create"}
            spaces={spaces}
            invitation={invitation}
            projects={projects}
            onNewProject={onNewProject}
            createdProjectId={createdProjectId}
          />
        )}
        {target.kind === "settings" && space && (
          <SpaceSettings
            key={space.id}
            spaces={spaces}
            space={space}
            projects={projects}
            onNewProject={onNewProject}
            createdProjectId={createdProjectId}
          />
        )}
      </div>
    </dialog>
  );
}
function AccessPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CollaborationAccess;
  onChange: (v: CollaborationAccess) => void;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as CollaborationAccess)}
      >
        <option value="collaborate">Совместная работа</option>
        <option value="direct">Прямая работа</option>
      </select>
    </label>
  );
}
function SpaceWizard({
  spaces,
  invitation,
  projects,
  onNewProject,
  createdProjectId,
}: {
  spaces: SpacesController;
  invitation?: CollaborationInvitation;
  projects: Project[];
  onNewProject: () => void;
  createdProjectId: string;
}) {
  const [step, setStep] = useState(0),
    [kind, setKind] = useState<CollaborationKind>(invitation?.kind ?? "project");
  const [title, setTitle] = useState(invitation?.title ?? ""),
    [person, setPerson] = useState<TeamContact | null>(null);
  const [projectId, setProjectId] = useState("");
  const [access, setAccess] = useState<CollaborationAccess>(
    invitation?.requestedAccess ?? "collaborate",
  );
  const [requestedAccess, setRequestedAccess] = useState<CollaborationAccess>("collaborate");
  const action = useSharedAction();
  const initialCreated = useRef(createdProjectId);
  useEffect(() => {
    if (createdProjectId && createdProjectId !== initialCreated.current)
      setProjectId(createdProjectId);
  }, [createdProjectId]);
  const used = new Set(
    spaces.catalog.spaces.flatMap((s) => s.projects.map((p) => p.personalProjectId)),
  );
  const available = projects.filter(
    (p) => !p.unassigned && !p.archived && !p.deleted && !used.has(p.id),
  );
  const project = available.find((p) => p.id === projectId);
  const done = async (accept = true) => {
    await action.run(async () => {
      let nextSpaceId = invitation?.spaceId;
      if (invitation)
        await sharedMutation(`/team/spaces/${invitation.spaceId}/answer`, "POST", {
          revision: invitation.revision,
          accept,
          ...(accept ? { personalProjectId: projectId, access } : {}),
        });
      else {
        const result = await sharedMutation<{ id: string }>("/team/spaces", "POST", {
          title: title.trim(),
          kind,
          userId: person!.id,
          personalProjectId: projectId,
          access,
          requestedAccess,
        });
        nextSpaceId = result.id;
      }
      await spaces.refresh(true);
      if (!invitation) {
        try {
          storage.removeItem("workspace-shared-request:/team/spaces");
        } catch {}
      }
      if (accept) {
        spaces.setMode("spaces");
        if (nextSpaceId) spaces.select(nextSpaceId);
      }
      spaces.open(null);
    });
  };
  return (
    <form
      className="space-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (step < 3) setStep(step + 1);
        else void done();
      }}
    >
      <small className="muted">
        {step + 1} из 4 · {["Пространство", "Проект и участник", "Доступ", "Подтверждение"][step]}
      </small>
      <fieldset disabled={action.busy}>
        {step === 0 &&
          (invitation ? (
            <>
              <p>
                {invitation.from.name} приглашает тебя в{" "}
                {kind === "project" ? "совместный проект" : "пространство"} <strong>{title}</strong>
                .
              </p>
              <p>
                {invitation.project.name} · {accessLabels[invitation.access]}
              </p>
              <a href={invitation.project.repository} target="_blank" rel="noreferrer">
                {invitation.project.repository}
              </a>
            </>
          ) : (
            <>
              <label>
                Название
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                  required
                  autoComplete="off"
                />
              </label>
              <div className="space-type-choices">
                {(["project", "space"] as const).map((v) => (
                  <button
                    type="button"
                    className="space-card"
                    key={v}
                    aria-pressed={kind === v}
                    onClick={() => setKind(v)}
                  >
                    <strong>{v === "project" ? "Один проект" : "Пространство"}</strong>
                    <small>
                      {v === "project"
                        ? "Один репозиторий, у каждого своя рабочая копия"
                        : "Связанные проекты — каждый добавляет свой"}
                    </small>
                  </button>
                ))}
              </div>
            </>
          ))}
        {step === 1 && (
          <>
            <label>
              {invitation && kind === "project" ? "Моя локальная копия проекта" : "Мой проект"}
              <select
                aria-label={
                  invitation && kind === "project" ? "Моя локальная копия проекта" : "Мой проект"
                }
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                required
              >
                <option value="">Выбрать проект…</option>
                {available.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {invitation && kind === "project" && (
              <p className="muted">
                Выбери или создай свою копию{" "}
                {invitation.project.repository.replace("https://github.com/", "")}.
              </p>
            )}
            <button type="button" className="secondary" onClick={onNewProject}>
              <Icon name="plus" size={16} />
              Создать проект
            </button>
            {!invitation && (
              <TeamContactPicker value={person} onChange={setPerson} exclude={[pageWorkspace]} />
            )}
          </>
        )}
        {step === 2 && (
          <>
            {(!invitation || kind === "space") && (
              <AccessPicker
                label={
                  invitation
                    ? `Доступ для ${invitation.from.name} к моему проекту`
                    : `Доступ для ${person?.name ?? "участника"} к моему проекту`
                }
                value={access}
                onChange={setAccess}
              />
            )}
            {!invitation && kind === "space" && (
              <AccessPicker
                label="Запросить доступ к проекту участника"
                value={requestedAccess}
                onChange={setRequestedAccess}
              />
            )}
            {invitation && (
              <p>
                Твой доступ к {invitation.project.name}:{" "}
                <strong>{accessLabels[invitation.access]}</strong>.
              </p>
            )}
            <p className="muted">
              Совместная работа — рабочие ветки и PR. Прямая работа — разрешённые ветки напрямую.
              Права GitHub остаются верхней границей доступа.
            </p>
            {!invitation && kind === "space" && (
              <p className="muted">Участник сам подтвердит доступ к своему проекту.</p>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <h3>{title}</h3>
            <p>
              {kind === "project" ? "Один проект" : "Связанные проекты"} ·{" "}
              {invitation?.from.name ?? person?.name}
            </p>
            <p>
              Мой проект: <strong>{project?.name}</strong>
            </p>
            {(!invitation || kind === "space") && (
              <p>Доступ к моему проекту: {accessLabels[access]}</p>
            )}
            {invitation ? (
              <p>Мой доступ: {accessLabels[invitation.access]}</p>
            ) : (
              kind === "space" && <p>Запрошен доступ: {accessLabels[requestedAccess]}</p>
            )}
            <p className="muted">
              Проект появится в «Общих» с существующими диалогами. У каждого остаётся своя рабочая
              папка и личная история.
            </p>
          </>
        )}
      </fieldset>
      {action.error && <p role="alert">{action.error}</p>}
      <footer className="space-actions">
        {step > 0 ? (
          <button
            type="button"
            className="secondary"
            disabled={action.busy}
            onClick={() => setStep(step - 1)}
          >
            Назад
          </button>
        ) : invitation ? (
          <button
            type="button"
            className="secondary"
            disabled={action.busy}
            onClick={() => void done(false)}
          >
            Отклонить
          </button>
        ) : (
          <span />
        )}
        <button
          type="submit"
          className="primary"
          disabled={
            action.busy ||
            (step === 0 && !title.trim()) ||
            (step === 1 && (!project || (!invitation && !person)))
          }
        >
          {action.busy
            ? "Сохраняем…"
            : step === 3
              ? invitation
                ? "Присоединиться"
                : "Пригласить"
              : "Далее"}
        </button>
      </footer>
    </form>
  );
}
function SpaceSettings({
  spaces,
  space,
  projects,
  onNewProject,
  createdProjectId,
}: {
  spaces: SpacesController;
  space: CollaborationSpace;
  projects: Project[];
  onNewProject: () => void;
  createdProjectId: string;
}) {
  const [title, setTitle] = useState(space.title),
    [confirm, setConfirm] = useState(false);
  const action = useSharedAction(),
    curator = space.curatorId === pageWorkspace;
  return (
    <div className="space-form">
      <p>{space.members.map((p) => p.name).join(" · ")}</p>
      <SpaceProjects
        spaces={spaces}
        space={space}
        projects={projects}
        onNewProject={onNewProject}
        createdProjectId={createdProjectId}
      />
      {space.pending.length > 0 && <p>Приглашены: {space.pending.map((p) => p.name).join(", ")}</p>}
      {curator && (
        <form
          className="space-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await sharedMutation(`/team/spaces/${space.id}`, "PATCH", {
                title: title.trim(),
                revision: space.revision,
              });
              await spaces.refresh(true);
            });
          }}
        >
          <label>
            Название
            <input
              value={title}
              maxLength={120}
              required
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <button
            className="secondary"
            type="submit"
            disabled={action.busy || !title.trim() || title.trim() === space.title}
          >
            Сохранить
          </button>
        </form>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {confirm ? (
        <>
          <p>
            {curator
              ? `Закрыть «${space.title}» для всех участников?`
              : `Выйти из «${space.title}»?`}{" "}
            Проекты вернутся в личный список. Файлы и диалоги сохранятся.
          </p>
          <div className="space-actions">
            <button
              className="secondary"
              type="button"
              disabled={action.busy}
              onClick={() => setConfirm(false)}
            >
              Отмена
            </button>
            <button
              className="danger"
              type="button"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await sharedMutation(`/team/spaces/${space.id}/leave`, "POST", {
                    revision: space.revision,
                  });
                  await spaces.refresh(true);
                  spaces.open(null);
                })
              }
            >
              {curator ? "Закрыть пространство" : "Выйти"}
            </button>
          </div>
        </>
      ) : (
        <button className="secondary" type="button" onClick={() => setConfirm(true)}>
          {curator ? "Закрыть пространство" : "Выйти из пространства"}
        </button>
      )}
    </div>
  );
}
