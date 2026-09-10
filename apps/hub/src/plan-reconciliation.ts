import { createHash } from "node:crypto";
import {
  HubError,
  type PlanReconciliation,
  type ProjectAction,
  type ProjectPlan,
  planReconciliationPayloadSchema,
  planSectionSchema,
  type ReconciliationApply,
  type ReconciliationDetail,
  type ReconciliationItem,
  type WorkReview,
} from "@codex-web/shared";
import { z } from "zod";
import { ProjectPlans } from "./project-plans.js";
import type { Sessions } from "./sessions.js";

const snapshotSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  title: z.string().max(120),
  sections: z.array(planSectionSchema).max(20),
});
export function reconciliationInstructions(
  plan: Pick<ProjectPlan, "id" | "revision" | "sections">,
  includeItems = false,
) {
  return [
    "## Сопоставление результата с планом",
    "После обычного итогового ответа добавь один блок ```codex-plan-result с JSON ниже. Это предложение для владельца, не изменение плана. Для каждого неотмеченного пункта укажи complete (выполнено), partial (частично), unknown (не установлено) или not_done. Не объявляй проверки, которые не выполнялись. В commands указывай только точные команды фактически выполненных проверок этого хода, иначе пустой массив. Короткая note необязательна. Блок до 32000 символов; не добавляй рассуждения.",
    JSON.stringify({
      planId: plan.id,
      revision: plan.revision,
      items: [
        {
          id: plan.sections.flatMap((s) => s.items).find((i) => !i.checked)?.id ?? "UUID пункта",
          state: "unknown",
          commands: [],
        },
      ],
    }),
    includeItems
      ? "Пункты исходного плана (только сопоставь результат, не запускай план заново):\n" +
        plan.sections
          .flatMap((s) => s.items)
          .filter((i) => !i.checked)
          .map((i) => `${i.id}: ${i.text.slice(0, 60)}`)
          .join("\n")
      : "Идентификаторы указаны в квадратных скобках рядом с пунктами выше.",
  ].join("\n\n");
}
export function makeProposal(action: ProjectAction, review: WorkReview): PlanReconciliation | null {
  const parsed = snapshotSchema.safeParse(action.snapshot.plan);
  if (!parsed.success) return null;
  const plan = parsed.data;
  // Only a dedicated bounded payload from this frozen final answer is considered.
  const matches = [...review.answer.matchAll(/^```codex-plan-result\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  let payload: z.infer<typeof planReconciliationPayloadSchema> | undefined;
  let origin: PlanReconciliation["origin"] = matches.length ? "invalid" : "missing";
  if (matches.length === 1 && matches[0]![1]!.length <= 32000) {
    try {
      const result = planReconciliationPayloadSchema.safeParse(JSON.parse(matches[0]![1]!));
      const ids = new Set(plan.sections.flatMap((s) => s.items).map((i) => i.id));
      if (
        result.success &&
        result.data.planId === plan.id &&
        result.data.revision === plan.revision &&
        result.data.items.every((i) => ids.has(i.id))
      ) {
        payload = result.data;
        origin = "structured";
      }
    } catch {}
  }
  const proposals = new Map(payload?.items.map((i) => [i.id, i]));
  const items: ReconciliationItem[] = plan.sections.flatMap((s) =>
    s.items.map((item) => {
      const reported = proposals.get(item.id);
      const checks =
        reported?.commands.flatMap((command) =>
          review.evidence.filter((e) => e.command === command && !e.commandTruncated),
        ) ?? [];
      const allRecorded =
        !!reported?.commands.length &&
        reported.commands.every((command) => checks.some((e) => e.command === command));
      let state: ReconciliationItem["state"] = item.checked
        ? "complete"
        : (reported?.state ?? "unknown");
      let note = item.checked
        ? "Было отмечено до этой работы."
        : (reported?.note ?? "Нет отдельного подтверждения по пункту.");
      if (!item.checked && state === "complete" && checks.some((c) => c.status === "failed")) {
        state = "unknown";
        note = `${note} Записанная проверка завершилась с ошибкой.`.trim();
      } else if (
        !item.checked &&
        state === "complete" &&
        allRecorded &&
        checks.every((c) => c.status === "passed")
      )
        state = "verified";
      return {
        id: item.id,
        section: s.title,
        text: item.text,
        wasChecked: item.checked,
        state,
        note,
        evidenceIds: [...new Set(checks.map((c) => c.id))],
      };
    }),
  );
  return {
    actionId: action.id,
    planId: plan.id,
    planRevision: plan.revision,
    planTitle: plan.title,
    createdAt: Date.now(),
    origin,
    items,
  };
}
export class PlanReconciliations {
  constructor(readonly sessions: Sessions) {}
  private get db() {
    return this.sessions.store.db;
  }
  capture(action: ProjectAction, review: WorkReview) {
    if (
      action.state !== "completed" ||
      this.db.prepare("SELECT 1 FROM plan_reconciliations WHERE actionId=?").get(action.id)
    )
      return;
    const proposal = makeProposal(action, review);
    if (proposal)
      this.db
        .prepare("INSERT OR IGNORE INTO plan_reconciliations VALUES(?,?,?,?,?)")
        .run(
          action.id,
          proposal.planId,
          proposal.planRevision,
          JSON.stringify(proposal),
          proposal.createdAt,
        );
  }
  get(id: string): PlanReconciliation {
    const row = this.db.prepare("SELECT value FROM plan_reconciliations WHERE actionId=?").get(id);
    if (!row)
      throw new HubError(404, "RECONCILIATION_MISSING", "У этой работы нет связанного плана.");
    return JSON.parse(String(row.value));
  }
  detail(id: string): ReconciliationDetail {
    const proposal = this.get(id),
      row = this.db.prepare("SELECT revision FROM project_plans WHERE id=?").get(proposal.planId),
      review = this.db.prepare("SELECT state,revision FROM work_reviews WHERE id=?").get(id)!;
    const revision = row ? Number(row.revision) : null;
    return {
      proposal,
      currentRevision: revision,
      planState:
        revision === null
          ? "deleted"
          : revision === (proposal.applied?.planRevision ?? proposal.planRevision)
            ? "matching"
            : "changed",
      reviewState: String(review.state) as WorkReview["state"],
      reviewRevision: Number(review.revision),
    };
  }
  apply(id: string, input: ReconciliationApply): ReconciliationDetail {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ operation: "reconcile-plan", id, ...input }))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db
        .prepare("SELECT fingerprint,response FROM work_review_receipts WHERE id=?")
        .get(input.requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new HubError(
            409,
            "RECONCILIATION_KEY_REUSED",
            "Это подтверждение относится к другому набору пунктов.",
          );
        this.db.exec("COMMIT");
        return JSON.parse(String(receipt.response));
      }
      const data = this.detail(id),
        p = data.proposal;
      if (data.reviewRevision !== input.reviewRevision || data.reviewState !== "accepted")
        throw new HubError(
          409,
          "REVIEW_REQUIRED",
          "Сначала прими эту работу; решение должно быть актуальным.",
        );
      if (p.applied)
        throw new HubError(
          409,
          "RECONCILIATION_APPLIED",
          "Выбранные пункты уже применены. Обнови план.",
        );
      if (
        data.planState !== "matching" ||
        data.currentRevision !== input.planRevision ||
        p.planRevision !== input.planRevision
      )
        throw new HubError(
          409,
          "PLAN_CONFLICT",
          data.planState === "deleted"
            ? "План удалён. Сохранённое предложение остаётся доступным."
            : "План изменился после выполнения. Старое предложение не применено.",
        );
      const selected = new Set(input.itemIds),
        eligible = p.items.filter(
          (i) => !i.wasChecked && ["complete", "verified"].includes(i.state),
        );
      if ([...selected].some((id) => !eligible.some((i) => i.id === id)))
        throw new HubError(
          400,
          "RECONCILIATION_SELECTION",
          "Можно применить только выполненные пункты этого предложения.",
        );
      const plans = new ProjectPlans(this.sessions),
        plan = plans.get(p.planId);
      const sections = plan.sections.map((s) => ({
        ...s,
        items: s.items.map((i) => ({ ...i, checked: i.checked || selected.has(i.id) })),
      }));
      const next = plans.save(plan.id, {
        scope: plan.scope,
        title: plan.title,
        description: plan.description,
        sections,
        links: plan.links,
        status: sections.every((s) => s.items.every((i) => i.checked)) ? "done" : plan.status,
        revision: plan.revision,
      });
      p.applied = { at: Date.now(), planRevision: next.revision, itemIds: input.itemIds };
      this.db
        .prepare("UPDATE plan_reconciliations SET value=? WHERE actionId=?")
        .run(JSON.stringify(p), id);
      const response = this.detail(id);
      this.db
        .prepare("INSERT INTO work_review_receipts VALUES(?,?,?,?)")
        .run(input.requestId, id, fingerprint, JSON.stringify(response));
      this.db.exec("COMMIT");
      return response;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
