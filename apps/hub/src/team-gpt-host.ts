import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { HubConfig } from "@codex-web/shared";
import { hostLock } from "./host-lock.js";
import { teamGptName, teamGptRowSchema } from "./team-gpt.js";

const exec = promisify(execFile);
type Docker = (args: string[]) => Promise<string>;
export const teamGuacdImage =
  "guacamole/guacd:1.6.0@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f";
const docker: Docker = async (args) =>
  (await exec("docker", args, { timeout: 30000, maxBuffer: 512 * 1024, windowsHide: true })).stdout;
function directory(path: string) {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== resolve(ancestor)) throw Error("GPT_PROFILE_PATH_UNSAFE");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("GPT_PROFILE_PATH_UNSAFE");
  chmodSync(path, 0o700);
}
function keyFile(path: string, value: string) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 128 ||
      readFileSync(path, "utf8") !== value
    )
      throw Error("GPT_PROFILE_KEY_CHANGED");
  } else writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Host-only reconciler. The engine/browser receives no Docker socket or caller command API. */
export async function reconcileGptProfiles(
  config: HubConfig,
  db: DatabaseSync,
  options: {
    image: string;
    run?: Docker;
    health?: (endpoint: string, token: string) => Promise<boolean>;
  },
) {
  if (!config.team?.enabled || !config.team.gptProfiles?.enabled) return { prepared: 0, failed: 0 };
  const lock = await hostLock(join(config.team.root, "gpt-host.lock"));
  try {
    return await reconcileLocked(config, db, options);
  } finally {
    await lock.close();
  }
}
async function reconcileLocked(
  config: HubConfig,
  db: DatabaseSync,
  options: {
    image: string;
    run?: Docker;
    health?: (endpoint: string, token: string) => Promise<boolean>;
  },
) {
  if (!config.team?.enabled || !config.team.gptProfiles?.enabled) return { prepared: 0, failed: 0 };
  if (!/^codex-web-gpt:(?:[a-f0-9]{7,64}|local)$/.test(options.image))
    throw Error("GPT_HOST_CONFIGURATION_INVALID");
  if (
    db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()?.value === "blocked"
  )
    throw Error("RESTORE_ADMISSION_REQUIRED");
  const run = options.run ?? docker;
  const inspect = async (
    kind: "container" | "network",
    name: string,
  ): Promise<Record<string, any> | undefined> => {
    // Enumerate by exact name first. A daemon/permission failure is not evidence of absence.
    const names = await run(
      kind === "container"
        ? ["container", "ls", "-a", "--format", "{{.Names}}"]
        : ["network", "ls", "--format", "{{.Name}}"],
    );
    if (!names.trim().split(/\r?\n/).includes(name)) return undefined;
    const result = JSON.parse(await run([kind, "inspect", name]));
    if (!Array.isArray(result) || result.length !== 1) throw Error("GPT_DOCKER_INSPECTION_INVALID");
    return result[0];
  };
  const installation = createHash("sha256")
    .update(resolve(config.team.root))
    .digest("hex")
    .slice(0, 16);
  const rows = db
    .prepare(
      "SELECT p.* FROM team_gpt_profiles p JOIN team_users u ON p.userId=u.id WHERE p.state='requested' AND u.state='active' ORDER BY p.createdAt",
    )
    .all();
  let prepared = 0,
    failed = 0;
  for (const input of rows) {
    const row = teamGptRowSchema.parse(input),
      name = teamGptName(row.userId),
      network = name;
    try {
      const root = join(config.team.root, "users", row.userId, "gpt");
      directory(root);
      keyFile(join(root, "service-token"), row.serviceToken);
      keyFile(join(root, "bridge-token"), row.bridgeToken);
      keyFile(join(root, "vnc-password"), row.vncPassword);
      const labels = {
        "io.codex-web.workspace": row.userId,
        "io.codex-web.installation": installation,
      };
      const sameLabels = (value: Record<string, unknown> | undefined) =>
        Object.entries(labels).every(([k, v]) => value?.[k] === v);
      const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
      const outside = name + "-out",
        edge = name + "-edge",
        remote = name + "-remote";
      for (const [id, internal] of [
        [network, true],
        [outside, false],
      ] as const) {
        const current = await inspect("network", id);
        if (
          current &&
          (!sameLabels(current.Labels) ||
            current.Driver !== "bridge" ||
            current.Internal !== internal ||
            (internal &&
              current.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated"))
        )
          throw Error("GPT_NETWORK_IDENTITY_CHANGED");
        if (!current)
          await run([
            "network",
            "create",
            "--driver",
            "bridge",
            ...labelArgs,
            ...(internal
              ? ["--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated"]
              : []),
            id,
          ]);
      }
      const port = String(config.team.gptProfiles.portBase + row.slot),
        remotePort = String(config.team.gptProfiles.portBase + 100 + row.slot);
      const stillAllowed = () =>
        db
          .prepare(
            "SELECT 1 FROM team_gpt_profiles p JOIN team_users u ON p.userId=u.id WHERE p.userId=? AND p.revision=? AND p.state='requested' AND u.state='active'",
          )
          .get(row.userId, row.revision);
      const start = async (
        id: string,
        image: string,
        networks: string[],
        extra: string[],
        bindings: Record<string, string>,
        command?: string[],
      ) => {
        const existing = await inspect("container", id);
        if (existing) {
          const mounts = existing.Mounts ?? [],
            ports = existing.HostConfig?.PortBindings ?? {};
          const env = new Set(existing.Config?.Env ?? []);
          if (
            !sameLabels(existing.Config?.Labels) ||
            existing.Config?.Image !== image ||
            existing.HostConfig?.Privileged ||
            existing.HostConfig?.NetworkMode === "host" ||
            existing.HostConfig?.CapAdd?.length ||
            !existing.HostConfig?.CapDrop?.includes("ALL") ||
            !existing.HostConfig?.SecurityOpt?.includes("no-new-privileges:true") ||
            existing.Config?.User !== (id === remote ? "1000" : "1000:1000") ||
            (id !== remote && !env.has(`GPT_WORKSPACE_ID=${row.userId}`)) ||
            (id === edge && JSON.stringify(existing.Config?.Cmd) !== JSON.stringify(command)) ||
            (id === name
              ? mounts.length !== 1 ||
                mounts[0]?.Source !== root ||
                mounts[0]?.Destination !== "/data" ||
                mounts[0]?.Type !== "bind"
              : mounts.length !== 0) ||
            Object.keys(ports).length !== Object.keys(bindings).length ||
            Object.entries(bindings).some(
              ([p, host]) =>
                ports[p]?.length !== 1 ||
                ports[p][0]?.HostIp !== "127.0.0.1" ||
                ports[p][0]?.HostPort !== host,
            ) ||
            Object.keys(existing.NetworkSettings?.Networks ?? {}).some((n) => !networks.includes(n))
          )
            throw Error("GPT_CONTAINER_IDENTITY_CHANGED");
        } else {
          await run([
            "create",
            "--name",
            id,
            "--init",
            "--restart",
            "unless-stopped",
            "--user",
            id === remote ? "1000" : "1000:1000",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--stop-timeout",
            "30",
            "--network",
            networks[0]!,
            ...labelArgs,
            ...extra,
            image,
            ...(command ?? []),
          ]);
        }
        for (const n of networks.slice(1))
          if (!existing?.NetworkSettings?.Networks?.[n]) await run(["network", "connect", n, id]);
        if (
          !stillAllowed() ||
          db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()?.value ===
            "blocked"
        )
          throw Error("GPT_REQUEST_REVOKED");
        if (!existing?.State?.Running) await run(["start", id]);
      };
      // The browser and its own guacd have neither a route nor a gateway to the
      // host/LAN/other users. Only this mount-free edge can reach public Internet.
      await start(
        edge,
        options.image,
        [outside, network],
        [
          "--memory",
          "128m",
          "--cpus",
          "0.5",
          "--read-only",
          "--env",
          `GPT_WORKSPACE_ID=${row.userId}`,
          "--publish",
          `127.0.0.1:${port}:8786`,
          "--publish",
          `127.0.0.1:${remotePort}:4822`,
        ],
        { "8786/tcp": port, "4822/tcp": remotePort },
        ["node", "/opt/gpt/public-egress.mjs"],
      );
      await start(remote, teamGuacdImage, [network], ["--memory", "128m", "--cpus", "0.5"], {});
      await start(
        name,
        options.image,
        [network],
        [
          "--memory",
          "2g",
          "--memory-swap",
          "3g",
          "--cpus",
          "1",
          "--shm-size",
          "256m",
          "--env",
          `GPT_WORKSPACE_ID=${row.userId}`,
          "--mount",
          `type=bind,source=${root},target=/data`,
        ],
        {},
      );
      if (
        !stillAllowed() ||
        db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()?.value ===
          "blocked"
      )
        throw Error("GPT_REQUEST_REVOKED");
      db.prepare(
        "UPDATE team_gpt_profiles SET code='GPT_BROWSER_STARTING',updatedAt=? WHERE userId=? AND revision=? AND state='requested' AND code IS NULL",
      ).run(Date.now(), row.userId, row.revision);
      const endpoint = `http://127.0.0.1:${port}/service-health`;
      const healthy = options.health
        ? await options.health(endpoint, row.serviceToken)
        : await fetch(endpoint, {
            headers: { Authorization: `Bearer ${row.serviceToken}` },
            signal: AbortSignal.timeout(5000),
          })
            .then(async (r) => {
              await r.body?.cancel();
              return r.ok;
            })
            .catch(() => false);
      if (!healthy) {
        if (row.code === "GPT_BROWSER_STARTING" && Date.now() - row.updatedAt > 300000)
          throw Error("GPT_BROWSER_START_TIMEOUT");
        continue; // Browser startup is asynchronous; the next host pass checks the same instance.
      }
      if (stillAllowed()) {
        db.prepare(
          "UPDATE team_gpt_profiles SET state='ready',code=NULL,updatedAt=? WHERE userId=? AND revision=?",
        ).run(Date.now(), row.userId, row.revision);
        prepared++;
      }
    } catch (error) {
      const code =
        error instanceof Error && /^GPT_[A-Z_]+$/.test(error.message)
          ? error.message
          : "GPT_PROVISIONING_FAILED";
      db.prepare(
        "UPDATE team_gpt_profiles SET state='failed',code=?,updatedAt=? WHERE userId=? AND revision=? AND state='requested'",
      ).run(code, Date.now(), row.userId, row.revision);
      failed++;
    }
  }
  return { prepared, failed };
}
