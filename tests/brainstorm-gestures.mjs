import assert from "node:assert/strict";
import { join } from "node:path";
import { expect } from "@playwright/test";

export async function checkBrainstormGestures({ page, engine, cards, requests, screens }) {
  const writes = () => requests.filter((r) => r.method === "PUT" && r.path.includes("/cards/"));
  const cdp = engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const scroll = page.locator(".brainstorm-board-scroll");
  const sourceId = cards[0].id;
  const source = page.locator(`[data-card="${sourceId}"]`);
  const target = page.locator('[data-card="44444444-4444-4444-8444-444444444444"]');
  const handle = source.locator(".brainstorm-card-move");
  const touch = async (from, to, release = true) => {
    assert(cdp);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12, id: 1 },
        ],
      });
    }
    if (release) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const center = async (locator) => {
    const b = await locator.boundingBox();
    assert(b);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  // Mouse path and one exact revision write, preserving the visible drop until acknowledgement.
  await page.setViewportSize({ width: 1366, height: 1024 });
  await handle.scrollIntoViewIfNeeded();
  let before = cards.find((c) => c.id === sourceId),
    count = writes().length;
  let start = await center(handle);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 50, start.y + 85, { steps: 8 });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
    await handle.dispatchEvent(event, { pointerId: 999, pointerType: "touch", isPrimary: false });
  }
  assert.equal(writes().length, count, "drag does not flood Hub with writes");
  await expect(source).toHaveCSS("left", `${before.x + 50}px`);
  await page.mouse.up();
  await expect.poll(() => writes().length).toBe(count + 1);
  await expect(handle).toBeEnabled();
  assert.equal(cards.find((c) => c.id === sourceId).y, before.y + 85);

  await page.setViewportSize({ width: 768, height: 1024 });
  await handle.scrollIntoViewIfNeeded();
  start = await center(handle);
  before = cards.find((c) => c.id === sourceId);
  count = writes().length;
  const oldScroll = await scroll.evaluate((n) => [n.scrollLeft, n.scrollTop]);
  assert.equal(await handle.evaluate((n) => getComputedStyle(n).touchAction), "none");
  if (cdp) {
    await touch(start, { x: start.x + 45, y: start.y + 110 }, false);
    assert.equal(writes().length, count);
    await expect(source).toHaveCSS("top", `${before.y + 110}px`);
    assert.deepEqual(
      await scroll.evaluate((n) => [n.scrollLeft, n.scrollTop]),
      oldScroll,
      "tablet touch drag must not scroll",
    );
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => writes().length).toBe(count + 1);
    await expect(handle).toBeEnabled();
    assert.equal(cards.find((c) => c.id === sourceId).x, before.x + 45);
    // Cancelled native touch restores the saved location without a mutation.
    start = await center(handle);
    count = writes().length;
    const savedY = cards.find((c) => c.id === sourceId).y;
    await touch(start, { x: start.x, y: start.y + 40 }, false);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(source).toHaveCSS("top", `${savedY}px`);
    assert.equal(writes().length, count);
  }
  if (cdp) {
    const rect = await scroll.boundingBox();
    await scroll.evaluate((n) => (n.scrollLeft = 0));
    await touch(
      { x: rect.x + rect.width - 50, y: rect.y + 420 },
      { x: rect.x + rect.width - 190, y: rect.y + 420 },
    );
    await expect.poll(() => scroll.evaluate((n) => n.scrollLeft)).toBeGreaterThan(20);
  }
  // WebKit verifies its real DOM's native non-passive listener boundary as well.
  assert.equal(
    await handle.evaluate(
      (n) => !n.dispatchEvent(new Event("touchmove", { bubbles: true, cancelable: true })),
    ),
    true,
  );

  // Pull an actual connection to a card, then tapping pins works on phone too.
  await page.setViewportSize({ width: 1366, height: 1024 });
  await scroll.evaluate((n) => {
    n.scrollTop = 0;
    n.scrollLeft = 0;
  });
  const fromPin = source.locator(".brainstorm-wire-pin");
  const orderBefore = await page
    .locator("[data-card]")
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.card));
  start = await center(fromPin);
  const end = await center(target.locator(".brainstorm-wire-pin"));
  count = writes().length;
  if (cdp) await touch(start, end, false);
  else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
  }
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
    await fromPin.dispatchEvent(event, { pointerId: 999, pointerType: "touch", isPrimary: false });
  }
  await expect(page.locator(".brainstorm-wire-preview")).toBeVisible();
  if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  else await page.mouse.up();
  await expect.poll(() => writes().length).toBe(count + 1);
  await expect(fromPin).toBeEnabled();
  assert(
    cards.find((c) => c.id === sourceId).links.includes("44444444-4444-4444-8444-444444444444"),
  );
  assert.deepEqual(
    await page.locator("[data-card]").evaluateAll((nodes) => nodes.map((n) => n.dataset.card)),
    orderBefore,
    "linking preserves card order",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  count = writes().length;
  await target.locator(".brainstorm-wire-pin").tap();
  await expect(page.getByText("Выберите вторую карточку", { exact: true })).toBeVisible();
  await fromPin.tap();
  await expect.poll(() => writes().length).toBe(count + 1);
  await expect(fromPin).toBeEnabled();
  assert(
    cards.find((c) => c.id === "44444444-4444-4444-8444-444444444444").links.includes(sourceId),
  );

  await page.getByRole("button", { name: "Материал", exact: true }).click();
  const editor = page.locator("dialog[open]").last();
  await editor.getByRole("combobox", { name: "Тип", exact: true }).selectOption("drawing");
  await editor.getByLabel("Название", { exact: true }).fill("Touch sketch");
  const pad = editor.locator(".brainstorm-ink-surface");
  await pad.scrollIntoViewIfNeeded();
  const form = editor.locator("form");
  const formScroll = await form.evaluate((n) => n.scrollTop);
  const b = await pad.boundingBox();
  const p1 = { x: b.x + b.width * 0.2, y: b.y + b.height * 0.75 },
    p2 = { x: b.x + b.width * 0.8, y: b.y + b.height * 0.2 };
  if (cdp) await touch(p1, p2);
  else {
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await page.mouse.move(p2.x, p2.y, { steps: 12 });
    await page.mouse.up();
  }
  await expect(editor.getByRole("button", { name: "Отменить штрих", exact: true })).toBeEnabled();
  assert.equal(
    await form.evaluate((n) => n.scrollTop),
    formScroll,
    "drawing cannot scroll the editor",
  );
  assert.equal(await pad.evaluate((n) => getComputedStyle(n).touchAction), "none");
  assert.equal(
    await pad
      .locator("path")
      .evaluate(
        (n) => !n.dispatchEvent(new Event("touchmove", { bubbles: true, cancelable: true })),
      ),
    true,
  );
  const firstStroke = await pad.locator("path").getAttribute("d");
  assert(firstStroke.split("L").length >= 8, "continuous stroke has samples, not only a dot");
  if (cdp) await touch(p2, p1);
  else {
    await page.mouse.move(p2.x, p2.y);
    await page.mouse.down();
    await page.mouse.move(p1.x, p1.y, { steps: 10 });
    await page.mouse.up();
  }
  await editor.getByRole("button", { name: "Отменить штрих", exact: true }).click();
  await expect(pad.locator("path")).toHaveAttribute("d", firstStroke);
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await pad.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screens, `${engine}-${theme}-drawing-touch.png`) });
  }
  // Scrolling remains available outside the dedicated input surfaces.
  if (cdp) {
    await form.evaluate((n) => (n.scrollTop = 0));
    const f = await form.boundingBox(),
      y = f.y + Math.min(f.height - 30, 220);
    await touch({ x: f.x + 3, y }, { x: f.x + 3, y: y - 130 });
    await expect.poll(() => form.evaluate((n) => n.scrollTop)).toBeGreaterThan(20);
  }
  await editor.getByRole("button", { name: "Опубликовать", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Изменить Touch sketch", exact: true }),
  ).toBeVisible();
  const drawing = cards.find((c) => c.title === "Touch sketch");
  assert(drawing?.points.length >= 8);
  assert.equal(drawing.points.filter((p) => p[0] === -1).length, 1);
  // A phone's title is scrollable, unlike a tablet's drag handle.
  assert.notEqual(await handle.evaluate((n) => getComputedStyle(n).touchAction), "none");
  console.log(
    `${engine}: direct card gestures, connections and drawing passed${cdp ? " with native touch input and outside-surface scrolling" : " (WebKit pointer and native touch cancellation boundaries)"}.`,
  );
  await cdp?.detach();
}
