import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { chromium, expect, webkit } from "@playwright/test";

const source = stripTypeScriptTypes(await readFile("apps/web/src/remoteInput.ts", "utf8"), {
  mode: "transform",
}).replace("export class RemoteInput", "window.RemoteInput = class RemoteInput");
const guac = await readFile("apps/web/public/vendor/guacamole-1.6.0.min.js", "utf8");
for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await type.launch(),
    page = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  try {
    await page.setContent(
      '<div id="surface" tabindex="0" style="width:900px;height:650px;touch-action:none"></div>',
    );
    await page.addScriptTag({ content: guac });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      window.packets = [];
      window.zooms = [];
      window.pans = [];
      window.mode = "touch";
      const tunnel = { sendMessage: (...args) => window.packets.push(args) },
        client = new Guacamole.Client(tunnel);
      client.importState({
        currentState: Guacamole.Client.State.CONNECTED,
        currentTimestamp: 0,
        layers: {},
      });
      const host = document.querySelector("#surface");
      window.input = new RemoteInput(host, {
        mode: () => window.mode,
        scale: () => 0.5,
        sensitivity: () => 1,
        direct: (x, y) => ({ x: x * 2, y: y * 2 }),
        clamp: (x, y) => ({ x, y }),
        send: (s) => client.sendMouseState(s, false),
        pointer: () => {},
        position: () => {},
        zoom: (...args) => window.zooms.push(args),
        pan: (...args) => window.pans.push(args),
      });
      input.setPosition(500, 400);
      window.pointer = (type, id, x, y) =>
        host.dispatchEvent(
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
    for (const mode of ["touch", "trackpad"]) {
      await page.evaluate((mode) => {
        input.reset();
        window.mode = mode;
        input.setPosition(500, 400);
        packets.length = zooms.length = 0;
        pointer("pointerdown", 1, 100, 200);
        pointer("pointerdown", 2, 100, 300);
        pointer("pointermove", 1, 100, 100);
        pointer("pointermove", 2, 100, 200);
        pointer("pointerup", 1, 100, 100);
        pointer("pointerup", 2, 100, 200);
      }, mode);
      const packets = await page.evaluate(() => window.packets);
      const pulses = packets.filter((p) => p[0] === "mouse" && p[3] === 16);
      assert(pulses.length > 0, mode + " sends scroll-down packets");
      assert(
        pulses.every(
          (p) => p[1] === (mode === "touch" ? 200 : 500) && p[2] === (mode === "touch" ? 500 : 400),
        ),
      );
      assert.equal(packets.at(-1)[3], 0, "wheel released");
      assert(!packets.some((p) => p[3] & 7), "no unintended mouse click");
      assert.equal(await page.evaluate(() => zooms.length), 0, "scroll does not zoom");
    }
    await page.evaluate(() => {
      input.reset();
      packets.length = 0;
      pointer("pointerdown", 3, 100, 100);
      pointer("pointerdown", 4, 200, 100);
      pointer("pointermove", 4, 240, 100);
    });
    await expect.poll(() => page.evaluate(() => zooms.length)).toBeGreaterThan(0);
    await page.evaluate(() => {
      input.reset();
      packets.length = pans.length = 0;
      pointer("pointerdown", 5, 100, 100);
      pointer("pointerdown", 6, 200, 100);
      pointer("pointerdown", 7, 150, 150);
      pointer("pointermove", 5, 100, 170);
      pointer("pointermove", 6, 200, 170);
      pointer("pointermove", 7, 150, 220);
    });
    assert((await page.evaluate(() => pans.length)) > 0);
    assert(!(await page.evaluate(() => packets)).some((p) => p[3] & 24));
    await page.evaluate(() => {
      input.reset();
      packets.length = 0;
      document
        .querySelector("#surface")
        .dispatchEvent(
          new WheelEvent("wheel", { deltaY: -80, clientX: 120, clientY: 180, cancelable: true }),
        );
    });
    assert(
      (await page.evaluate(() => packets)).some((p) => p[3] === 8),
      "mouse wheel scrolls up",
    );
    await page.evaluate(() => input.dispose());
    console.log(
      JSON.stringify({
        browser: name,
        touchAndTrackpadScroll: true,
        guacamoleWheelPackets: true,
        pinch: true,
        threeFingerPan: true,
        mouseWheel: true,
      }),
    );
  } finally {
    await browser.close();
  }
}
