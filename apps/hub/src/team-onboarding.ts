import { type HubConfig, HubError, type MemberSetupStatus } from "@codex-web/shared";
import type { MachineEnrollmentStore } from "./machine-enrollment-store.js";
import type { TeamGpt } from "./team-gpt.js";
import type { TeamStore } from "./team-store.js";

// Progress is derived from existing private enrollment/runtime state, not another job queue.
export function memberSetupStatus(
  config: HubConfig,
  registry: TeamStore,
  enrollments: MachineEnrollmentStore,
  gpt: TeamGpt,
  userId: string,
  runtime?: HubConfig,
): MemberSetupStatus {
  registry.active(userId);
  const originalOwner = userId === registry.ownerId;
  const stored = registry.db
    .prepare("SELECT value FROM team_meta WHERE key=?")
    .get(`onboarding:${userId}`)?.value;
  const items = enrollments
    .list(userId)
    .filter((item) => !["revoked", "expired"].includes(item.state));
  const rank = (item: (typeof items)[number]) =>
    item.state === "approved"
      ? runtime?.machines.some((machine) => machine.id === item.machineId)
        ? 4
        : 3
      : item.state === "reported"
        ? 2
        : 1;
  const selected = items.sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt)[0];
  const machine: MemberSetupStatus["machine"] = {
    enabled: !!config.team?.hubTailnetAddress,
    stage: selected
      ? rank(selected) === 4
        ? "active"
        : (selected.state as "pending" | "reported" | "approved")
      : "absent",
    codex: !!selected?.readiness?.codex,
    git: !!selected?.readiness?.git,
    github: !!selected?.readiness?.github,
  };
  const status = gpt.status(userId);
  const activeGpt =
    status.state === "ready" && !!(runtime?.nativeGpt?.userId === userId || runtime?.gpt);
  const ready =
    originalOwner ||
    (machine.stage === "active" && machine.codex && machine.git && machine.github && activeGpt);
  return {
    originalOwner,
    state: originalOwner
      ? "complete"
      : stored === "complete" || stored === "deferred"
        ? stored
        : "pending",
    ready,
    machine,
    gpt: {
      enabled: status.enabled,
      stage: activeGpt ? "active" : (status.state as MemberSetupStatus["gpt"]["stage"]),
    },
  };
}

export function saveMemberSetup(
  registry: TeamStore,
  userId: string,
  state: "deferred" | "complete",
  status: MemberSetupStatus,
) {
  registry.active(userId);
  if (status.originalOwner) return;
  if (state === "complete" && !status.ready)
    throw new HubError(
      409,
      "SETUP_INCOMPLETE",
      "Подключения ещё не готовы. Можно продолжить настройку позже.",
    );
  registry.db
    .prepare(
      "INSERT INTO team_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(`onboarding:${userId}`, state);
}
