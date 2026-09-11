import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { guiPreviewFixture } from "./gui-preview-fixture.mjs";

const { validateAction, absolute } = createRequire(import.meta.url)(
  "../ops/windows/GuiPreviewWorker.cjs",
);
const call = async (f, method, url, payload) => {
  const r = await f.app.inject({
    method,
    url: "/api/projects/project/gui-previews" + url,
    payload,
    headers: f.headers,
  });
  return { status: r.statusCode, value: r.json() };
};
test("configured preview actions reject unbounded/runtime browser input", () => {
  const a = {
    id: "app",
    label: "App",
    projectRoot: "C:/Project",
    executable: "C:/Project/App.exe",
    args: [],
    workingDirectory: "C:/Project",
  };
  assert.equal(validateAction(a).capture, "window");
  assert.equal(validateAction(a).keepAliveMinutes, 30);
  for (const patch of [
    { id: "../app" },
    { reuse: true },
    { executable: "cmd /c x" },
    { executable: "C:/x.cmd" },
    { args: ["x\ncmd"] },
    { startupTimeoutSeconds: 1000 },
    { keepAliveMinutes: 0 },
    { capture: "desktop" },
  ])
    assert.throws(() => validateAction({ ...a, ...patch }));
  for (const p of ["C:relative", "\\\\host\\share", "C:/x:stream", "C:/x\n"])
    assert.equal(absolute(p), false);
});
test("preview is authenticated, exact once, scoped and independent of native writers", async (t) => {
  const f = await guiPreviewFixture();
  t.after(() => f.close());
  const before = f.calls.length,
    id = randomUUID(),
    body = { actionId: "app", threadId: f.thread.id };
  const catalog = await call(f, "GET", "");
  assert.equal(catalog.value.threadId, f.thread.id);
  assert.equal((await call(f, "PUT", "/" + id, { ...body, executable: "evil" })).status, 400);
  const op = await call(f, "PUT", "/" + id, body);
  assert.equal(op.status, 202);
  assert.equal(op.value.state, "waiting");
  assert.equal((await call(f, "PUT", "/" + id, body)).value.id, id);
  assert.equal(f.previewCalls.filter((c) => c.q.op === "start").length, 1);
  assert.equal((await call(f, "PUT", "/" + id, { ...body, actionId: "other" })).status, 409);
  assert.equal(
    (await call(f, "PUT", "/" + randomUUID(), { ...body, threadId: randomUUID() })).status,
    409,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: "/api/projects/project/gui-previews/" + randomUUID(),
        payload: body,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: "/api/projects/project/gui-previews/" + randomUUID(),
        headers: { cookie: f.headers.cookie, origin: f.headers.origin },
        payload: body,
      })
    ).statusCode,
    403,
  );
  assert.equal(f.calls.length, before);
  assert(f.previewCalls.every((c) => c.root === "C:/Project" && c.machine === "pc"));
});
test("lost launch acknowledgement becomes one private image Result in the frozen thread", async (t) => {
  const f = await guiPreviewFixture();
  t.after(() => f.close());
  const id = randomUUID();
  f.lose();
  assert.equal(
    (await call(f, "PUT", "/" + id, { actionId: "app", threadId: f.thread.id })).value.state,
    "unknown",
  );
  f.capture(id);
  const r = await call(f, "GET", "/" + id);
  assert.equal(r.status, 200);
  assert.equal(r.value.state, "captured");
  assert(r.value.resultId);
  assert(r.value.artifact.url.startsWith("/api/artifacts/"));
  const again = await call(f, "GET", "/" + id);
  assert.equal(again.value.resultId, r.value.resultId);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM results WHERE sourceKey=?").get("gui-preview:" + id)
      .n,
    1,
  );
  const result = f.store.db
    .prepare("SELECT threadId,turnId FROM results WHERE id=?")
    .get(r.value.resultId);
  assert.equal(result.threadId, f.thread.id);
  assert.equal(result.turnId, null);
  assert.equal((await f.app.inject({ method: "GET", url: r.value.artifact.url })).statusCode, 401);
  assert.equal(
    (await f.app.inject({ method: "GET", url: r.value.artifact.url, headers: f.headers }))
      .statusCode,
    200,
  );
  assert.equal((await call(f, "POST", "/" + id + "/stop", {})).status, 400);
  assert.equal((await call(f, "POST", "/" + id + "/stop", { confirm: true })).value.appOpen, false);
  assert.equal(f.previewCalls.filter((c) => c.q.op === "start").length, 1);
});
test("changed project binding and wrong worker identity cannot attach a screenshot", async (t) => {
  const f = await guiPreviewFixture();
  t.after(() => f.close());
  const id = randomUUID();
  await call(f, "PUT", "/" + id, { actionId: "app", threadId: f.thread.id });
  f.records.get(id).actionId = "wrong";
  f.capture(id);
  const wrong = await call(f, "GET", "/" + id);
  assert(!wrong.value.resultId);
  assert(wrong.value.error);
  f.sessions.config.projects[0].workingDirectory = "C:/Other";
  assert.equal((await call(f, "GET", "/" + id)).status, 409);
  assert.equal((await call(f, "POST", "/" + id + "/stop", { confirm: true })).status, 409);
});
