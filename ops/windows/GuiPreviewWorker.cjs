// Fixed private mailbox. Only locally configured actions reach the interactive helper.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const home = path.join(process.env.LOCALAPPDATA || "", "CodexWeb", "gui-preview"), state = path.join(home, "state");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, actionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const fail = code => { throw Error(code); }, norm = p => path.win32.resolve(p).replaceAll("/", "\\").toLowerCase();
function absolute(p) { return typeof p === "string" && /^[a-z]:[\\/]/i.test(p) && !/[\x00-\x1f]/.test(p) && p.length < 2048 && !p.slice(2).includes(":"); }
function localPath(p, directory) {
  if (!absolute(p)) fail("PREVIEW_CONFIG");
  let cursor = path.resolve(p);
  while (true) { if (fs.lstatSync(cursor).isSymbolicLink()) fail("PREVIEW_CONFIG"); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  const s = fs.statSync(p); if (directory ? !s.isDirectory() : !s.isFile()) fail("PREVIEW_CONFIG");
  return p;
}
function validateAction(a) {
  if (!a || !actionId.test(a.id) || typeof a.label !== "string" || !a.label.trim() || a.label.length > 80 || !["window", "desktop-crop"].includes(a.capture ?? "window") || a.reuse === true) fail("PREVIEW_CONFIG");
  if (!Array.isArray(a.args ?? []) || (a.args ?? []).length > 32 || (a.args ?? []).some(v => typeof v !== "string" || v.length > 2048 || /[\x00\r\n]/.test(v))) fail("PREVIEW_CONFIG");
  const startup = a.startupTimeoutSeconds ?? 20, minutes = a.keepAliveMinutes ?? 30;
  if (!Number.isInteger(startup) || startup < 3 || startup > 60 || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) fail("PREVIEW_CONFIG");
  if (!absolute(a.projectRoot) || !absolute(a.executable) || !/\.exe$/i.test(a.executable) || !absolute(a.workingDirectory)) fail("PREVIEW_CONFIG");
  return { id: a.id, label: a.label.trim(), projectRoot: a.projectRoot, executable: a.executable, args: a.args ?? [], workingDirectory: a.workingDirectory, capture: a.capture ?? "window", startupTimeoutSeconds: startup, keepAliveMinutes: minutes };
}
function actions(root) {
  if (!absolute(root)) fail("PREVIEW_PROJECT");
  const file = path.join(home, "actions.json");
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > 262144) fail("PREVIEW_CONFIG");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows) || rows.length > 100) fail("PREVIEW_CONFIG");
  const result = rows.map(validateAction).filter(a => norm(a.projectRoot) === norm(root));
  if (new Set(result.map(a => a.id)).size !== result.length) fail("PREVIEW_CONFIG");
  return result;
}
function file(id, suffix) { if (!uuid.test(id)) fail("PREVIEW_INPUT"); return path.join(state, id + suffix); }
function read(id, suffix) { try { return JSON.parse(fs.readFileSync(file(id, suffix), "utf8")); } catch(e) { if (e.code === "ENOENT") return null; throw e; } }
function publish(id, suffix, value) {
  const temp = file(id, "." + crypto.randomUUID() + ".tmp");
  const fd = fs.openSync(temp, "wx", 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temp, file(id, suffix)); return true; } catch(e) { if (e.code !== "EEXIST") throw e; return false; } finally { fs.unlinkSync(temp); }
}
function receipt(record) {
  const progress = read(record.id, ".progress.json"), claimed = read(record.id, ".claim.json");
  let status = progress?.state ?? (claimed ? "launching" : "queued"), code = progress?.code;
  let appOpen = Boolean(progress?.appOpen);
  if (Date.now() > record.expiresAt + 10000) { appOpen = false; if (!["captured", "failed"].includes(status)) { status = "unknown"; code = "PREVIEW_EXPIRED"; } }
  return { id: record.id, actionId: record.action.id, state: status, appOpen, expiresAt: record.expiresAt, capture: record.action.capture, ...(code ? { code } : {}) };
}
function load(id, root) { const v = read(id, ".request.json"); if (!v || norm(v.root) !== norm(root)) fail("PREVIEW_MISSING"); return v; }
async function requestImpl(input) {
  if (!input || Object.keys(input).some(k => !["root", "request"].includes(k)) || !absolute(input.root)) fail("PREVIEW_INPUT");
  const q = input.request;
  if (!q || !["catalog", "start", "status", "image", "ack", "stop"].includes(q.op) || Object.keys(q).some(k => !["op", "id", "actionId"].includes(k))) fail("PREVIEW_INPUT");
  if (q.op === "catalog") return { installed: true, actions: actions(input.root).map(({ id, label, capture }) => ({ id, label, capture })) };
  if (!uuid.test(q.id)) fail("PREVIEW_INPUT");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (q.op === "start") {
    if (!actionId.test(q.actionId)) fail("PREVIEW_INPUT");
    const previous = read(q.id, ".request.json");
    if (previous) { if (norm(previous.root) !== norm(input.root) || previous.action.id !== q.actionId) fail("PREVIEW_KEY_REUSED"); return receipt(previous); }
    const action = actions(input.root).find(a => a.id === q.actionId); if (!action) fail("PREVIEW_ACTION");
    localPath(action.projectRoot, true); localPath(action.workingDirectory, true); localPath(action.executable, false);
    const records = fs.readdirSync(state).filter(n => uuid.test(n.slice(0, -13)) && n.endsWith(".request.json"));
    if (records.length >= 1000) fail("PREVIEW_CAPACITY");
    const pending = records.map(n => read(n.slice(0, -13), ".request.json")).filter(v => v && v.expiresAt > Date.now() && !["failed"].includes(receipt(v).state) && (receipt(v).appOpen || ["queued", "launching", "waiting"].includes(receipt(v).state)));
    if (pending.length >= 2 || pending.some(v => norm(v.root) === norm(input.root) && v.action.id === action.id)) fail("PREVIEW_BUSY");
    const record = { id: q.id, root: input.root, action, createdAt: Date.now(), expiresAt: Date.now() + action.keepAliveMinutes * 60000 };
    if (!publish(q.id, ".request.json", record)) return requestImpl(input);
    // A failed task start is uncertain, never issue another launch for this receipt.
    try { cp.execFileSync(path.join(process.env.WINDIR, "System32", "schtasks.exe"), ["/Run", "/TN", "CodexWebGuiPreview"], { timeout: 8000, windowsHide: true, stdio: "ignore" }); } catch { publish(q.id, ".progress.json", { state: "unknown", appOpen: false, code: "PREVIEW_UNAVAILABLE" }); }
    return receipt(record);
  }
  const record = load(q.id, input.root);
  if (q.op === "stop") publish(q.id, ".stop.json", { stop: true });
  if (q.op === "image") {
    if (receipt(record).state !== "captured") fail("PREVIEW_NOT_READY");
    const image = file(q.id, ".png"), s = fs.lstatSync(image); if (s.isSymbolicLink() || !s.isFile() || s.size > 8388608) fail("PREVIEW_CAPTURE");
    return { png: fs.readFileSync(image).toString("base64") };
  }
  if (q.op === "ack") { const p = file(q.id, ".png"); if (fs.existsSync(p)) fs.unlinkSync(p); }
  return receipt(record);
}
async function request(input) {
  if(input?.request?.op!=="start")return requestImpl(input);
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  const lock=path.join(state,"start.lock");let fd;
  try { fd=fs.openSync(lock,"wx",0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:Date.now()})); }
  catch(e){if(e.code!=="EEXIST")throw e;try{const owner=JSON.parse(fs.readFileSync(lock,"utf8"));try{process.kill(owner.pid,0);}catch(dead){if(dead.code==="ESRCH" && Date.now()-owner.at>15000){fs.unlinkSync(lock);return request(input);}}}catch{}fail("PREVIEW_BUSY");}
  try{return await requestImpl(input);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function work() {
  fs.mkdirSync(state, { recursive: true }); const children = new Set(); let last = Date.now();
  const workerStart = Date.now();
  while (Date.now() - last < 30000 && Date.now() - workerStart < 125 * 60000) {
    const records = fs.readdirSync(state).filter(n => n.endsWith(".request.json") && uuid.test(n.slice(0, -13))).slice(0, 1000);
    for (const name of records) {
      const record = read(name.slice(0, -13), ".request.json");
      if (!record || read(record.id, ".claim.json") || read(record.id, ".progress.json") || record.expiresAt < Date.now()) continue;
      if (children.size >= 2) break;
      if (!publish(record.id, ".claim.json", { pid: process.pid, at: Date.now() })) continue;
      if (read(record.id, ".stop.json")) { publish(record.id, ".progress.json", { state: "failed", appOpen: false, code: "PREVIEW_STOPPED" }); continue; }
      const child = cp.spawn(path.join(process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", path.join(home, "NativePreview.ps1"), "-OperationId", record.id, "-WorkerPid", String(process.pid)], { windowsHide: true, stdio: "ignore" });
      children.add(child); child.on("error", () => {}); child.on("close", () => children.delete(child));
    }
    if (children.size) last = Date.now();
    await new Promise(r => setTimeout(r, 400));
  }
  // Each helper observes this exact worker process lifetime and closes its own Job Object.
}
module.exports = { validateAction, absolute, request };
if (require.main === module) {
  if (process.argv[2] === "work") work().catch(() => process.exitCode = 1);
  else if (process.argv[2] === "request") {
    let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", b => { input += b; if (input.length > 16384) process.exit(2); });
    process.stdin.on("end", async () => { try { process.stdout.write(JSON.stringify({ ok: true, value: await request(JSON.parse(input)) })); } catch(e) { process.stdout.write(JSON.stringify({ ok: false, code: /^PREVIEW_[A-Z_]+$/.test(e.message) ? e.message : "PREVIEW_UNAVAILABLE" })); } });
  } else process.exitCode = 2;
}
