import { createRequire } from "node:module";
import { technicalInputLimit, technicalOutputLimit } from "./technicalConvert.js";

type Mesh = {
  attributes: { position: { array: number[] } };
  index: { array: number[] };
  color?: number[];
};
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > technicalInputLimit) process.exit(1);
  chunks.push(chunk);
}
const format = process.argv[2];
if (format !== "step" && format !== "iges") process.exit(1);
try {
  const load = createRequire(import.meta.url)("occt-import-js");
  const occt = await load({ print: () => {}, printErr: () => {} });
  const result = occt[format === "step" ? "ReadStepFile" : "ReadIgesFile"](Buffer.concat(chunks), {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.002,
    angularDeflection: 0.5,
  }) as { success: boolean; meshes: Mesh[] };
  if (!result.success || !result.meshes.length || result.meshes.length > 512) throw Error();
  let vertices = 0,
    triangles = 0;
  const meshes = result.meshes.map((m) => {
    const positions = m.attributes.position.array,
      indices = m.index.array;
    vertices += positions.length / 3;
    triangles += indices.length / 3;
    if (
      vertices > 750000 ||
      triangles > 250000 ||
      positions.length % 3 ||
      indices.length % 3 ||
      positions.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e9) ||
      indices.some((n) => !Number.isInteger(n) || n < 0 || n >= positions.length / 3)
    )
      throw Error();
    return { positions, indices, color: m.color?.slice(0, 3) };
  });
  const output = JSON.stringify({ meshes, unit: "mm", unitSource: "document", triangles });
  if (Buffer.byteLength(output) > technicalOutputLimit) throw Error();
  process.stdout.write(output);
} catch {
  process.exitCode = 1;
}
