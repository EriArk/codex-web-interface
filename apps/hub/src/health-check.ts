import { request } from "node:http";

if (process.env.HUB_ROLE === "engine") {
  const req = request({ socketPath: process.env.HUB_ENGINE_SOCKET, path: "/api/health" }, (res) => {
    res.resume();
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  });
  req.setTimeout(3000, () => req.destroy());
  req.on("error", () => {
    process.exitCode = 1;
  });
  req.end();
} else {
  try {
    process.exitCode = (
      await fetch(process.env.HUB_HEALTH_URL ?? "http://127.0.0.1:8780/api/health", {
        signal: AbortSignal.timeout(3000),
      })
    ).ok
      ? 0
      : 1;
  } catch {
    process.exitCode = 1;
  }
}
