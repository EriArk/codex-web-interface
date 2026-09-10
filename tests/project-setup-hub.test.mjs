import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { handoffFixture } from "./handoff-fixture.mjs";

const input = {
  machineId: "pc",
  name: "Wizard",
  workingDirectory: "C:/Wizard",
  createDirectory: true,
  repository: { mode: "none", owner: "", name: "", description: "", visibility: "private" },
};
const inspection = {
  exists: false,
  empty: true,
  git: false,
  branch: "",
  head: "",
  origin: "",
  dirty: false,
  steps: ["create-directory", "register-project"],
  fingerprint: "a".repeat(64),
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await tick();
  }
  assert.fail("Operation did not settle");
}
test("project setup requires auth and review, serializes exact retries and only registers confirmed files", async (t) => {
  let applies = 0,
    inspections = 0,
    release;
  const gate = new Promise((resolve) => (release = resolve));
  const f = await handoffFixture(undefined, undefined, {
    projectSetupProbe: async (_m, r) => {
      if (r.op === "inspect") {
        inspections++;
        return inspection;
      }
      if (r.op === "status") return null;
      applies++;
      await gate;
      return { id: r.id, state: "complete", phase: "register-project" };
    },
  });
  t.after(() => f.close());
  const registrations = [];
  f.sessions.catalog.refresh = async () => {};
  f.sessions.catalog.createProject = async (...args) => {
    registrations.push(args);
    return { id: "created", name: "Wizard", machineId: "pc", workingDirectory: "C:/Wizard" };
  };
  const id = randomUUID(),
    request = {
      method: "POST",
      url: "/api/project-setup/prepare",
      headers: { ...f.headers, "idempotency-key": id },
      payload: input,
    };
  assert.equal((await f.app.inject({ ...request, headers: {} })).statusCode, 401);
  const [a, b] = await Promise.all([f.app.inject(request), f.app.inject(request)]);
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json(), b.json());
  assert.equal(inspections, 1);
  assert.equal(applies, 0);
  assert.equal(
    (await f.app.inject({ ...request, payload: { ...input, name: "Other" } })).statusCode,
    409,
  );
  const execute = {
    method: "POST",
    url: `/api/project-setup/${id}/execute`,
    headers: f.headers,
    payload: {},
  };
  await Promise.all([f.app.inject(execute), f.app.inject(execute)]);
  assert.equal(applies, 1);
  assert.equal(registrations.length, 0);
  const second = randomUUID();
  await f.app.inject({ ...request, headers: { ...request.headers, "idempotency-key": second } });
  assert.equal(
    (await f.app.inject({ ...execute, url: `/api/project-setup/${second}/execute` })).statusCode,
    409,
  );
  release();
  await until(
    async () =>
      (await f.app.inject({ url: `/api/project-setup/${id}`, headers: f.headers })).json().state ===
      "complete",
  );
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][4], id);
  assert.equal((await f.app.inject(execute)).json().state, "complete");
  assert.equal(applies, 1);
  assert.equal(f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length, 0);
});
test("unknown setup and lost native registration acknowledgements recover by identity without duplicate projects", async (t) => {
  let confirmed = false,
    registrations = 0;
  const f = await handoffFixture(undefined, undefined, {
    projectSetupProbe: async (_m, r) =>
      r.op === "inspect"
        ? inspection
        : {
            id: r.id,
            state: confirmed ? "complete" : "unknown",
            phase: "register-project",
            error: "SETUP_UNAVAILABLE",
          },
  });
  t.after(() => f.close());
  const projects = f.sessions.config.projects;
  f.sessions.catalog.refresh = async () => {};
  f.sessions.catalog.createProject = async () => {
    registrations++;
    projects.push({
      id: "created",
      name: "Wizard",
      machineId: "pc",
      workingDirectory: "C:/Wizard",
      enabled: true,
    });
    throw Error("native acknowledgement lost");
  };
  const id = randomUUID();
  await f.app.inject({
    method: "POST",
    url: "/api/project-setup/prepare",
    headers: { ...f.headers, "idempotency-key": id },
    payload: input,
  });
  const execute = () =>
    f.app.inject({
      method: "POST",
      url: `/api/project-setup/${id}/execute`,
      headers: f.headers,
      payload: {},
    });
  const read = async () =>
    (await f.app.inject({ url: `/api/project-setup/${id}`, headers: f.headers })).json();
  await execute();
  await until(async () => (await read()).state === "unknown");
  assert.equal(registrations, 0);
  confirmed = true;
  await execute();
  await until(async () => (await read()).state === "unknown");
  assert.equal(registrations, 1);
  await execute();
  await until(async () => (await read()).state === "complete");
  assert.equal(registrations, 1);
  assert.equal((await read()).project.id, "created");
});
test("late setup status cannot roll a completed Hub operation back to running", async (t) => {
  let finishApply, finishRead;
  const f = await handoffFixture(undefined, undefined, {
    projectSetupProbe: async (_m, r) => {
      if (r.op === "inspect") return inspection;
      if (r.op === "status")
        return await new Promise(
          (resolve) => (finishRead = () => resolve({ id: r.id, state: "running", phase: "clone" })),
        );
      return await new Promise(
        (resolve) =>
          (finishApply = () => resolve({ id: r.id, state: "complete", phase: "register-project" })),
      );
    },
  });
  t.after(() => f.close());
  f.sessions.catalog.refresh = async () => {};
  f.sessions.catalog.createProject = async () => ({ id: "created", ...input });
  const id = randomUUID();
  await f.app.inject({
    method: "POST",
    url: "/api/project-setup/prepare",
    headers: { ...f.headers, "idempotency-key": id },
    payload: input,
  });
  await f.app.inject({
    method: "POST",
    url: `/api/project-setup/${id}/execute`,
    headers: f.headers,
    payload: {},
  });
  const read = f.app.inject({ url: `/api/project-setup/${id}`, headers: f.headers });
  await until(() => finishRead);
  finishApply();
  await until(
    () =>
      f.store.db.prepare("SELECT state FROM project_setup_operations WHERE id=?").get(id).state ===
      "complete",
  );
  finishRead();
  assert.equal((await read).json().state, "complete");
});
