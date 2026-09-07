import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("../apps/web/src/remoteInput.ts", import.meta.url), "utf8");
const compiled = stripTypeScriptTypes(source, { mode: "transform" });
const { RemoteInput } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
function setup() {
  class Host extends EventTarget {
    focus() {}
    setPointerCapture() {}
    releasePointerCapture() {}
  }
  const host = new Host(),
    sent = [],
    zooms = [],
    pans = [];
  let mode = "trackpad";
  const input = new RemoteInput(host, {
    mode: () => mode,
    scale: () => 0.5,
    sensitivity: () => 1,
    direct: (x, y) => ({ x: x * 2, y: y * 2 }),
    clamp: (x, y) => ({ x: Math.max(0, Math.min(2000, x)), y: Math.max(0, Math.min(1000, y)) }),
    send: (s) => sent.push(s),
    pointer: () => {},
    position: () => {},
    zoom: (...args) => zooms.push(args),
    pan: (...args) => pans.push(args),
  });
  input.setPosition(500, 400);
  const event = (type, id, x, y, kind = "touch", button = 0) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { pointerId: id, clientX: x, clientY: y, pointerType: kind, button });
    host.dispatchEvent(e);
  };
  return { input, sent, zooms, pans, event, mode: (value) => (mode = value) };
}
test("phone trackpad moves relatively and taps at the pointer, with no absolute jump", () => {
  const f = setup();
  try {
    f.event("pointerdown", 1, 10, 10);
    f.event("pointermove", 1, 25, 20);
    f.event("pointerup", 1, 25, 20);
    assert.equal(f.sent.at(-1).x, 530);
    assert.equal(f.sent.at(-1).y, 420);
    assert(!f.sent.some((s) => s.left));
    f.event("pointerdown", 2, 280, 250);
    f.event("pointerup", 2, 280, 250);
    assert(f.sent.some((s) => s.left && s.x === 530 && s.y === 420));
    assert.equal(f.sent.at(-1).left, false);
  } finally {
    f.input.dispose();
  }
});
test("direct touch and stylus map coordinates and cancel releases held buttons", () => {
  const f = setup();
  try {
    f.mode("touch");
    f.event("pointerdown", 1, 30, 40);
    f.event("pointerup", 1, 30, 40);
    assert(f.sent.some((s) => s.left && s.x === 60 && s.y === 80));
    f.mode("trackpad");
    f.event("pointerdown", 2, 90, 100, "pen");
    assert.equal(f.sent.at(-1).x, 180);
    assert(f.sent.at(-1).left);
    f.event("pointermove", 2, 100, 110, "pen");
    assert.equal(f.sent.at(-1).y, 220);
    f.event("pointercancel", 2, 100, 110, "pen");
    assert.equal(f.sent.at(-1).left, false);
  } finally {
    f.input.dispose();
  }
});
test("two-finger tap right-clicks once; slow parallel motion scrolls; pinch zooms", async () => {
  const f = setup();
  try {
    f.event("pointerdown", 1, 100, 100);
    f.event("pointerdown", 2, 200, 100);
    f.event("pointerup", 1, 100, 100);
    f.event("pointerup", 2, 200, 100);
    assert.equal(f.sent.filter((s) => s.right).length, 1);
    f.sent.length = 0;
    f.event("pointerdown", 3, 100, 200);
    f.event("pointerdown", 4, 200, 200);
    for (let y = 199; y >= 150; y--) {
      f.event("pointermove", 3, 100, y);
      f.event("pointermove", 4, 200, y);
    }
    f.event("pointerup", 3, 100, 150);
    f.event("pointerup", 4, 200, 150);
    assert(f.sent.some((s) => s.down));
    assert(!f.sent.some((s) => s.right));
    f.event("pointerdown", 5, 100, 100);
    f.event("pointerdown", 6, 200, 100);
    f.event("pointermove", 6, 240, 100);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert(f.zooms.length > 0);
  } finally {
    f.input.dispose();
  }
});

test("direct touch scrolls under the gesture, fast parallel motion is not a pinch, and three fingers still pan", () => {
  const f = setup();
  try {
    f.mode("touch");
    f.event("pointerdown", 1, 100, 200);
    f.event("pointerdown", 2, 100, 300);
    f.event("pointermove", 1, 100, 120);
    f.event("pointermove", 2, 100, 220);
    assert(f.sent.some((s) => s.down && s.x === 200 && s.y === 500));
    assert.equal(f.zooms.length, 0);
    f.event("pointermove", 1, 100, 240);
    f.event("pointermove", 2, 100, 340);
    assert(f.sent.some((s) => s.up));
    f.event("pointerup", 1, 100, 240);
    f.event("pointerup", 2, 100, 340);
    assert(!f.sent.some((s) => s.left || s.right));
    const before = f.sent.filter((s) => s.up || s.down).length;
    f.event("pointerdown", 3, 100, 100);
    f.event("pointerdown", 4, 200, 100);
    f.event("pointerdown", 5, 150, 150);
    f.event("pointermove", 3, 120, 140);
    f.event("pointermove", 4, 220, 140);
    assert(f.pans.length > 0);
    assert.equal(f.sent.filter((s) => s.up || s.down).length, before);
    f.input.reset();
    assert(
      !Object.entries(f.sent.at(-1)).some(([key, value]) => !["x", "y"].includes(key) && value),
    );
  } finally {
    f.input.dispose();
  }
});
