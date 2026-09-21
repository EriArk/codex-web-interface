import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { createRequire } from "node:module";
const sharp = createRequire(new URL("../apps/hub/package.json", import.meta.url))("sharp");
import { handoffFixture } from "./handoff-fixture.mjs";
import { gptResults } from "../apps/hub/dist/gpt-results.js";
import { GptTextArtifacts } from "../apps/hub/dist/gpt-text-artifacts.js";

await mkdir(".local/qa-message-results", { recursive: true });
const picture = await sharp({
  create: { width: 320, height: 240, channels: 3, background: "#88aac8" },
})
  .png()
  .toBuffer();
for (const [browserName, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  for (const client of ["codex", "gpt"]) {
    const origin = "http://127.0.0.1:18946",
      f = await handoffFixture(origin),
      browser = await browserType.launch();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    try {
      const generated = "/api/gpt/assets/generated-image",
        download = "/api/gpt/assets/report";
      const short = "```md\n" + "Short visible line\n".repeat(20) + "```";
      const body = "Long exported line\n".repeat(21);
      const text =
        `Before block\n\n${short}\n\nBetween blocks\n\n\`\`\`md\n${body}\`\`\`\n\nAfter block\n\n![Web thumbnail](https://images.test/web.png)\n\n[Source](https://example.org/source)` +
        (client === "codex" ? `\n\n![Generated picture](${generated})` : "");
      const message = {
        id: "answer",
        role: "assistant",
        phase: "final",
        complete: true,
        text,
        createdAt: 1,
        files: [
          {
            id: "generated",
            name: "Generated picture",
            url: generated,
            mime: "image/png",
            image: true,
            bytes: picture.length,
          },
          {
            id: "report",
            name: "report.txt",
            url: download,
            mime: "text/plain",
            image: false,
            bytes: 6,
          },
        ],
      };
      f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
      f.store.append(
        f.thread.id,
        "assistant.completed",
        { id: "answer", text, phase: "final_answer" },
        "turn",
      );
      f.store.setStatus(f.thread.id, "completed");
      f.sessions.catalog.artifacts.observe(f.thread, "turn", {
        id: "answer",
        type: "agentMessage",
        text,
      });
      const artifacts = new GptTextArtifacts(
        f.sessions.config.hub.resultsPath + "/gpt-block-test",
        f.store,
      );
      const items = gptResults("chat", [message], f.sessions.catalog.previews, origin, artifacts);
      await f.app.listen({ port: 18946, host: "127.0.0.1" });
      const [name, value] = f.headers.cookie.split("=");
      await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
      await context.addInitScript(
        ({ client, thread }) => {
          localStorage.setItem("codex-client", client);
          localStorage.setItem("codex-project", "project");
          localStorage.setItem("codex-thread", thread);
          localStorage.setItem("gpt-conversation", "chat");
        },
        { client, thread: f.thread.id },
      );
      const page = await context.newPage(),
        errors = [],
        reveals = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (event) => {
        if (event.type() === "error") console.log("browser:", event.text());
      });
      await page.route("https://images.test/**", (r) =>
        r.fulfill({ contentType: "image/png", body: picture }),
      );
      await page.route("**/api/gpt/**", async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          p = url.pathname,
          j = (json) => route.fulfill({ json });
        if (p === generated) return route.fulfill({ contentType: "image/png", body: picture });
        if (p === download) return route.fulfill({ contentType: "text/plain", body: "report" });
        if (p.startsWith("/api/gpt/text-artifacts/"))
          return route.fulfill({ contentType: "text/markdown", body });
        if (p === "/api/gpt/status")
          return j({ configured: true, canSend: true, state: "healthy" });
        if (p === "/api/gpt/models")
          return j({
            models: [{ id: "Latest", label: "Latest" }],
            efforts: [{ id: "2", label: "High" }],
            currentModel: "Latest",
            currentEffort: "2",
          });
        if (p === "/api/gpt/conversations")
          return j({
            items: [{ id: "chat", title: "Message results", updatedAt: 1 }],
            nextOffset: null,
          });
        if (p.endsWith("/messages"))
          return j({ items: [message], nextBefore: null, revision: "a".repeat(64) });
        if (p.endsWith("/results/reveal")) {
          reveals.push(req.postDataJSON());
          return j(items.find((x) => x.id.startsWith("text-")));
        }
        if (p.endsWith("/results"))
          return j({
            items: items.filter((x) =>
              url.searchParams.get("category") === "images"
                ? x.type === "image"
                : x.type === "file",
            ),
            counts: {
              all: items.length,
              files: 2,
              images: 2,
              links: 1,
              demos: 0,
              work: 0,
              reasoning: 0,
            },
            nextBefore: null,
          });
        return j({ items: [], projects: [], jobs: [], conversations: [] });
      });
      page.on("request", (req) => {
        if (client === "codex" && req.url().endsWith("/results/reveal"))
          reveals.push(req.postDataJSON());
      });
      await page.goto(origin);
      const shortBlock = page.locator(".message-short-block"),
        blockLink = page.getByRole("button", { name: /Блок в результатах/ });
      await expect(shortBlock)
        .toHaveCount(1)
        .catch(async (e) => {
          console.log({
            client,
            errors,
            body: (await page.locator("body").innerText()).slice(0, 3000),
          });
          throw e;
        });
      await expect(shortBlock.locator("pre")).toBeVisible();
      await expect(shortBlock.locator("code")).toContainText("Short visible line");
      await expect(blockLink).toHaveCount(1);
      await expect(page.locator(".message-body")).not.toContainText("Long exported line");
      const web = page.getByRole("img", { name: "Web thumbnail" }),
        generatedImage = page.getByRole("img", { name: "Generated picture" });
      await expect(async () => {
        await web.scrollIntoViewIfNeeded();
        await expect(web).toBeVisible();
      }).toPass({ timeout: 5000 });
      await expect.poll(() => web.evaluate((img) => img.naturalWidth)).toBe(320);
      assert.equal((await web.boundingBox()).width, 88);
      await expect(async () => {
        await generatedImage.scrollIntoViewIfNeeded();
        await expect(generatedImage).toBeVisible();
      }).toPass({ timeout: 5000 });
      assert((await generatedImage.boundingBox()).width > 200);
      if (client === "gpt")
        await expect(page.getByRole("button", { name: "report.txt" })).toBeVisible();
      const editor = page.getByRole("textbox", {
        name: client === "gpt" ? "Сообщение GPT" : "Сообщение Codex",
      });
      await editor.fill("Keep draft");
      for (const width of [390, 1024])
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
          await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
          await expect(async () => {
            await blockLink.scrollIntoViewIfNeeded();
          }).toPass({ timeout: 5000 });
          const box = await blockLink.boundingBox();
          assert(box.width < width);
          assert(box.height >= 40);
          await page.screenshot({
            path: `.local/qa-message-results/${browserName}-${client}-${width}-${theme}.png`,
          });
        }
      await blockLink.click();
      await expect.poll(() => reveals.length).toBe(1);
      assert.match(reveals[0].source, /^text-block:\d+:[a-f0-9]{64}$/);
      assert.equal(reveals[0].messageId, "answer");
      await expect(page.locator(".file-preview")).toContainText("Long exported line");
      await page.getByRole("button", { name: "Чат", exact: true }).click();
      await expect(editor).toHaveValue("Keep draft");
      assert.deepEqual(errors, []);
      console.log(
        `${browserName} ${client}: inline 20 lines, exact 21-line result link, source thumbnail, generated image, draft, four themes and phone/tablet passed`,
      );
    } finally {
      await context.close();
      await browser.close();
      await f.close();
    }
  }
}
