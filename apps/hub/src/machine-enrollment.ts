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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { quotePowerShell, verifyProjectRoot } from "@codex-web/machines";
import { type DeviceConfig, type HubConfig, HubError, type MachineConfig } from "@codex-web/shared";
import { zipSync } from "fflate";
import {
  type EnrollmentKeys,
  type EnrollmentRow,
  enrollmentReport,
  type MachineEnrollmentStore,
} from "./machine-enrollment-store.js";
import { verifyPrivateVnc } from "./remote-probe.js";
import type { TeamStore } from "./team-store.js";

const execute = promisify(execFile);
const missingTailnet = () =>
  new HubError(
    503,
    "TAILNET_SETUP_REQUIRED",
    "Администратору нужно подключить Hub к Tailscale и указать его приватный адрес в настройке сервера.",
  );
export async function enrollmentKeys(): Promise<EnrollmentKeys> {
  const directory = await mkdtemp(join(tmpdir(), "cw-pair-key-"));
  try {
    const create = async (name: string) => {
      const path = join(directory, name);
      await execute(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", "codex-web-enrollment", "-f", path],
        { timeout: 15000, maxBuffer: 1024, windowsHide: true },
      );
      return {
        private: await readFile(path, "utf8"),
        public: (await readFile(path + ".pub", "utf8")).trim().split(" ").slice(0, 2).join(" "),
      };
    };
    const command = await create("command"),
      terminal = await create("terminal");
    return {
      command: command.private,
      terminal: terminal.private,
      commandPublic: command.public,
      terminalPublic: terminal.public,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function directory(path: string) {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== resolve(ancestor)) throw new Error("ENROLLMENT_STORAGE_UNSAFE");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (
    !lstatSync(path).isDirectory() ||
    lstatSync(path).isSymbolicLink() ||
    (process.getuid && lstatSync(path).uid !== process.getuid())
  )
    throw new Error("ENROLLMENT_STORAGE_UNSAFE");
  chmodSync(path, 0o700);
}
function fixedFile(path: string, content: string) {
  if (existsSync(path)) {
    if (
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink() ||
      readFileSync(path, "utf8") !== content
    )
      throw new Error("ENROLLMENT_FILE_CHANGED");
  } else writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}
export function enrolledTransport(config: HubConfig, row: EnrollmentRow) {
  if (!row.report || !config.team?.enabled) throw new Error("ENROLLMENT_NOT_READY");
  const report = enrollmentReport(JSON.parse(row.report)),
    keys = JSON.parse(row.keys) as EnrollmentKeys;
  // Reconstructed from the private registry after restore; paths never come from the client.
  const root = join(config.team.root, "transports", row.id);
  directory(root);
  fixedFile(join(root, "command"), keys.command);
  fixedFile(join(root, "terminal"), keys.terminal);
  fixedFile(join(root, "known_hosts"), `${report.address} ${report.hostKey}\n`);
  const alias = "pc-" + row.id;
  const quote = (v: string) => '"' + v.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  fixedFile(
    join(root, "ssh_config"),
    [
      `Host ${alias} ${alias}-terminal`,
      `  HostName ${report.address}`,
      `  User ${quote(report.username)}`,
      "  Port 22",
      "  BatchMode yes",
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking yes",
      `  UserKnownHostsFile ${quote(join(root, "known_hosts"))}`,
      "  GlobalKnownHostsFile /dev/null",
      "  PasswordAuthentication no",
      "  KbdInteractiveAuthentication no",
      "  ForwardAgent no",
      "  ClearAllForwardings yes",
      "  ControlMaster no",
      "  ConnectTimeout 8",
      "  ServerAliveInterval 15",
      "  ServerAliveCountMax 3",
      `Host ${alias}`,
      `  IdentityFile ${quote(join(root, "command"))}`,
      `Host ${alias}-terminal`,
      `  IdentityFile ${quote(join(root, "terminal"))}`,
      "",
    ].join("\n"),
  );
  const local = win32.join(report.profile, "AppData", "Local", "CodexWeb");
  const machine: MachineConfig = {
    id: alias,
    name: row.name,
    type: "ssh-windows",
    allowedProjectRoots: report.roots,
    ssh: { target: alias, configFile: join(root, "ssh_config") },
    codex: {
      command: "auto",
      shell: "powershell",
      launcher: win32.join(local, "companion", "CodexWebBridge.exe"),
      ...(report.readiness.desktop
        ? { desktopControl: win32.join(local, "desktop-control", "CodexDesktopControl.ps1") }
        : {}),
    },
  };
  if (report.readiness.remote && report.remote) {
    const secret = "REMOTE_TEAM_" + row.id.replaceAll("-", "_").toUpperCase();
    process.env[secret] = report.remote.password;
    machine.remote = { provider: "vnc", host: report.address, port: 5900, passwordSecret: secret };
  }
  const device: DeviceConfig = {
    id: alias,
    name: row.name,
    platform: "windows",
    shell: "powershell",
    power: true,
    mounts: true,
    ssh: { target: alias + "-terminal", configFile: join(root, "ssh_config") },
  };
  return { machine, device, report };
}
export function enrolledRuntime(config: HubConfig, registry: TeamStore, userId: string) {
  const rows = registry.db
    .prepare(
      "SELECT * FROM team_machine_enrollments WHERE ownerId=? AND state='approved' ORDER BY createdAt,id",
    )
    .all(userId) as unknown as EnrollmentRow[];
  const transports = rows.map((row) => enrolledTransport(config, row));
  return { machines: transports.map((t) => t.machine), devices: transports.map((t) => t.device) };
}
export async function verifyEnrollment(config: HubConfig, row: EnrollmentRow) {
  const hubAddress = config.team?.hubTailnetAddress;
  if (!hubAddress) throw missingTailnet();
  const { machine, report } = enrolledTransport(config, row);
  if (report.address === hubAddress)
    throw new HubError(
      400,
      "MACHINE_ADDRESS_INVALID",
      "Нельзя подключить Hub как личный Windows ПК.",
    );
  if (!report.readiness.companion || !report.readiness.codex || !report.readiness.node)
    throw new HubError(
      409,
      "MACHINE_SETUP_INCOMPLETE",
      "На ПК не завершена установка Codex, Node или Companion.",
    );
  // Authenticated read-only handshake verifies both host key and the intended Windows identity.
  // --probe does not start an App Server or acquire a conversation writer.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$utf8=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=$utf8",
    `$expectedSid=${quotePowerShell(report.sid)}`,
    "if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $expectedSid){throw 'SID_MISMATCH'}",
    `$expectedGuid=${quotePowerShell(report.machineGuid)}`,
    "if((Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid -ne $expectedGuid){throw 'IDENTITY_MISMATCH'}",
    `if($env:USERPROFILE -ne ${quotePowerShell(report.profile)}){throw 'PROFILE_MISMATCH'}`,
    `& ${quotePowerShell(machine.codex.launcher!)} --probe | Out-Null; if($LASTEXITCODE -ne 0){throw 'COMPANION_UNAVAILABLE'}`,
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "[Console]::Write('PAIR_OK:'+$identity)",
  ].join("; ");
  const run = async (target: string, command: string) => {
    const result = await execute(
      "ssh",
      [
        "-F",
        machine.ssh!.configFile!,
        "-T",
        target,
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      { timeout: 20000, maxBuffer: 2048, windowsHide: true },
    );
    return result.stdout.trim();
  };
  try {
    if ((await run(machine.ssh!.target, script)) !== "PAIR_OK:" + report.sid)
      throw new Error("IDENTITY");
    // Verify the separate device key too; do not open an interactive PTY during enrollment.
    if (
      (await run(
        machine.ssh!.target + "-terminal",
        "[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
      )) !== report.sid
    )
      throw new Error("TERMINAL_IDENTITY");
    for (const root of report.roots) await verifyProjectRoot(machine, root);
    if (report.readiness.remote && report.remote)
      await verifyPrivateVnc(report.address, report.remote.password);
  } catch {
    throw new HubError(
      409,
      "MACHINE_VERIFICATION_FAILED",
      "Приватное SSH-подключение, отпечаток, профиль, папки или выбранный Remote не прошли проверку. Проверь мастер на ПК и доступ Tailscale; подключение не активировано.",
    );
  }
}

// These are reviewed helpers, not arbitrary repository files. No credentials/native state in bundle.
export const ENROLLMENT_FILES = [
  "EnrollmentUi.ps1",
  "Enroll-Computer.ps1",
  "Pair-ComputerSsh.ps1",
  "Install-EnrolledRemote.ps1",
  "Install-RemoteDesktop.ps1",
  "Install-Companion.ps1",
  "Copy-CompanionRuntime.ps1",
  "companion/CodexWebBridge.cs",
  "Install-ProjectSetup.ps1",
  "ProjectSetupWorker.cjs",
  "Run-ProjectSetup.ps1",
  "Install-Delivery.ps1",
  "DeliveryWorker.cjs",
  "Run-Delivery.ps1",
  "Install-GitHubReleases.ps1",
  "GitHubReleases.cjs",
  "Run-GitHubReleases.ps1",
  "Install-GuiPreview.ps1",
  "GuiPreviewWorker.cjs",
  "NativePreview.ps1",
  "PreviewWindow.cs",
  "Run-GuiPreview.ps1",
  "Install-DesktopControl.ps1",
  "CodexDesktopControl.ps1",
  "desktop-activity.cjs",
  "DesktopWindow.ps1",
] as const;
export function enrollmentBundle(
  config: HubConfig,
  store: MachineEnrollmentStore,
  actor: string,
  id: string,
  token: string,
) {
  const row = store.owned(actor, id);
  if (store.token(token).id !== id || !["pending", "reported", "approved"].includes(row.state))
    throw new HubError(409, "ENROLLMENT_CLOSED", "Создай новое подключение.");
  const hubAddress = config.team?.hubTailnetAddress;
  if (!hubAddress) throw missingTailnet();
  const source =
    process.env.HUB_ENROLLMENT_ROOT ??
    fileURLToPath(new URL("../../../ops/windows/", import.meta.url));
  const read = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error("ENROLLMENT_BUNDLE_INVALID");
    return readFileSync(path);
  };
  const files = ENROLLMENT_FILES.map((name) => {
    const bytes = read(join(source, name));
    // Windows PowerShell 5 treats UTF-8 without BOM as ANSI, including smart quotes in Cyrillic.
    const content = name.endsWith(".ps1")
      ? Buffer.from("\uFEFF" + bytes.toString("utf8").replace(/^\uFEFF/, ""))
      : bytes;
    return { name, data: content.toString("base64") };
  });
  for (const name of ["setupProbe.js", "deliveryProbe.js"])
    files.push({
      name: name as (typeof ENROLLMENT_FILES)[number],
      data: read(
        process.env.HUB_ENROLLMENT_ROOT
          ? join(source, "probes", name)
          : resolve(source, "../../packages/machines/dist", name),
      ).toString("base64"),
    });
  const keys = JSON.parse(row.keys) as EnrollmentKeys;
  const descriptor = {
    version: 1,
    id,
    token,
    expires: row.expires,
    hubAddress,
    baseUrl: config.hub.publicBaseUrl,
    commandKey: keys.commandPublic,
    terminalKey: keys.terminalPublic,
  };
  const payload = gzipSync(Buffer.from(JSON.stringify({ descriptor, files }))).toString("base64");
  const bootstrap = read(join(source, "Start-Enrollment.ps1")).toString("utf8");
  if (!bootstrap.includes("__ENROLLMENT_PAYLOAD__"))
    throw new Error("ENROLLMENT_BOOTSTRAP_INVALID");
  const script = "\uFEFF" + bootstrap.replace("__ENROLLMENT_PAYLOAD__", payload);
  const zip = Buffer.from(
    zipSync({
      "Connect-CodexWeb.ps1": Buffer.from(script),
      "Connect.cmd": Buffer.from(
        '@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Connect-CodexWeb.ps1"\r\n',
        "utf8",
      ),
      "README.txt": Buffer.from(
        "Распакуйте архив в папку и откройте Connect.cmd. Мастер сам запросит подтверждение Windows.\r\nПакет действует сутки и предназначен только для вашего компьютера. Не пересылайте его.\r\nЕсли настройка прервётся, откройте тот же Connect.cmd ещё раз.\r\n",
        "utf8",
      ),
    }),
  );
  return {
    filename: "CodexWeb-Connect.zip",
    base64: zip.toString("base64"),
    sha256: createHash("sha256").update(zip).digest("hex"),
    expires: row.expires,
  };
}
