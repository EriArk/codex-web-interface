import { spawn } from "node:child_process";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { quotePowerShell, stopProcess } from "./index.js";

export interface NativeActivity {
  threadId: string;
  turnId: string;
  status: string;
  startedAt: number;
  completedAt: number;
  updatedAt: number;
}
/** A fixed read-only metadata query, never a caller-supplied SQL or filesystem endpoint.
 * App Server 0.153.4 maps another process's inProgress turn to interrupted on read.
 * Read the persisted status without that per-process projection. No prompts/items/auth data.
 */
export const activityReader = `
const {DatabaseSync}=require("node:sqlite"),{join}=require("node:path");
const input=JSON.parse(Buffer.from(process.argv[1],"base64").toString("utf8"));
if(!Array.isArray(input.ids)||input.ids.length>3000||input.ids.some(id=>!/^[-a-zA-Z0-9_]{1,100}$/.test(id)))throw Error("Invalid IDs");
let state,history;
try{
 state=new DatabaseSync(join(input.home,"state_5.sqlite"),{readOnly:true});
 history=new DatabaseSync(join(input.home,"thread_history_1.sqlite"),{readOnly:true});
 state.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
 history.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
 const meta=state.prepare("SELECT updated_at,archived FROM threads WHERE id=?");
 const last=history.prepare("SELECT turn_id,status,started_at,completed_at FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1");
 const rows=[];
 for(const id of input.ids){const m=meta.get(id),t=last.get(id);if(m&&!m.archived&&t)rows.push({threadId:id,turnId:t.turn_id,status:t.status,startedAt:t.started_at||0,completedAt:t.completed_at||0,updatedAt:m.updated_at||0});}
 process.stdout.write(JSON.stringify(rows));
}finally{history?.close();state?.close();}
`;
export async function readNativeActivity(
  machine: MachineConfig,
  home: string,
  ids: string[],
): Promise<NativeActivity[]> {
  authorizeMachine(machine);
  if (!machine.codex.activityNode || !home || ids.length > 3000)
    throw new HubError(503, "ACTIVITY_UNAVAILABLE", "Наблюдение за другими клиентами не настроено");
  const payload = Buffer.from(JSON.stringify({ home, ids })).toString("base64");
  const options = {
    stdio: "pipe" as const,
    detached: process.platform !== "win32",
    windowsHide: true,
  };
  const script =
    "& " +
    quotePowerShell(machine.codex.activityNode) +
    " --no-warnings -e " +
    quotePowerShell(
      "eval(Buffer.from('" +
        Buffer.from(activityReader).toString("base64") +
        "','base64').toString())",
    ) +
    " " +
    quotePowerShell(payload) +
    "; exit $LASTEXITCODE";
  // The script is fixed above. The only dynamic arguments are the server's own home and known IDs.
  const child =
    machine.type === "local-linux"
      ? spawn(machine.codex.activityNode, ["--no-warnings", "-e", activityReader, payload], options)
      : spawn(
          "ssh",
          [
            ...(machine.ssh?.configFile ? ["-F", machine.ssh.configFile] : []),
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=8",
            machine.ssh?.target ?? "",
            machine.codex.shell === "pwsh" ? "pwsh.exe" : "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          options,
        );
  return new Promise((resolve, reject) => {
    let output = "",
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      if (error) {
        reject(error);
        return;
      }
      try {
        const rows = JSON.parse(output) as NativeActivity[];
        if (
          !Array.isArray(rows) ||
          rows.length > ids.length ||
          rows.some(
            (r) =>
              !ids.includes(r.threadId) ||
              typeof r.turnId !== "string" ||
              !["inProgress", "completed", "interrupted", "failed"].includes(r.status) ||
              ![r.startedAt, r.completedAt, r.updatedAt].every(Number.isFinite),
          )
        )
          throw Error();
        resolve(rows);
      } catch {
        reject(new HubError(503, "ACTIVITY_UNSUPPORTED", "Формат состояния Codex изменился"));
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new HubError(503, "ACTIVITY_UNAVAILABLE", "Состояние другого клиента пока недоступно"),
        ),
      12000,
    );
    child.stdout.on("data", (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 1024 * 1024)
        finish(new HubError(503, "ACTIVITY_UNSUPPORTED", "Слишком большой ответ состояния"));
    });
    child.stderr.on("data", () => {});
    child.on("error", () =>
      finish(new HubError(503, "ACTIVITY_UNAVAILABLE", "Наблюдение за Codex недоступно")),
    );
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new HubError(503, "ACTIVITY_UNSUPPORTED", "Проверь совместимость наблюдения за Codex"),
      ),
    );
    child.stdin.end();
  });
}
