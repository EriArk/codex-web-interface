import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Uses the same OS advisory lock as the browser entrypoint, with no expiring lease. */
export async function hostLock(path: string) {
  if (
    process.platform !== "linux" ||
    resolve(path) !== path ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw Error("HOST_LOCK_PATH");
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
      throw Error("HOST_LOCK_UNSAFE");
  } finally {
    await file.close();
  }
  const before = await lstat(path);
  const child = spawn(
    "flock",
    [
      "--nonblock",
      "--no-fork",
      path,
      process.execPath,
      "-e",
      "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let exited = false;
  const closed = new Promise<void>((done) => {
    child.once("close", () => {
      exited = true;
      done();
    });
    child.once("error", () => {
      exited = true;
      done();
    });
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(Error("HOST_LOCK_TIMEOUT")), 5000);
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (text === "LOCKED\n") {
          clearTimeout(timer);
          done();
        } else if (text.length > 32) {
          clearTimeout(timer);
          fail(Error("HOST_LOCK_PROTOCOL"));
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        fail(Error("HOST_LOCK_FAILED"));
      });
      child.once("close", () => {
        clearTimeout(timer);
        fail(Error("HOST_LOCK_BUSY"));
      });
    });
    const check = async () => {
      const current = await lstat(path);
      if (
        exited ||
        current.isSymbolicLink() ||
        before.ino !== current.ino ||
        before.dev !== current.dev
      )
        throw Error("HOST_LOCK_LOST");
    };
    await check();
    return {
      check,
      close: async () => {
        child.stdin.end();
        await closed;
      },
    };
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  }
}
