import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { captureDoctorEvidence, doctorObstruction } from "../ops/gpt/browser-doctor.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
    let clicked = 0;
    await page.exposeFunction("clicked", () => clicked++);
    await page.setContent(
      '<style>body{background:#222;color:white;font:16px sans-serif}dialog{border:2px solid #789;width:300px;height:180px}article{height:250px}nav{height:80px}</style><nav>Private sidebar conversation title</nav><article data-message-author-role="user">Personal conversation text</article><form><textarea id="prompt-textarea">Unsent secret draft</textarea><button>Send</button></form><dialog open><h2>Unrecognized dialog</h2><p>Private account identifier</p><button onclick="clicked()">Continue</button></dialog>',
    );
    assert.equal(await doctorObstruction(page), "unknown");
    const first = await captureDoctorEvidence(page);
    assert.equal(first.kind, "redacted-layout");
    await page
      .locator("nav")
      .evaluate((el) => (el.textContent = "Different private sidebar title"));
    await page
      .locator("article")
      .evaluate((el) => (el.textContent = "Different private conversation"));
    await page.locator("textarea").fill("Different unsent secret");
    await page.locator("dialog p").evaluate((el) => (el.textContent = "Different private account"));
    const second = await captureDoctorEvidence(page);
    assert.equal(second.kind, "redacted-layout");
    assert.equal(first.base64, second.base64);
    await expect(page.locator("textarea")).toHaveValue("Different unsent secret");
    await expect(page.locator("article")).toBeVisible();
    assert.equal(clicked, 0);
    for (const title of ["Sign in", "Payment required", "Consent", "Privacy and terms"]) {
      await page.locator("h2").evaluate((el, title) => (el.textContent = title), title);
      assert.equal(await doctorObstruction(page), "owner");
      assert.equal((await captureDoctorEvidence(page)).kind, "omitted");
    }
    await page.locator("h2").evaluate((el) => (el.textContent = "Unknown setup"));
    await page
      .locator("dialog")
      .evaluate((el) => el.insertAdjacentHTML("beforeend", '<input value="owner input">'));
    assert.equal(await doctorObstruction(page), "owner");
    assert.equal(clicked, 0);
    console.log(
      engine +
        ": incident screenshot masks messages, drafts, sidebar, account and dialog text; owner dialogs are omitted and no controls clicked",
    );
  } finally {
    await browser.close();
  }
}

// The same private incident component is mounted in both clients' Settings.
const { handoffFixture } = await import("./handoff-fixture.mjs");
const { mkdir } = await import("node:fs/promises");
const { randomUUID } = await import("node:crypto");
await mkdir(".local/qa-doctor", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18894",
    f = await handoffFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "classic-dark",
  });
  const incident = {
    id: randomUUID(),
    projectId: "project",
    fingerprint: "a".repeat(64),
    state: "open",
    delivery: "pending",
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    occurrences: 3,
    diagnostics: {
      code: "GPT_CAPABILITY_MISSING",
      bridgeVersion: "6.3.14",
      protocol: 5,
      revision: "abcdef0",
      capabilities: { composer: true, attachments: false, models: true },
    },
    evidence: { kind: "omitted" },
  };
  f.store.db.prepare("INSERT INTO bridge_doctor_config VALUES(1,?)").run(
    JSON.stringify({
      projectId: "project",
      threadId: null,
      operationId: randomUUID(),
      state: "empty",
      enabled: true,
      revision: 1,
    }),
  );
  f.store.db
    .prepare("INSERT INTO bridge_doctor_incidents VALUES(?,?,?,?,?)")
    .run(
      incident.id,
      incident.fingerprint,
      incident.state,
      incident.lastSeen,
      JSON.stringify(incident),
    );
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18894 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByRole("textbox", { name: "Сообщение Codex" }).fill("Сохранить мой черновик");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator('.settings-browser[open] [data-category="maintenance"]').click();
    const doctor = page.locator(".bridge-doctor-panel");
    await doctor.locator(":scope > summary").click();
    await expect(doctor.getByLabel("Проект Bridge Doctor")).toHaveValue("project");
    assert(
      (await doctor.getByLabel("Автодиагностика GPT").locator("..").boundingBox()).height >= 44,
    );
    await doctor.getByLabel("Автодиагностика GPT").click();
    await expect(doctor.getByLabel("Автодиагностика GPT")).not.toBeChecked();
    await expect(doctor.getByLabel("Автодиагностика GPT")).toBeEnabled();
    assert.equal(
      JSON.parse(f.store.db.prepare("SELECT value FROM bridge_doctor_config").get().value).enabled,
      false,
    );
    await doctor.locator(".doctor-incident > summary").click();
    await expect(doctor.getByText("GPT_CAPABILITY_MISSING", { exact: true })).toBeVisible();
    await doctor.screenshot({
      path: `.local/qa-doctor/${engine}-incident-phone.png`,
      animations: "disabled",
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await doctor.getByRole("button", { name: "Скрыть", exact: true }).click();
    await expect(doctor.locator(".doctor-incident > summary")).toContainText("Скрыт");
    assert.equal(
      JSON.parse(f.store.db.prepare("SELECT value FROM bridge_doctor_incidents").get().value)
        .delivery,
      "skipped",
    );
    await page.getByRole("button", { name: "Закрыть настройки" }).click();
    await expect(page.getByRole("textbox", { name: "Сообщение Codex" })).toHaveValue(
      "Сохранить мой черновик",
    );
    assert.equal(
      f.calls.filter((c) => ["thread/start", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      engine + ": private Doctor settings, disable/dismiss and chat draft preservation passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
