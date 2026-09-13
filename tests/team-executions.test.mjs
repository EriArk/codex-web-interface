import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamExecutions } from "../apps/hub/dist/team-executions.js";
import { TeamProjects } from "../apps/hub/dist/team-projects.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import { handoffFixture, settings } from "./handoff-fixture.mjs";

const plan = () => ({
  kind: "plan",
  title: "Общий план",
  description: "Общая выбранная работа",
  status: "draft",
  sections: [
    {
      id: randomUUID(),
      title: "Изменения",
      items: [{ id: randomUUID(), text: "Сделать и проверить", checked: false }],
    },
  ],
});
const pause = () => {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
};

test("brief membership or account revocation cannot revive a queued shared execution before the next poll", async (t) => {
  for (const revoke of ["membership", "account"])
    await t.test(revoke, async (t) => {
      const f = await fixture(t),
        p = await f.prepare();
      f.friend.store.setStatus(f.friend.thread.id, "running");
      await f.executions.submit(f.friendId, f.projectId, p.execution.id);
      if (revoke === "membership") {
        f.projects.member(f.ownerId, f.projectId, f.friendId, randomUUID(), {
          revision: 1,
          role: "viewer",
          remove: true,
        });
        const invite = f.projects.invite(f.ownerId, f.projectId, randomUUID(), {
          login: "friend",
          role: "collaborator",
          revision: 1,
        });
        f.projects.answerInvitation(f.friendId, invite.id, randomUUID(), true);
      } else {
        f.registry.disable(f.ownerId, f.friendId, true);
        f.registry.disable(f.ownerId, f.friendId, false);
      }
      f.friend.store.setStatus(f.friend.thread.id, "idle");
      await f.executions.synchronize();
      assert.equal(f.count(f.friend), 0);
      assert.equal(
        f.registry.db.prepare("SELECT state FROM team_executions WHERE id=?").get(p.execution.id)
          .state,
        "blocked",
      );
    });
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cw-exec-team-"));
  const folders = [join(root, "owner-copy"), join(root, "friend-copy")];
  for (const folder of folders) {
    await mkdir(folder);
    execFileSync("git", ["init", "-q", folder]);
    execFileSync("git", [
      "-C",
      folder,
      "remote",
      "add",
      "origin",
      "https://github.com/example/shared-work.git",
    ]);
    await writeFile(join(folder, "README.md"), "Independent " + folder);
  }
  const natives = [];
  for (const folder of folders) {
    const f = await handoffFixture(undefined, undefined, {
      configure: (config) => {
        config.machines[0].type = "local-linux";
        config.machines[0].allowedProjectRoots = [folder];
        config.projects[0].workingDirectory = folder;
      },
    });
    f.store.setPreferences({ machineClients: { pc: "web" } });
    f.store.setThreadSettings(f.thread.id, settings);
    natives.push(f);
  }
  const [owner, friend] = natives;
  const registry = new TeamStore(join(root, "team.db"), owner.sessions.config, owner.store),
    ownerId = registry.ownerId,
    invitation = registry.invite(ownerId, "Друг"),
    friendId = registry.accept(
      invitation.token,
      "friend",
      "Друг",
      "fixture-inaccessible-hash",
      10,
    ).id,
    projects = new TeamProjects(registry),
    projectId = randomUUID(),
    repository = "https://github.com/example/shared-work";
  projects.create(ownerId, projectId, { title: "Общий", visibility: "shared", repository });
  const inv = projects.invite(ownerId, projectId, randomUUID(), {
    login: "friend",
    role: "collaborator",
    revision: 1,
  });
  projects.answerInvitation(friendId, inv.id, randomUUID(), true);
  for (const id of [ownerId, friendId])
    projects.bind(
      id,
      projectId,
      randomUUID(),
      { revision: 0, personalProjectId: "project" },
      { machineId: "pc", repository },
    );
  let maintenance = false;
  const personal = async (id) => {
    registry.active(id);
    if (![ownerId, friendId].includes(id)) throw Error("No fallback");
    return { runtime: id === ownerId ? owner : friend };
  };
  const executions = new TeamExecutions(projects, personal, () => {
    if (maintenance) throw Error("Maintenance");
  });
  owner.projectWork.policy = executions.policy(ownerId, () => owner);
  friend.projectWork.policy = executions.policy(friendId, () => friend);
  t.after(async () => {
    await executions.close();
    await Promise.all(natives.map((f) => f.close()));
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  const material = () =>
    projects.put(ownerId, projectId, randomUUID(), randomUUID(), {
      revision: 0,
      content: plan(),
      assigneeId: friendId,
    });
  const prepare = async () => {
    const item = material();
    const result = await executions.prepare(
      friendId,
      projectId,
      item.id,
      randomUUID(),
      item.revision,
    );
    return { item, ...result };
  };
  const count = (f) => f.calls.filter((c) => c.method === "turn/start").length;
  return {
    root,
    folders,
    owner,
    friend,
    registry,
    projects,
    projectId,
    ownerId,
    friendId,
    executions,
    material,
    prepare,
    count,
    maintenance: (v) => {
      maintenance = v;
    },
  };
}
test("two real independent Git folders: only assignee's ordinary native Work turn, exact receipt, private preview", async (t) => {
  const f = await fixture(t),
    coreId = randomUUID();
  f.projects.put(f.ownerId, f.projectId, coreId, randomUUID(), {
    revision: 0,
    assigneeId: null,
    content: {
      kind: "core",
      title: "Основа",
      value: {
        purpose: "Общие требования",
        behavior: "",
        rules: "",
        constraints: "",
        architecture: "",
        preferences: "",
      },
    },
  });
  const prepared = await f.prepare(),
    id = prepared.execution.id;
  assert.match(prepared.preview.text, /Общие требования/);
  assert.equal(prepared.preview.threadId, f.friend.thread.id);
  assert.notEqual(prepared.preview.threadId, f.owner.thread.id);
  assert.equal(f.count(f.owner), 0);
  assert.equal(f.count(f.friend), 0);
  const other = await f.executions.detail(f.ownerId, f.projectId, id);
  assert(!other.preview && !other.checkout && !JSON.stringify(other).includes(f.friend.thread.id));
  await assert.rejects(
    f.executions.submit(f.ownerId, f.projectId, id),
    (e) => e.code === "SHARED_EXECUTION_MISSING",
  );
  await assert.rejects(
    f.executions.prepare(f.ownerId, f.projectId, prepared.item.id, randomUUID(), 1),
    (e) => e.code === "SHARED_ASSIGNEE_REQUIRED",
  );
  await assert.rejects(
    f.executions.prepare(f.friendId, f.projectId, prepared.item.id, randomUUID(), 1),
    (e) => e.code === "SHARED_EXECUTION_ACTIVE",
  );
  const sent = await f.executions.submit(f.friendId, f.projectId, id);
  assert.equal(sent.execution.state, "running", JSON.stringify(sent));
  await f.executions.submit(f.friendId, f.projectId, id);
  assert.equal(f.count(f.owner), 0);
  assert.equal(f.count(f.friend), 1);
  assert.equal(
    f.friend.calls.find((c) => c.method === "turn/start").params.clientUserMessageId,
    prepared.preview.id,
  );
  assert.equal(
    f.friend.calls.some((c) => c.method === "thread/queue/add"),
    false,
  );
  f.friend.store.append(
    f.friend.thread.id,
    "assistant.completed",
    { id: "answer", text: "private final must not automatically publish", phase: "final" },
    sent.preview.turnId,
  );
  f.friend.finishTurn();
  const complete = await f.executions.detail(f.friendId, f.projectId, id);
  assert.equal(complete.execution.state, "completed");
  assert.equal(f.projects.items(f.ownerId, f.projectId, "result", "", 0).items.length, 0);
  assert.equal(
    f.owner.projectWork.context.current({ client: "codex", projectId: "project" }).threadId,
    f.owner.thread.id,
  );
});
test("Hub-held busy queue cancels on membership revocation, re-add never replays it", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  f.friend.store.setStatus(f.friend.thread.id, "running");
  assert.equal(
    (await f.executions.submit(f.friendId, f.projectId, p.execution.id)).execution.state,
    "queued",
  );
  assert.equal(f.count(f.friend), 0);
  f.projects.member(f.ownerId, f.projectId, f.friendId, randomUUID(), {
    revision: 1,
    role: "viewer",
    remove: true,
  });
  f.friend.store.setStatus(f.friend.thread.id, "idle");
  await f.executions.synchronize();
  const row = f.registry.db
    .prepare("SELECT state FROM team_executions WHERE id=?")
    .get(p.execution.id);
  assert.equal(row.state, "blocked");
  const inv = f.projects.invite(f.ownerId, f.projectId, randomUUID(), {
    login: "friend",
    role: "collaborator",
    revision: 1,
  });
  f.projects.answerInvitation(f.friendId, inv.id, randomUUID(), true);
  await f.executions.synchronize();
  await assert.rejects(
    f.executions.submit(f.friendId, f.projectId, p.execution.id),
    (e) => e.code === "SHARED_EXECUTION_FINISHED",
  );
  assert.equal(f.count(f.friend), 0);
});
test("busy work waits on Hub, dispatches once on idle, stops before native queue on a late busy race", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  f.friend.store.setStatus(f.friend.thread.id, "running");
  await f.executions.submit(f.friendId, f.projectId, p.execution.id);
  await f.executions.synchronize();
  assert.equal(f.count(f.friend), 0);
  f.friend.store.setStatus(f.friend.thread.id, "idle");
  const original = f.friend.projectWork.submit.bind(f.friend.projectWork);
  let race = true;
  f.friend.projectWork.submit = async (id) => {
    if (race) {
      race = false;
      f.friend.store.setStatus(f.friend.thread.id, "running");
    }
    return original(id);
  };
  await f.executions.synchronize();
  assert.equal(
    (await f.executions.detail(f.friendId, f.projectId, p.execution.id)).execution.state,
    "queued",
  );
  assert.equal(
    f.friend.calls.some((c) => c.method === "thread/queue/add"),
    false,
  );
  f.friend.store.setStatus(f.friend.thread.id, "idle");
  await f.executions.synchronize();
  assert.equal(f.count(f.friend), 1);
});
test("direct private action submission cannot bypass shared confirmation and its final commit guard", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  const denied = await f.friend.app.inject({
    method: "POST",
    url: `/api/workspace/actions/${p.preview.id}/submit`,
    headers: f.friend.headers,
    payload: { confirm: true },
  });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, "SHARED_CONFIRM_REQUIRED");
  const wait = pause(),
    entered = pause(),
    original = f.friend.sessions.attachments.prepare;
  f.friend.sessions.attachments.prepare = async (...args) => {
    const value = await original(...args);
    entered.release();
    await wait.promise;
    return value;
  };
  const send = f.executions.submit(f.friendId, f.projectId, p.execution.id);
  await entered.promise;
  f.projects.member(f.ownerId, f.projectId, f.friendId, randomUUID(), {
    revision: 1,
    role: "viewer",
    remove: false,
  });
  wait.release();
  const result = await send;
  assert.equal(result.execution.state, "blocked");
  assert.equal(f.count(f.friend), 0);
  assert.equal(
    f.friend.store.db.prepare("SELECT count(*) n FROM messages WHERE id=?").get(p.preview.id).n,
    0,
  );
});
test("lost native acknowledgement stays unknown across restart and exact repeated confirmation", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  f.friend.loseAck();
  const unknown = await f.executions.submit(f.friendId, f.projectId, p.execution.id);
  assert.equal(unknown.execution.state, "unknown");
  assert.equal(f.count(f.friend), 1);
  await f.executions.submit(f.friendId, f.projectId, p.execution.id);
  await f.executions.synchronize();
  assert.equal(f.count(f.friend), 1);
  await assert.rejects(
    f.executions.prepare(f.friendId, f.projectId, p.item.id, randomUUID(), 1),
    (e) => e.code === "SHARED_EXECUTION_ACTIVE",
  );
  const restored = new TeamExecutions(
    f.projects,
    async () => ({ runtime: f.friend }),
    () => {},
  );
  await restored.synchronize();
  assert.equal(
    (await restored.detail(f.friendId, f.projectId, p.execution.id)).execution.state,
    "unknown",
  );
  assert.equal(f.count(f.friend), 1);
  await restored.close();
});
test("Core, current chat, settings or physical Git identity change blocks the frozen preview", async (t) => {
  for (const mutation of ["core", "chat", "settings", "origin"])
    await t.test(mutation, async (t) => {
      const f = await fixture(t),
        p = await f.prepare();
      if (mutation === "core")
        f.projects.put(f.ownerId, f.projectId, randomUUID(), randomUUID(), {
          revision: 0,
          assigneeId: null,
          content: {
            kind: "core",
            title: "Новая основа",
            value: {
              purpose: "Новые требования",
              behavior: "",
              rules: "",
              constraints: "",
              architecture: "",
              preferences: "",
            },
          },
        });
      if (mutation === "chat") {
        const next = f.friend.store.createThread("project", randomUUID(), "New own chat");
        f.friend.projectWork.context.adopt(
          { client: "codex", projectId: "project", name: "Project" },
          next.id,
        );
      }
      if (mutation === "settings")
        f.friend.store.setThreadSettings(f.friend.thread.id, { ...settings, effort: "low" });
      if (mutation === "origin")
        execFileSync("git", [
          "-C",
          f.folders[1],
          "remote",
          "set-url",
          "origin",
          "https://github.com/example/different.git",
        ]);
      await f.executions.submit(f.friendId, f.projectId, p.execution.id).catch(() => {});
      assert.equal(f.count(f.friend), 0);
      assert.equal(f.count(f.owner), 0);
    });
});
test("maintenance freezes consented Hub queue; idle resumes only after admission, explicit cancellation wins", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  f.friend.store.setStatus(f.friend.thread.id, "running");
  await f.executions.submit(f.friendId, f.projectId, p.execution.id);
  f.friend.store.setStatus(f.friend.thread.id, "idle");
  f.maintenance(true);
  await f.executions.synchronize();
  assert.equal(f.count(f.friend), 0);
  f.maintenance(false);
  f.executions.cancel(f.friendId, f.projectId, p.execution.id);
  await f.executions.synchronize();
  assert.equal(f.count(f.friend), 0);
});
