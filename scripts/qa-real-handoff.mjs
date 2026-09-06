
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../apps/hub/dist/store.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
process.umask(0o077);
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
config.hub = { ...config.hub, databasePath: ":memory:", resultsPath: "/tmp/codex-handoff-qa" };
const stores = [new Store(":memory:"), new Store(":memory:")];
const source = new Sessions(config, stores[0]), web = new Sessions(config, stores[1]);
const marker = "HANDOFF-" + randomBytes(6).toString("hex");
let original, adopted;
async function turn(manager, id, prompt, settings) {
  let timer, listener;
  const finished = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Native handoff turn timeout")), 120000);
    listener = event => {
      if (event.threadId === id && event.type === "turn.completed") resolve(event);
    };
    manager.on("event", listener);
  });
  // Observe rejection even if startTurn fails before we begin awaiting completion.
  void finished.catch(() => {});
  try {
    await manager.startTurn(id, prompt, settings);
    assert.equal((await finished).payload.status, "completed");
  } finally {
    clearTimeout(timer);
    manager.off("event", listener);
  }
}
try {
  original = await source.create(config.projects[0].id, "CodexWeb same-thread handoff verification");
  const caps = await source.capabilities(original.projectId);
  const settings = { ...caps.defaults, mode: "default" };
  if (caps.models.find(m => m.id === settings.model)?.efforts.includes("low")) settings.effort = "low";
  await turn(source, original.id, "Isolated integration test. Do not use tools, inspect files or do work. Remember " + marker + " and reply with that word only.", settings);
  console.log("Source test writer completed its first turn.");
  adopted = stores[1].createThread(original.projectId, original.codexThreadId, original.title);
  stores[1].db.prepare("UPDATE threads SET origin='desktop',historyMode='paginated',workingDirectory=? WHERE id=?").run(config.projects[0].workingDirectory, adopted.id);
  await assert.rejects(web.resume(adopted.id), { code: "THREAD_IN_USE" });
  await source.close(); // Only this test's own App Server. Never stop the owner's desktop.
  for (let attempt = 0; ; attempt++) {
    try { await web.resume(adopted.id); break; }
    catch (error) {
      if (error.code !== "THREAD_IN_USE" || attempt >= 14) throw error;
      await delay(500);
    }
  }
  console.log("The same native ID resumed after the test writer exited.");
  for (let count = 1; count <= 2; count++) {
    await turn(web, adopted.id, "Do not use tools. What HANDOFF word did I ask you to remember earlier? Reply with that word only.", settings);
    const latest = stores[1].history(adopted.id).messages.findLast(m => m.role === "assistant");
    assert(latest?.text.includes(marker), "Original context must survive the writer handoff");
    assert.equal(stores[1].thread(adopted.id).codexThreadId, original.codexThreadId);
    console.log("Web continuation " + count + " retained the original ID and remembered context.");
  }
  const report = { nativeWindowsCodex: true, idleWriterConflictConfirmed: true, sameIdResumedAfterWriterExit: true, originalContextPreserved: true, twoSequentialWebTurns: true, noFork: true, ownerDesktopUntouched: true };
  await mkdir(".local/qa-handoff", { recursive: true });
  await writeFile(".local/qa-handoff/native.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await source.close();
  if (adopted) {
    if (stores[1].thread(adopted.id).activeTurnId) await web.interrupt(adopted.id).catch(() => {});
    await (await web.runtime(adopted.projectId)).rpc.request("thread/archive", { threadId: adopted.codexThreadId }).catch(() => {});
  }
  await web.close();
  for (const store of stores) store.close();
}
