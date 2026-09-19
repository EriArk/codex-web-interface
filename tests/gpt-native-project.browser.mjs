import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const native = nativeWorkspaceFixture(),
    origin = "http://127.0.0.1:18942",
    id = "g-p-example";
  let revision = 1,
    writes = 0,
    checks = 0,
    files = [],
    instructions = "Rules",
    saved;
  const rev = () => revision.toString(16).padStart(64, "0");
  native.workspace.projects = new Set([id]);
  native.client.projectContent = async () => ({
    ...(await native.client.project(id)),
    instructions,
    files,
    revision: rev(),
  });
  native.client.projectMutation = async (r, path) => {
    writes++;
    assert.equal(r.revision, rev());
    if (r.action === "instructions") {
      saved = r;
      throw Error("NATIVE_TIMEOUT");
    }
    if (r.action === "upload") {
      const bytes = await readFile(path);
      assert.equal(bytes.length, 32 * 1024 ** 2);
      assert.equal(r.file.sha256, createHash("sha256").update(bytes).digest("hex"));
      files = [{ id: "file-exact", name: r.file.name, bytes: bytes.length }];
    } else {
      assert.equal(r.fileId, "file-exact");
      files = [];
    }
    revision++;
    return { state: "completed" };
  };
  native.client.reconcileProject = async (key, projectId) => {
    checks++;
    assert.equal(key, saved.key);
    assert.equal(projectId, id);
    instructions = saved.text;
    revision++;
    return { state: "completed" };
  };
  const f = await handoffFixture(origin, undefined, { nativeGpt: native.workspace }),
    browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18942, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript(() => localStorage.setItem("codex-client", "gpt"));
    const response = await f.app.inject({
      method: "POST",
      url: "/api/gpt/project-operations",
      headers: { ...f.headers, "idempotency-key": randomUUID() },
      payload: {
        projectId: id,
        revision: rev(),
        action: "instructions",
        text: "Verified instructions",
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Открыть проект", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Инструкции и файлы ChatGPT" });
    await expect(
      modal.getByRole("button", { name: "Проверить результат", exact: true }),
    ).toBeVisible();
    await expect(modal.getByRole("button", { name: "Проверено вручную", exact: true })).toHaveCount(
      0,
    );
    await modal.getByRole("button", { name: "Проверить результат", exact: true }).click();
    await expect(modal.getByRole("textbox", { name: "Инструкции проекта ChatGPT" })).toHaveValue(
      "Verified instructions",
    );
    await modal
      .locator("input[type=file]")
      .setInputFiles({
        name: "project-large.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.alloc(32 * 1024 ** 2, 65),
      });
    await expect(modal.getByText("project-large.pdf", { exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(modal.getByRole("link", { name: "project-large.pdf", exact: true })).toHaveCount(
      0,
    );
    page.once("dialog", (d) => d.accept());
    await modal.getByRole("button", { name: "Удалить project-large.pdf из ChatGPT" }).click();
    await expect(modal.getByText("В проекте пока нет файлов.", { exact: true })).toBeVisible();
    assert.equal(writes, 3);
    assert.equal(checks, 1);
    assert.equal(native.state.sends, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": actual Hub/shared project UI: lost acknowledgement, read-only reconcile, 32 MiB upload/hash and exact removal; no send",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
