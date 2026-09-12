import { request } from "node:http";

export const ENGINE_PROTOCOL = 1;
export interface EngineInfo {
  protocol: number;
  schema: number;
  revision: string;
  instance: string;
}
export function engineInfo(socketPath: string): Promise<EngineInfo> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/internal/runtime", method: "GET" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
        if (text.length > 4096) req.destroy(new Error("ENGINE_RESPONSE_LIMIT"));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const value = JSON.parse(text);
          if (
            res.statusCode !== 200 ||
            !Number.isInteger(value.protocol) ||
            !Number.isInteger(value.schema) ||
            typeof value.instance !== "string"
          )
            throw new Error("ENGINE_INCOMPATIBLE");
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error("ENGINE_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}
