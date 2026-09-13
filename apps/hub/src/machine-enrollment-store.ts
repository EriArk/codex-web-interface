import { createHash, randomBytes, randomUUID } from "node:crypto";
import { normalizedProjectPath } from "@codex-web/machines";
import {
  HubError,
  type MachineEnrollment,
  type MachineEnrollmentReport,
  machineEnrollmentReportSchema,
} from "@codex-web/shared";
import { tokenHash } from "./auth.js";
import type { TeamStore } from "./team-store.js";

export interface EnrollmentKeys {
  command: string;
  terminal: string;
  commandPublic: string;
  terminalPublic: string;
}
export interface EnrollmentRow {
  id: string;
  ownerId: string;
  name: string;
  tokenHash: string;
  keys: string;
  state: MachineEnrollment["state"];
  report: string | null;
  digest: string | null;
  machineId: string | null;
  createdAt: number;
  expires: number;
}
const unavailable = () =>
  new HubError(404, "ENROLLMENT_UNAVAILABLE", "Подключение недоступно или отозвано.");
export function hostFingerprint(key: string) {
  const blob = Buffer.from(key.split(" ")[1] ?? "", "base64");
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString() !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32
  )
    throw new HubError(400, "HOST_KEY_INVALID", "Неверный ключ компьютера.");
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}
export function enrollmentReport(input: unknown): MachineEnrollmentReport {
  const report = machineEnrollmentReportSchema.parse(input);
  if (!!report.readiness.remote !== !!report.remote)
    throw new HubError(400, "REMOTE_REPORT_INVALID", "Настройка Remote не завершена.");
  report.machineGuid = report.machineGuid.toLowerCase();
  report.profile = normalizedProjectPath({ type: "ssh-windows" }, report.profile);
  if (!/^[A-Z]:\\/i.test(report.profile))
    throw new HubError(400, "PROFILE_INVALID", "Нужен локальный профиль Windows.");
  report.roots = [
    ...new Set(report.roots.map((root) => normalizedProjectPath({ type: "ssh-windows" }, root))),
  ];
  hostFingerprint(report.hostKey);
  return report;
}
export class MachineEnrollmentStore {
  constructor(readonly registry: TeamStore) {}
  row(id: string): EnrollmentRow {
    const row = this.registry.db
      .prepare("SELECT * FROM team_machine_enrollments WHERE id=?")
      .get(id) as unknown as EnrollmentRow | undefined;
    if (!row) throw unavailable();
    return row;
  }
  owned(actor: string, id: string) {
    this.registry.active(actor);
    const row = this.row(id);
    if (row.ownerId !== actor) throw unavailable();
    return row;
  }
  projection(row: EnrollmentRow): MachineEnrollment {
    const report = row.report ? enrollmentReport(JSON.parse(row.report)) : undefined;
    return {
      id: row.id,
      ownerId: row.ownerId,
      ownerName: this.registry.user(row.ownerId).name,
      name: row.name,
      state:
        ["pending", "reported"].includes(row.state) && row.expires <= Date.now()
          ? "expired"
          : row.state,
      createdAt: row.createdAt,
      expires: row.expires,
      ...(report
        ? {
            fingerprint: hostFingerprint(report.hostKey),
            address: report.address,
            roots: report.roots,
            readiness: report.readiness,
          }
        : {}),
      ...(row.machineId ? { machineId: row.machineId } : {}),
    };
  }
  list(actor: string, review = false) {
    if (review) this.registry.admin(actor);
    else this.registry.active(actor);
    const rows = this.registry.db
      .prepare(
        review
          ? "SELECT * FROM team_machine_enrollments WHERE state='reported' AND expires>? ORDER BY createdAt DESC LIMIT 100"
          : "SELECT * FROM team_machine_enrollments WHERE ownerId=? ORDER BY createdAt DESC LIMIT 100",
      )
      .all(review ? Date.now() : actor) as unknown as EnrollmentRow[];
    return rows.map((row) => this.projection(row));
  }
  create(
    actor: string,
    name: string,
    keys: EnrollmentKeys,
    request?: { id: string; token: string },
  ) {
    this.registry.active(actor);
    if (request) {
      const existing = this.registry.db
        .prepare("SELECT * FROM team_machine_enrollments WHERE id=?")
        .get(request.id) as unknown as EnrollmentRow | undefined;
      if (existing) {
        if (
          existing.ownerId !== actor ||
          existing.name !== name ||
          existing.tokenHash !== tokenHash(request.token)
        )
          throw new HubError(
            409,
            "ENROLLMENT_CONFLICT",
            "Параметры этого подключения уже отличаются.",
          );
        return { enrollment: this.projection(existing), token: request.token };
      }
    }
    if (
      Number(
        this.registry.db
          .prepare(
            "SELECT COUNT(*) n FROM team_machine_enrollments WHERE ownerId=? AND (state='approved' OR (state IN ('pending','reported') AND expires>?))",
          )
          .get(actor, Date.now())?.n,
      ) >= 20
    )
      throw new HubError(
        409,
        "MACHINE_LIMIT",
        "Сначала отзови лишнее подключение. Лимит — 20 компьютеров.",
      );
    const id = request?.id ?? randomUUID(),
      token = request?.token ?? randomBytes(32).toString("base64url"),
      expires = Date.now() + 86400000;
    this.registry.transaction(() => {
      this.registry.db
        .prepare(
          "INSERT INTO team_machine_enrollments VALUES(?,?,?,?,?,'pending',NULL,NULL,NULL,?,?)",
        )
        .run(id, actor, name, tokenHash(token), JSON.stringify(keys), Date.now(), expires);
      this.registry.audit(actor, "machine.enrollment_created", id);
    });
    return { enrollment: this.projection(this.row(id)), token };
  }
  token(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
    const row = this.registry.db
      .prepare(
        "SELECT * FROM team_machine_enrollments WHERE tokenHash=? AND state IN ('pending','reported','approved') AND expires>?",
      )
      .get(tokenHash(token), Date.now()) as unknown as EnrollmentRow | undefined;
    if (!row) throw unavailable();
    this.registry.active(row.ownerId);
    return row;
  }
  report(token: string, input: unknown, hubAddress: string) {
    const row = this.token(token),
      report = enrollmentReport(input);
    if (report.address === hubAddress)
      throw new HubError(400, "MACHINE_ADDRESS_INVALID", "Нужен адрес подключаемого ПК, а не Hub.");
    const value = JSON.stringify(report),
      digest = createHash("sha256").update(value).digest("hex");
    if (row.state === "reported" || row.state === "approved") {
      if (row.digest !== digest)
        throw new HubError(
          409,
          "ENROLLMENT_ALREADY_REPORTED",
          "Параметры уже отправлены. Для их изменения создай новое подключение.",
        );
      return this.projection(row);
    }
    this.registry.transaction(() => {
      this.token(token);
      this.registry.db
        .prepare(
          "UPDATE team_machine_enrollments SET state='reported',report=?,digest=? WHERE id=?",
        )
        .run(value, digest, row.id);
      this.registry.audit(row.ownerId, "machine.reported", row.id);
    });
    return this.projection(this.row(row.id));
  }
  approval(actor: string, id: string, fingerprint: string) {
    this.registry.admin(actor);
    const row = this.row(id);
    this.registry.active(row.ownerId);
    if (
      !["reported", "approved"].includes(row.state) ||
      !row.report ||
      (row.state !== "approved" && row.expires <= Date.now())
    )
      throw unavailable();
    const report = enrollmentReport(JSON.parse(row.report));
    if (hostFingerprint(report.hostKey) !== fingerprint)
      throw new HubError(
        409,
        "MACHINE_IDENTITY_CHANGED",
        "Отпечаток отличается. Обнови карточку подключения.",
      );
    // No endpoint can bind the original owner's or another member's existing machine identity.
    for (const existing of this.registry.db
      .prepare(
        "SELECT id,ownerId,report FROM team_machine_enrollments WHERE state='approved' AND id<>?",
      )
      .all(id)) {
      const previous = enrollmentReport(JSON.parse(String(existing.report)));
      if (
        previous.hostKey === report.hostKey ||
        previous.machineGuid === report.machineGuid ||
        previous.address === report.address
      )
        throw new HubError(
          409,
          "MACHINE_ALREADY_PAIRED",
          "Этот компьютер уже подключён. Сначала отключи прежнее подключение.",
        );
    }
    return { row, report };
  }
  approved(actor: string, id: string, fingerprint: string, digest: string) {
    return this.registry.transaction(() => {
      const { row } = this.approval(actor, id, fingerprint);
      if (row.digest !== digest)
        throw new HubError(409, "MACHINE_IDENTITY_CHANGED", "Параметры подключения изменились.");
      if (row.state === "approved") return this.projection(row);
      this.registry.db
        .prepare("UPDATE team_machine_enrollments SET state='approved',machineId=? WHERE id=?")
        .run("pc-" + id, id);
      this.registry.audit(actor, "machine.approved", id);
      return this.projection(this.row(id));
    });
  }
  revoke(actor: string, id: string) {
    const row = this.owned(actor, id);
    if (row.state === "revoked") return;
    this.registry.transaction(() => {
      this.registry.db
        .prepare("UPDATE team_machine_enrollments SET state='revoked' WHERE id=?")
        .run(id);
      this.registry.audit(actor, "machine.revoked", id);
    });
    this.registry.events.emit("machine-revoked", actor, row.machineId);
  }
}
