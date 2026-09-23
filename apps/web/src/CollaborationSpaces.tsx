import type {
  ActivityGptHandoff,
  CollaborationAccess,
  CollaborationInvitation,
  CollaborationKind,
  CollaborationSpace,
  ProjectRules,
  TeamContact,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { ActivityAttentionWindow } from "./ActivityDiscussion";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { BrainstormWindow } from "./Brainstorm";
import { IntakeButton } from "./IntakeWindow";
import { Icon } from "./icons";
import type { ProjectSetupSeed } from "./ProjectDialog";
import { emptyProjectRules, ProjectRulesEditor } from "./ProjectRulesEditor";
import { SpaceActivity } from "./SpaceActivity";
import { SpaceChat } from "./SpaceChat";
import { SpaceGitHubAccessPanel } from "./SpaceGitHubAccess";
import { SpaceInvite } from "./SpaceInvite";
import { SpaceProjectOverview } from "./SpaceProjectOverview";
import { SpaceProjects } from "./SpaceProjects";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { TeamContactPicker } from "./TeamContactPicker";
import type { Project } from "./types";
import type { SpacesController } from "./useCollaborationSpaces";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./collaboration-spaces.css";

const accessLabels = {
  none: "Доступ не предоставлен",
  owner: "Владелец",
  collaborate: "Совместная работа",
  direct: "Полный доступ",
};
export function SpaceModeControl({ spaces }: { spaces: SpacesController }) {
  if (!spaces.enabled) return null;
  return (
    <button
      type="button"
      className="icon-button client-picker space-mode-toggle"
      aria-label={spaces.mode === "spaces" ? "Личные проекты" : "Общие пространства"}
      aria-pressed={spaces.mode === "spaces"}
      title={spaces.mode === "spaces" ? "Личные проекты" : "Общие пространства"}
      onClick={() => spaces.setMode(spaces.mode === "spaces" ? "personal" : "spaces")}
    >
      <Icon name="people" size={30} />
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
        s.unread +
        (s.activityAttention?.length ?? 0) +
        (s.issueDispatches?.length ?? 0) +
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
          <button
            type="button"
            className="space-back"
            onClick={() => spaces.open({ kind: "activity", id: selected.id })}
          >
            <Icon name="history" size={18} /> Активность
          </button>
          <small className="space-entry-details">
            {selected.members.map((m) => (
              <span key={m.id}>
                <Icon name="person" size={13} />
                {m.name}
              </span>
            ))}
          </small>
          {selected.pending.length > 0 && (
            <small className="space-entry-details">
              Приглашены:{" "}
              {selected.pending.map((p) => (
                <span key={p.id}>
                  <Icon name="person" size={13} />
                  {p.name}
                </span>
              ))}
            </small>
          )}
          {selected.projects
            .filter((p) => p.ownerId !== pageWorkspace)
            .map((p) => (
              <button
                type="button"
                className="nav-project"
                key={p.id}
                onClick={() => spaces.open({ kind: "project", id: selected.id, projectId: p.id })}
              >
                <span className="folder-icon">
                  <Icon name="folder" />
                </span>
                <span>
                  {p.name}
                  <small>{accessLabels[p.access]}</small>
                </span>
                <span className="project-chevron">
                  <Icon name="chevron" size={15} />
                </span>
              </button>
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
              <div className="nav-project-group space-card-row" key={s.id}>
                <button
                  type="button"
                  className="nav-project space-entry"
                  onClick={() => spaces.select(s.id)}
                >
                  <span className="folder-icon">
                    <Icon name="people" />
                  </span>
                  <span>
                    {s.title}
                    <small className="space-entry-details">
                      {s.members.map((m) => (
                        <span key={m.id}>
                          <Icon name="person" size={13} />
                          {m.name}
                        </span>
                      ))}
                    </small>
                    <small className="space-entry-details">
                      {s.projects.map((p) => (
                        <span key={p.id}>
                          <Icon name="folder" size={13} />
                          {p.name}
                        </span>
                      ))}
                    </small>
                  </span>
                  <span className="project-chevron">
                    <Icon name="chevron" size={15} />
                  </span>
                </button>
                {s.unread > 0 && (
                  <small
                    className="space-card-unread"
                    title={`Непрочитанных сообщений: ${s.unread}`}
                  >
                    {s.unread}
                  </small>
                )}
              </div>
            ))}
          {spaces.ready && !spaces.catalog.spaces.length && (
            <p className="nav-empty">Создай пространство и пригласи участника.</p>
          )}
        </>
      )}
    </div>
  );
}
export function SpaceChatButton({
  projectId,
  spaces,
}: {
  projectId: string;
  spaces: SpacesController;
}) {
  const space =
    spaces.mode === "spaces"
      ? spaces.catalog.spaces.find((s) => s.id === spaces.selectedId)
      : spaces.catalog.spaces.find((s) =>
          s.projects.some((p) => p.personalProjectId === projectId),
        );
  if (!space) return null;
  return (
    <button
      type="button"
      className="icon-button header-space-chat"
      aria-label={`Чат: ${space.title}${space.unread ? `, непрочитанных: ${space.unread}` : ""}`}
      title={`Чат пространства: ${space.title}`}
      aria-haspopup="dialog"
      aria-expanded={spaces.window?.kind === "chat" && spaces.window.id === space.id}
      onClick={() => spaces.open({ kind: "chat", id: space.id })}
    >
      <Icon name="chat" />
      {space.unread > 0 && <small>{space.unread}</small>}
    </button>
  );
}

