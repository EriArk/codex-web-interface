import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
