import assert from "node:assert/strict";
import test from "node:test";
import { ProjectCores } from "../apps/hub/dist/project-core.js";
import { workspaceProjects } from "../apps/hub/dist/workspace-projects.js";
import { coreWriteSchema, emptyCore } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
test("owner core is revisioned, retry-safe, historical and independent of chat/native project deletion", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const cores = new ProjectCores(f.sessions);
  const input = {
    scope,
    revision: 0,
    value: {
      ...emptyCore,
      purpose: "Книги",
      constraints: "Не копировать архив",
      architecture: "Windows → Hub",
    },
  };
  assert.equal(cores.get(scope).revision, 0);
  const first = cores.save(input);
  assert.equal(first.revision, 1);
  assert.equal(cores.save(input).revision, 1);
  const second = cores.save({
    ...input,
    revision: 1,
    value: { ...input.value, rules: "Сначала backend" },
  });
  assert.equal(second.revision, 2);
  assert.throws(
    () => cores.save({ ...input, revision: 1, value: { ...input.value, purpose: "Другое" } }),
    (e) => e.code === "CORE_CONFLICT",
  );
  const restored = cores.restore(scope, 2, 1);
  assert.equal(restored.revision, 3);
  assert.equal(restored.value.rules, "");
  assert.equal(cores.version(scope, 2).value.rules, "Сначала backend");
  f.sessions.catalog.library.save("project", scope.projectId, { deleted: true });
  assert.equal(cores.get(scope).value.purpose, "Книги");
  assert(
    workspaceProjects(f.sessions).items.some(
      (p) => p.scope.projectId === scope.projectId && p.availability === "missing",
    ),
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
  assert.match(cores.text(scope), /подтверждена владельцем/);
  assert.doesNotMatch(cores.text(scope), /Сначала backend/);
});
test("core history is bounded, metadata-only and scoped separately for GPT and Codex", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const cores = new ProjectCores(f.sessions);
  for (let i = 0; i < 45; i++)
    cores.save({ scope, revision: i, value: { ...emptyCore, purpose: "Версия " + i } });
  const page = cores.history(scope);
  assert.equal(page.items.length, 10);
  assert.equal(page.nextOffset, 10);
  assert.equal(page.items[0].revision, 45);
  assert(!("value" in page.items[0]));
  assert.equal(cores.history(scope, 30).nextOffset, null);
  assert.equal(cores.history(scope, 40).items.length, 0);
  assert.throws(
    () => cores.version(scope, 1),
    (e) => e.code === "CORE_VERSION_MISSING",
  );
  const gpt = { ...scope, client: "gpt" };
  assert.equal(cores.get(gpt).revision, 0);
  cores.save({ scope: gpt, revision: 0, value: { ...emptyCore, purpose: "Другой core" } });
  assert.equal(cores.get(scope).value.purpose, "Версия 44");
});
test("core writes require existing authentication, CSRF, explicit revision and bounded owner fields", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const payload = { scope, revision: 0, value: { ...emptyCore, purpose: "Private" } };
  assert.equal(
    (await f.app.inject({ method: "PUT", url: "/api/workspace/core", payload })).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: "/api/workspace/core",
        payload,
        headers: { cookie: f.headers.cookie },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ method: "PUT", url: "/api/workspace/core", payload, headers: f.headers }))
      .statusCode,
    200,
  );
  assert.equal(
    coreWriteSchema.safeParse({
      ...payload,
      value: { ...payload.value, architecture: "x".repeat(3001) },
    }).success,
    false,
  );
  assert.equal(coreWriteSchema.safeParse({ ...payload, extra: "execute" }).success, false);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/workspace/core/restore",
        payload: { scope, revision: 1, version: 1 },
        headers: f.headers,
      })
    ).statusCode,
    400,
  );
});
