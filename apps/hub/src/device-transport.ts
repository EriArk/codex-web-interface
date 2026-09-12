import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { quotePowerShell, stopProcess } from "@codex-web/machines";
import {
  type DeviceAction,
  type DeviceConfig,
  type DeviceSnapshot,
  HubError,
} from "@codex-web/shared";
import { shellTracking } from "./terminal-activity.js";

export const sshOptions = (device: DeviceConfig, terminal = false) => [
  "-F",
  device.ssh.configFile,
  terminal ? "-tt" : "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ClearAllForwardings=yes",
  device.ssh.target,
];
const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const utf8Console =
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Text.UTF8Encoding]::new($false)";
const powershell = (device: DeviceConfig, script: string, interactive = false) => [
  device.shell === "pwsh" ? "pwsh.exe" : "powershell.exe",
  "-NoLogo",
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(interactive ? `${utf8Console};${script}` : script, "utf16le").toString("base64"),
];

export function terminalCommand(
  device: DeviceConfig,
  action: DeviceAction,
  activityToken?: string,
): string[] {
  const args = sshOptions(device, true);
  if (action.kind === "shell")
    return device.platform === "windows"
      ? [
          ...args,
          ...powershell(device, activityToken ? shellTracking(activityToken, "windows") : "", true),
          "-NoExit",
        ]
      : activityToken && device.platform === "linux"
        ? [
            ...args,
            "bash",
            "-c",
            shQuote(
              `exec bash --rcfile <(printf %s ${shQuote(Buffer.from(shellTracking(activityToken, "linux")).toString("base64"))} | base64 -d) -i`,
            ),
          ]
        : args;
  if (action.confirmation !== device.name)
    throw new HubError(
      409,
      "DEVICE_CONFIRMATION_REQUIRED",
      "Подтверди действие для выбранного устройства.",
    );
  if (action.kind !== "mount") {
    if (!device.power)
      throw new HubError(
        409,
        "DEVICE_ACTION_UNAVAILABLE",
        "Управление питанием здесь не настроено.",
      );
    if (device.platform === "windows")
      return [
        ...args,
        ...powershell(
          device,
          `& shutdown.exe /${action.kind === "restart" ? "r" : "s"} /t 0; exit $LASTEXITCODE`,
          true,
        ),
      ];
    return [...args, "sudo", "systemctl", action.kind === "restart" ? "reboot" : "poweroff"];
  }
  if (!device.mounts)
    throw new HubError(409, "DEVICE_ACTION_UNAVAILABLE", "Подключение дисков здесь не настроено.");
  if (
    action.protocol === "smb"
      ? !/^(?:\/\/|\\\\)[A-Za-z0-9_.-]+[/\\][^/\\]/u.test(action.source)
      : !/^[A-Za-z0-9_.-]+:\//u.test(action.source)
  )
    throw new HubError(400, "DEVICE_MOUNT_SOURCE", "Проверь адрес сетевого ресурса.");
  if (device.platform === "windows") {
    if (action.protocol !== "smb" || !/^[D-Z]$/i.test(action.name))
      throw new HubError(
        400,
        "DEVICE_MOUNT_DRIVE",
        "Выбери SMB и свободную букву диска от D до Z.",
      );
    const name = quotePowerShell(action.name.toUpperCase()),
      source = quotePowerShell(action.source.replaceAll("/", "\\"));
    const script = [
      "$ErrorActionPreference='Stop'",
      `$name=${name}`,
      `$source=${source}`,
      "if(Get-PSDrive -Name $name -ErrorAction SilentlyContinue){throw 'Drive is already in use'}",
      ...(action.credentials
        ? [
            "$u=Read-Host 'Share user'",
            "$p=Read-Host 'Share password' -AsSecureString",
            "$credential=[PSCredential]::new($u,$p)",
          ]
        : []),
      `New-PSDrive -Name $name -PSProvider FileSystem -Root $source -Persist -Scope Global${action.credentials ? " -Credential $credential" : ""}`,
      "Get-PSDrive -Name $name",
      "Set-Location -LiteralPath ($name + ':\\')",
    ].join("; ");
    return [...args, ...powershell(device, script, true), "-NoExit"];
  }
  const source = shQuote(action.source.replaceAll("\\", "/")),
    name = shQuote(action.name);
  const script = [
    "set -eu",
    `name=${name}`,
    'base="$HOME/mnt"',
    'target="$base/$name"',
    '[ ! -L "$base" ] && [ ! -L "$target" ] || { echo "Mount path is a symbolic link"; exit 1; }',
    'mkdir -p -- "$target"',
    'if mountpoint -q -- "$target" || [ -n "$(ls -A -- "$target")" ]; then echo "Mount folder is in use"; exit 1; fi',
    ...(action.protocol === "smb" && action.credentials
      ? ["printf 'Share user: '; IFS= read -r share_user"]
      : []),
    action.protocol === "nfs"
      ? `sudo mount -t nfs -- ${source} "$target"`
      : `sudo mount -t cifs -o "uid=$(id -u),gid=$(id -g)${action.credentials ? ",username=$share_user" : ""}" -- ${source} "$target"`,
    'df -Pk -- "$target"',
  ].join("; ");
  return [...args, "sh", "-c", shQuote(script)];
}

