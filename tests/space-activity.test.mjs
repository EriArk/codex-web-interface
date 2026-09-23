import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collaborationPolicy } from "../apps/hub/dist/collaboration-policy.js";
import { registerCollaborationSpaces } from "../apps/hub/dist/collaboration-routes.js";
import { CollaborationSpaces } from "../apps/hub/dist/collaboration-spaces.js";
import { SpaceActivity } from "../apps/hub/dist/space-activity.js";
import { Store } from "../apps/hub/dist/store.js";
import { TeamProjects } from "../apps/hub/dist/team-projects.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import Fastify from "../apps/hub/node_modules/fastify/fastify.js";
import { configSchema } from "../packages/shared/dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cw-spaces-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://spaces.example.test",
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "files"),
    },
    auth: { username: "owner" },
    team: { enabled: true, root: join(root, "team") },
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath);
  store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", "fixture-password-hash");
  const registry = new TeamStore(join(root, "team.db"), config, store);
  const owner = registry.ownerId;
  const member = (name) =>
    registry.accept(registry.invite(owner, name).token, name, name, "fixture-password-hash", 10).id;
  const friend = member("friend"),
    stranger = member("stranger");
  const team = new TeamProjects(registry),
    spaces = new CollaborationSpaces(team);
  t.after(async () => {
    registry.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = (id, repository = "https://github.com/example/altar") => ({
    personalProjectId: id,
    name: id,
    repository,
  });
  const input = (kind = "space") => ({
    title: "Altar + World",
    kind,
    userId: friend,
    personalProjectId: "altar",
    access: "collaborate",
    requestedAccess: "direct",
  });
  return { root, registry, team, spaces, owner, friend, stranger, project, input };
}

test("Space activity uses the viewer's checkout, coalesces reads, persists exact references and rechecks revocation", async (t) => {
  const f = await fixture(t),
    s = f.spaces;
  const { id } = s.create(f.owner, randomUUID(), f.input("project"), f.project("altar"));
  s.answer(
    f.friend,
    id,
    randomUUID(),
    { revision: 1, accept: true, access: "direct" },
    f.project("friend-copy"),
  );
  const projectId = s.catalog(f.owner).spaces[0].projects[0].id;
  const calls = [],
    personalCalls = [];
  const personal = async (actor) => {
    personalCalls.push(actor);
    return {
      runtime: {
        sessions: {
          project: (id) => ({
            id,
            name: id,
            machineId: actor,
            workingDirectory: "/fixture/" + actor,
          }),
          catalog: {
            machine: () => ({
              id: actor,
              type: "local-linux",
              name: "local",
              allowedRoots: ["/fixture"],
            }),
          },
        },
        projectWork: { context: { assertProject() {} } },
      },
    };
  };
  let access = "read",
    repositoryId = 42,
    during;
  const source = (kind, n, author) => ({
    kind,
    key: kind + ":" + (kind === "commit" ? String(n).repeat(40) : n),
    title: `${kind} ${n}`,
    author: { id: author, login: "author" + author },
    authorName: "author" + author,
    at: "2026-09-23T10:00:00Z",
    url: `https://github.com/example/altar/${kind === "commit" ? "commit/" + String(n).repeat(40) : "issues/" + n}`,
  });
  const probe = async (machine, root, request) => {
    calls.push({ machine: machine.id, root, request });
    await new Promise((done) => setTimeout(done, 10));
    if (during) {
      const action = during;
      during = null;
      action();
    }
    return {
      repository: "example/altar",
      repositoryId,
      access,
      identity: { id: 7, login: "viewer" },
      checkedAt: Date.now(),
      query: request.query,
      activity:
        request.query.kind === "activity"
          ? [source("commit", 1, 11), source("commit", 2, 12), source("issue", 3, 11)]
          : undefined,
    };
  };
  let activity = new SpaceActivity(s, personal, probe);
  const [a, b] = await Promise.all([
    activity.page(f.friend, id, projectId),
    activity.page(f.friend, id, projectId),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].machine, f.friend);
  assert(personalCalls.every((v) => v === f.friend));
  assert.equal(a.items.length, 3);
  assert(!JSON.stringify(a).includes("/fixture"));
  activity = new SpaceActivity(s, personal, probe);
  const restored = await activity.page(f.friend, id, projectId);
  assert.deepEqual(restored.items, a.items);
  assert.equal(calls.at(-1).request.query.kind, "identity");
  const opened = await activity.page(f.friend, id, projectId, a.items[0].key);
  assert.equal(opened.items.length, 1);
  await assert.rejects(activity.page(f.stranger, id, projectId), { code: "SPACE_NOT_FOUND" });
  const before = calls.length;
  await assert.rejects(activity.page(f.owner, id, randomUUID()));
  assert.equal(calls.length, before);
  repositoryId = 99;
  await assert.rejects(activity.page(f.friend, id, projectId, a.items[0].key), {
    code: "ACTIVITY_UNAVAILABLE",
  });
  repositoryId = 42;
  access = "unavailable";
  await assert.rejects(activity.page(f.friend, id, projectId), { code: "ACTIVITY_UNAVAILABLE" });
  assert.equal(f.team.db.prepare("SELECT count(*) AS n FROM space_activity_index").get().n, 0);
  access = "read";
  during = () =>
    s.removeMember(f.owner, id, randomUUID(), {
      revision: s.catalog(f.owner).spaces[0].revision,
      userId: f.friend,
    });
  await assert.rejects(activity.page(f.friend, id, projectId));
  assert.equal(f.team.db.prepare("SELECT count(*) AS n FROM space_activity_index").get().n, 0);
  assert.equal(s.chat.unread(f.owner, id), 0);
});
