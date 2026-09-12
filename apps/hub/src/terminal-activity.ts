import { randomBytes } from "node:crypto";

export type TerminalWork = "idle" | "busy" | "unknown";
export interface TerminalIdentity {
  pid: number;
  birth: string;
}

/** Shell notifications carry no commands or paths and are removed before xterm/history. */
export class TerminalActivity {
  readonly token = randomBytes(24).toString("hex");
  identity?: TerminalIdentity;
  state: TerminalWork = "unknown";
  revision = 0;
  private tail = "";
  private awaitingPrompt = false;
  private remainingLines = 0;
  private paste = false;
  private started = false;
  private lastInput = 0;
  private backgroundJobs = false;
  private earlyInput = false;

  input(data: string) {
    if (!data) return;
    this.revision++;
    if (!this.identity) this.earlyInput = true;
    this.lastInput = Date.now();
    this.state = "unknown";
    this.awaitingPrompt = true;
    // Bracketed paste is one editable buffer; only AcceptLine submits it.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal bracketed-paste protocol.
    for (const part of data.split(/(\x1b\[200~|\x1b\[201~)/)) {
      if (part === "\x1b[200~") this.paste = true;
      else if (part === "\x1b[201~") this.paste = false;
      else if (!this.paste) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Enter and interrupt are terminal input frames.
        for (const key of part.match(/\r\n|\r|\n|\x03/g) ?? []) {
          if (key === "\x03") this.remainingLines = 1;
          else this.remainingLines++;
        }
      }
    }
  }

  output(data: string): string {
    const prefix = "\x1b]777;codexweb;";
    let text = this.tail + data,
      visible = "";
    this.tail = "";
    while (text) {
      const start = text.indexOf(prefix);
      if (start < 0) {
        let partial = 0;
        for (let n = 1; n < prefix.length && n <= text.length; n++)
          if (text.endsWith(prefix.slice(0, n))) partial = n;
        visible += text.slice(0, text.length - partial);
        this.tail = partial ? text.slice(-partial) : "";
        break;
      }
      visible += text.slice(0, start);
      text = text.slice(start);
      const end = text.indexOf("\x07");
      if (end < 0) {
        if (text.length <= 256) this.tail = text;
        else {
          visible += text;
          this.state = "unknown";
        }
        break;
      }
      const fields = text.slice(prefix.length, end).split(";");
      if (
        fields[0] === this.token &&
        fields.length === 5 &&
        /^\d{1,10}$/.test(fields[2] ?? "") &&
        /^\d{1,22}$/.test(fields[3] ?? "")
      ) {
        const identity = { pid: Number(fields[2]), birth: fields[3]! };
        if (
          identity.pid > 1 &&
          (!this.identity ||
            (this.identity.pid === identity.pid && this.identity.birth === identity.birth))
        ) {
          this.identity = identity;
          if (fields[1] === "busy") {
            this.state = "busy";
            this.started = true;
            this.earlyInput = false;
          } else if (fields[1] === "jobs") {
            this.backgroundJobs = fields[4] !== "0" && fields[4] !== "1";
          } else if (fields[1] === "prompt") {
            // A startup/previous prompt cannot acknowledge arbitrary unsubmitted input.
            const acceptedLine = this.remainingLines > 0;
            if (this.remainingLines > 0) this.remainingLines--;
            // Ordinary PowerShell BackgroundJob runs in a child process checked independently.
            // In-process/remoting jobs require a new prompt confirming their completion.
            this.backgroundJobs = fields[4] !== "0" && fields[4] !== "1";
            const accepted =
              !this.earlyInput && (!this.awaitingPrompt || this.started || acceptedLine);
            if (accepted) {
              this.state = this.remainingLines === 0 ? "idle" : "unknown";
            } else this.state = "unknown";
            this.started = false;
            this.awaitingPrompt = !accepted || this.remainingLines > 0;
          }
        } else this.state = "unknown";
      }
      text = text.slice(end + 1);
    }
    return visible;
  }

  candidate(now = Date.now()) {
    return (
      !!this.identity &&
      this.state === "idle" &&
      !this.paste &&
      !this.backgroundJobs &&
      now - this.lastInput >= 1500
    );
  }
}

export function shellTracking(token: string, platform: string): string {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid terminal identity");
  if (platform === "windows")
    return [
      `$global:CodexWebTerminalToken='${token}'`,
      "$global:CodexWebTerminalBirth=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()",
      "function global:CodexWebTerminalSignal($phase,$jobs){[Console]::Write(([char]27)+']777;codexweb;'+$global:CodexWebTerminalToken+';'+$phase+';'+$PID+';'+$global:CodexWebTerminalBirth+';'+$jobs+([char]7))}",
      "$global:CodexWebOriginalPrompt=(Get-Command prompt).ScriptBlock",
      "function global:CodexWebPendingJobs { @(Get-Job | Where-Object { $_ -isnot [System.Management.Automation.PSEventJob] -and $_.State -notin @('Completed','Failed','Stopped') }) }",
      // ConsoleHost invokes a bare prompt pipeline. A script calling prompt is still work.
      "function global:prompt { if(($MyInvocation.Line -ceq 'prompt') -and [string]::IsNullOrEmpty($MyInvocation.ScriptName) -and @(Get-PSCallStack).Count -eq 2){ $pending=@(CodexWebPendingJobs); $jobs=0; if($pending.Count){$jobs=1;if(@($pending | Where-Object {$_.PSJobTypeName -ne 'BackgroundJob' -or $_.State -ne 'Running'}).Count){$jobs=2}}; CodexWebTerminalSignal 'prompt' $jobs }; & $global:CodexWebOriginalPrompt }",
      "Import-Module PSReadLine -ErrorAction SilentlyContinue",
      "$reader=Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue",
      "if($reader){$global:CodexWebOriginalReadLine=$reader.ScriptBlock; function global:PSConsoleHostReadLine { $line=& $global:CodexWebOriginalReadLine; CodexWebTerminalSignal 'busy' 0; return $line }}",
    ].join("; ");
  return [
    'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    `__cw_token='${token}'`,
    "__cw_birth=$(awk '{print $22}' /proc/$$/stat)",
    '__cw_signal() { printf "\\033]777;codexweb;%s;%s;%s;%s;0\\007" "$__cw_token" "$1" "$$" "$__cw_birth"; }',
    "PS0='$( __cw_signal busy )'${PS0-}",
    // A prompt reports foreground completion; the independent process probe checks jobs.
    "PROMPT_COMMAND+=( '__cw_signal prompt' )",
  ].join("\n");
}
