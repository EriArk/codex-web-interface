import { createHash } from "node:crypto";
import { handoffFixture } from "./handoff-fixture.mjs";
export const deliveryInput = {
  kind: "commit",
  paths: ["app.ts"],
  message: "Reviewed app",
  title: "",
  body: "",
};
export function deliveryState() {
  return {
    repository: true,
    branch: "feature/mobile",
    head: "a".repeat(40),
    upstream: "origin/feature/mobile",
    ahead: 2,
    behind: 0,
    changed: 2,
    staged: 1,
    untracked: 1,
    hidden: 0,
    paths: [
      { path: "app.ts", index: "M", working: "M", size: 2048, hash: "a".repeat(64) },
      { path: "README.md", index: "?", working: "?", size: 1024, hash: "b".repeat(64) },
    ],
    truncated: false,
    fingerprint: "f".repeat(64),
    checkedAt: Date.now(),
    github: {
      state: "ok",
      repository: "Owner/Project",
      url: "https://github.com/Owner/Project",
      defaultBranch: "main",
      remoteHead: "a".repeat(40),
      pr: {
        number: 12,
        title: "Mobile layout",
        body: "Reviewed work",
        url: "https://github.com/Owner/Project/pull/12",
        head: "feature/mobile",
        base: "main",
        sha: "a".repeat(40),
        mergeable: true,
      },
      checksKnown: true,
      checksSha: "a".repeat(40),
      checks: [
        {
          name: "Browser / WebKit",
          state: "failed",
          url: "https://github.com/Owner/Project/actions/runs/12",
        },
        { name: "Hub", state: "passed" },
      ],
    },
  };
}
export async function deliveryFixture(origin = "https://handoff.test") {
  const receipts = new Map(),
    calls = [];
  let state = deliveryState(),
    pending,
    lose = false;
  const f = await handoffFixture(origin, undefined, {
    projectDeliveryProbe: async (machine, root, req) => {
      calls.push({ machine: machine.id, root, request: req });
      if (req.op === "inspect") return structuredClone(state);
      if (req.op === "prepare") {
        if (receipts.has(req.id)) return structuredClone(receipts.get(req.id));
        const v = {
          id: req.id,
          kind: req.input.kind,
          state: "prepared",
          snapshot: structuredClone(state),
          input: req.input,
          fingerprint: createHash("sha256").update(JSON.stringify(req.input)).digest("hex"),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        receipts.set(req.id, v);
        return structuredClone(v);
      }
      const v = receipts.get(req.id);
      if (req.op === "status") return v ? structuredClone(v) : null;
      if (req.op === "apply") {
        if (pending) await pending;
        v.state = "completed";
        v.commit = "b".repeat(40);
        state = {
          ...state,
          head: v.commit,
          changed: 1,
          paths: state.paths.filter((p) => p.path !== "app.ts"),
        };
        if (lose) {
          lose = false;
          throw Error("lost worker response");
        }
        return structuredClone(v);
      }
      throw Error("unexpected probe");
    },
  });
  return Object.assign(f, {
    deliveryCalls: calls,
    receipts,
    state: () => state,
    setState: (v) => {
      state = v;
    },
    loseDeliveryAck: () => {
      lose = true;
    },
    hold: () => {
      let release;
      pending = new Promise((r) => {
        release = r;
      });
      return () => {
        release();
        pending = undefined;
      };
    },
  });
}
