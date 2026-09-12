import { spawn } from "node:child_process";
import { stopProcess } from "@codex-web/machines";
import type { DeviceConfig } from "@codex-web/shared";
import { sshOptions } from "./device-transport.js";
import type { TerminalIdentity, TerminalWork } from "./terminal-activity.js";

/** A prompt alone does not exclude background jobs or a nested terminal program. */
export function terminalProbeScript(platform: string, identity: TerminalIdentity): string {
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 2 || !/^\d{1,22}$/.test(identity.birth))
    throw new Error("Invalid terminal process identity");
  if (platform === "windows")
    return [
      "$ErrorActionPreference='Stop'",
      `$root=Get-Process -Id ${identity.pid} -ErrorAction Stop`,
      `if($root.StartTime.ToUniversalTime().Ticks.ToString() -ne '${identity.birth}'){throw 'Identity changed'}`,
      "if($root.ProcessName -notin @('powershell','pwsh')){throw 'Unknown shell'}",
      "$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)",
      `$pending=@(${identity.pid});$seen=@{};$work=0`,
      "while($pending.Count){$next=@();foreach($parent in $pending){if($seen.ContainsKey($parent)){continue};$seen[$parent]=$true;foreach($child in $all){if($child.ParentProcessId -eq $parent -and $child.ProcessId -ne $parent){$next+=[int]$child.ProcessId;if($child.Name -ne 'conhost.exe'){$work++}}}};$pending=$next}",
      "if($work){[Console]::Write('busy')}else{[Console]::Write('idle')}",
    ].join("; ");
  if (platform !== "linux") throw new Error("Unsupported terminal probe");
  // Read numeric fields only, never process command lines/environment or terminal output.
  return `python3 - <<'CW_PROBE'\nimport os\nroot=${identity.pid}\nexpected='${identity.birth}'\nrows={}\nfor name in os.listdir('/proc'):\n if not name.isdigit(): continue\n try:\n  raw=open('/proc/'+name+'/stat').read(); p=raw.rindex(')'); rows[int(name)]=(raw[raw.index('(')+1:p],raw[p+2:].split())\n except FileNotFoundError: pass\n except ProcessLookupError: pass\nshell,stat=rows[root]\nif shell!='bash' or stat[19]!=expected or int(stat[5])!=int(stat[2]): raise RuntimeError('Shell identity or foreground changed')\nseen={root};pending=[root];work=False\nwhile pending:\n parent=pending.pop()\n for pid,(name,fields) in rows.items():\n  if int(fields[1])==parent and pid not in seen:\n   seen.add(pid);pending.append(pid)\n   if fields[0]!='Z': work=True\nprint('busy' if work else 'idle',end='')\nCW_PROBE`;
}

export function probeTerminal(
  device: DeviceConfig,
  identity: TerminalIdentity,
): Promise<TerminalWork> {
  let script: string;
  try {
    script = terminalProbeScript(device.platform, identity);
  } catch {
    return Promise.resolve("unknown");
  }
  const argv =
    device.platform === "windows"
      ? [
          device.shell === "pwsh" ? "pwsh.exe" : "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ]
      : ["sh", "-s"];
  const child = spawn("ssh", [...sshOptions(device), ...argv], {
    stdio: "pipe",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  return new Promise((resolve) => {
    let text = "",
      done = false;
    const finish = (state: TerminalWork) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      resolve(state);
    };
    const timer = setTimeout(() => finish("unknown"), 10000);
    child.stdout.on("data", (data) => {
      text += data;
      if (text.length > 1024) finish("unknown");
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish("unknown"));
    child.on("close", (code) =>
      finish(
        code === 0 && /^(idle|busy)$/.test(text.trim()) ? (text.trim() as TerminalWork) : "unknown",
      ),
    );
    child.stdin.on("error", () => finish("unknown"));
    child.stdin.end(device.platform === "windows" ? undefined : script);
  });
}
