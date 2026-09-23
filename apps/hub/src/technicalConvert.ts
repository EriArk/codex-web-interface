import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const technicalConverterVersion = "occt-0.0.23-mm-ratio0.002-angle0.5-mesh1";
export const technicalInputLimit = 32 * 1024 * 1024;
export const technicalOutputLimit = 24 * 1024 * 1024;
let running = 0;
/** A disposable parser process: no native account access, no shell or caller arguments. */
export function convertTechnical(
  bytes: Buffer,
  format: "step" | "iges",
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (running >= 2) {
      reject(Error("TECHNICAL_CONVERTER_BUSY"));
      return;
    }
    running++;
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=256",
        fileURLToPath(new URL("./technicalWorker.js", import.meta.url)),
        format,
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
      },
    );
    let total = 0,
      done = false;
    const chunks: Buffer[] = [];
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      running--;
      clearTimeout(timeout);
      clearInterval(memory);
      signal.removeEventListener("abort", abort);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (ok && total) resolve(Buffer.concat(chunks, total));
      else reject(Error("TECHNICAL_CONVERSION_FAILED"));
    };
    const abort = () => finish(false);
    const timeout = setTimeout(abort, 25000);
    // WASM memory is outside V8's heap limit. Bound RSS as well, including transient native growth.
    const memory = setInterval(() => {
      if (process.platform !== "linux" || !child.pid || done) return;
      void readFile(`/proc/${child.pid}/status`, "utf8")
        .then((value) => {
          if (Number(value.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) > 512 * 1024) abort();
        })
        .catch(() => {});
    }, 100);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (value: Buffer) => {
      total += value.length;
      if (total > technicalOutputLimit) finish(false);
      else chunks.push(value);
    });
    child.on("error", abort);
    child.stdin.on("error", abort);
    child.on("close", (code) => finish(code === 0));
    if (signal.aborted || bytes.length > technicalInputLimit) abort();
    else child.stdin.end(bytes);
  });
}