const linuxProbe = `
printf 'system\\t%s\\t%s\\t%s\\n' "$(hostname)" "$(uname -sr)" "$(uname -m)"
printf 'cpu\\t%s\\t%s\\n' "$(awk -F: '/model name|Hardware/{sub(/^[ \\t]+/,"",$2);print $2;exit}' /proc/cpuinfo)" "$(getconf _NPROCESSORS_ONLN)"
awk '/MemTotal:/{t=$2*1024}/MemAvailable:/{a=$2*1024}END{printf "memory\\t%.0f\\t%.0f\\n",t,a}' /proc/meminfo
awk '{print "uptime\\t"$1}' /proc/uptime
awk '{print "load\\t"$1}' /proc/loadavg
df -Pk 2>/dev/null | awk 'NR>1 {printf "disk\\t%s\\t%.0f\\t%.0f\\t%s\\n",$1,$2*1024,$4*1024,$6}' | head -40
for zone in /sys/class/thermal/thermal_zone*; do
  [ -r "$zone/temp" ] || continue
  printf 'temperature\\t%s\\t%s\\n' "$(cat "$zone/type" 2>/dev/null)" "$(cat "$zone/temp" 2>/dev/null)"
done
`;
const windowsProbe = [
  "$ErrorActionPreference='Stop'",
  "$out=@{disks=@();temperatures=@()}",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1",
  "$out.hostname=$env:COMPUTERNAME;$out.os=$os.Caption;$out.architecture=$os.OSArchitecture;$out.cpu=$cpu.Name;$out.cores=[double]$cpu.NumberOfLogicalProcessors;$out.cpuPercent=[double]$cpu.LoadPercentage",
  "$out.memoryTotal=[double]$os.TotalVisibleMemorySize*1024;$out.memoryAvailable=[double]$os.FreePhysicalMemory*1024;$out.uptimeSeconds=([DateTime]::Now-$os.LastBootUpTime).TotalSeconds",
  "$out.disks=@(Get-CimInstance Win32_LogicalDisk | Where-Object {$_.Size -gt 0} | Select-Object -First 40 | ForEach-Object {@{name=$_.VolumeName;mount=$_.DeviceID;filesystem=$_.FileSystem;total=[double]$_.Size;available=[double]$_.FreeSpace}})",
  "try{$out.temperatures=@(Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 16 | ForEach-Object {@{name=$_.InstanceName;celsius=[double]$_.CurrentTemperature/10-273.15}})}catch{}",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.Write(($out|ConvertTo-Json -Depth 5 -Compress))",
].join("; ");

