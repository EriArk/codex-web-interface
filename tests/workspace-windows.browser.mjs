import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-windows", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18912",
    f = await handoffFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [];
  let extraProjectReads = 0;
  await page.route("**/api/workspace/projects*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("offset") === "100") {
      extraProjectReads++;
      return route.fulfill({
        json: {
          items: [
            {
              scope: { client: "codex", projectId: "later", name: "Проект на следующей странице" },
              availability: "available",
            },
          ],
          nextOffset: null,
        },
      });
    }
    const response = await route.fetch(),
      pageData = await response.json();
    return route.fulfill({
      response,
      json: {
        items: [
          ...pageData.items,
          ...Array.from({ length: 99 }, (_, i) => ({
            scope: { client: "codex", projectId: `extra-${i}`, name: `Дополнительный проект ${i}` },
            availability: "available",
          })),
        ],
        nextOffset: 100,
      },
    });
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const open = async (label) => {
    if (page.viewportSize().width < 800)
      await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await page
      .locator(".workspace-shortcuts:visible")
      .getByRole("button", { name: label, exact: true })
      .click();
  };
  try {
    await f.app.listen({ port: 18912, host: "127.0.0.1" });
    await page.goto(origin);
    await page.addStyleTag({
      content:
        "*, *::before, *::after { transition: none !important; animation: none !important; }",
    });
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Не потерять чат при работе с окнами");
    for (const [label, mode] of [
      ["Задачи", "tasks"],
      ["Заметки", "notes"],
      ["Планы", "plans"],
      ["Отчёты", "reports"],
    ]) {
      await open(label);
      const dialog = page.locator(`dialog[data-workspace-module="${mode}"]`);
      await expect(dialog).toBeVisible();
      const projects = dialog.locator(".workspace-project-filter select");
      await expect(projects).toBeVisible();
      await expect(projects.locator('option[value="codex:project"]')).toHaveCount(1);
      await projects.selectOption("codex:project");
      await expect(projects).toHaveValue("codex:project");
      if (!(await projects.locator('option[value="codex:later"]').count())) {
        const reads = extraProjectReads;
        await expect(projects.locator('option[value="load-more"]')).toHaveCount(1);
        await projects.selectOption("load-more");
        await expect(projects.locator('option[value="codex:later"]')).toHaveCount(1);
        await expect(projects).toHaveValue("codex:project");
        assert.equal(extraProjectReads, reads + 1);
      }
      await projects.selectOption("all");
      await expect(dialog.locator(".task-project-filters")).toHaveCount(0);
      await expect(dialog.getByRole("navigation", { name: "Разделы проекта" })).toHaveCount(0);
      await expect(page.locator(".workspace-window[open]")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(chat).toHaveValue("Не потерять чат при работе с окнами");
    }
    await open("Заметки");
    const dialog = page.locator('dialog[data-workspace-module="notes"]');
    for (const theme of ["crt-green", "hitech-2000s"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.caseColor = "blue";
      }, theme);
      for (const width of [390, 1376]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1032 });
        await expect
          .poll(() =>
            dialog
              .locator(".notebook-heading")
              .evaluate((el) => getComputedStyle(el).backgroundImage),
          )
          .not.toBe("none");
        assert.equal(
          await dialog
            .locator(".notebook-task-controls")
            .evaluate((el) => getComputedStyle(el).backgroundColor),
          "rgba(0, 0, 0, 0)",
        );
        await page.screenshot({
          path: `.local/qa-windows/${engine}-${theme}-toolbar-${width}.png`,
        });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole("button", { name: "Новая заметка", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Название заметки" }).fill("Материалы и контраст");
    await dialog
      .getByRole("textbox", { name: "Текст заметки" })
      .fill("Сохранить мысль и вернуться к работе.\nЧерновик остаётся личным.");
    const colors = [
      "graphite",
      "white",
      "silver",
      "red",
      "orange",
      "yellow",
      "green",
      "mint",
      "turquoise",
      "blue",
      "purple",
      "pink",
    ];
    for (const theme of ["organizer", "classic-dark", "crt-green", "hitech-2000s"]) {
      const palette = ["crt-green", "hitech-2000s"].includes(theme) ? colors : ["turquoise"];
      for (const color of palette) {
        await page.evaluate(
          ({ theme, color }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.caseColor = color;
          },
          { theme, color },
        );
        const contrast = await dialog.evaluate((el) => {
          const canvas = document.createElement("canvas"),
            ctx = canvas.getContext("2d");
          const rgb = (color) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
          };
          const lum = (color) =>
            rgb(color)
              .map((v) => v / 255)
              .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
              .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
          const ratio = (a, b) =>
            (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
          const field = el.querySelector('input[aria-label="Название заметки"]');
          const input = getComputedStyle(field);
          let surface = field,
            background = input.backgroundColor;
          while (background === "rgba(0, 0, 0, 0)" && surface.parentElement) {
            surface = surface.parentElement;
            background = getComputedStyle(surface).backgroundColor;
          }
          const values = [ratio(input.color, background)];
          if (["crt-green", "hitech-2000s"].includes(document.documentElement.dataset.theme)) {
            const probe = document.createElement("span");
            el.append(probe);
            const resolved = (property) => {
              probe.style.backgroundColor = `var(${property})`;
              return getComputedStyle(probe).backgroundColor;
            };
            const heading = getComputedStyle(el.querySelector(".notebook-heading"));
            values.push(ratio(heading.color, resolved("--case-mid")));
            const key = getComputedStyle(el.querySelector(".notebook-save .primary"));
            for (const stop of ["--cap-top", "--cap-mid", "--cap-low"])
              values.push(ratio(key.color, resolved(stop)));
            const caption = el.querySelector(".notebook-context small");
            if (caption)
              for (const stop of ["--cap-top", "--cap-mid", "--cap-low"])
                values.push(ratio(getComputedStyle(caption).color, resolved(stop)));
            probe.remove();
          }
          return values;
        });
        assert(
          contrast.every((n) => n >= 4.5),
          `${theme}/${color} contrast: ${contrast}`,
        );
      }
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1024, 768],
        [1280, 800],
        [1376, 1032],
        [1920, 1080],
      ]) {
        await page.setViewportSize({ width, height });
        await expect
          .poll(() =>
            page.evaluate(() =>
              parseFloat(document.documentElement.style.getPropertyValue("--app-height")),
            ),
          )
          .toBe(height);
        const box = await dialog.boundingBox();
        assert(
          box.x >= -1 &&
            box.y >= -1 &&
            box.x + box.width <= width + 1 &&
            box.y + box.height <= height + 1,
          `${theme} ${width}: dialog in viewport`,
        );
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const close = await dialog.getByRole("button", { name: "Закрыть заметки" }).boundingBox();
        assert(close.width >= 44 && close.height >= 44);
        if ([390, 1376].includes(width))
          await page.screenshot({ path: `.local/qa-windows/${engine}-${theme}-${width}.png` });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.style.getPropertyValue("--app-height")),
      )
      .toBe("844px");
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        get: () => 390,
      });
      Object.defineProperty(window.visualViewport, "offsetTop", {
        configurable: true,
        get: () => 70,
      });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
    const keyboard = await dialog.boundingBox();
    assert(keyboard.y >= 70 && keyboard.y + keyboard.height <= 460, JSON.stringify(keyboard));
    const close = await dialog.getByRole("button", { name: "Закрыть заметки" }).boundingBox();
    const save = await dialog.getByRole("button", { name: "Сохранить", exact: true }).boundingBox();
    assert(close.y >= 70 && close.y + close.height <= 460);
    assert(
      save.y >= 70 && save.y + save.height <= 460,
      `save remains reachable: ${JSON.stringify(save)}`,
    );
    await page.screenshot({ path: `.local/qa-windows/${engine}-keyboard.png` });
    await page.keyboard.press("Escape");
    await expect(chat).toHaveValue("Не потерять чат при работе с окнами");
    assert.deepEqual(errors, []);
    console.log(
      `${engine}: independent windows, viewport/focus/keyboard, four themes, 12 material colors and text/key contrast passed`,
    );
  } catch (error) {
    await page.screenshot({ path: `.local/qa-windows/${engine}-failure.png` }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await f.app.close();
  }
}
