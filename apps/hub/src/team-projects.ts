import { createHash, randomUUID } from "node:crypto";
import {
  HubError,
  type ProjectMemberRole,
  type SharedInvitation,
  type SharedItem,
  type SharedMaterialWrite,
  type SharedProject,
  type SharedProjectDetail,
  sharedMaterialWriteSchema,
  type TeamCheckout,
} from "@codex-web/shared";
import type { TeamStore } from "./team-store.js";

type Row = Record<string, any>;
type Source = NonNullable<SharedItem["source"]> & { ownerId: string };
const missing = () => new HubError(404, "SHARED_NOT_FOUND", "Проект или материал недоступен.");
const conflict = () =>
  new HubError(
    409,
    "SHARED_CONFLICT",
    "Данные изменились. Обнови сохранённую версию; твой черновик сохранён.",
  );
const normalized = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ru");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Explicitly published collaboration state. Never reads another user's personal runtime. */
export class TeamProjects {
  constructor(readonly registry: TeamStore) {}
  get db() {
    return this.registry.db;
  }
  access(actor: string, id: string, role: "read" | "write" | "owner" = "read") {
    this.registry.active(actor);
    const row = this.db
      .prepare(`SELECT p.*,m.role FROM team_projects p JOIN team_project_members m
      ON m.projectId=p.id AND m.userId=? AND m.state='active' WHERE p.id=?`)
      .get(actor, id) as Row | undefined;
    if (!row) throw missing();
    if ((role === "owner" && row.role !== "owner") || (role === "write" && row.role === "viewer"))
      throw new HubError(
        403,
        "SHARED_ROLE_REQUIRED",
        role === "owner"
          ? "Это действие доступно владельцу проекта."
          : "У тебя доступ только для чтения.",
      );
    if (role === "write" && row.archived)
      throw new HubError(409, "SHARED_ARCHIVED", "Проект в архиве.");
    return row;
  }
  private project(row: Row): SharedProject {
    return {
      id: row.id,
      ownerId: row.ownerId,
      title: row.title,
      visibility: row.visibility,
      revision: row.revision,
      role: row.role,
      archived: !!row.archived,
      ...(row.repository ? { repository: row.repository } : {}),
    };
  }
  private changed(actor: string, projectId: string, action: string, itemId: string | null = null) {
    this.db
      .prepare(
        "INSERT INTO team_project_activity(projectId,actorId,actorName,action,itemId,createdAt) VALUES(?,?,?,?,?,?)",
      )
      .run(projectId, actor, this.registry.user(actor).name, action, itemId, Date.now());
    this.db
      .prepare(
        "DELETE FROM team_project_activity WHERE projectId=? AND seq NOT IN (SELECT seq FROM team_project_activity WHERE projectId=? ORDER BY seq DESC LIMIT 1000)",
      )
      .run(projectId, projectId);
    this.registry.audit(actor, action, projectId);
  }
  private once<T>(actor: string, scope: string, key: string, input: unknown, work: () => T): T {
    return this.registry.transaction(() => {
      this.registry.active(actor);
      const fingerprint = digest(input);
      const previous = this.db
        .prepare("SELECT digest,value FROM team_receipts WHERE userId=? AND scope=? AND key=?")
        .get(actor, scope, key);
      if (previous) {
        if (previous.digest !== fingerprint)
          throw new HubError(
            409,
            "SHARED_REQUEST_REUSED",
            "Подтверждение относится к другому действию.",
          );
        return JSON.parse(String(previous.value)) as T;
      }
      const result = work();
      this.db
        .prepare("INSERT INTO team_receipts VALUES(?,?,?,?, 'completed',?,?)")
        .run(actor, scope, key, fingerprint, JSON.stringify(result), Date.now());
      return result;
    });
  }
  list(actor: string, offset = 0) {
    this.registry.active(actor);
    const rows = this.db
      .prepare(`SELECT p.*,m.role FROM team_projects p JOIN team_project_members m
      ON m.projectId=p.id WHERE m.userId=? AND m.state='active' ORDER BY p.archived,p.updatedAt DESC,p.id LIMIT 31 OFFSET ?`)
      .all(actor, offset);
    return {
      items: rows.slice(0, 30).map((row) => this.project(row)),
      nextOffset: rows.length > 30 ? offset + 30 : null,
    };
  }
  create(
    actor: string,
    id: string,
    input: { title: string; visibility: "private" | "shared"; repository: string | null },
  ) {
    this.registry.active(actor);
    if (this.db.prepare("SELECT 1 FROM team_projects WHERE id=?").get(id)) this.access(actor, id);
    return this.once(actor, "project.create", id, input, () => {
      if (this.db.prepare("SELECT 1 FROM team_projects WHERE id=?").get(id)) throw conflict();
      if (
        Number(
          this.db.prepare("SELECT COUNT(*) n FROM team_projects WHERE ownerId=?").get(actor)?.n,
        ) >= 100
      )
        throw new HubError(409, "SHARED_PROJECT_LIMIT", "Достигнут лимит проектов: 100.");
      const now = Date.now();
      this.db
        .prepare("INSERT INTO team_projects VALUES(?,?,?,?,?,1,0,?,?)")
        .run(id, actor, input.title, input.visibility, input.repository, now, now);
      this.db
        .prepare("INSERT INTO team_project_members VALUES(?,?,'owner','active',1)")
        .run(id, actor);
      this.changed(actor, id, "project.created");
      return this.detail(actor, id);
    });
  }
  detail(actor: string, id: string): SharedProjectDetail {
    const row = this.access(actor, id);
    const members = this.db
      .prepare(`SELECT m.userId,u.name,u.login,m.role,u.state,m.revision,
      EXISTS(SELECT 1 FROM team_checkouts c WHERE c.projectId=m.projectId AND c.userId=m.userId) checkoutReady
      FROM team_project_members m JOIN team_users u ON u.id=m.userId
      WHERE m.projectId=? AND m.state='active' ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,u.name,u.id`)
      .all(id);
    return {
      project: this.project(row),
      members: members.map((m) => ({
        ...m,
        checkoutReady: !!m.checkoutReady,
      })) as SharedProjectDetail["members"],
      checkout: this.checkout(actor, id),
      ...(row.role === "owner"
        ? {
            invitations: this.db
              .prepare(
                "SELECT i.id,u.name,u.login,i.role,i.expires FROM team_project_invites i JOIN team_users u ON u.id=i.userId WHERE i.projectId=? AND i.state='pending' AND i.expires>? ORDER BY i.createdAt DESC LIMIT 100",
              )
              .all(id, Date.now()) as SharedProjectDetail["invitations"],
          }
        : {}),
    };
  }
  revokeInvitation(actor: string, projectId: string, id: string, key: string) {
    this.access(actor, projectId, "owner");
    return this.once(actor, "project.invite.revoke:" + projectId + ":" + id, key, {}, () => {
      const invite = this.db
        .prepare("SELECT state FROM team_project_invites WHERE id=? AND projectId=?")
        .get(id, projectId);
      if (!invite || invite.state !== "pending") throw missing();
      this.db.prepare("UPDATE team_project_invites SET state='revoked' WHERE id=?").run(id);
      this.changed(actor, projectId, "membership.invite_revoked");
      return { ok: true };
    });
  }
  edit(
    actor: string,
    id: string,
    key: string,
    input: { revision: number; title: string; archived: boolean; visibility: "private" | "shared" },
  ) {
    this.access(actor, id, "owner");
    return this.once(actor, "project.edit:" + id, key, input, () => {
      const current = this.access(actor, id, "owner");
      if (current.revision !== input.revision) throw conflict();
      if (
        input.visibility === "private" &&
        this.db
          .prepare(
            "SELECT 1 FROM team_project_members WHERE projectId=? AND state='active' AND userId!=?",
          )
          .get(id, actor)
      )
        throw new HubError(409, "PROJECT_HAS_MEMBERS", "Сначала отзови доступ участников.");
      this.db
        .prepare(
          "UPDATE team_projects SET title=?,archived=?,visibility=?,revision=revision+1,updatedAt=? WHERE id=?",
        )
        .run(input.title, Number(input.archived), input.visibility, Date.now(), id);
      if (input.archived || input.visibility === "private")
        this.db
          .prepare(
            "UPDATE team_project_invites SET state='revoked' WHERE projectId=? AND state='pending'",
          )
          .run(id);
      this.changed(actor, id, input.archived ? "project.archived" : "project.updated");
      return this.detail(actor, id);
    });
  }
  invite(
    actor: string,
    projectId: string,
    key: string,
    input: { login: string; role: ProjectMemberRole; revision: number },
  ) {
    this.access(actor, projectId, "owner");
    return this.once(actor, "project.invite:" + projectId, key, input, () => {
      const project = this.access(actor, projectId, "owner"),
        user = this.registry.byLogin(input.login);
      if (project.archived || project.visibility !== "shared")
        throw new HubError(
          409,
          "SHARED_REQUIRED",
          "Сначала сделай проект общим и открой его из архива.",
        );
      if (project.revision !== input.revision) throw conflict();
      if (!user || user.state !== "active" || user.id === actor)
        throw new HubError(
          404,
          "PARTICIPANT_UNAVAILABLE",
          "Участник недоступен. Проверь его логин.",
        );
      const membership = this.db
        .prepare("SELECT role,state FROM team_project_members WHERE projectId=? AND userId=?")
        .get(projectId, user.id);
      if (input.role === "owner" ? membership?.state !== "active" : membership?.state === "active")
        throw new HubError(
          409,
          "MEMBERSHIP_CHANGED",
          input.role === "owner"
            ? "Сначала пригласи нового владельца как участника."
            : "Участник уже подключён. Измени его роль в списке.",
        );
      if (input.role === "owner") this.idle(projectId);
      this.db
        .prepare(
          "UPDATE team_project_invites SET state='revoked' WHERE projectId=? AND userId=? AND state='pending'",
        )
        .run(projectId, user.id);
      const id = randomUUID(),
        now = Date.now(),
        expires = now + 7 * 86400000;
      this.db
        .prepare("INSERT INTO team_project_invites VALUES(?,?,?,?,?,'pending',?,?,?)")
        .run(id, projectId, actor, user.id, input.role, project.revision, now, expires);
      this.changed(
        actor,
        projectId,
        input.role === "owner" ? "ownership.offered" : "membership.invited",
      );
      return { id, expires };
    });
  }
  invitations(actor: string): { items: SharedInvitation[] } {
    this.registry.active(actor);
    return {
      items: this.db
        .prepare(`SELECT i.id,i.projectId,p.title projectTitle,u.name ownerName,i.role,i.expires
      FROM team_project_invites i JOIN team_projects p ON p.id=i.projectId JOIN team_users u ON u.id=i.createdBy
      WHERE i.userId=? AND i.state='pending' AND i.expires>? AND p.archived=0 AND p.visibility='shared'
      AND u.state='active' AND p.ownerId=i.createdBy ORDER BY i.createdAt DESC LIMIT 100`)
        .all(actor, Date.now()) as unknown as SharedInvitation[],
    };
  }
  answerInvitation(actor: string, id: string, key: string, accept: boolean) {
    this.registry.active(actor);
    return this.once(actor, "project.invite.answer:" + id, key, { accept }, () => {
      const invite = this.db
        .prepare("SELECT * FROM team_project_invites WHERE id=? AND userId=? AND state='pending'")
        .get(id, actor) as Row | undefined;
      if (!invite || invite.expires <= Date.now()) throw missing();
      const project = this.access(invite.createdBy, invite.projectId, "owner");
      if (project.archived || project.visibility !== "shared") throw missing();
      if (accept) {
        if (invite.role === "owner") {
          if (project.revision !== invite.projectRevision) throw conflict();
          this.idle(project.id);
          this.access(actor, project.id);
          this.db
            .prepare(
              "UPDATE team_project_members SET role='collaborator',revision=revision+1 WHERE projectId=? AND userId=?",
            )
            .run(project.id, project.ownerId);
          this.db
            .prepare(
              "UPDATE team_projects SET ownerId=?,revision=revision+1,updatedAt=? WHERE id=?",
            )
            .run(actor, Date.now(), project.id);
          this.db
            .prepare(
              "UPDATE team_project_invites SET state='revoked' WHERE projectId=? AND state='pending' AND id!=?",
            )
            .run(project.id, id);
        }
        this.db
          .prepare(`INSERT INTO team_project_members VALUES(?,?,?,'active',1)
          ON CONFLICT(projectId,userId) DO UPDATE SET role=excluded.role,state='active',revision=revision+1`)
          .run(project.id, actor, invite.role);
      }
      this.db
        .prepare("UPDATE team_project_invites SET state=? WHERE id=?")
        .run(accept ? "accepted" : "declined", id);
      this.changed(
        actor,
        project.id,
        accept
          ? invite.role === "owner"
            ? "ownership.accepted"
            : "membership.joined"
          : "membership.declined",
      );
      return { ok: true, projectId: accept ? project.id : null };
    });
  }
  member(
    actor: string,
    projectId: string,
    target: string,
    key: string,
    input: { revision: number; role: "viewer" | "collaborator"; remove: boolean },
  ) {
    this.access(actor, projectId, "owner");
    return this.once(actor, "project.member:" + projectId + ":" + target, key, input, () => {
      const project = this.access(actor, projectId, "owner");
      const current = this.db
        .prepare(
          "SELECT * FROM team_project_members WHERE projectId=? AND userId=? AND state='active'",
        )
        .get(projectId, target);
      if (!current) throw missing();
      if (target === project.ownerId)
        throw new HubError(
          409,
          "PROJECT_OWNER_REQUIRED",
          "У проекта всегда один владелец. Сначала передай владение с подтверждением получателя.",
        );
      if (current.revision !== input.revision) throw conflict();
      this.db
        .prepare(
          "UPDATE team_project_members SET role=?,state=?,revision=revision+1 WHERE projectId=? AND userId=?",
        )
        .run(input.role, input.remove ? "removed" : "active", projectId, target);
      this.db
        .prepare(
          "UPDATE team_project_invites SET state='revoked' WHERE projectId=? AND userId=? AND state='pending'",
        )
        .run(projectId, target);
      this.changed(
        actor,
        projectId,
        input.remove ? "membership.removed" : "membership.role_changed",
      );
      return this.detail(actor, projectId);
    });
  }
  checkout(actor: string, projectId: string): TeamCheckout | null {
    this.access(actor, projectId);
    const row = this.db
      .prepare("SELECT * FROM team_checkouts WHERE projectId=? AND userId=?")
      .get(projectId, actor);
    return row
      ? {
          id: String(row.id),
          projectId,
          userId: actor,
          client: "codex",
          personalProjectId: String(row.personalProjectId),
          machineId: String(row.machineId),
          revision: Number(row.revision),
          state: "ready",
        }
      : null;
  }
  association(actor: string, personalProjectId: string): SharedProject | null {
    this.registry.active(actor);
    const row = this.db
      .prepare(`SELECT p.*,m.role FROM team_checkouts c JOIN team_projects p ON p.id=c.projectId
      JOIN team_project_members m ON m.projectId=p.id AND m.userId=c.userId AND m.state='active'
      WHERE c.userId=? AND c.personalProjectId=?`)
      .get(actor, personalProjectId);
    return row ? this.project(row) : null;
  }
  /** Called only after the acting user's real personal project/root and origin were verified. */
  bind(
    actor: string,
    projectId: string,
    key: string,
    input: { revision: number; personalProjectId: string },
    verified: { machineId: string; repository: string | null },
  ) {
    this.access(actor, projectId);
    return this.once(actor, "project.checkout:" + projectId, key, { ...input, ...verified }, () => {
      const project = this.access(actor, projectId, "write"),
        current = this.checkout(actor, projectId);
      if ((current?.revision ?? 0) !== input.revision) throw conflict();
      if (project.repository !== verified.repository)
        throw new HubError(
          409,
          "REPOSITORY_MISMATCH",
          "Выбранная рабочая папка относится к другому репозиторию.",
        );
      this.idle(projectId, actor);
      const other = this.db
        .prepare(
          "SELECT projectId FROM team_checkouts WHERE userId=? AND personalProjectId=? AND projectId!=?",
        )
        .get(actor, input.personalProjectId, projectId);
      if (other)
        throw new HubError(
          409,
          "CHECKOUT_ALREADY_BOUND",
          "Рабочая папка уже связана с другим логическим проектом.",
        );
      this.db
        .prepare(`INSERT INTO team_checkouts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(projectId,userId)
        DO UPDATE SET personalProjectId=excluded.personalProjectId,machineId=excluded.machineId,repository=excluded.repository,revision=excluded.revision,updatedAt=excluded.updatedAt`)
        .run(
          current?.id ?? randomUUID(),
          projectId,
          actor,
          input.personalProjectId,
          verified.machineId,
          verified.repository,
          input.revision + 1,
          Date.now(),
        );
      this.changed(actor, projectId, "checkout.connected");
      return this.checkout(actor, projectId);
    });
  }
  private idle(projectId: string, userId?: string) {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM team_executions WHERE projectId=? AND (? IS NULL OR userId=?) AND state IN ('prepared','dispatching','queued','running','unknown') LIMIT 1",
        )
        .get(projectId, userId ?? null, userId ?? null)
    )
      throw new HubError(
        409,
        "SHARED_WORK_ACTIVE",
        "Сначала заверши или проверь уже подготовленную работу.",
      );
  }
  private material(actor: string, row: Row): SharedItem {
    const content = JSON.parse(row.content),
      source = row.source ? (JSON.parse(row.source) as Source) : null;
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      title: content.title,
      content,
      revision: row.revision,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      authorName: row.authorName,
      editorName: row.editorName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      assigneeId: row.assigneeId,
      hasPrivateSource: !!source,
      ...(source?.ownerId === actor
        ? {
            source: {
              client: source.client,
              kind: source.kind,
              id: source.id,
              projectId: source.projectId,
            },
          }
        : {}),
    };
  }
  get(actor: string, projectId: string, id: string) {
    this.access(actor, projectId);
    const row = this.db
      .prepare("SELECT * FROM team_materials WHERE id=? AND projectId=? AND deleted=0")
      .get(id, projectId);
    if (!row) throw missing();
    return this.material(actor, row);
  }
  items(actor: string, projectId: string, kind: string, query: string, offset: number) {
    this.access(actor, projectId);
    const rows = this.db
      .prepare(
        "SELECT * FROM team_materials WHERE projectId=? AND deleted=0 AND (?='all' OR kind=?) AND instr(search,?)>0 ORDER BY updatedAt DESC,id LIMIT 31 OFFSET ?",
      )
      .all(projectId, kind, kind, normalized(query), offset);
    return {
      items: rows.slice(0, 30).map((row) => {
        const m = this.material(actor, row),
          {
            id,
            kind,
            title,
            revision,
            updatedAt,
            authorName,
            editorName,
            assigneeId,
            hasPrivateSource,
          } = m;
        const text =
          "body" in m.content
            ? m.content.body
            : "description" in m.content
              ? m.content.description
              : m.content.value.purpose;
        return {
          id,
          kind,
          title,
          revision,
          updatedAt,
          authorName,
          editorName,
          assigneeId,
          hasPrivateSource,
          excerpt: text.slice(0, 160),
        };
      }),
      nextOffset: rows.length > 30 ? offset + 30 : null,
    };
  }
  put(
    actor: string,
    projectId: string,
    id: string,
    key: string,
    input: SharedMaterialWrite,
    source?: Source,
  ) {
    const value = sharedMaterialWriteSchema.parse(input);
    this.access(actor, projectId, value.content.kind === "core" ? "owner" : "write");
    return this.once(actor, "material.put:" + projectId + ":" + id, key, { ...value, source }, () =>
      this.save(actor, projectId, id, value, source),
    );
  }
  publish(
    actor: string,
    projectId: string,
    key: string,
    input: { fingerprint: string },
    read: () => {
      fingerprint: string;
      items: { content: SharedMaterialWrite["content"]; source: Source }[];
    },
  ) {
    this.access(actor, projectId, "write");
    return this.once(actor, "material.publish:" + projectId, key, input, () => {
      const observed = read();
      if (observed.fingerprint !== input.fingerprint)
        throw new HubError(
          409,
          "PUBLICATION_CHANGED",
          "Личные материалы изменились. Просмотри новую версию перед публикацией.",
        );
      if (
        !observed.items.length ||
        observed.items.length > 20 ||
        JSON.stringify(observed).length > 180000
      )
        throw new HubError(
          400,
          "PUBLICATION_SIZE",
          "Выбери до 20 материалов общим размером до 180 КБ.",
        );
      return {
        items: observed.items.map((item) =>
          this.save(
            actor,
            projectId,
            randomUUID(),
            {
              revision: 0,
              content: sharedMaterialWriteSchema.parse({ revision: 0, content: item.content })
                .content,
              assigneeId: null,
            },
            item.source,
          ),
        ),
      };
    });
  }
  private save(
    actor: string,
    projectId: string,
    id: string,
    input: SharedMaterialWrite,
    source?: Source,
  ): SharedItem {
    this.access(actor, projectId, "write");
    const row = this.db.prepare("SELECT * FROM team_materials WHERE id=?").get(id);
    if (row && (row.projectId !== projectId || row.deleted)) throw missing();
    if (row && row.kind !== input.content.kind)
      throw new HubError(
        409,
        "MATERIAL_KIND_CHANGED",
        "Тип сохранённого материала нельзя заменить.",
      );
    if ((row?.revision ?? 0) !== input.revision) throw conflict();
    if (input.content.kind === "core") {
      this.access(actor, projectId, "owner");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM team_materials WHERE projectId=? AND kind='core' AND deleted=0 AND id!=?",
          )
          .get(projectId, id)
      )
        throw new HubError(
          409,
          "PROJECT_CORE_EXISTS",
          "Основа проекта уже создана. Открой её для редактирования.",
        );
    }
    if (input.assigneeId) {
      if (!["task", "plan"].includes(input.content.kind))
        throw new HubError(
          400,
          "ASSIGNMENT_INVALID",
          "Исполнителя можно назначить задаче или плану.",
        );
      const assignee = this.db
        .prepare(
          "SELECT 1 FROM team_project_members m JOIN team_users u ON u.id=m.userId WHERE m.projectId=? AND m.userId=? AND m.state='active' AND m.role IN ('owner','collaborator') AND u.state='active'",
        )
        .get(projectId, input.assigneeId);
      if (!assignee)
        throw new HubError(
          409,
          "ASSIGNEE_UNAVAILABLE",
          "Выбранный исполнитель больше не может выполнять работу в этом проекте.",
        );
    }
    if (
      this.db
        .prepare(
          "SELECT 1 FROM team_executions WHERE itemId=? AND state IN ('prepared','dispatching','queued','running','unknown')",
        )
        .get(id)
    )
      throw new HubError(
        409,
        "MATERIAL_EXECUTING",
        "Этот план уже подготовлен или выполняется. Сначала заверши либо отмени его запуск.",
      );
    if (
      !row &&
      Number(
        this.db.prepare("SELECT COUNT(*) n FROM team_materials WHERE projectId=?").get(projectId)
          ?.n,
      ) >= 5000
    )
      throw new HubError(409, "SHARED_MATERIAL_LIMIT", "Достигнут лимит материалов проекта: 5000.");
    const now = Date.now(),
      name = this.registry.user(actor).name,
      content = JSON.stringify(input.content),
      revision = input.revision + 1;
    this.db
      .prepare(`INSERT INTO team_materials VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id)
      DO UPDATE SET content=excluded.content,search=excluded.search,revision=excluded.revision,updatedBy=excluded.updatedBy,editorName=excluded.editorName,updatedAt=excluded.updatedAt,assigneeId=excluded.assigneeId`)
      .run(
        id,
        projectId,
        input.content.kind,
        content,
        normalized(content),
        revision,
        actor,
        actor,
        name,
        name,
        now,
        now,
        input.assigneeId,
        source ? JSON.stringify(source) : null,
      );
    this.db
      .prepare("INSERT INTO team_material_history VALUES(?,?,?,?,?,?)")
      .run(id, revision, content, actor, name, now);
    this.db
      .prepare(
        "DELETE FROM team_material_history WHERE itemId=? AND revision NOT IN (SELECT revision FROM team_material_history WHERE itemId=? ORDER BY revision DESC LIMIT 40)",
      )
      .run(id, id);
    this.changed(actor, projectId, row ? "material.updated" : "material.created", id);
    return this.get(actor, projectId, id);
  }
  remove(actor: string, projectId: string, id: string, key: string, revision: number) {
    this.access(actor, projectId, "write");
    return this.once(actor, "material.remove:" + projectId + ":" + id, key, { revision }, () => {
      const current = this.get(actor, projectId, id);
      if (current.kind === "core") this.access(actor, projectId, "owner");
      if (current.revision !== revision) throw conflict();
      if (
        this.db
          .prepare(
            "SELECT 1 FROM team_executions WHERE itemId=? AND state IN ('prepared','dispatching','queued','running','unknown')",
          )
          .get(id)
      )
        throw new HubError(409, "MATERIAL_EXECUTING", "Сначала заверши работу по этому материалу.");
      this.db
        .prepare("UPDATE team_materials SET deleted=1,revision=revision+1,updatedAt=? WHERE id=?")
        .run(Date.now(), id);
      this.changed(actor, projectId, "material.removed", id);
      return { ok: true };
    });
  }
  history(actor: string, projectId: string, id: string, before: number) {
    this.get(actor, projectId, id);
    return {
      items: this.db
        .prepare(
          "SELECT revision,actorId,actorName,createdAt,content FROM team_material_history WHERE itemId=? AND revision<? ORDER BY revision DESC LIMIT 10",
        )
        .all(id, before)
        .map((row) => ({ ...row, content: JSON.parse(String(row.content)) })),
    };
  }
  activity(actor: string, projectId: string, before: number) {
    this.access(actor, projectId);
    return {
      items: this.db
        .prepare(
          "SELECT seq,actorId,actorName,action,itemId,createdAt FROM team_project_activity WHERE projectId=? AND seq<? ORDER BY seq DESC LIMIT 40",
        )
        .all(projectId, before),
    };
  }
}
