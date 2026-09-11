import { readFileSync } from "node:fs";
import { handoffFixture } from "./handoff-fixture.mjs";
export const png = readFileSync(new URL("./fixtures/gui-preview.png", import.meta.url)).toString(
  "base64",
);
export async function guiPreviewFixture(origin = "https://handoff.test") {
  const calls = [],
    records = new Map();
  let lose = false,
    held;
  const f = await handoffFixture(origin, undefined, {
    guiPreviewProbe: async (machine, root, q) => {
      calls.push({ machine: machine.id, root, q });
      if (q.op === "catalog")
        return {
          installed: true,
          actions: [{ id: "app", label: "Открыть приложение", capture: "window" }],
        };
      if (q.op === "start") {
        if (held) await held;
        const v = {
          id: q.id,
          actionId: q.actionId,
          state: "waiting",
          appOpen: true,
          capture: "window",
          expiresAt: Date.now() + 60000,
        };
        records.set(q.id, v);
        if (lose) {
          lose = false;
          throw Error("lost acknowledgement");
        }
        return structuredClone(v);
      }
      const v = records.get(q.id);
      if (!v) throw Error("missing");
      if (q.op === "image")
        return {
          png,
        };
      if (q.op === "stop") v.appOpen = false;
      return structuredClone(v);
    },
  });
  return Object.assign(f, {
    previewCalls: calls,
    records,
    lose() {
      lose = true;
    },
    capture(id) {
      records.get(id).state = "captured";
    },
    hold() {
      held = new Promise((resolve) => {
        f.finishLaunch = resolve;
      });
    },
    finishLaunch() {},
  });
}
