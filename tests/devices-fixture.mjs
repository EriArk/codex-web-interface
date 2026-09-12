import { EventEmitter } from "node:events";
import { handoffFixture } from "./handoff-fixture.mjs";
export async function devicesFixture(origin = "http://127.0.0.1:18873", appOptions = {}) {
  const processes = [],
    probes = [];
  const dependencies = {
    spawn(args) {
      const events = new EventEmitter();
      const pty = {
        args,
        writes: [],
        sizes: [],
        killed: false,
        onData(fn) {
          events.on("data", fn);
          return { dispose: () => events.off("data", fn) };
        },
        onExit(fn) {
          events.on("exit", fn);
          return { dispose: () => events.off("exit", fn) };
        },
        write(value) {
          this.writes.push(value);
          events.emit("data", value.replaceAll("\r", "\r\n"));
        },
        resize(cols, rows) {
          this.sizes.push([cols, rows]);
        },
        kill() {
          if (!this.killed) {
            this.killed = true;
            events.emit("exit", { exitCode: 0 });
          }
        },
        output(value) {
          events.emit("data", value);
        },
      };
      processes.push(pty);
      setTimeout(() => pty.output("Device ready\r\n$ "), 40);
      return pty;
    },
    async probe(d) {
      probes.push(d.id);
      return {
        checkedAt: Date.now(),
        online: true,
        hostname: d.id,
        os: d.platform === "linux" ? "Ubuntu Linux" : "Windows 10",
        cpu: "Intel Core i7",
        architecture: "x86_64",
        cores: 8,
        uptimeSeconds: 72000,
        memoryTotal: 16000000000,
        memoryAvailable: 8000000000,
        disks: [
          {
            name: "System",
            mount: d.platform === "linux" ? "/" : "C:",
            total: 1000000000000,
            available: 800000000000,
          },
        ],
        temperatures: [{ name: "Package", celsius: 48 }],
      };
    },
  };
  const f = await handoffFixture(origin, undefined, {
    ...appOptions,
    devices: { ...dependencies, ...appOptions.devices },
  });
  f.sessions.config.devices.push(
    ...["linux", "windows"].map((platform, i) => ({
      id: i ? "pc" : "server",
      name: i ? "ПК" : "Сервер",
      platform,
      shell: "powershell",
      ssh: { target: i ? "private-pc" : "private-server", configFile: "/private/ssh/config" },
      power: true,
      mounts: true,
    })),
  );
  return { ...f, processes, probes };
}
