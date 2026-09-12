import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ENGINE_PROTOCOL, type EngineInfo, engineInfo } from "./engine-client.js";

export interface WebRelease {
  id: string;
  revision: string;
  protocol: number;
  minSchema: number;
  maxSchema: number;
  files: Record<string, string>;
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const releaseId = (id: string) => /^[a-f0-9]{7,64}$/.test(id);
export function atomicJson(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
export function compatible(release: WebRelease, engine: EngineInfo) {
  if (
    release.protocol !== ENGINE_PROTOCOL ||
    release.protocol !== engine.protocol ||
    !Number.isInteger(release.minSchema) ||
    !Number.isInteger(release.maxSchema) ||
    release.minSchema > release.maxSchema ||
    engine.schema < release.minSchema ||
    engine.schema > release.maxSchema
  )
    throw new Error("WEB_ENGINE_INCOMPATIBLE");
}
export function currentRelease(root: string): WebRelease {
  const pointer = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
  if (!releaseId(pointer.id)) throw new Error("INVALID_RELEASE");
  const manifest = JSON.parse(
    readFileSync(join(root, "releases", pointer.id, "release.json"), "utf8"),
  );
  if (manifest.id !== pointer.id || !manifest.files || typeof manifest.files !== "object")
    throw new Error("INVALID_RELEASE");
  return manifest;
}
export function publicFile(root: string, release: WebRelease, pathname: string) {
  let path = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!path || !path.includes(".")) path = "index.html";
  if (
    path.includes("\\") ||
    path.split("/").some((p) => p === "." || p === "..") ||
    path.includes("\0")
  )
    return null;
  const base = path.startsWith("assets/")
    ? join(root, "retained")
    : join(root, "releases", release.id);
  if (!path.startsWith("assets/") && !Object.hasOwn(release.files, path)) return null;
  const file = join(base, path);
  if (!existsSync(file)) return null;
  const actual = realpathSync(file),
    boundary = realpathSync(base);
  if (!actual.startsWith(boundary + sep) || !lstatSync(file).isFile()) return null;
  return actual;
}

// Staging and publication change only immutable public files and one atomic pointer.
// No Store, native session, migration or container operation is imported here.
export async function publishWeb(options: {
  source: string;
  root: string;
  socketPath: string;
  revision: string;
  postcheck?: (release: WebRelease) => Promise<void>;
}) {
  const { source, root, socketPath, revision } = options;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".publish-lock");
  mkdirSync(lock, { mode: 0o700 });
  let switched = false,
    previous: WebRelease | undefined;
  const startedAt = Date.now();
  const status = (state: string, extra = {}) =>
    atomicJson(join(root, "status.json"), {
      kind: "web",
      revision,
      state,
      startedAt,
      updatedAt: Date.now(),
      ...extra,
    });
  try {
    if (!releaseId(revision)) throw new Error("INVALID_REVISION");
    status("checking");
    const version = JSON.parse(readFileSync(join(source, "version.json"), "utf8"));
    if (!releaseId(version.id)) throw new Error("INVALID_RELEASE");
    const contract = JSON.parse(readFileSync(join(source, "engine-compat.json"), "utf8"));
    const manifest: WebRelease = {
      id: version.id,
      revision,
      protocol: contract.protocol,
      minSchema: contract.minSchema,
      maxSchema: contract.maxSchema,
      files: {},
    };
    const runtime = await engineInfo(socketPath);
    compatible(manifest, runtime);
    const directory = join(root, "releases", manifest.id);
    if (existsSync(join(root, "current.json"))) previous = currentRelease(root);
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        const file = join(path, name),
          info = lstatSync(file);
        if (info.isSymbolicLink()) throw new Error("WEB_SYMLINK_REJECTED");
        if (info.isDirectory()) walk(file);
        else if (info.isFile()) {
          const key = relative(source, file).split(sep).join("/");
          if (key === "release.json" || key.endsWith(".map")) continue;
          manifest.files[key] = digest(file);
          const dest = join(directory, key);
          mkdirSync(resolve(dest, ".."), { recursive: true, mode: 0o700 });
          if (existsSync(dest) && digest(dest) !== manifest.files[key])
            throw new Error("IMMUTABLE_ASSET_CONFLICT");
          if (!existsSync(dest)) copyFileSync(file, dest);
          if (key.startsWith("assets/")) {
            const retained = join(root, "retained", key);
            mkdirSync(resolve(retained, ".."), { recursive: true, mode: 0o700 });
            if (existsSync(retained) && digest(retained) !== manifest.files[key])
              throw new Error("IMMUTABLE_ASSET_CONFLICT");
            if (!existsSync(retained)) copyFileSync(file, retained);
          }
        } else throw new Error("INVALID_WEB_FILE");
      }
    };
    walk(resolve(source));
    if (!manifest.files["index.html"] || !manifest.files["sw.js"])
      throw new Error("INCOMPLETE_WEB_RELEASE");
    atomicJson(join(directory, "release.json"), manifest);
    const latest = await engineInfo(socketPath);
    compatible(manifest, latest);
    if (runtime.instance !== latest.instance) throw new Error("ENGINE_CHANGED_DURING_PUBLICATION");
    atomicJson(join(root, "current.json"), { id: manifest.id });
    switched = true;
    if (options.postcheck) await options.postcheck(manifest);
    status("installed", { installedAt: Date.now(), id: manifest.id });
    return manifest;
  } catch (error) {
    if (switched) {
      if (previous) atomicJson(join(root, "current.json"), { id: previous.id });
      else rmSync(join(root, "current.json"), { force: true });
    }
    status(switched ? "rolled_back" : "failed", {
      code:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "WEB_PUBLICATION_FAILED",
    });
    throw error;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
