import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { deliveryFixture, deliveryState } from "./delivery-fixture.mjs";

const engine = process.env.BROWSER ?? "webkit",
  origin = "http://127.0.0.1:18878";
const f = await deliveryFixture(origin, {
  collaborationPolicy: {
    instructions: () => null,
    delivery: () => {},
    checkoutScope: () => ({
      spaceId: "space",
      projectId: "shared",
      ownerId: "owner",
      ownerProjectId: "owner-project",
      participantId: "member",
      repository: "https://github.com/owner/project",
      access: "collaborate",
    }),
  },
});
const state = {
  ...deliveryState(),
  changed: 0,
  paths: [],
  sync: {
    status: "behind",
    baseRef: "refs/heads/main",
    baseSha: "b".repeat(40),
    commonSha: "a".repeat(40),
    repositoryId: 73,
    githubUserId: 42,
    gitDirectory: "/work/.git",
    commonDirectory: "/work/.git",
    ahead: 0,
    behind: 7,
    conflicts: [],
    conflictsTotal: 0,
  },
};
f.setState(state);
await f.release();
f.store.setPreferences({
  projectId: "project",
  threadId: f.thread.id,
  theme: "classic-dark",
  view: "chat",
});
const browser = await (engine === "webkit" ? webkit : chromium).launch(),
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "allow",
  });
const [name, value] = f.headers.cookie.split("=");
await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await f.app.listen({ host: "127.0.0.1", port: 18878 });
  await page.goto(origin);
  const compose = page.getByRole("textbox", { name: "Сообщение Codex", exact: true });
  await expect(compose).toBeVisible();
  await compose.fill("Сохранённый черновик");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("open-project-delivery", {
        detail: {
          projectId: "project",
          projectName: "Очень длинное название общего проекта для проверки заголовка",
        },
      }),
    ),
  );
  const panel = page.getByRole("dialog", { name: "Доставка проекта", exact: true });
  await expect(panel.locator(".checkout-sync")).toContainText("Новых коммитов: 7");
  await panel.getByRole("button", { name: "Обновить копию", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Подтвердить обновление копии", exact: true }),
  ).toBeVisible();
  assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 0);
  await panel.getByRole("button", { name: "Подтвердить обновление копии", exact: true }).click();
  await expect(panel.locator(".delivery-operation")).toHaveAttribute("data-state", "completed", {
    timeout: 12000,
  });
  assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 1);
  await panel.getByRole("button", { name: "Продолжить", exact: true }).click();
  f.setState({
    ...state,
    sync: {
      ...state.sync,
      status: "conflict",
      ahead: 2,
      conflictsTotal: 1,
      conflicts: [
        {
          path: "src/component-with-long-name.ts",
          preview:
            "<<<<<<< local\nconst title = 'Мой вариант';\n=======\nconst title = 'Общий вариант';\n>>>>>>> upstream",
        },
      ],
    },
  });
  await panel.getByRole("button", { name: "Обновить доставку", exact: true }).click();
  await expect(panel.locator(".checkout-sync")).toContainText("Нужен разбор конфликтов");
  await panel.getByText("Конфликты · 1", { exact: true }).click();
  await panel.getByText("src/component-with-long-name.ts", { exact: true }).click();
  await mkdir(".local/qa-checkout-sync", { recursive: true });
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    for (const [width, height] of [
      [390, 844],
      [390, 500],
      [768, 1024],
      [1024, 768],
      [1366, 1024],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.caseColor =
          t === "hitech-2000s" ? "turquoise" : t === "classic-dark" ? "blue" : "green";
      }, theme);
      await page.waitForTimeout(150);
      await panel.locator(".checkout-sync").scrollIntoViewIfNeeded();
      assert(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await page.screenshot({
        animations: "disabled",
        path: `.local/qa-checkout-sync/${engine}-${theme}-${width}x${height}.png`,
      });
    }
  }
  await panel.getByRole("button", { name: "Разобрать в Codex", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Задание проекта" })).toContainText(
    "Согласование рабочей копии",
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  await panel.getByRole("button", { name: "Закрыть доставку" }).click();
  await expect(compose).toHaveValue("Сохранённый черновик");
  assert.deepEqual(errors, []);
  console.log(engine + " checkout sync browser passed");
} finally {
  await browser.close();
  await f.close();
}
