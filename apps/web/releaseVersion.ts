import { createHash } from "node:crypto";
export function releaseVersion(
  bundle: Record<string, { type: string; fileName: string; isEntry?: boolean }>,
) {
  const files = Object.values(bundle);
  const entry = files.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
  if (!entry) throw new Error("Missing web entry");
  const assets = files
    .filter((file) => /\.(?:js|css)$/.test(file.fileName))
    .map((file) => "/" + file.fileName)
    .sort();
  return {
    id: createHash("sha256").update(JSON.stringify(assets)).digest("hex"),
    entry: "/" + entry.fileName,
    styles: files
      .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
      .map((file) => "/" + file.fileName)
      .sort(),
  };
}
