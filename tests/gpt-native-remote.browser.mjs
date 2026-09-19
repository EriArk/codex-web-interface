import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { chromium, webkit } from "@playwright/test";
import { GuacParser, instruction } from "../apps/hub/dist/remote.js";

// Real Guacamole renderer/tunnel and shared PC Remote input, with a disposable
// framebuffer. No native user desktop, account, credentials or login actions.
const origin = "https://native-remote.test";
const files = {
  "style.css": await readFile("ops/gpt/connect.css", "utf8"),
  "client.js": await readFile("ops/gpt/connect-client.js", "utf8"),
  "vendor.js": await readFile("apps/web/public/vendor/guacamole-1.6.0.min.js", "utf8"),
  "input.js": stripTypeScriptTypes(await readFile("apps/web/src/remoteInput.ts", "utf8"), {
    mode: "transform",
  }).replace("export class RemoteInput", "window.RemoteInput = class RemoteInput"),
};
const html = (await readFile("ops/gpt/connect.html", "utf8"))
  .replace(
    '<meta charset="utf-8">',
    '<meta charset="utf-8"><meta name="codex-runtime" content="native"><meta name="codex-native-adapter" content="read-only">',
  )
  .replace(
    '<script src="/gpt-connect/client.js">',
    '<script src="/gpt-connect/input.js"></script><script src="/gpt-connect/client.js">',
  );
for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 760 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = [],
      packets = [];
    let connections = 0,
      resumed = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(origin + "/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/gpt-connect/native/resume") {
        assert.equal(route.request().method(), "POST");
        resumed++;
        return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
      }
      if (path === "/")
        return route.fulfill({ contentType: "text/html", body: "<p>Workspace</p>" });
      const name = new URL(route.request().url()).pathname.split("/").at(-1),
        body = files[name] ?? html;
      return route.fulfill({
        contentType: name.endsWith(".js")
          ? "application/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "text/html",
        body,
      });
    });
    await page.routeWebSocket(origin.replace("https:", "wss:") + "/**", (route) => {
      const url = new URL(route.url());
      assert.equal(url.searchParams.get("runtime"), "native");
      assert.equal(url.searchParams.get("width"), "1280");
      connections++;
      const parser = new GuacParser();
      route.onMessage((data) =>
        packets.push(...parser.feed(String(data)).filter((p) => p[0] === "mouse")),
      );
      route.send(
        instruction("", "fixture") +
          instruction("size", "0", "1280", "900") +
          instruction("rect", "0", "0", "0", "1280", "900") +
          instruction("cfill", "14", "0", "230", "230", "230", "255") +
          instruction("sync", "1"),
      );
    });
    await page.goto(origin + "/gpt-connect?runtime=native");
    await page.waitForFunction(() => document.querySelector("#status").hidden);
    await page.evaluate(() => {
      window.pointer = (type, id, x, y) =>
        document.querySelector("#surface").dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
    });
    async function gesture(action) {
      packets.length = 0;
      await page.evaluate(action);
      await page.waitForTimeout(40);
      return [...packets];
    }
    const move = await gesture(() => {
      pointer("pointerdown", 1, 40, 200);
      pointer("pointermove", 1, 80, 200);
      pointer("pointerup", 1, 80, 200);
    });
    assert.deepEqual(
      move,
      [["mouse", "690", "450", "0"]],
      name + " relative movement at 0.8 scale",
    );
    const tap = await gesture(() => {
      pointer("pointerdown", 2, 300, 400);
      pointer("pointerup", 2, 300, 400);
    });
    assert.deepEqual(
      tap,
      [
        ["mouse", "690", "450", "1"],
        ["mouse", "690", "450", "0"],
      ],
      name + " tap never teleports cursor",
    );
    await page.waitForTimeout(350);
    const scroll = await gesture(() => {
      pointer("pointerdown", 3, 100, 300);
      pointer("pointerdown", 4, 180, 300);
      pointer("pointermove", 3, 100, 220);
      pointer("pointermove", 4, 180, 220);
      pointer("pointerup", 3, 100, 220);
      pointer("pointerup", 4, 180, 220);
    });
    assert(scroll.some((p) => p[3] === "16"));
    assert(scroll.every((p) => p[1] === "690" && p[2] === "450" && !(Number(p[3]) & 7)));
    // A second connection must replace listeners, not send twice or keep a drag.
    await page.getByRole("button", { name: "Переподключить приложение", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status").hidden);
    const after = await gesture(() => {
      pointer("pointerdown", 5, 40, 200);
      pointer("pointermove", 5, 80, 200);
      pointer("pointerup", 5, 80, 200);
    });
    assert.deepEqual(after, [["mouse", "690", "450", "0"]]);
    assert.equal(connections, 2);
    // Fit mode must still reach the full native desktop, not clamp to CSS width.
    await page.getByRole("button", { name: "Весь экран приложения", exact: true }).click();
    const edge = await gesture(() => {
      pointer("pointerdown", 6, 30, 200);
      pointer("pointermove", 6, 380, 200);
      pointer("pointerup", 6, 380, 200);
    });
    assert.equal(edge.at(-1)[1], "1279");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page
      .getByRole("button", { name: "Закрыть Remote и вернуть управление сайту", exact: true })
      .click();
    await page.waitForURL(origin + "/");
    assert.equal(resumed, 1);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        browser: name,
        relativeMove: true,
        tap: true,
        twoFingerScroll: true,
        reconnect: true,
        fullNativeBounds: true,
      }),
    );
  } finally {
    await browser.close();
  }
}
