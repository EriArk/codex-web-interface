import { lstatSync, unlinkSync } from "node:fs";
import { connect } from "node:net";

// Remove only a stale socket owned by this process's UID. Never unlink a live engine.
export async function prepareEngineSocket(path: string) {
  let file: ReturnType<typeof lstatSync>;
  try {
    file = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!file.isSocket() || file.uid !== process.getuid?.())
    throw new Error("ENGINE_SOCKET_OWNERSHIP");
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("ENGINE_SOCKET_BUSY"));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("ENGINE_ALREADY_RUNNING"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        unlinkSync(path);
        resolve();
      } else if (error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
}
