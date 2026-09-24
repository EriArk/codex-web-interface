import assert from "node:assert/strict";
import test from "node:test";
import { beginNativeRecovery } from "../ops/gpt/native-recovery.mjs";

test("recovery waits for a bounded busy read using the same lease", async () => {
  let calls = 0;
  const adapter = {
    manual: async (op, id) => {
      assert.equal(op, "beginManual");
      assert.equal(id, "exact");
      if (++calls < 4) throw Error("NATIVE_BUSY");
      return { manual: true };
    },
  };
  assert.deepEqual(
    await beginNativeRecovery(
      adapter,
      "exact",
      () => false,
      async () => {},
    ),
    { manual: true },
  );
  assert.equal(calls, 4);
});
test("recovery never retries an ambiguous failure and stops on cancellation or its bound", async () => {
  for (const code of ["NATIVE_UNAVAILABLE", "NATIVE_WRONG_OWNER"]) {
    let calls = 0;
    await assert.rejects(
      beginNativeRecovery(
        {
          manual: async () => {
            calls++;
            throw Error(code);
          },
        },
        "exact",
        () => false,
        async () => {},
      ),
      new RegExp(code),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const adapter = {
    manual: async () => {
      calls++;
      throw Error("NATIVE_BUSY");
    },
  };
  await assert.rejects(
    beginNativeRecovery(adapter, "exact", () => true),
    /CANCELLED/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    beginNativeRecovery(
      adapter,
      "exact",
      () => false,
      async () => {},
    ),
    /BUSY/,
  );
  assert.equal(calls, 50);
});
