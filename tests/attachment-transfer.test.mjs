import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { quoteSftpPath } from "../packages/machines/dist/attachment.js";
import { stageAttachment } from "../packages/machines/dist/index.js";

test("SFTP batch paths cannot inject commands and preserve special characters", () => {
  assert.equal(quoteSftpPath('/tmp/a "quote" \\ фото'), '"/tmp/a \\"quote\\" \\\\ фото"');
  for (const value of ["file\n!command", "file\rput another", "file\0"]) {
    assert.throws(() => quoteSftpPath(value), { code: "INVALID_ATTACHMENT_PATH" });
  }
});

test("SSH upload uses SFTP, validates acknowledgement and cleans failed temporary transfers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-transfer-test-"));
  const source = join(root, 'local "quoted" фото.bin'),
    initial = Buffer.from("payload with real bytes \0\n");
  let bytes = initial;
  await writeFile(source, bytes);
  const original = childProcess.spawn;
  try {
    for (const outcome of [
      "success",
      "large-success",
      "sftp-error",
      "timeout",
      "bad-ack",
      "bad-destination",
      "ssh-error",
      "oversized-response",
    ]) {
      await t.test(outcome, async () => {
        bytes = outcome === "large-success" ? Buffer.alloc(26 * 1024 ** 2, 47) : initial;
        await writeFile(source, bytes);
        const id = randomUUID(),
          directory = "C:\\Users\\QA\\AppData\\Local\\CodexWeb\\attachments\\test\\" + id + "\\";
        const destination = directory + "upload-Фото _.png",
          calls = [];
        let temporary;
        childProcess.spawn = (binary, args, options) => {
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            pid: undefined,
            exitCode: null,
            signalCode: null,
          });
          child.kill = (signal) => {
            child.signalCode = signal;
            queueMicrotask(() => child.emit("close", null));
            return true;
          };
          let input = "";
          child.stdin.on("data", (chunk) => (input += chunk));
          child.stdin.on("finish", () =>
            queueMicrotask(() => {
              const script =
                binary === "ssh" ? Buffer.from(args.at(-1), "base64").toString("utf16le") : "";
              calls.push({ binary, args, input, script, options });
              const close = (output = "", code = 0) => {
                // Split UTF-8 within a Cyrillic glyph to exercise stream decoding.
                const data = Buffer.from(output),
                  at = data.findIndex((n) => n > 127) + 1;
                child.stdout.write(data.subarray(0, at));
                child.stdout.write(data.subarray(at));
                child.exitCode = code;
                child.emit("close", code);
              };
              child.stderr.write("PRIVATE NATIVE DIAGNOSTIC");
              if (binary === "sftp") {
                if (outcome === "timeout") return;
                return close("", outcome === "sftp-error" ? 1 : 0);
              }
              if (script.includes("$temporary=Join-Path")) {
                temporary = directory + script.match(/\.upload-[0-9a-f-]+\.part/)[0];
                if (outcome === "ssh-error") {
                  child.emit("error", new Error("PRIVATE SSH FAILURE"));
                  return;
                }
                if (outcome === "oversized-response") return close("x".repeat(9000));
                return close(
                  JSON.stringify({
                    path: outcome === "bad-destination" ? "C:\\outside.bin" : destination,
                    temporary,
                  }),
                );
              }
              if (script.includes("UPLOAD_INTEGRITY_FAILED"))
                return close(
                  JSON.stringify({
                    path: destination,
                    bytes: bytes.length,
                    sha256:
                      outcome === "bad-ack"
                        ? "wrong"
                        : createHash("sha256").update(bytes).digest("hex"),
                  }),
                );
              assert(script.includes("[IO.File]::Delete"));
              return close();
            }),
          );
          return child;
        };
        syncBuiltinESMExports();
        const machine = {
          type: "ssh-windows",
          ssh: { target: "qa-target", configFile: "/private/ssh/config" },
        };
        const promise = stageAttachment(
          machine,
          "test",
          id,
          'Фото ".png',
          source,
          Date.now() + (outcome === "timeout" ? 100 : 3000),
        );
        if (outcome === "success" || outcome === "large-success")
          assert.equal(await promise, destination);
        else
          await assert.rejects(promise, (error) => {
            assert.equal(error.statusCode, 503);
            assert.equal(
              error.code,
              outcome === "timeout" ? "UPLOAD_TRANSFER_TIMEOUT" : "UPLOAD_TRANSFER_FAILED",
            );
            assert(!error.message.includes("PRIVATE"));
            return true;
          });
        const transfer = calls.find((c) => c.binary === "sftp");
        if (!["bad-destination", "ssh-error", "oversized-response"].includes(outcome)) {
          assert(transfer);
          assert(transfer.args.includes("StrictHostKeyChecking=yes"));
          assert(transfer.args.includes("/private/ssh/config"));
          assert.equal(
            transfer.input,
            "put " +
              quoteSftpPath(source) +
              " " +
              quoteSftpPath("/" + temporary.replaceAll("\\", "/")) +
              "\n",
          );
          assert(
            !calls.some(
              (c) => c.script.includes("ReadLine") || c.script.includes("OpenStandardInput"),
            ),
          );
        }
        if (["sftp-error", "timeout", "bad-ack"].includes(outcome))
          assert(calls.at(-1).script.includes("[IO.File]::Delete"));
      });
    }
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
