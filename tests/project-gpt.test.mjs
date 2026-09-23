import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectGpts } from "../apps/hub/dist/project-gpt.js";
import { inspectorProbe } from "../packages/machines/dist/inspectorProbe.js";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cw-project-gpt-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://github.com/example/altar.git",
  ]);
  const native = nativeWorkspaceFixture();
  let collaboration = {
    space: "Altar + World",
    repository: "https://github.com/example/altar",
    relatedProjects: [{ name: "World", repository: "https://github.com/example/world" }],
  };
  const f = await handoffFixture(undefined, undefined, {
    nativeGpt: native.workspace,
    configure: (cfg) => {
      cfg.machines[0] = { ...cfg.machines[0], type: "local-linux", allowedRoots: [root] };
      cfg.projects[0].workingDirectory = root;
    },
    collaborationPolicy: {
      gptScope: () =>
        collaboration
          ? { spaceId: "space", projectId: "shared-project", access: "collaborate" }
          : null,
      instructions: () => "Shared agreement",
      gptContext: () => collaboration,
      delivery: () => {},
    },
  });
  t.after(async () => {
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = (method, tail = "", payload, key) =>
    f.app.inject({
      method,
      url: "/api/projects/project/gpt" + tail,
      headers: { ...f.headers, ...(key ? { "idempotency-key": key } : {}) },
      payload,
    });
  await f.app.inject({ url: "/api/gpt/conversations", headers: f.headers });
  return {
    ...f,
    root,
    native,
    request,
    changeContext: () => {
      collaboration = null;
    },
  };
}
const until = async (fn) => {
  for (let i = 0; i < 250; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Timed out");
};

test("Project GPT uses the real durable outbox, frozen exact retries, own binding and current public context", async (t) => {
  const f = await fixture(t),
    initial = await f.request("GET");
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().nativeId, null);
  assert.equal(f.native.state.sends, 0);
  const bound = await f.request("PUT", "", { nativeId: f.native.conversationId, revision: 0 });
  assert.equal(bound.statusCode, 200, bound.body);
  const key = randomUUID(),
    input = { ...f.native.input, text: "Что изменится в World?", revision: 1 };
  const sent = await f.request("POST", "/send", input, key);
  assert.equal(sent.statusCode, 202, sent.body);
  await until(() => f.native.state.sends === 1);
  assert.match(f.native.state.input.text, /Altar \+ World/);
  assert.match(f.native.state.input.text, /Что изменится в World\?$/);
  assert.doesNotMatch(f.native.state.input.text, new RegExp(f.root));
  f.changeContext();
  const again = await f.request("POST", "/send", input, key);
  assert.equal(again.statusCode, 202, again.body);
  assert.equal(again.json().job.id, sent.json().job.id);
  assert.equal(f.native.state.sends, 1);
  assert.equal(
    (await f.request("POST", "/send", { ...input, text: "Другой текст" }, key)).statusCode,
    409,
  );
  assert.equal(
    (await f.request("PUT", "", { nativeId: randomUUID(), revision: 1 })).statusCode,
    409,
  );
  assert.equal((await f.request("PUT", "", { nativeId: null, revision: 0 })).statusCode, 409);
  const get = await f.request("GET");
  assert.doesNotMatch(get.json().context, /Altar \+ World/);
  assert.equal(get.json().nativeId, f.native.conversationId);
  f.native.state.finished = true;
  await until(
    () =>
      f.store.db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(key)?.status === "completed",
  );
});

test("Activity evidence joins the frozen project envelope and cannot change under an accepted send key", async (t) => {
  const f = await fixture(t);
  const service = f.projectGpts;
  const bound = service.bind("project", f.native.conversationId, 0);
  const key = randomUUID(),
    body = { ...f.native.input, text: "Discuss exact activity", revision: bound.revision };
  const evidence = "Exact GitHub source commit:" + "a".repeat(40) + "\n+ nullable field";
  service.send("project", key, body, evidence);
  await until(() => f.native.state.sends === 1);
  assert.match(f.native.state.input.text, /nullable field/);
  assert.match(f.native.state.input.text, /Discuss exact activity$/);
  service.send("project", key, body, evidence);
  assert.throws(() => service.send("project", key, body, "different source"), {
    code: "GPT_KEY_REUSED",
  });
  assert.equal(f.native.state.sends, 1);
  f.native.state.finished = true;
});
test("New-chat identity survives binding-write interruption; pending first send cannot fork another chat", async (t) => {
  const f = await fixture(t),
    db = f.store.db;
  // Actual outbox schema, with a transport-free durable queued receipt.
  const jobs = {
    library: { get: () => null },
    job: (id) => {
      const r = db.prepare("SELECT * FROM gpt_jobs WHERE id=?").get(id);
      return r;
    },
    enqueue: (id) => jobs.job(id),
  };
  const service = new ProjectGpts(f.sessions, jobs);
  const id = randomUUID();
  db.prepare("INSERT INTO gpt_jobs VALUES(?,?,?,?,?,?,?,'queued','',?,?,?,'',NULL,0)").run(
    id,
    "hash",
    null,
    "text",
    "[]",
    "latest",
    "1",
    "[]",
    1,
    1,
  );
  db.prepare("INSERT INTO project_gpt_sends VALUES(?,?,?,?,?)").run(id, "project", 0, "hash", "{}");
  assert.equal(service.get("project").jobId, id);
  assert.throws(
    () => service.send("project", randomUUID(), { ...f.native.input, nativeId: null, revision: 0 }),
    /Первый запрос/,
  );
  db.prepare("UPDATE gpt_jobs SET status='unknown' WHERE id=?").run(id);
  assert.throws(() => service.bind("project", null, 0), /Первый запрос/);
  assert.equal(service.get("project").revision, 0);
  db.prepare("UPDATE gpt_jobs SET nativeId=?,status='running' WHERE id=?").run("created-chat", id);
  assert.equal(new ProjectGpts(f.sessions, jobs).get("project").nativeId, "created-chat");
  const other = await fixture(t);
  assert.equal((await other.request("GET")).json().nativeId, null);
  // Rebinding leaves the original work intact and rejects a stale device's new send.
  service.bind("project", null, 0);
  assert.equal(db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(id).status, "running");
  assert.throws(
    () => service.send("project", randomUUID(), { ...f.native.input, nativeId: null, revision: 0 }),
    /Привязка/,
  );
});

test("an unaccepted pre-crash intent cannot create another chat after a different first send settles", async (t) => {
  const f = await fixture(t),
    db = f.store.db;
  const body = { ...f.native.input, nativeId: null, revision: 0 };
  const key = randomUUID();
  db.prepare("INSERT INTO project_gpt_sends VALUES(?,?,?,?,?)").run(
    key,
    "project",
    0,
    createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    JSON.stringify(body),
  );
  f.projectGpts.bindings.ensure(
    {
      provider: "gpt",
      scope: "project",
      scopeId: "project",
      role: "companion",
      lifecycle: "persistent",
      visibility: "normal",
      execution: null,
    },
    { nativeId: f.native.conversationId, jobId: null, revision: 0 },
  );
  assert.throws(() => f.projectGpts.send("project", key, body), { code: "PROJECT_GPT_CHANGED" });
  assert.equal(db.prepare("SELECT 1 FROM gpt_jobs WHERE id=?").get(key), undefined);
  assert.equal(f.native.state.sends, 0);
});

test("legacy Project GPT migration retains native history, rules, revision and receipts across restart", async (t) => {
  const f = await fixture(t),
    db = f.store.db;
  const rules = JSON.stringify({ enabled: ["tests"], custom: "Keep my rules" });
  db.prepare("INSERT INTO project_gpt_bindings VALUES(?,?,?,?,?)").run(
    "project",
    f.native.conversationId,
    null,
    7,
    rules,
  );
  const service = new ProjectGpts(f.sessions, f.gpt);
  assert.equal(service.get("project").nativeId, f.native.conversationId);
  assert.equal(service.get("project").revision, 7);
  assert.equal(service.get("project").rules.custom, "Keep my rules");
  assert.equal(service.bind("project", f.native.conversationId, 7).revision, 7);
  service.bind("project", null, 7);
  const restarted = new ProjectGpts(f.sessions, f.gpt);
  assert.equal(restarted.get("project").nativeId, null);
  assert.equal(restarted.get("project").revision, 8);
  assert.equal(
    db.prepare("SELECT nativeId FROM project_gpt_bindings WHERE projectId='project'").get()
      .nativeId,
    f.native.conversationId,
  );
  assert.equal(f.native.state.sends, 0);
});

test("Project GPT prevents cross-project reuse, preserves missing native identity and rechecks revoked execution", async (t) => {
  const f = await fixture(t);
  f.sessions.config.projects.push({ ...f.sessions.config.projects[0], id: "other", name: "Other" });
  const service = f.projectGpts;
  service.bind("project", f.native.conversationId, 0);
  assert.throws(() => service.bind("other", f.native.conversationId, 0), {
    code: "CONVERSATION_ALREADY_BOUND",
  });
  service.bind("project", null, 1);
  assert.throws(() => service.bind("other", f.native.conversationId, 0), {
    code: "CONVERSATION_ALREADY_BOUND",
  });
  service.bind("project", f.native.conversationId, 2);
  f.gpt.library.save("thread", f.native.conversationId, { deleted: true });
  assert.equal(service.get("project").nativeId, f.native.conversationId);
  assert.throws(() => service.send("project", randomUUID(), { ...f.native.input, revision: 3 }));
  assert.equal(f.native.state.sends, 0);
  f.sessions.authorizeExecution = () => {
    throw Error("REVOKED");
  };
  assert.throws(() => service.bind("project", null, 3), /REVOKED/);
  assert.throws(
    () => service.send("project", randomUUID(), { ...f.native.input, revision: 3 }),
    /REVOKED/,
  );
  assert.equal(service.get("project").revision, 3);
});

for (const change of ["binding", "project", "user", "membership"]) {
  test(`Project GPT rechecks ${change} after asynchronous preparation, before the native send`, async (t) => {
    const f = await fixture(t);
    f.projectGpts.bind("project", f.native.conversationId, 0);
    let release,
      entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const prepare = f.native.client.prepareDispatch;
    f.native.client.prepareDispatch = async (input) => {
      const result = await prepare(input);
      entered = true;
      await gate;
      return result;
    };
    const key = randomUUID(),
      input = { ...f.native.input, revision: 1 };
    const accepted = await f.request("POST", "/send", input, key);
    assert.equal(accepted.statusCode, 202, accepted.body);
    await until(() => entered);
    if (change === "binding") f.projectGpts.bind("project", null, 1);
    if (change === "project")
      f.sessions.catalog.library.save("project", "project", { archived: true });
    if (change === "membership") f.changeContext();
    if (change === "user")
      f.sessions.authorizeExecution = () => {
        throw Error("REVOKED");
      };
    release();
    await until(
      () =>
        f.store.db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(key)?.status === "failed",
    );
    assert.equal(f.native.state.sends, 0);
    assert.equal(
      f.store.db.prepare("SELECT 1 FROM gpt_native_receipts WHERE jobId=?").get(key),
      undefined,
    );
  });
}

test("Optional local rules preserve AGENTS/gitignore, stay outside Git and activate only on subsequent native turns", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "AGENTS.md"), "Existing owner rules\n");
  await writeFile(join(f.root, ".gitignore"), "cache/\n");
  await f.request("GET");
  await assert.rejects(access(join(f.root, "CODEXWEB.md")));
  const saved = await f.request("PUT", "/rules", {
    enabled: ["related", "tests"],
    custom: "Сохранять совместимость World.",
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.match(await readFile(join(f.root, "CODEXWEB.md"), "utf8"), /Сохранять совместимость/);
  assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), "Existing owner rules\n");
  assert.equal(await readFile(join(f.root, ".gitignore"), "utf8"), "cache/\n");
  assert.equal(
    execFileSync("git", ["-C", f.root, "check-ignore", "CODEXWEB.md"], { encoding: "utf8" }).trim(),
    "CODEXWEB.md",
  );
  assert.match(
    f.sessions.projectInstructions("project"),
    /Shared agreement[\s\S]*Read CODEXWEB.md[\s\S]*Сохранять совместимость/,
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.equal((await f.request("PUT", "/rules", { enabled: [], custom: "" })).statusCode, 200);
  await assert.rejects(access(join(f.root, "CODEXWEB.md")));
  assert.equal(f.sessions.projectInstructions("project"), "Shared agreement");
  await writeFile(join(f.root, "CODEXWEB.md"), "Manual document");
  await assert.rejects(
    inspectorProbe(f.root, {
      op: "project-rules",
      content: "<!-- CodexWeb: personal project rules -->\nnew",
    }),
    /UNMANAGED/,
  );
  assert.equal(await readFile(join(f.root, "CODEXWEB.md"), "utf8"), "Manual document");
});

test("Invitation preferences merge once, survive a retry and can be declined without a local file", async (t) => {
  const f = await fixture(t);
  const service = new ProjectGpts(f.sessions, { job: () => null });
  await service.invitationRules("project", randomUUID(), { enabled: [], custom: "" });
  await assert.rejects(access(join(f.root, "CODEXWEB.md")));
  await service.rules("project", { enabled: ["focused"], custom: "Личные пожелания" });
  const key = randomUUID(),
    selected = { enabled: ["related"], custom: "Совместимость API" };
  await service.invitationRules("project", key, selected);
  const saved = service.get("project").rules;
  assert.deepEqual(saved.enabled, ["focused", "related"]);
  assert.equal(saved.custom, "Личные пожелания\n\nСовместимость API");
  assert.match(await readFile(join(f.root, "CODEXWEB.md"), "utf8"), /Совместимость API/);
  await service.rules("project", { enabled: ["tests"], custom: "Изменено позже" });
  await new ProjectGpts(f.sessions, { job: () => null }).invitationRules("project", key, selected);
  assert.deepEqual(service.get("project").rules, { enabled: ["tests"], custom: "Изменено позже" });
});
