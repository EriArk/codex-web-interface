import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

const engine = process.env.BROWSER || "webkit",
  origin = "http://127.0.0.1:18879",
  root = await mkdtemp(join(tmpdir(), "cw-profile-ui-"));
execFileSync("git", ["init", "-q", root]);
const f = await handoffFixture(origin, undefined, {
  configure(c) {
    c.machines[0] = { ...c.machines[0], type: "local-linux", allowedRoots: [root] };
    c.projects[0].workingDirectory = root;
    c.projects[0].name = "Проект с длинным названием для проверки настроек поведения агента";
  },
});
const browser = await (engine === "webkit" ? webkit : chromium).launch(),
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
try {
  await f.app.listen({ port: 18879, host: "127.0.0.1" });
  f.store.setPreferences({ machineClients: { pc: "web" } });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
  await context.addInitScript((id) => {
    localStorage.setItem("codex-project", "project");
    localStorage.setItem("codex-thread", id);
  }, f.thread.id);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  await page.goto(origin);
  console.log("page loaded");
  const composer = page.getByRole("textbox", { name: "Сообщение Codex", exact: true });
  await expect(composer).toBeVisible();
  await composer.fill("Черновик основного чата");
  await page.getByRole("button", { name: "Обзор текущего проекта", exact: true }).click();
  const overview = page.locator(".project-overview-modal");
  await overview.getByRole("button", { name: "Поведение ИИ", exact: true }).click();
  console.log("profile opened");
  const win = page.getByRole("dialog", { name: "Поведение ИИ проекта", exact: true });
  await win.getByLabel("Использовать профиль поведения", { exact: true }).check();
  await win.getByLabel("Шаблон", { exact: true }).selectOption("hardware");
  await win
    .getByLabel("Дополнительные правила агента")
    .fill("Сохраняй Qt.\nУчитывай физические ограничения.");
  await win.getByRole("button", { name: "Закрыть профиль" }).click();
  await overview.getByRole("button", { name: "Поведение ИИ", exact: true }).click();
  console.log("profile opened");
  await expect(win.getByLabel("Дополнительные правила агента")).toHaveValue(
    "Сохраняй Qt.\nУчитывай физические ограничения.",
  );
  await mkdir(".local/qa-agent-profiles", { recursive: true });
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    for (const [width, height] of [
      [390, 844],
      [390, 500],
      [768, 1024],
      [1366, 1024],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(100);
      const box = await win.boundingBox(),
        close = await win.getByRole("button", { name: "Закрыть профиль" }).boundingBox(),
        save = await win.getByRole("button", { name: "Сравнить изменения" }).boundingBox();
      assert(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y + box.height <= height + 1,
      );
      assert(close.width >= 44 && close.height >= 44);
      assert.notEqual(
        await win
          .getByLabel("Шаблон", { exact: true })
          .evaluate((e) => getComputedStyle(e).backgroundImage),
        "none",
      );
      assert(save.y + save.height <= height + 1);
      await page.screenshot({
        path: `.local/qa-agent-profiles/${engine}-${theme}-${width}-${height}.png`,
        animations: "disabled",
      });
    }
  }
  await win.getByRole("button", { name: "Сравнить изменения" }).click();
  await expect(win.getByRole("region", { name: "Изменения профиля" })).toBeVisible();
  await win.getByRole("button", { name: "Применить профиль" }).click();
  await expect(win.getByRole("status")).toContainText("Профиль сохранён");
  const file = join(root, "CODEXWEB.md"),
    saved = await readFile(file, "utf8");
  assert.match(saved, /Сохраняй Qt/);
  const probe = f.projectGpts.profiles.probe;
  let delayed;
  f.projectGpts.profiles.probe = async (...args) => {
    if (args[2].op === "project-rules") {
      delayed = args;
      throw Error("lost before dispatch");
    }
    return probe(...args);
  };
  await win.getByLabel("Дополнительные правила агента").fill("Черновик после потери связи");
  await win.getByRole("button", { name: "Сравнить изменения" }).click();
  await win.getByRole("button", { name: "Применить профиль" }).click();
  await win.getByRole("button", { name: "Отменить сохранение" }).click();
  await expect(win.getByRole("button", { name: "Сравнить изменения" })).toBeEnabled();
  await expect(win.getByLabel("Дополнительные правила агента")).toHaveValue(
    "Черновик после потери связи",
  );
  assert.equal((await probe(...delayed)).receipt, "failed");
  assert.equal(await readFile(file, "utf8"), saved);
  f.projectGpts.profiles.probe = probe;
  await writeFile(file, saved + "Manual owner change\n");
  await win.getByRole("button", { name: "Обновить сравнение" }).click();
  await expect(win.getByText(/CODEXWEB.md изменён вручную/)).toBeVisible();
  await win.getByLabel("Дополнительные правила агента").fill("Сохранённый конфликтный черновик");
  await expect(win.getByRole("button", { name: "Сравнить изменения" })).toBeDisabled();
  assert.match(await readFile(file, "utf8"), /Manual owner change/);
  await win.getByRole("button", { name: "Закрыть профиль" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await overview.getByRole("button", { name: /Закрыть обзор/ }).click();
  await expect(composer).toHaveValue("Черновик основного чата");
  await page
    .getByRole("button", { name: /Открыть навигацию|Открыть проекты|Меню/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Создать проект", exact: true }).click();
  const wizard = page.getByRole("dialog", { name: "Создание проекта", exact: true });
  await wizard.getByText("Дополнительные настройки…", { exact: true }).click();
  await wizard.getByLabel("Использовать профиль поведения", { exact: true }).check();
  await wizard.getByLabel("Шаблон", { exact: true }).selectOption("web");
  await wizard.getByLabel("Дополнительные правила агента").fill("Создание с профилем");
  await wizard.getByRole("button", { name: "Закрыть создание проекта" }).click();
  assert.deepEqual(errors, []);
  console.log(
    engine +
      ": profile editing, draft isolation, file conflict and creation editor passed; four themes and keyboard geometry captured",
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
  await rm(root, { recursive: true, force: true });
}
