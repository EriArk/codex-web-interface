import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18918",
    f = await handoffFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "hitech-2000s",
    view: "chat",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  await mkdir(`.local/qa-controls/${engine}`, { recursive: true });
  try {
    await f.app.listen({ port: 18918, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await chat.fill("Сохранённый черновик");
    await chat.blur();
    for (const width of [393, 1024, 1099, 1100, 1366]) {
      await page.setViewportSize({ width, height: width < 1100 ? 852 : 1024 });
      await expect(page.locator(".workspace-header .wide-pane-control")).toBeVisible({
        visible: width >= 1100,
      });
    }
    for (const width of [320, 393, 1366]) {
      await page.setViewportSize({ width, height: width < 1100 ? 852 : 1024 });
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.caseColor = "red";
        }, theme);
        await expect(page.locator(".workspace-header .wide-pane-control")).toBeVisible({
          visible: width >= 1100,
        });
        await page.evaluate(() => document.fonts.ready);
        const buttons = await page
          .locator(".workspace-header > .icon-button:visible")
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const b = node.getBoundingClientRect();
              return { w: b.width, h: b.height };
            }),
          );
        assert(buttons.length >= 2);
        for (const b of buttons) assert.equal(b.w, b.h, `${theme}: square header`);
        if (width < 1100) await page.getByRole("button", { name: "Открыть проекты" }).click();
        const nav = page.locator(width < 1100 ? ".project-sheet" : ".desktop-nav");
        if (width < 1100)
          await expect
            .poll(async () => Math.round((await nav.boundingBox()).x))
            .toBeGreaterThanOrEqual(0);
        const rail = nav.locator(".navigation-system-row");
        await expect
          .poll(
            () =>
              rail.evaluate((node) => {
                const bounds = node.getBoundingClientRect();
                return [...node.querySelectorAll("button,a")].every((button) => {
                  const b = button.getBoundingClientRect();
                  return (
                    b.width >= 44 &&
                    b.height >= 44 &&
                    b.left >= bounds.left &&
                    b.right <= bounds.right
                  );
                });
              }),
            { message: `${theme} ${width}: footer actions fit with 44px touch targets` },
          )
          .toBe(true);
        const centers = await rail.evaluate((node) =>
          [
            node.querySelector(".nav-settings"),
            node.querySelector(".navigation-mode-controls"),
          ].map((el) => {
            const r = el.getBoundingClientRect();
            return r.y + r.height / 2;
          }),
        );
        assert(Math.abs(centers[0] - centers[1]) < 1, "Settings vertically centered");
        const links = await nav.locator(".workspace-shortcuts button").evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return { y: r.y, w: r.width, h: r.height, fits: n.scrollWidth <= n.clientWidth };
          }),
        );
        assert.equal(links.length, 4);
        assert(
          links.every(
            (l) => l.y === links[0].y && Math.abs(l.w - links[0].w) < 1 && l.h >= 44 && l.fits,
          ),
          "Four equally spaced readable shortcuts",
        );
        await page.screenshot({
          path: `.local/qa-controls/${engine}/${theme}-${width}-navigation.png`,
          animations: "disabled",
        });
        if (width < 1100) await nav.getByRole("button", { name: "Закрыть проекты" }).click();
      }
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await page.evaluate(() => (document.documentElement.dataset.theme = "hitech-2000s"));
    await page.getByRole("button", { name: "Открыть проекты" }).click();
    await page
      .locator(".project-sheet")
      .getByRole("button", { name: "Заметки", exact: true })
      .click();
    const panel = page.getByRole("dialog", { name: "Заметки и ссылки", exact: true });
    await panel.getByRole("button", { name: "Новая заметка", exact: true }).click();
    const body = panel.getByRole("textbox", { name: "Текст заметки" });
    await body.fill("Редактируем заметку\n".repeat(60));
    // Simulate the separate visual viewport used by iOS keyboard pan, not a tiny desktop window.
    for (const [width, height, offset] of [
      [393, 340, 190],
      [1366, 520, 90],
    ]) {
      await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
      await page.evaluate(
        ({ height, offset }) => {
          Object.defineProperty(window.visualViewport, "height", {
            configurable: true,
            get: () => height,
          });
          Object.defineProperty(window.visualViewport, "offsetTop", {
            configurable: true,
            get: () => offset,
          });
          window.visualViewport.dispatchEvent(new Event("resize"));
        },
        { height, offset },
      );
      await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
      await body.press("End");
      await body.press("Enter");
      await body.pressSequentially("Дополнение");
      const box = await panel.boundingBox(),
        close = await panel.getByRole("button", { name: "Закрыть заметки" }).boundingBox();
      assert(
        box.y >= offset && box.y + box.height <= offset + height + 1,
        "Dialog follows visible keyboard viewport",
      );
      assert(
        close.y >= offset && close.y + close.height <= offset + height,
        "Close remains reachable",
      );
      assert(
        await body.evaluate((node) => node.scrollHeight > node.clientHeight),
        "Long editor scrolls internally",
      );
      await page.screenshot({ path: `.local/qa-controls/${engine}/keyboard-${width}.png` });
    }
    await panel.getByRole("button", { name: "Закрыть заметки" }).click();
    await expect(chat).toHaveValue("Сохранённый черновик");
    assert.deepEqual(errors, []);
    assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 0);
    console.log(
      `${engine}: square controls, centered rail, four shortcuts, phone/tablet keyboard pan and draft continuity`,
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
