import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Catalog } from "../apps/hub/dist/catalog.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import {
  assertProjectRoot,
  projectPathAllowed,
  verifyProjectRoot,
} from "../packages/machines/dist/projectRoots.js";
import { configSchema } from "../packages/shared/dist/index.js";

test("a freshly enrolled machine opens its root and discovers projects without a seed project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cw-new-machine-"));
  const folder = join(root, "project");
  await mkdir(folder);
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://example.test",
      databasePath: ":memory:",
      resultsPath: join(root, "results"),
    },
    auth: {},
    machines: [{ id: "new", name: "New", type: "local-linux", allowedProjectRoots: [root] }],
    projects: [],
  });
  const store = new Store(":memory:"),
    calls = [],
    anchors = [];
  const rpc = new EventEmitter();
  rpc.initialize = async () => ({ userAgent: "codex/0.153.4" });
  rpc.close = () => {};
  rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "project/list")
      return { data: [{ id: "native-project", name: "Existing", roots: [{ path: folder }] }] };
    if (method === "fs/readDirectory") return { entries: [] };
    return {};
  };
  const sessions = new Sessions(config, store, (_machine, anchor) => {
    anchors.push(anchor);
    return rpc;
  });
  t.after(async () => {
    await sessions.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(sessions.catalog.machines()[0].projectsDirectory, root);
  assert.equal((await sessions.catalog.directories("new", root)).parent, null);
  await sessions.catalog.refresh(true);
  assert(sessions.catalog.projects().some((p) => p.workingDirectory === folder));
  await sessions.catalog.directories("new", folder);
  assert.deepEqual(
    anchors,
    [root],
    "Companion starts at the enrolled root, even for nested projects",
  );
  assert(!calls.some((c) => c.method === "thread/start" || c.method === "turn/start"));
});

test("allowed Windows roots respect path segments, OS case, UNC shares and device/ADS aliases", () => {
  const machine = {
    type: "ssh-windows",
    allowedProjectRoots: ["D:\\Work", "\\\\nas\\share\\Projects"],
  };
  for (const path of [
    "d:/work",
    "D:\\WORK\\Alpha",
    "D:\\Work\\one\\..\\two",
    "\\\\NAS\\SHARE\\Projects\\Alpha",
  ])
    assert(projectPathAllowed(machine, path), path);
  for (const path of [
    "D:\\Work-other",
    "D:\\Work\\..\\outside",
    "D:Work",
    "\\Work",
    "C:\\Work",
    "\\\\nas\\share-other\\Projects",
    "\\\\nas\\share\\Projects-other",
    "\\\\?\\D:\\Work",
    "\\\\.\\D:\\Work",
    "D:\\Work\\text:stream",
    "D:\\Work\\NUL",
    "D:\\Work.\\child",
    "D:\\Work\\child ",
    "D:\\Work\\a\n",
  ])
    assert(!projectPathAllowed(machine, path), path);
  assert.throws(
    () => assertProjectRoot({ ...machine, allowedProjectRoots: [] }, "D:\\Work"),
    /корней/,
  );
  assert(projectPathAllowed({ type: "ssh-windows" }, "D:\\OwnerLegacy"));
});

test("canonical checks reject links in roots or descendants and only allow missing directories inside roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cw-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed"),
    outside = join(root, "outside"),
    sub = join(allowed, "project");
  await mkdir(sub, { recursive: true });
  await mkdir(outside);
  const machine = { type: "local-linux", allowedProjectRoots: [allowed] };
  await verifyProjectRoot(machine, sub);
  await verifyProjectRoot(machine, join(allowed, "new", "nested"), true);
  await assert.rejects(verifyProjectRoot(machine, join(allowed, "new")));
  await assert.rejects(verifyProjectRoot(machine, outside, true));
  await symlink(outside, join(allowed, "escape"));
  await assert.rejects(verifyProjectRoot(machine, join(allowed, "escape")));
  await assert.rejects(verifyProjectRoot(machine, join(allowed, "escape", "new"), true));
  const alias = join(root, "alias");
  await symlink(allowed, alias);
  await assert.rejects(verifyProjectRoot({ ...machine, allowedProjectRoots: [alias] }, alias));
});

test("catalog discovery and folder browsing respect enrolled roots before native access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cw-root-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed"),
    outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://example.test",
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "owner" },
    machines: [{ id: "pc", name: "PC", type: "local-linux", allowedProjectRoots: [allowed] }],
    projects: [{ id: "allowed", machineId: "pc", name: "Allowed", workingDirectory: allowed }],
  });
  const store = new Store(config.hub.databasePath);
  t.after(() => store.close());
  const calls = [],
    rpc = {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "project/list")
          return {
            data: [
              { id: "native-in", name: "Inside", roots: [{ path: allowed }] },
              { id: "native-out", name: "PRIVATE_OUTSIDE", roots: [{ path: outside }] },
              {
                id: "native-link",
                name: "PRIVATE_ALIAS",
                roots: [{ path: join(allowed, "native-escape") }],
              },
            ],
          };
        if (method === "fs/readDirectory") return { entries: [] };
        return {};
      },
    };
  const catalog = new Catalog(config, store, async () => rpc);
  await symlink(outside, join(allowed, "native-escape"));
  await catalog.refresh(true);
  assert(!JSON.stringify(catalog.publicProjects()).includes("PRIVATE_OUTSIDE"));
  assert(!JSON.stringify(catalog.publicProjects()).includes("PRIVATE_ALIAS"));
  assert.equal(catalog.machines()[0].projectsDirectory, allowed);
  calls.length = 0;
  await assert.rejects(catalog.directories("pc", outside));
  await assert.rejects(catalog.createProject("pc", "Outside", outside, false, "test"));
  assert.equal(calls.length, 0);
  assert.equal((await catalog.directories("pc", allowed)).parent, null);
  await symlink(outside, join(allowed, "escape"));
  calls.length = 0;
  await assert.rejects(catalog.directories("pc", join(allowed, "escape")));
  assert.equal(calls.length, 0);
});