export function CollaborationWindow(props: Parameters<typeof SpaceWindowContent>[0]) {
  return props.spaces.window?.kind === "brainstorm" ? (
    <BrainstormWindow
      key={props.spaces.window.id}
      id={props.spaces.window.id}
      spaces={props.spaces}
      onProject={props.onProject}
    />
  ) : (
    <SpaceWindowContent {...props} />
  );
}
function SpaceWindowContent({
  spaces,
  projects,
  onNewProject,
  createdProjectId,
  onProject,
  onChat,
  onDiscuss,
}: {
  spaces: SpacesController;
  projects: Project[];
  onNewProject: (seed?: ProjectSetupSeed) => void;
  createdProjectId: string;
  onProject: (id: string) => void;
  onChat: (id: string, projectId: string) => void;
  onDiscuss: (handoff: ActivityGptHandoff) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const target = spaces.window!;
  const receiptAction = useSharedAction();
  const invitation =
    "id" in target ? spaces.catalog.invitations.find((i) => i.spaceId === target.id) : undefined;
  const space = "id" in target ? spaces.catalog.spaces.find((s) => s.id === target.id) : undefined;
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className={`space-dialog workspace-window${target.kind === "chat" ? " space-chat-dialog" : target.kind === "activity" || target.kind === "activity-reply" ? " activity-dialog" : ""}`}
      aria-label={target.kind === "create" ? "Новое пространство" : "Общее пространство"}
      onCancel={() => spaces.open(null)}
    >
      <header className="panel-heading notebook-heading">
        <h2>
          {target.kind === "create"
            ? "Новое пространство"
            : target.kind === "invitations"
              ? "Уведомления"
              : target.kind === "activity" || target.kind === "activity-reply"
                ? `Активность · ${space?.title ?? "Пространство"}`
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
      <div
        className={`space-dialog-body${target.kind === "chat" ? " space-chat-body" : " shared-scroll"}`}
      >
        {target.kind === "activity" && space && (
          <SpaceActivity
            key={`${space.id}:${space.revision}`}
            space={space}
            onDiscuss={onDiscuss}
            onProject={(projectId) => spaces.open({ kind: "project", id: space.id, projectId })}
          />
        )}
        {target.kind === "activity-reply" && space && (
          <ActivityAttentionWindow
            key={target.seq}
            space={space}
            seq={target.seq}
            onRead={spaces.refresh}
          />
        )}
        {target.kind === "chat" && space && (
          <SpaceChat key={space.id} space={space} spaces={spaces} />
        )}
        {target.kind === "project" && space && (
          <SpaceProjectOverview
            key={target.projectId}
            spaces={spaces}
            space={space}
            projectId={target.projectId}
            projects={projects}
            onNewProject={onNewProject}
            createdProjectId={createdProjectId}
            onProject={onProject}
            onChat={onChat}
          />
        )}
        {target.kind === "invitations" && (
          <>
            {receiptAction.error && (
              <p className="notice" role="alert">
                {receiptAction.error}
              </p>
            )}
            {spaces.catalog.invitations.length === 0 &&
              !spaces.catalog.spaces.some(
                (s) =>
                  s.unread > 0 ||
                  !!s.activityAttention?.length ||
                  !!s.issueDispatches?.length ||
                  s.projects.some((p) => p.ownerId === pageWorkspace && p.requests.length),
              ) && <p>Новых уведомлений нет.</p>}
            {spaces.catalog.spaces.flatMap((s) =>
              (s.issueDispatches ?? []).map((n) => {
                const p = s.projects.find((p) => p.id === n.projectId);
                return (
                  <section className="space-card" key={n.id}>
                    <strong>{p?.name ?? s.title}</strong>
                    <p>
                      {n.sender.name} отправил Issues: {n.issues.length}
                    </p>
                    {p?.personalProjectId &&
                      Array.from({ length: Math.ceil(n.issues.length / 5) }, (_, group) => (
                        <IntakeButton
                          key={n.issues[group * 5]!.url}
                          projectId={p.personalProjectId!}
                          name={p.name}
                          draftScope={`${n.id}:${group}`}
                          sources={n.issues.slice(group * 5, group * 5 + 5).map((i) => i.url)}
                          label={
                            n.issues.length <= 5
                              ? "Изучить"
                              : "Изучить " +
                                (group * 5 + 1) +
                                "–" +
                                Math.min(n.issues.length, group * 5 + 5)
                          }
                        />
                      ))}
                    <button
                      type="button"
                      className="secondary"
                      disabled={receiptAction.busy}
                      onClick={() =>
                        void receiptAction.run(() =>
                          sharedMutation("/team/spaces/" + s.id + "/issues/read", "POST", {
                            dispatchId: n.id,
                          }).then(() => spaces.refresh()),
                        )
                      }
                    >
                      Прочитано
                    </button>
                  </section>
                );
              }),
            )}
            {spaces.catalog.spaces.flatMap((s) =>
              (s.activityAttention ?? []).map((n) => (
                <button
                  type="button"
                  className="space-card"
                  key={`activity:${n.id}`}
                  onClick={() => spaces.open({ kind: "activity-reply", id: s.id, seq: n.id })}
                >
                  <strong>{s.projects.find((p) => p.id === n.projectId)?.name ?? s.title}</strong>
                  <span>{n.author.name} обращается к тебе в обсуждении события</span>
                </button>
              )),
            )}
            {spaces.catalog.spaces
              .filter((s) => s.unread > 0)
              .map((s) => (
                <button
                  type="button"
                  className="space-card"
                  key={`chat:${s.id}`}
                  onClick={() => spaces.open({ kind: "chat", id: s.id })}
                >
                  <strong>{s.title}</strong>
                  <span>Новые сообщения: {s.unread}</span>
                </button>
              ))}
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
        <option value="direct">Полный доступ</option>
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
  onNewProject: (seed?: ProjectSetupSeed) => void;
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
  const [rules, setRules] = useState<ProjectRules>(
    invitation?.recommendations ?? emptyProjectRules,
  );
  const [memberAccess, setMemberAccess] = useState<Record<string, CollaborationAccess>>({});
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
          ...(accept
            ? {
                personalProjectId: projectId,
                access,
                ...(kind === "space" && invitation.members
                  ? {
                      grants: invitation.members.map((m) => ({
                        userId: m.id,
                        access: memberAccess[m.id] ?? access,
                      })),
                    }
                  : {}),
                ...(invitation.recommendations ? { rules } : {}),
              }
            : {}),
        });
      else {
        const result = await sharedMutation<{ id: string }>("/team/spaces", "POST", {
          title: title.trim(),
          kind,
          userId: person!.id,
          personalProjectId: projectId,
          access,
          requestedAccess,
          ...(rules.enabled.length || rules.custom.trim() ? { recommendations: rules } : {}),
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
              <p>{invitation.project.name}</p>
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
            {invitation && (
              <SpaceGitHubAccessPanel
                spaceId={invitation.spaceId}
                revision={invitation.revision}
                names={invitation.projects ?? []}
              />
            )}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                onNewProject(
                  invitation && kind === "project"
                    ? {
                        name: invitation.project.name,
                        repository: invitation.project.repository,
                        scope: `space:${invitation.spaceId}:invitation`,
                      }
                    : undefined,
                )
              }
            >
              <Icon name="plus" size={16} />
              {invitation && kind === "project" ? "Создать рабочую копию" : "Создать проект"}
            </button>
            {!invitation && (
              <TeamContactPicker value={person} onChange={setPerson} exclude={[pageWorkspace]} />
            )}
          </>
        )}
        {step === 2 && (
          <>
            {(!invitation || (kind === "space" && !invitation.members)) && (
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
            {invitation &&
              kind === "space" &&
              invitation.members?.map((m) => (
                <AccessPicker
                  key={m.id}
                  label={`Доступ для ${m.name} к моему проекту`}
                  value={memberAccess[m.id] ?? access}
                  onChange={(v) => setMemberAccess((old) => ({ ...old, [m.id]: v }))}
                />
              ))}
            {!invitation && kind === "space" && (
              <AccessPicker
                label="Запросить доступ к проекту участника"
                value={requestedAccess}
                onChange={setRequestedAccess}
              />
            )}
            {invitation && !invitation.projects && (
              <p>
                Твой доступ к {invitation.project.name}:{" "}
                <strong>{accessLabels[invitation.access]}</strong>.
              </p>
            )}
            {invitation?.projects?.map((p) => (
              <p key={p.id}>
                {p.name}: <strong>{accessLabels[p.access]}</strong>
              </p>
            ))}
            <p className="muted">
              Совместная работа — рабочие ветки и PR. Полный доступ — GitHub Write и разрешённые
              ветки напрямую. Права GitHub остаются верхней границей доступа.
            </p>
            {!invitation && kind === "space" && (
              <p className="muted">Участник сам подтвердит доступ к своему проекту.</p>
            )}
          </>
        )}
        {step === 3 && (
          <>
            {(!invitation || invitation.recommendations) && (
              <details open={!!invitation?.recommendations}>
                <summary>Настройка Codex для совместной работы</summary>
                <p className="muted">
                  {invitation
                    ? "Это рекомендации, а не условия участия. Отключи ненужное. Выбранное добавим к твоим личным правилам проекта."
                    : "Необязательные пожелания для себя и приглашённого. Он сможет отключить любое из них."}
                </p>
                <p className="muted">Завершённая работа — коммит и отправка в разрешённую ветку.</p>
                <ProjectRulesEditor value={rules} onChange={setRules} />
              </details>
            )}
            <h3>{title}</h3>
            <p>
              {kind === "project" ? "Один проект" : "Связанные проекты"} ·{" "}
              {invitation?.from.name ?? person?.name}
            </p>
            <p>
              Мой проект: <strong>{project?.name}</strong>
            </p>
            {(!invitation || (kind === "space" && !invitation.members)) && (
              <p>Доступ к моему проекту: {accessLabels[access]}</p>
            )}
            {invitation &&
              kind === "space" &&
              invitation.members?.map((m) => (
                <p key={m.id}>
                  Доступ для {m.name}: {accessLabels[memberAccess[m.id] ?? access]}
                </p>
              ))}
            {invitation?.projects?.map((p) => (
              <p key={p.id}>
                Мой доступ к {p.name}: {accessLabels[p.access]}
              </p>
            ))}
            {invitation && !invitation.projects ? (
              <p>Мой доступ: {accessLabels[invitation.access]}</p>
            ) : (
              !invitation &&
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
                ? invitation.recommendations
                  ? "Применить и присоединиться"
                  : "Присоединиться"
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
  onNewProject: (seed?: ProjectSetupSeed) => void;
  createdProjectId: string;
}) {
  const [title, setTitle] = useState(space.title),
    [confirm, setConfirm] = useState(false);
  const action = useSharedAction(),
    curator = space.curatorId === pageWorkspace;
  return (
    <div className="space-form">
      <p>{space.members.map((p) => p.name).join(" · ")}</p>
      {curator && <SpaceInvite space={space} spaces={spaces} />}
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
