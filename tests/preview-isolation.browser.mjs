import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, expect, webkit } from "@playwright/test";
import { assertPreviewFrame, previewCsp, previewFrameSources } from "../apps/hub/dist/previews.js";

const received = [],
  forbidden = [];
const external = createServer((req, res) => {
  received.push(req.url);
  res.end("External fixture");
});
external.on("upgrade", (req, socket) => {
  received.push("upgrade:" + req.url);
  socket.destroy();
});
await new Promise((r) => external.listen(0, "127.0.0.1", r));
const outside = "http://127.0.0.1:" + external.address().port;
let origin = "",
  attack = "";
const server = createServer((req, res) => {
  const path = new URL(req.url, origin).pathname;
  if (path === "/") {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; frame-src " +
        previewFrameSources(origin).join(" ") +
        "; object-src 'none'; base-uri 'none'",
    );
    res.setHeader("Set-Cookie", "fixture=private; Path=/; SameSite=Strict");
    return res.end(
      '<!doctype html><meta charset="utf-8"><div id="owner">Unchanged</div><script src="/boot.js"></script>',
    );
  }
  if (path === "/boot.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(
      `localStorage.setItem("fixture","private");const frame=document.createElement("iframe");frame.id="demo";frame.sandbox="allow-scripts";frame.src="/api/previews/probe";document.body.append(frame);`,
    );
  }
  if (path === "/api/previews/redirect") {
    res.writeHead(302, { Location: outside + "/redirect" });
    return res.end();
  }
  if (path === "/api/previews/probe") {
    try {
      assertPreviewFrame(req.headers);
    } catch {
      res.writeHead(403);
      return res.end("Open through Results");
    }
    res.setHeader("Content-Security-Policy", previewCsp);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(
      '<!doctype html><button id="local">Local</button><button id="attack">Probe</button><script>window.report={};document.querySelector("#local").onclick=()=>document.querySelector("#local").textContent="Works";document.querySelector("#attack").onclick=()=>{try{' +
        attack +
        "}catch(e){window.report.error=e.name;}};</script>",
    );
  }
  forbidden.push(path);
  res.end("Forbidden Hub route");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
origin = "http://127.0.0.1:" + server.address().port;
const dest = JSON.stringify(outside + "/probe"),
  same = JSON.stringify(origin + "/forbidden");
const vectors = [
  ["location-href", `location.href=${dest}`],
  ["location-assign", `location.assign(${dest})`],
  ["location-replace", `location.replace(${dest})`],
  ["same-origin-route", `location.href=${same}`],
  ["redirect", `location.href="/api/previews/redirect"`],
  [
    "meta-refresh",
    `const m=document.createElement("meta");m.httpEquiv="refresh";m.content="0;url="+${dest};document.head.append(m)`,
  ],
  ...["_self", "_top", "_parent", "_blank"].map((target) => [
    "link-" + target,
    `const a=document.createElement("a");a.href=${dest};a.target="${target}";document.body.append(a);a.click()`,
  ]),
  [
    "download",
    `const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["demo"]));a.download="test.txt";a.click()`,
  ],
  ["popup", `window.open(${dest})`],
  [
    "form",
    `const f=document.createElement("form");f.action=${dest};f.method="POST";document.body.append(f);f.submit()`,
  ],
  [
    "nested-frame",
    `const f=document.createElement("iframe");f.src=${dest};document.body.append(f)`,
  ],
  [
    "resources",
    `const img=new Image();img.src=${dest};document.body.append(img);const style=document.createElement("style");style.textContent="@import url("+${dest}+");@font-face{font-family:probe;src:url("+${dest}+")}body{font-family:probe;background:url("+${dest}+")}";document.head.append(style);const v=document.createElement("video");v.src=${dest};v.autoplay=true;document.body.append(v)`,
  ],
  ["fetch", `fetch(${dest}).catch(()=>{})`],
  ["xhr", `const x=new XMLHttpRequest();x.open("GET",${dest});x.send()`],
  ["beacon", `navigator.sendBeacon(${dest},"test")`],
  ["websocket", `new WebSocket(${dest}.replace("http:","ws:"))`],
  ["eventsource", `new EventSource(${dest})`],
  [
    "nested-srcdoc",
    `const f=document.createElement("iframe");f.srcdoc="<img src="+${dest}+">";document.body.append(f)`,
  ],
  ["object", `const o=document.createElement("object");o.data=${dest};document.body.append(o)`],
  [
    "credentials-parent",
    `for(const [key,fn] of Object.entries({cookie:()=>document.cookie,storage:()=>localStorage.getItem("fixture"),parent:()=>parent.document.querySelector("#owner").textContent="Changed",serviceWorker:()=>navigator.serviceWorker.controller})){try{fn();report[key]="allowed"}catch{report[key]="blocked"}}parent.postMessage({type:"SKIP_WAITING",text:"probe"},"*")`,
  ],
  ["parent-top-navigation", `top.location.href=${dest}`],
  [
    "data-navigation",
    `location.href="data:text/html,<script>location.href='"+${dest}+"'<"+"/script>"`,
  ],
];
try {
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch(),
      context = await browser.newContext({ acceptDownloads: true });
    let downloads = 0;
    context.on("page", (p) => p.on("download", () => downloads++));
    const page = await context.newPage();
    try {
      for (const [label, code] of vectors) {
        attack = code;
        received.length = 0;
        forbidden.length = 0;
        await page.goto(origin);
        const frame = page.frameLocator("#demo");
        await frame.locator("#local").click();
        await expect(frame.locator("#local")).toHaveText("Works");
        await frame.locator("#attack").click();
        await page.waitForTimeout(250);
        assert.deepEqual(received, [], name + " " + label + " external egress");
        assert.deepEqual(forbidden, [], name + " " + label + " unauthorized Hub navigation");
        assert.equal(page.url(), origin + "/");
        assert.equal(context.pages().length, 1);
        assert.equal(downloads, 0);
        await expect(page.locator("#owner")).toHaveText("Unchanged");
        if (label === "credentials-parent") {
          const report = await page
            .frames()
            .find((f) => f.url().includes("/api/previews/probe"))
            .evaluate(() => window.report);
          assert.deepEqual(report, {
            cookie: "blocked",
            storage: "blocked",
            parent: "blocked",
            serviceWorker: "blocked",
          });
        }
      }
      const direct = await page.goto(origin + "/api/previews/probe");
      assert.equal(direct.status(), 403);
      console.log(
        JSON.stringify({
          browser: name,
          vectors: vectors.length,
          localScripts: true,
          externalRequests: 0,
          unexpectedHubRequests: 0,
          credentialsBlocked: true,
          directDocumentBlocked: true,
        }),
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
  await new Promise((r) => external.close(r));
}
