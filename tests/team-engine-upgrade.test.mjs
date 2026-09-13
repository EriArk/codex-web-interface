import { execFileSync } from "node:child_process";
import test from "node:test";

test("coordinated Team engine checkpoint and rollback fault cases", {
  skip: process.platform === "win32",
  timeout: 60000,
}, () => {
  execFileSync("python3", ["tests/team-engine-upgrade.py"], { stdio: "pipe" });
});
