import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "cw-room-ui-")),
  screens = resolve(process.env.QA_SCREENSHOTS || ".local/qa-brainstorm");
await mkdir(screens, { recursive: true });
async function checkDialog(page) {
  const dialog = page.locator("dialog[open]").last();
  const frame = await dialog.boundingBox();
  const close = await dialog.locator(":scope > header > button").boundingBox();
  const viewport = page.viewportSize();
  assert(
    Math.abs(frame.y - (viewport.height - frame.y - frame.height)) <= 2,
    "dialog vertically centered",
  );
  assert(
    frame.y >= 0 && frame.y + frame.height <= viewport.height + 1,
    "dialog fits keyboard viewport",
  );
  assert(
    close.width >= 44 && close.height >= 44 && frame.x + frame.width - close.x - close.width <= 24,
    "Close anchored at right edge",
  );
}
try {
  await build({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "error",
    build: {
      outDir: dir,
      emptyOutDir: true,
      lib: {
        entry: resolve("apps/web/tests/fixtures/brainstorm.tsx"),
        name: "Room",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8"),
    css = (
      await Promise.all(
        (
          await readdir(dir)
        )
          .filter((f) => f.endsWith(".css"))
          .map((f) => readFile(join(dir, f), "utf8")),
      )
    ).join("\n");
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
        errors = [],
        requests = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error(e.stack);
      });
      const owner = "22222222-2222-4222-8222-222222222222",
        roomId = "11111111-1111-4111-8111-111111111111";
      const room = {
        id: roomId,
        title: "Идеи для проекта с длинным названием AltarApps — совместное пространство",
        description: "Room description",
        owner: { id: owner, name: "Owner" },
        revision: 1,
        closed: false,
        createdAt: 1,
        updatedAt: 1,
        following: true,
        muted: false,
        unread: 0,
        projects: [],
      };
      let version = 1;
      const cards = [
        {
          id: "33333333-3333-4333-8333-333333333333",
          kind: "note",
          title: "Первый шаг",
          text: "Обсудить идею и подготовить понятный план.",
          url: "",
          fileId: null,
          x: 24,
          y: 24,
          width: 310,
          points: [],
          revision: 1,
          author: room.owner,
          updatedAt: 1,
        },
      ];
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=",
        "base64",
      );
      let imageReads = 0;
      cards.push({
        ...cards[0],
        id: "44444444-4444-4444-8444-444444444444",
        kind: "file",
        title: "preview.png",
        text: "",
        fileId: "55555555-5555-4555-8555-555555555555",
        file: { name: "preview.png", mime: "image/png", bytes: png.length },
        x: 364,
      });
      await page.route("https://rooms.test/**", async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          p = url.pathname;
        const json = (data, status = 200) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
        if (p === "/")
          return route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><script>sessionStorage.setItem('codex-workspace-identity','${owner}')</script><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>`,
          });
        if (p === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (p === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (/^\/fonts\/[\w.-]+\.woff2$/.test(p))
          return route.fulfill({
            contentType: "font/woff2",
            body: await readFile("apps/web/public" + p),
          });
        if (p === "/brainstorm-audio.js")
          return route.fulfill({
            contentType: "application/javascript",
            body: await readFile("apps/web/public/brainstorm-audio.js", "utf8"),
          });
        requests.push({ path: p, method: req.method(), body: req.postDataJSON() });
        if (p === `/api/team/brainstorm/${roomId}`)
          return json({
            room,
            cards: url.searchParams.has("since") ? [] : cards,
            removed: [],
            version,
            reset: !url.searchParams.has("since"),
            people: [room.owner],
          });
        if (p.includes("/cards/")) {
          const input = req.postDataJSON(),
            id = p.split("/").at(-1);
          const old = cards.find((c) => c.id === id);
          if (old && old.revision !== input.revision)
            return json({ message: "Материал уже изменился.", code: "ROOM_CHANGED" }, 409);
          const value = {
            ...input,
            id,
            revision: input.revision + 1,
            author: room.owner,
            updatedAt: Date.now(),
          };
          if (old) cards.splice(cards.indexOf(old), 1, value);
          else cards.push(value);
          version++;
          return json(value);
        }
        if (p.endsWith("/chat")) return json({ messages: [], more: false });
        if (p.includes("/chat/files/")) {
          imageReads++;
          return route.fulfill({ contentType: "image/png", body: png });
        }
        if (p.endsWith("/snapshots")) return json({ items: [] });
        if (p === "/api/team/contacts") return json({ items: [], nextOffset: null });
        if (p.endsWith("/gpt"))
          return json({
            projectId: roomId,
            name: room.title,
            nativeId: null,
            jobId: null,
            revision: 0,
            rules: { enabled: [], custom: "" },
            context: "Private room",
          });
        if (p === "/api/gpt/status")
          return json({ available: true, authenticated: true, mode: "native" });
        if (p === "/api/gpt/projects") return json({ items: [], conversations: [] });
        if (p === "/api/gpt/jobs") return json({ items: [] });
        if (p === "/api/gpt/models")
          return json({
            models: [{ id: "latest", label: "Latest" }],
            efforts: [{ id: "1", label: "Standard" }],
            currentModel: "latest",
            currentEffort: "1",
          });
        return json({
          items: [],
          projects: [],
          models: [],
          choices: [],
          capabilities: {},
          jobs: [],
        });
      });
      let voiceFrames = 0;
      await page.routeWebSocket("**/voice?*", (socket) => {
        socket.onMessage((message) => {
          if (Buffer.isBuffer(message)) {
            assert.equal(message.length, 1280);
            voiceFrames++;
          } else {
            const state = JSON.parse(message);
            assert.equal(state.type, "state");
          }
        });
      });
      await page.goto("https://rooms.test/");
      await page.getByText("Первый шаг", { exact: true }).waitFor();
      const original = await page
        .locator('[data-card="33333333-3333-4333-8333-333333333333"]')
        .elementHandle();
      await page.locator(".brainstorm-image img").evaluate(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) resolve();
            else img.onload = resolve;
          }),
      );
      const imageCount = imageReads;
      await page.getByRole("button", { name: "Общий чат", exact: true }).click();
      await page
        .getByLabel("Сообщение участникам", { exact: true })
        .fill("Shared draft survives tab switch");
      await page.getByRole("button", { name: "Доска", exact: true }).click();
      await page.waitForTimeout(3200);
      assert(await original.evaluate((n) => n.isConnected));
      assert.equal(imageReads, imageCount);
      await page.getByRole("button", { name: "Общий чат", exact: true }).click();
      await expect(page.getByLabel("Сообщение участникам", { exact: true })).toHaveValue(
        "Shared draft survives tab switch",
      );
      await page.getByRole("button", { name: "Доска", exact: true }).click();
      await page.getByRole("button", { name: "Материал", exact: true }).click();
      await page.getByLabel("Название", { exact: true }).fill("Новая мысль");
      await page.getByLabel("Текст", { exact: true }).fill("Exact new note\nSecond line");
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.evaluate(() => document.fonts.ready);
        await checkDialog(page);
        await page.screenshot({ path: join(screens, `${engine}-${theme}-editor.png`) });
      }
      await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
      await page.getByText("Новая мысль", { exact: true }).waitFor();
      assert.equal(
        requests.filter((r) => r.method === "PUT" && r.path.includes("/cards/")).length,
        1,
      );
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        for (const [label, width, height] of [
          ["phone", 390, 844],
          ["keyboard", 390, 430],
          ["tablet", 1366, 1024],
        ]) {
          await page.setViewportSize({ width, height });
          const dialog = page.getByRole("dialog").first();
          const b = await dialog.boundingBox();
          assert(
            b.x >= 0 && b.y >= 0 && b.x + b.width <= width + 1 && b.y + b.height <= height + 1,
            `${engine} ${theme} ${label} dialog fits`,
          );
          await page.screenshot({ path: join(screens, `${engine}-${theme}-${label}.png`) });
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Создать проект", exact: true }).click();
      await page.getByRole("dialog", { name: "Проект из комнаты", exact: true }).waitFor();
      await page.getByText("Мои выводы для GPT проекта", { exact: true }).click();
      await page.getByLabel("Личное резюме", { exact: true }).fill("Private conclusion");
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await checkDialog(page);
        await page.screenshot({ path: join(screens, `${engine}-${theme}-conversion.png`) });
      }
      await page
        .getByRole("dialog", { name: "Проект из комнаты", exact: true })
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
      await page.getByRole("button", { name: "Создать проект", exact: true }).click();
      await page.getByText("Мои выводы для GPT проекта", { exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Личное резюме", exact: true })).toHaveValue(
        "Private conclusion",
      );
      await page
        .getByRole("dialog", { name: "Проект из комнаты", exact: true })
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
      await page.evaluate(
        (script) => {
          const add = AudioWorklet.prototype.addModule;
          const module = URL.createObjectURL(
            new Blob([script], { type: "application/javascript" }),
          );
          AudioWorklet.prototype.addModule = function () {
            return add.call(this, module);
          };
          Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
            value: async () => {
              const context = new AudioContext();
              await context.resume();
              const source = context.createOscillator(),
                dest = context.createMediaStreamDestination();
              source.connect(dest);
              source.start();
              window.__roomTestAudio = context;
              window.__roomTestStream = dest.stream;
              return dest.stream;
            },
          });
        },
        await readFile("apps/web/public/brainstorm-audio.js", "utf8"),
      );
      await page.getByRole("button", { name: "Голосовой разговор", exact: true }).click();
      await page
        .getByRole("button", { name: "Включить микрофон", exact: true })
        .click({ timeout: 10000 })
        .catch(async (e) => {
          throw Error(await page.locator(".brainstorm-voice").innerText(), { cause: e });
        });
      await expect.poll(() => voiceFrames).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Выключить звук", exact: true }).click();
      await page.getByRole("button", { name: "Выйти", exact: true }).click();
      assert.equal(
        await page.evaluate(() =>
          window.__roomTestStream.getTracks().every((t) => t.readyState === "ended"),
        ),
        true,
      );
      await page.evaluate(() => window.__roomTestAudio.close());
      await page.getByRole("button", { name: "Мой GPT", exact: true }).click();
      await page
        .getByText("Личный чат. На общую доску попадает только то, что вы опубликуете.", {
          exact: true,
        })
        .waitFor();
      await page
        .locator(".project-gpt-embedded")
        .waitFor()
        .catch(async (e) => {
          await page.screenshot({ path: join(screens, "gpt-error.png") });
          throw Error(
            JSON.stringify({
              errors,
              html: await page.locator("body").innerText(),
              requests: requests.slice(-12),
            }),
            { cause: e },
          );
        });
      await page.screenshot({ path: join(screens, `${engine}-private-gpt.png`) });
      assert.equal(
        requests.filter((r) => r.path.endsWith("/send")).length,
        0,
        "opening room GPT never submits",
      );
      assert.equal(
        await page.getByLabel("Underlying draft").inputValue(),
        "Do not replace my personal draft",
      );
      assert.deepEqual(errors, []);
      console.log(
        `${engine}: room board/chat continuity, exact edits, private GPT, snapshots, all four themes and constrained layouts passed.`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
