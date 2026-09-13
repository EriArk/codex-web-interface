import assert from "node:assert/strict";
import test from "node:test";
import { transferWindowsAttachment } from "../packages/machines/dist/attachment.js";
import {
  bindMachineAuthority,
  controlDesktop,
  inspectMachineStaging,
  inspectProject,
  readMachineImage,
  readMachinePreview,
  readMachineResources,
  readNativeActivity,
  readProjectFile,
  readWorkspaceDependencies,
  runGuiPreview,
  runProjectDelivery,
  runProjectSetup,
  spawnCodex,
  stageAttachment,
} from "../packages/machines/dist/index.js";

test("revoked native capabilities stop every machine entry point before transport or local effects", async () => {
  const machine = {
    id: "private",
    type: "ssh-windows",
    ssh: { target: "must-not-run.invalid" },
    codex: { command: "must-not-run", shell: "powershell" },
  };
  let enabled = true;
  const close = bindMachineAuthority(machine, () => {
    if (!enabled) throw new Error("TEST_ACCOUNT_REVOKED");
  });
  enabled = false;
  assert.throws(() => spawnCodex(machine, "D:\\Projects"), /TEST_ACCOUNT_REVOKED/);
  const operations = [
    () => stageAttachment(machine, "project", "id", "file", "/must-not-read"),
    () =>
      transferWindowsAttachment(
        machine,
        "project",
        "id",
        "file",
        "/must-not-read",
        Date.now() + 1000,
      ),
    () => readNativeActivity(machine, "D:\\Home", []),
    () => controlDesktop(machine, "Open"),
    () => readMachineImage(machine, "D:\\private.png"),
    () => readMachinePreview(machine, "D:\\Projects", "demo.html"),
    () => readWorkspaceDependencies(machine),
    () => inspectProject(machine, "D:\\Projects", { op: "git" }),
    () => runProjectDelivery(machine, "D:\\Projects", { op: "inspect" }),
    () => runProjectSetup(machine, { op: "repositories" }),
    () => runGuiPreview(machine, "D:\\Projects", { op: "catalog" }),
    () => inspectMachineStaging(machine),
    () => readMachineResources(machine, "D:\\Projects"),
    () => readProjectFile(machine, "D:\\Projects", "file.txt"),
  ];
  for (const operation of operations) await assert.rejects(operation, /TEST_ACCOUNT_REVOKED/);
  assert.throws(() => bindMachineAuthority(machine, () => {}), /ALREADY_BOUND/);
  close();
  enabled = true;
  await assert.rejects(readWorkspaceDependencies(machine), /MACHINE_RUNTIME_CLOSED/);
});
