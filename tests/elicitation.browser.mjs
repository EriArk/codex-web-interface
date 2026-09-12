import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { formRequest } from "./elicitation-fixture.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18888",
    f = await handoffFixture(origin),
    replies = [];
  await f.release();
  await f.sessions.resume(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "classic-dark",
    machineClients: { pc: "web" },
  });
  const r = await f.sessions.runtime("project");
  r.rpc.respond = (id, result) => replies.push({ id, result });
  r.rpc.rejectRequest = () => assert.fail("unexpected rejected request");
  const request = async (id, params = formRequest) =>
    f.sessions.request(r, {
      id,
      method: "mcpServer/elicitation/request",
      params: { ...params, threadId: f.thread.codexThreadId, turnId: "turn" },
    });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  const [cookie, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name: cookie, value, url: origin, httpOnly: true }]);
  try {
    await f.app.listen({ port: 18888, host: "127.0.0.1" });
    await request(1);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const card = page.getByRole("region", { name: "Запрос Calendar" });
    await expect(card).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
    await composer.fill("Черновик не меняется");
    await page.reload();
    await expect(card).toBeVisible();
    await expect(composer).toHaveValue("Черновик не меняется");
    await mkdir(`.local/qa-elicitation/${name}`, { recursive: true });
    for (const theme of ["classic-dark", "crt-green", "organizer", "hitech-2000s"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [393, 1366]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await card.locator("header").scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({
          path: `.local/qa-elicitation/${name}/${theme}-${width}.png`,
          animations: "disabled",
        });
      }
    }
    await card.getByLabel("title", { exact: false }).fill("Demo");
    await card.getByLabel("enabled", { exact: false }).selectOption("false");
    await card.getByLabel("count", { exact: false }).fill("0");
    await card.getByLabel("One", { exact: true }).check();
    await card.getByRole("button", { name: "Ответить", exact: true }).click();
    await expect.poll(() => replies.length).toBe(1);
    assert.deepEqual(replies[0].result.content, {
      enabled: false,
      title: "Demo",
      count: 0,
      labels: ["x"],
    });
    await expect(card).toHaveCount(0);
    await expect(composer).toHaveValue("Черновик не меняется");
    await request(2, {
      mode: "url",
      serverName: "Account",
      message: "Подключи сервис",
      url: "https://external.test/auth?token=private",
      elicitationId: "url-1",
    });
    const urlCard = page.getByRole("region", { name: "Запрос Account" });
    await expect(urlCard).toBeVisible();
    await expect(urlCard.getByRole("button", { name: "Готово", exact: true })).toBeDisabled();
    assert(!(await urlCard.innerHTML()).includes("token=private"));
    const link = urlCard.getByRole("link");
    assert.equal(await link.getAttribute("target"), "_blank");
    // The test container has no external network. Verify the real authenticated
    // redirect, then stand in for the service page in the newly opened window.
    await context.route("**/api/approvals/*/open", async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      assert.equal(response.status(), 302);
      assert.equal(response.headers().location, "https://external.test/auth?token=private");
      await route.fulfill({ status: 200, body: "Connected", contentType: "text/plain" });
    });
    const popupReady = page.waitForEvent("popup");
    await link.click();
    const popup = await popupReady;
    await expect(popup.locator("body")).toHaveText("Connected");
    await popup.close();
    await urlCard.getByRole("button", { name: "Готово", exact: true }).click();
    await expect.poll(() => replies.length).toBe(2);
    assert.deepEqual(replies[1].result, { action: "accept", content: null });
    await request(3);
    await card.getByRole("button", { name: "Отклонить", exact: true }).click();
    await expect.poll(() => replies.length).toBe(3);
    assert.equal(replies[2].result.action, "decline");
    await request(4);
    await card.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect.poll(() => replies.length).toBe(4);
    assert.equal(replies[3].result.action, "cancel");
    await request(5);
    await expect(card).toBeVisible();
    r.rpc.emit("notification", "serverRequest/resolved", {
      threadId: f.thread.codexThreadId,
      requestId: 5,
    });
    await expect(card).toHaveCount(0);
    assert.equal(replies.length, 4);
    await request(6, {
      mode: "openaiForm",
      serverName: "Resources",
      message: "Choose files",
      requestedSchema: {
        type: "object",
        required: ["files"],
        properties: {
          files: {
            type: "array",
            items: { type: "string", format: "uri" },
            "x-openai-input": {
              type: "file",
              selection: "implicit",
              options: [{ uri: "file:///D:/one.md", name: "One document" }],
              userOptions: { kind: "file", accept: [".md"] },
            },
          },
        },
      },
    });
    const resources = page.getByRole("region", { name: "Запрос Resources" });
    await expect(resources.getByLabel("One document", { exact: true })).toBeChecked();
    await resources.getByLabel("Другой файл на машине").fill("file:///D:/two.md");
    await resources.getByRole("button", { name: "Выбрать", exact: true }).click();
    await resources.getByRole("button", { name: "Ответить", exact: true }).click();
    await expect.poll(() => replies.length).toBe(5);
    assert.deepEqual(replies[4].result.content, {
      files: ["file:///D:/one.md", "file:///D:/two.md"],
    });
    await request(7, {
      mode: "openai/form",
      serverName: "Images",
      message: "Choose image",
      requestedSchema: {
        type: "object",
        required: ["image"],
        properties: {
          image: {
            type: "openai/imagePicker",
            items: [
              {
                id: "cover",
                title: "Cover",
                image:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=",
              },
            ],
          },
        },
      },
    });
    const images = page.getByRole("region", { name: "Запрос Images" });
    await images.getByRole("radio", { name: "Cover" }).check();
    await images.getByRole("button", { name: "Ответить", exact: true }).click();
    await expect.poll(() => replies.length).toBe(6);
    assert.deepEqual(replies[5].result.content, { image: "cover" });
    await expect(composer).toHaveValue("Черновик не меняется");
    assert.deepEqual(errors, []);
    console.log(
      name +
        ": typed MCP form, reload, unchanged draft, URL popup, accept/decline/cancel, external resolution and four themes passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
