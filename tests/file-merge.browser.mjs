import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-file-merge", { recursive: true });
const engine = process.env.BROWSER ?? "chromium",
  type = engine === "webkit" ? webkit : chromium;
{
  const root = await mkdtemp(join(tmpdir(), "file-batch-browser-")),
    origin = "http://127.0.0.1:18887",
    f = await handoffFixture(origin);
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  f.sessions.config.projects[0].name = "Очень длинное название проекта — рабочие файлы команды";
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
    machineClients: { pc: "web" },
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18887 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const composer = page.getByLabel("Сообщение Codex", { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill("Сохранить черновик чата");
    const pane = page.locator(".project-files[open]"),
      popup = page.getByRole("dialog", { name: "Групповая операция", exact: true }),
      controls = pane.getByRole("region", { name: "Выбор и групповые действия" });
    const open = async () => {
      await page.getByRole("button", { name: "Файлы проекта", exact: true }).click();
      await pane.getByRole("button", { name: "Разблокировать файлы", exact: true }).click();
    };
    const folder = async (path) => {
      await pane.getByRole("button", { name: "Ввести путь", exact: true }).click();
      await pane.getByLabel("Путь в проекте").fill(path);
      await pane.getByRole("button", { name: "Открыть папку", exact: true }).click();
      await expect(pane.locator(".inspector-entry").first()).toBeVisible();
    };
    const select = (path) =>
      pane.getByRole("checkbox", { name: `Выбрать: ${path}`, exact: true }).check();
    const start = () => popup.getByRole("button", { name: "Выполнить", exact: true }).click();
    const row = (path) => popup.getByRole("region", { name: path, exact: true });
    const finish = () => popup.getByRole("button", { name: "Завершить", exact: true }).click();
    for (const directory of [
      "incoming/tree/nested",
      "incoming/tree/empty",
      "destination/tree/nested",
      "destination/tree/empty",
    ])
      await mkdir(join(root, directory), { recursive: true });
    for (const [path, text] of [
      ["incoming/tree/nested/keep.txt", "source keep"],
      ["destination/tree/nested/keep.txt", "target keep"],
      ["incoming/tree/nested/both.txt", "new both"],
      ["destination/tree/nested/both.txt", "old both"],
      ["incoming/tree/nested/replace.txt", "new replace"],
      ["destination/tree/nested/replace.txt", "old replace"],
      ["incoming/tree/new.txt", "new file"],
      ["destination/tree/only.txt", "target only"],
    ])
      await writeFile(join(root, path), text);
    await open();
    await folder("incoming");
    await controls.getByRole("button", { name: /^Выбрать несколько/ }).click();
    await select("incoming/tree");
    await controls.getByRole("button", { name: "Вырезать", exact: true }).click();
    await folder("destination");
    await controls.getByRole("button", { name: /^Вставить сюда/ }).click();
    await start();
    await expect(
      row("incoming/tree").getByRole("button", { name: "Объединить папки", exact: true }),
    ).toBeEnabled();
    await writeFile(join(root, "destination/tree/arrived.txt"), "external arrival");
    await row("incoming/tree")
      .getByRole("button", { name: "Объединить папки", exact: true })
      .click();
    await expect(popup.getByRole("alert")).toContainText("назначения изменился");
    await row("incoming/tree")
      .getByRole("button", { name: "Объединить папки", exact: true })
      .click();
    await expect(row("incoming/tree/nested/replace.txt")).toBeVisible();
    for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"])
      for (const [width, height] of [
        [390, 844],
        [390, 430],
        [768, 1024],
        [1366, 1024],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await row("incoming/tree/nested/both.txt").scrollIntoViewIfNeeded();
        await expect
          .poll(async () => {
            const b = await popup.boundingBox();
            return (
              b.x >= 0 &&
              b.y >= 0 &&
              b.y + b.height <= height + 1 &&
              Math.abs(b.x - (width - b.x - b.width)) < 2
            );
          })
          .toBe(true);
        const peers = await row("incoming/tree/nested/both.txt")
          .locator(".file-batch-pair button")
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
        assert(Math.abs(peers[0] - peers[1]) < 1);
        const close = await popup
          .getByRole("button", { name: "Закрыть групповую операцию" })
          .boundingBox();
        assert(close.width >= 44 && close.height >= 44);
        await page.screenshot({
          path: `.local/qa-file-merge/${engine}-${theme}-${width}x${height}.png`,
          animations: "disabled",
        });
      }
    await page.setViewportSize({ width: 390, height: 844 });
    await row("incoming/tree/nested/keep.txt")
      .getByRole("button", { name: "Пропустить", exact: true })
      .click();
    await row("incoming/tree/nested/both.txt")
      .getByRole("button", { name: "Сохранить оба", exact: true })
      .click();
    await row("incoming/tree/nested/replace.txt")
      .getByRole("button", { name: "Заменить выбранную версию", exact: true })
      .click();
    // Lost response after an actual move: reload must preserve the entire expanded merge plan.
    let lost = false,
      notSent = false;
    const writes = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/file-tools"))
        writes.push(request.postDataJSON());
    });
    await page.route("**/file-tools", async (route) => {
      const request = route.request();
      if (
        request.method() === "POST" &&
        !lost &&
        request.postDataJSON().path.endsWith("nested/both.txt")
      ) {
        lost = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        await route.abort("failed");
      } else if (
        request.method() === "POST" &&
        !notSent &&
        request.postDataJSON().path.endsWith("/new.txt")
      ) {
        notSent = true;
        await route.abort("failed");
      } else await route.continue();
    });
    await start();
    await expect(
      row("incoming/tree/nested/both.txt").getByRole("button", { name: "Проверить результат" }),
    ).toBeVisible();
    assert.equal(
      await readFile(join(root, "destination/tree/nested/both (копия).txt"), "utf8"),
      "new both",
    );
    await page.reload();
    await open();
    await controls.getByRole("button", { name: /^Операция/ }).click();
    await expect(popup.getByRole("button", { name: "Выполнить", exact: true })).toBeDisabled();
    await row("incoming/tree/nested/both.txt")
      .getByRole("button", { name: "Проверить результат" })
      .click();
    await expect(row("incoming/tree/nested/both.txt")).toContainText("Готово");
    assert(writes.filter((r) => r.path.endsWith("nested/both.txt")).at(-1).checkOnly);
    await start();
    await expect(
      row("incoming/tree/new.txt").getByRole("button", { name: "Проверить результат" }),
    ).toBeVisible();
    await assert.rejects(stat(join(root, "destination/tree/new.txt")), { code: "ENOENT" });
    await row("incoming/tree/new.txt").getByRole("button", { name: "Проверить результат" }).click();
    await expect(row("incoming/tree/new.txt")).toContainText("Готов к выполнению");
    await assert.rejects(stat(join(root, "destination/tree/new.txt")), { code: "ENOENT" });
    await start();
    await expect(row("incoming/tree")).toContainText("Папка сохранена");
    assert.equal(
      await readFile(join(root, "incoming/tree/nested/keep.txt"), "utf8"),
      "source keep",
    );
    assert.equal(
      await readFile(join(root, "destination/tree/nested/keep.txt"), "utf8"),
      "target keep",
    );
    assert.equal(
      await readFile(join(root, "destination/tree/nested/replace.txt"), "utf8"),
      "new replace",
    );
    assert.equal(await readFile(join(root, "destination/tree/only.txt"), "utf8"), "target only");
    await assert.rejects(stat(join(root, "incoming/tree/empty")), { code: "ENOENT" });
    await finish();
    await page.unroute("**/file-tools");
    await pane.getByRole("button", { name: "Закрыть файлы", exact: true }).click();
    await expect(composer).toHaveValue("Сохранить черновик чата");
    assert.deepEqual(errors, []);
    console.log(engine + " folder merge browser passed");
  } catch (error) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `.local/qa-file-merge/${engine}-failure.png` });
      console.log(await page.locator("dialog[open]").allTextContents());
    }
    throw error;
  } finally {
    await browser.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}
