import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import reader from "../ops/windows/GitHubReleases.cjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "github-release-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "config.json"), JSON.stringify({ gh: join(root, "gh.exe") }));
  return root;
}
async function job(root, changes = {}) {
  const id = randomUUID();
  await writeFile(
    join(root, id + ".request.json"),
    JSON.stringify({ owner: "Owner", repo: "Repo", createdAt: Date.now(), ...changes }),
  );
  return id;
}
test("Windows release worker runs only fixed GETs and strips unrelated response fields", async (t) => {
  const root = await fixture(t),
    id = await job(root);
  let calls = 0;
  const execute = async (file, args, options) => {
    calls++;
    assert.equal(file, join(root, "gh.exe"));
    assert.deepEqual(args, [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "repos/Owner/Repo/releases?per_page=6",
    ]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 8000);
    assert.equal(options.env.GH_PROMPT_DISABLED, "1");
    return {
      stdout: JSON.stringify([
        {
          id: 3,
          tag_name: "v1",
          body: "a".repeat(13000),
          assets: [{ url: "private" }],
          private_data: "secret",
        },
      ]),
    };
  };
  await reader.worker(root, execute);
  await reader.worker(root, execute);
  const result = JSON.parse(await readFile(join(root, id + ".response.json"), "utf8"));
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.items[0].body.length, 12001);
  assert.deepEqual(result.items[0].assets, [{}]);
  assert.equal(result.items[0].private_data, undefined);
});
test("Windows release worker rejects malformed or expired requests without invoking GitHub", async (t) => {
  const root = await fixture(t);
  const ids = await Promise.all([
    job(root, { repo: "../else" }),
    job(root, { owner: "https://other" }),
    job(root, { createdAt: 0 }),
  ]);
  await reader.worker(root, () => assert.fail("unexpected command"));
  for (const id of ids)
    assert.deepEqual(JSON.parse(await readFile(join(root, id + ".response.json"), "utf8")), {
      ok: false,
      code: "RELEASES_UNAVAILABLE",
    });
});
test("Windows release requester retries the fixed task after an exiting worker and cleans receipts", async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const result = await reader.request(root, "Owner", "Repo", async (file, args, options) => {
    calls++;
    assert(file.endsWith("schtasks.exe"));
    assert.deepEqual(args, ["/Run", "/TN", "CodexWebGitHubReleases"]);
    assert.equal(options.windowsHide, true);
    if (calls === 1) return {};
    const input = (await readdir(root)).find((f) => f.endsWith(".request.json"));
    await writeFile(
      join(root, input.replace(".request.json", ".response.json")),
      JSON.stringify({ ok: true, items: [] }),
    );
    return {};
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, []);
  assert.deepEqual(await readdir(root), ["config.json"]);
  await assert.rejects(
    reader.request(root, "-bad/owner", "Repo", () => assert.fail("unexpected command")),
    /INVALID_REPOSITORY/,
  );
});
