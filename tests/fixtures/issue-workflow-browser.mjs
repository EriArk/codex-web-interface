import assert from "node:assert/strict";
import { expect } from "@playwright/test";

/** Real Team HTTP/CSRF routing; disposable native transports and GitHub effects. */
export async function issueWorkflow({
  browser,
  other,
  login,
  drawer,
  runtimes,
  friendNative,
  spaces,
  spaceId,
  ownerId,
  activityProbe,
  base,
}) {
  const sender = runtimes.get("friend"),
    recipient = runtimes.get("owner"),
    receipts = new Map();
  let writes = 0;
  sender.issueDrawer.probe = async (_machine, root, q) => {
    assert.equal(root, sender.sessions.project("friend-extra").workingDirectory);
    assert.equal(q.repository, "example/altar");
    if (q.op === "prepare") {
      const receipt = {
        id: q.id,
        state: "prepared",
        fingerprint: q.id,
        input: q.input,
        snapshot: {
          repository: q.repository,
          repositoryId: 42,
          identity: { id: 22, login: "Friend" },
          access: "write",
          issues: true,
        },
      };
      receipts.set(q.id, receipt);
      return structuredClone(receipt);
    }
    const r = receipts.get(q.id);
    if (q.op === "apply") {
      writes++;
      r.state = "completed";
      r.result = { number: 987, url: "https://github.com/example/altar/issues/987" };
    }
    return structuredClone(r);
  };
  await sender.gpt.catalog();
  sender.projectGpts.bind("friend-extra", friendNative.conversationId, 0);
  const nav = await drawer(other);
  await nav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await nav.locator(".space-entry").click();
  await nav.getByRole("button", { name: "Активность", exact: true }).click();
  const activity = other.locator("dialog.activity-dialog[open]");
  await activity.getByRole("button", { name: "Обсудить в GPT", exact: true }).first().click();
  const gpt = other.locator(".project-gpt-window[open]"),
    composer = gpt.getByRole("textbox", { name: "Сообщение GPT", exact: true });
  await expect(gpt.getByRole("group", { name: "Контекст Activity" })).toContainText("Источников:");
  await composer.fill("private-review-sentinel: предложи Issue по выбранному изменению");
  await gpt.getByRole("button", { name: "Отправить GPT", exact: true }).click();
  await expect.poll(() => friendNative.state.sends).toBe(1);
  friendNative.state.finished = true;
  await expect
    .poll(
      () =>
        sender.store.db.prepare("SELECT status FROM gpt_jobs ORDER BY rowid DESC LIMIT 1").get()
          ?.status,
      { timeout: 15000 },
    )
    .toBe("completed");
  await expect(gpt.getByText("nativeworkspaceok", { exact: true })).toBeVisible();
  await gpt
    .locator(".message")
    .filter({ hasText: "nativeworkspaceok" })
    .getByRole("button", { name: "В Issues", exact: true })
    .click();
  const selection = other.getByRole("dialog", { name: "Подборка Issues", exact: true });
  await selection.getByRole("button", { name: "Добавить в подборку" }).click();
  await selection
    .getByRole("textbox", { name: "Название Issue", exact: true })
    .fill("Проверить совместимость сохранений");
  await selection
    .getByRole("textbox", { name: "Текст Issue", exact: true })
    .fill("Точный согласованный текст.\n\nПроверить старые сохранения после изменения API.");
  await selection.getByRole("button", { name: "Сохранить", exact: true }).click();
  await selection
    .getByRole("checkbox", { name: "Выбрать: Проверить совместимость сохранений" })
    .check();
  await selection.getByRole("button", { name: "Проверить пакет", exact: true }).click();
  await expect(
    selection.getByText("От GitHub: @Friend · Issues: 1", { exact: true }),
  ).toBeVisible();
  assert.equal(writes, 0);
  let lost = false;
  await other.route("**/api/issue-drawer/packages/*/confirm", async (route) => {
    if (!lost) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await selection.getByRole("button", { name: "Отправить 1 Issues", exact: true }).click();
  await expect(
    selection.getByRole("button", { name: "Открыть Issue #987", exact: true }),
  ).toBeVisible();
  assert.equal(writes, 1);
  assert.equal(recipient.issueDrawer.list().items.length, 0);
  const notices = spaces.catalog(ownerId).spaces.find((s) => s.id === spaceId).issueDispatches;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sender.name, "Друг");
  assert(!JSON.stringify(notices).includes("private-review-sentinel"));
  assert(!JSON.stringify(notices).includes(friendNative.conversationId));
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "owner");
    const id = sender.issueDrawer.list().items[0].id;
    assert.equal(
      (await context.request.get(base + `/api/issue-drawer/items/${id}/source`)).status(),
      404,
    );
    const ownerNav = await drawer(page);
    await ownerNav.getByRole("button", { name: /^Уведомления/ }).click();
    const notifications = page.getByRole("dialog", { name: "Общее пространство", exact: true });
    const card = notifications
      .locator(".space-card")
      .filter({ hasText: "Друг отправил Issues: 1" });
    await expect(card).toBeVisible();
    recipient.intake.probe = activityProbe;
    recipient.sessions.catalog.history = async (t) => ({
      ...recipient.store.history(t.id),
      nextBefore: null,
    });
    const previous = recipient.projectWork.context.current({
      client: "codex",
      projectId: "owner-project",
      name: "Altar",
    }).threadId;
    const before = recipient.nativeCalls.filter((c) => c.method === "turn/start").length;
    await page.evaluate((ownerId) => {
      localStorage.setItem(
        `cw-user:${ownerId}:intake-draft:owner-project`,
        "Existing unrelated draft",
      );
      localStorage.setItem(`cw-user:${ownerId}:intake-refs:owner-project`, "issue:123");
    }, ownerId);
    await card.getByRole("button", { name: "Изучить", exact: true }).click();
    const intake = page.getByRole("dialog", { name: "Разбор · Altar", exact: true });
    await expect(intake).toBeVisible();
    const draft = intake.getByRole("textbox", { name: "Сообщение для разбора", exact: true });
    const refs = intake.getByRole("textbox", { name: "Источники разбора", exact: true });
    await expect(draft).toHaveValue("");
    await intake.locator("summary").filter({ hasText: "Issues, PR" }).click();
    await expect(refs).toHaveValue("https://github.com/example/altar/issues/987");
    await refs.fill("issue:987");
    await draft.fill("Saved notification draft");
    await intake.getByRole("button", { name: "Закрыть разбор" }).click();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Изучить", exact: true }).click();
    await expect(draft).toHaveValue("Saved notification draft");
    await intake.locator("summary").filter({ hasText: "Issues, PR" }).click();
    await expect(refs).toHaveValue("issue:987");
    assert.deepEqual(
      await page.evaluate(
        (ownerId) => [
          localStorage.getItem(`cw-user:${ownerId}:intake-draft:owner-project`),
          localStorage.getItem(`cw-user:${ownerId}:intake-refs:owner-project`),
        ],
        ownerId,
      ),
      ["Existing unrelated draft", "issue:123"],
    );
    assert.equal(
      recipient.nativeCalls.filter((c) => c.method === "turn/start").length,
      before,
      "opening never sends automatically",
    );
    await intake
      .getByRole("textbox", { name: "Сообщение для разбора", exact: true })
      .fill("Изучи предложенную проверку совместимости");
    await intake.getByRole("button", { name: "Отправить на разбор", exact: true }).click();
    await expect
      .poll(() => recipient.nativeCalls.filter((c) => c.method === "turn/start").length)
      .toBe(before + 1);
    const turn = recipient.nativeCalls.filter((c) => c.method === "turn/start").at(-1);
    assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly" });
    assert(JSON.stringify(turn.params).includes("issue:987"));
    assert(!JSON.stringify(turn.params).includes("private-review-sentinel"));
    assert.equal(
      recipient.projectWork.context.current({
        client: "codex",
        projectId: "owner-project",
        name: "Altar",
      }).threadId,
      previous,
    );
    const state = recipient.intake.get("owner-project"),
      thread = recipient.store.thread(state.threadId);
    recipient.sessions.emitEvent(
      thread.id,
      "assistant.completed",
      {
        id: "accepted-intake-final",
        text: "Проверил совместимость. Нужен регрессионный тест.",
        phase: "final_answer",
      },
      thread.activeTurnId,
    );
    recipient.rpc.emit("notification", "turn/completed", {
      threadId: thread.codexThreadId,
      turn: { id: thread.activeTurnId, status: "completed" },
    });
    await expect(
      intake.getByText("Проверил совместимость. Нужен регрессионный тест.", { exact: true }),
    ).toBeVisible();
    await intake.getByRole("button", { name: "Закрыть разбор" }).click();
    await card.getByRole("button", { name: "Прочитано", exact: true }).click();
    await expect(card).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  await selection.getByRole("button", { name: "Закрыть подборку" }).click();
  await gpt.getByRole("button", { name: "Закрыть GPT проекта" }).click();
  await activity.getByRole("button", { name: "Закрыть пространство" }).click();
  console.log(
    "Team Issue workflow passed: Activity -> own GPT -> reviewed Issue once -> recipient notice -> own read-only Intake; private source denied across accounts.",
  );
}
