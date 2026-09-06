import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { displayUserText, NativeImages } from "../apps/hub/dist/nativeImages.js";
import { Store } from "../apps/hub/dist/store.js";

const require = createRequire(new URL("../apps/hub/package.json", import.meta.url)),
  sharp = require("sharp");
test("native attachments become private cached images with no exposed source path; only matching file wrappers are removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-native-images-")),
    store = new Store(":memory:");
  try {
    const imagePath = join(root, "Фото.png");
    writeFileSync(
      imagePath,
      await sharp({ create: { width: 100, height: 160, channels: 3, background: "#287454" } })
        .png()
        .toBuffer(),
    );
    const t = store.createThread("p", "native", "Picture");
    const images = new NativeImages({ hub: { resultsPath: join(root, "results") } }, store, () => ({
      type: "local-linux",
    }));
    const image = images.register(t.id, "message", imagePath);
    assert.equal(images.register(t.id, "message", imagePath).id, image.id);
    assert(!JSON.stringify(image).includes(root));
    const bytes = await images.get(image.id);
    assert.equal(bytes.mime, "image/png");
    unlinkSync(imagePath);
    assert.deepEqual((await images.get(image.id)).data, bytes.data);
    assert.equal(
      store.db.prepare("SELECT source FROM native_images WHERE id=?").get(image.id).source,
      "",
    );
    const raw =
      "# Files mentioned by the user:\n\n## Фото.png: " +
      imagePath +
      "\n\n## My request for Codex:\n\nShow the picture";
    assert.equal(displayUserText(raw, [imagePath]), "Show the picture");
    assert.equal(
      displayUserText("An ordinary path: " + imagePath, [imagePath]),
      "An ordinary path: " + imagePath,
    );
    assert.equal(images.register(t.id, "m", "https://127.0.0.1/private.png"), undefined);
    assert.equal(images.register(t.id, "m", "/private/auth.json"), undefined);
    assert.equal(images.register(t.id, "m", "../../image.png"), undefined);
    const invalidPath = join(root, "invalid.png");
    writeFileSync(invalidPath, "<html>not an image</html>");
    await assert.rejects(images.get(images.register(t.id, "bad", invalidPath).id), {
      code: "INVALID_IMAGE",
    });
    await assert.rejects(images.get("unknown"), { code: "IMAGE_NOT_FOUND" });
    store.append(t.id, "user.message", { id: "message", text: "Show the picture" });
    assert.equal(store.history(t.id).messages[0].images[0].id, image.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true });
  }
});
