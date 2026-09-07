import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:8783";
const auth = JSON.parse(await readFile(process.env.QA_CREDENTIALS ?? ".local/update-qa-credentials.json", "utf8"));
const versionPath = "apps/web/dist/version.json", htmlPath = "apps/web/dist/index.html";
const originalVersion = await readFile(versionPath), originalHtml = await readFile(htmlPath, "utf8");
const current = JSON.parse(originalVersion.toString()), next = { ...current, id: "b".repeat(64) };
const reports = [];
await mkdir(".local/qa-pwa-update", { recursive: true });
for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
  console.log("Update PWA: " + engine);
  const browser = await type.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "allow" });
    const setup = (await (await context.request.get(origin + "/api/auth/status")).json()).requiresSetup;
    const login = await context.request.post(origin + (setup ? "/api/auth/setup" : "/api/auth/login"), {
      headers: { Origin: origin }, data: setup ? { password: auth.password, token: auth.setupToken } : { password: auth.password },
    });
    expect(login.ok()).toBeTruthy();
    const page = await context.newPage(), errors = [], navigationAborts = [];
    let navigating = false;
    page.on("pageerror", error => {
      if (navigating && engine === "webkit" && error.message.startsWith("/127.0.0.1:8783/api/") && error.message.endsWith(" due to access control checks.")) navigationAborts.push(error.message);
      else errors.push(error.message);
    });
    await page.clock.install();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".chat-pane").waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    navigating = true;
    await page.reload();
    await page.waitForLoadState("networkidle");
    navigating = false;
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const created = page.waitForResponse(response => response.url().endsWith("/threads") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Создать диалог", exact: true }).click();
    expect((await created).ok()).toBeTruthy();
    await expect(page.locator(".chat-pane .empty-state h2")).toBeVisible();
    const notice = page.locator(".update-notice"), input = page.getByRole("textbox", { name: "Сообщение Codex", exact: true });
    await expect(input).toBeVisible();
    await page.clock.fastForward(61000);
    await expect(notice).toHaveCount(0);
    // Loading an optional stylesheet is not a release change.
    await page.evaluate(style => {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = style; document.head.append(link);
    }, current.styles.find(style => style.includes("GptWorkspace")));
    await page.clock.fastForward(61000);
    await expect(notice).toHaveCount(0);
    await input.fill("Черновик останется после обновления");
    await page.getByLabel("Выбрать файлы или изображения", { exact: true }).setInputFiles({ name: "update-note.txt", mimeType: "text/plain", buffer: Buffer.from("saved upload") });
    await page.getByRole("button", { name: "Удалить update-note.txt", exact: true }).waitFor();
    await writeFile(versionPath, JSON.stringify(next));
    await page.clock.fastForward(61000);
    await expect(notice).toContainText("Есть обновление сайта");
    // A failed version check cannot navigate, discard the draft or pretend success.
    await writeFile(versionPath, "temporary invalid response");
    await notice.getByRole("button", { name: "Обновить", exact: true }).click();
    await expect(notice).toContainText("Обновление не загрузилось");
    await expect(input).toHaveValue("Черновик останется после обновления");
    expect(new URL(page.url()).searchParams.has("_codex_update")).toBeFalsy();
    await writeFile(versionPath, JSON.stringify(next));
    // Serving an old HTML document after an update is explicitly detected on boot.
    navigating = true;
    const staleNavigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame() && frame.url().includes("_codex_update="));
    await notice.getByRole("button", { name: "Обновить", exact: true }).click();
    await staleNavigation;
    await page.waitForLoadState("networkidle");
    navigating = false;
    await expect(notice).toContainText("Обновление не загрузилось");
    await expect(input).toHaveValue("Черновик останется после обновления");
    expect(await page.locator('meta[name="codex-release"]').getAttribute("content")).toBe(current.id);
    await page.getByRole("button", { name: "Удалить update-note.txt", exact: true }).waitFor();
    // The next navigation receives the target release and confirms it, then disappears.
    await writeFile(htmlPath, originalHtml.replace(current.id, next.id));
    navigating = true;
    const updatedNavigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame() && frame.url().includes("_codex_update="));
    await notice.getByRole("button", { name: "Обновить", exact: true }).click();
    await updatedNavigation;
    await page.waitForLoadState("networkidle");
    navigating = false;
    await expect(notice).toContainText("Сайт обновлён");
    expect(await page.locator('meta[name="codex-release"]').getAttribute("content")).toBe(next.id);
    await expect(input).toHaveValue("Черновик останется после обновления");
    await page.getByRole("button", { name: "Удалить update-note.txt", exact: true }).waitFor();
    expect(await page.evaluate(() => sessionStorage.getItem("codex-pending-update"))).toBeNull();
    expect(new URL(page.url()).searchParams.has("_codex_update")).toBeFalsy();
    await page.evaluate(() => { document.documentElement.dataset.theme = "crt-green"; });
    await page.screenshot({ path: ".local/qa-pwa-update/" + engine + "-confirmed.png" });
    await page.clock.fastForward(5000);
    await expect(notice).toHaveCount(0);
    await page.clock.fastForward(61000);
    await expect(notice).toHaveCount(0);
    // Returning to a different viewport does not reintroduce the notice.
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.screenshot({ path: ".local/qa-pwa-update/" + engine + "-tablet.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(errors).toEqual([]);
    reports.push({ engine, serviceWorker: true, currentReleaseNeverPrompts: true, lazyCssDoesNotPrompt: true, failurePreservesDraft: true, staleHtmlDetected: true, targetBootConfirmed: true, noticeDisappears: true, draftAndFileRetained: true, navigationAborts: navigationAborts.length, errors });
  } finally {
    await writeFile(versionPath, originalVersion);
    await writeFile(htmlPath, originalHtml);
    await browser.close();
  }
}
await writeFile(".local/qa-pwa-update/report.json", JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