export function parseDeviceSnapshot(
  platform: DeviceConfig["platform"],
  output: string,
): DeviceSnapshot {
  const snapshot: DeviceSnapshot = {
    checkedAt: Date.now(),
    online: true,
    disks: [],
    temperatures: [],
  };
  const text = (v: unknown) =>
    typeof v === "string"
      ? Array.from(v)
          .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
          .join("")
          .slice(0, 240)
      : undefined;
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  let raw: Record<string, unknown>;
  if (platform === "windows") raw = JSON.parse(output);
  else {
    raw = { disks: [], temperatures: [] };
    for (const line of output.split("\n")) {
      const [kind, a, b, c, d] = line.split("\t");
      if (kind === "system") Object.assign(raw, { hostname: a, os: b, architecture: c });
      if (kind === "cpu") Object.assign(raw, { cpu: a, cores: Number(b) });
      if (kind === "memory")
        Object.assign(raw, { memoryTotal: Number(a), memoryAvailable: Number(b) });
      if (kind === "uptime") raw.uptimeSeconds = Number(a);
      if (kind === "load") raw.load1 = Number(a);
      if (kind === "disk")
        (raw.disks as unknown[]).push({
          name: a,
          total: Number(b),
          available: Number(c),
          mount: d,
        });
      if (kind === "temperature")
        (raw.temperatures as unknown[]).push({ name: a, celsius: Number(b) / 1000 });
    }
  }
  for (const key of ["hostname", "os", "architecture", "cpu"] as const)
    snapshot[key] = text(raw[key]);
  for (const key of [
    "cores",
    "cpuPercent",
    "load1",
    "uptimeSeconds",
    "memoryTotal",
    "memoryAvailable",
  ] as const)
    snapshot[key] = number(raw[key]);
  if (snapshot.cpuPercent !== undefined) snapshot.cpuPercent = Math.min(100, snapshot.cpuPercent);
  if (!snapshot.hostname && !snapshot.os) throw new Error("Incomplete device snapshot");
  if (Array.isArray(raw.disks))
    for (const disk of raw.disks.slice(0, 40)) {
      if (disk && text(disk.mount) && number(disk.total) && number(disk.available) !== undefined)
        snapshot.disks.push({
          name: text(disk.name) || text(disk.mount)!,
          mount: text(disk.mount)!,
          total: disk.total,
          available: Math.min(disk.available, disk.total),
          filesystem: text(disk.filesystem),
        });
    }
  if (Array.isArray(raw.temperatures))
    for (const sensor of raw.temperatures.slice(0, 16)) {
      if (
        sensor &&
        typeof sensor.celsius === "number" &&
        Number.isFinite(sensor.celsius) &&
        sensor.celsius > -30 &&
        sensor.celsius < 150
      )
        snapshot.temperatures.push({
          name: text(sensor.name) || "Sensor",
          celsius: sensor.celsius,
        });
    }
  return snapshot;
}

export async function probeDevice(device: DeviceConfig): Promise<DeviceSnapshot> {
  const child = spawn(
    "ssh",
    [
      ...sshOptions(device),
      ...(device.platform === "windows" ? powershell(device, windowsProbe) : ["sh", "-s"]),
    ],
    { stdio: "pipe", detached: process.platform !== "win32", windowsHide: true },
  );
  return new Promise((resolve) => {
    let output = "",
      done = false;
    const decoder = new StringDecoder("utf8");
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      try {
        if (ok) {
          resolve(parseDeviceSnapshot(device.platform, output));
          return;
        }
      } catch {}
      resolve({
        checkedAt: Date.now(),
        online: false,
        error: "Не удалось прочитать состояние устройства.",
        disks: [],
        temperatures: [],
      });
    };
    const timer = setTimeout(() => finish(false), 12000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += decoder.write(chunk);
      if (output.length > 64000) finish(false);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(device.platform === "windows" ? undefined : linuxProbe);
  });
}
