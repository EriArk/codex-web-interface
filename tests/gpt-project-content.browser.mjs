import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18927",
    f = await handoffFixture(origin),
    browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18927, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript(() => localStorage.setItem("codex-client", "gpt"));
    const page = await context.newPage(),
      errors = [],
      requests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let project = {
        id: "g-p-fixture",
        name: "Личный проект",
        instructions: "Исходные инструкции",
        revision: "a".repeat(64),
        canWrite: true,
        files: [],
      },
      ops = [],
      loseAck = true;
    await page.route("**/api/gpt/**", async (route) => {
      const r = route.request(),
        p = new URL(r.url()).pathname,
        j = (v) => route.fulfill({ json: v });
      if (p === "/api/gpt/status") return j({ configured: true, canSend: true, state: "healthy" });
      if (p === "/api/gpt/models")
        return j({
          models: [{ id: "Latest", label: "Latest" }],
          efforts: [{ id: "2", label: "High" }],
          currentModel: "Latest",
          currentEffort: "2",
        });
      if (p === "/api/gpt/project-operations") {
        if (r.method() === "GET")
          return j({ items: [{ id: "entry", projectId: project.id, state: "unknown" }] });
        const body = r.postDataJSON(),
          id = r.headers()["idempotency-key"];
        requests.push({ id, body });
        if (!ops.some((o) => o.id === id))
          ops = [
            {
              id,
              projectId: project.id,
              action: body.action,
              state: body.revision === project.revision ? "unknown" : "failed",
              error:
                body.revision === project.revision ? "Подтверждение потеряно" : "Проект изменился",
            },
          ];
        if (loseAck) {
          loseAck = false;
          return route.abort("failed");
        }
        return j({ id });
      }
      if (p.endsWith("/content")) return j({ project, operations: ops });
      if (p.endsWith("/check")) {
        const sent = requests.at(-1);
        project = { ...project, instructions: sent.body.text, revision: "c".repeat(64) };
        ops[0].state = "completed";
        return j({ ok: true });
      }
      return j({ items: [], conversations: [], nextOffset: null, blocked: false });
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "Открыть проект", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Инструкции и файлы ChatGPT" }),
      editor = modal.getByRole("textbox", { name: "Инструкции проекта ChatGPT" });
    await expect(editor).toHaveValue("Исходные инструкции");
    await editor.fill("Мой черновик");
    await modal.getByRole("button", { name: "Закрыть проект ChatGPT" }).click();
    project = { ...project, instructions: "Изменено в другом клиенте", revision: "b".repeat(64) };
    await page.getByRole("button", { name: "Открыть проект", exact: true }).click();
    await expect(editor).toHaveValue("Мой черновик");
    await modal.getByRole("button", { name: "Сохранить инструкции", exact: true }).click();
    await expect(modal.getByText("Проект изменился", { exact: true })).toBeVisible();
    assert.equal(requests[0].body.revision, "a".repeat(64));
    await expect(editor).toBeEnabled();
    await expect(editor).toHaveValue("Мой черновик");
    await modal.getByRole("button", { name: "Обновить", exact: true }).click();
    await expect(editor).toHaveValue("Мой черновик");
    await modal.getByRole("button", { name: "Сохранить инструкции", exact: true }).click();
    assert.equal(requests.at(-1).body.revision, "b".repeat(64));
    await expect(
      modal.getByRole("button", { name: "Проверить результат", exact: true }),
    ).toBeVisible();
    await modal.getByRole("button", { name: "Проверить результат", exact: true }).click();
    await expect(modal.getByText("Изменение подтверждено ChatGPT.", { exact: true })).toBeVisible();
    await expect(editor).toBeEnabled();
    assert.equal(requests.length, 2);
    project.files = [
      {
        id: "file-check",
        name: "Длинное имя файла с пробелами и подробным описанием.txt",
        bytes: 1234,
      },
    ];
    await modal.getByRole("button", { name: "Обновить", exact: true }).click();
    await mkdir(`.local/qa-gpt-project/${engine}`, { recursive: true });
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [320, 393, 1366]) {
        await page.setViewportSize({ width, height: width < 1000 ? 852 : 1024 });
        const rect = await modal.boundingBox();
        assert(rect.x >= 0 && rect.x + rect.width <= width + 1);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert(
          await modal
            .locator(".gpt-project-file")
            .evaluate((row) =>
              [...row.children].every((el) => el.scrollWidth <= el.clientWidth + 1),
            ),
          "The file name must wrap inside its row, including its button",
        );
        await page.screenshot({ path: `.local/qa-gpt-project/${engine}/${theme}-${width}.png` });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      engine + ": native project draft/revision recovery and themed phone/tablet layout passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
