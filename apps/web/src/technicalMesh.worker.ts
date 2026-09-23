import { XMLParser } from "fast-xml-parser";
import { unzipSync } from "fflate";
import {
  type BufferGeometry,
  LoadingManager,
  Matrix4,
  type Mesh,
  type Object3D,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type { MeshDocument, MeshPart } from "./technicalMesh";

const maxTriangles = 250000,
  maxMeshes = 512;
const decoder = new TextDecoder();
function validate(
  meshes: MeshPart[],
  unit = "",
  unitSource: MeshDocument["unitSource"] = "unknown",
): MeshDocument {
  let triangles = 0,
    vertices = 0;
  if (!meshes.length || meshes.length > maxMeshes) throw Error("Слишком много частей модели.");
  for (const m of meshes) {
    vertices += m.positions.length / 3;
    triangles += (m.indices?.length ?? m.positions.length / 3) / 3;
    if (
      vertices > 750000 ||
      triangles > maxTriangles ||
      m.positions.length % 3 ||
      Array.from(m.positions).some((n) => !Number.isFinite(n) || Math.abs(n) > 1e9) ||
      (m.indices &&
        (m.indices.length % 3 ||
          Array.from(m.indices).some(
            (n) => !Number.isInteger(n) || n < 0 || n >= m.positions.length / 3,
          )))
    )
      throw Error("Модель превышает лимит геометрии.");
  }
  return { meshes, unit, unitSource, triangles };
}
function part(geometry: BufferGeometry): MeshPart {
  const position = geometry.getAttribute("position");
  if (!position || position.count > 750000) throw Error("Некорректная геометрия.");
  return {
    positions: new Float32Array(position.array),
    indices: geometry.index ? new Uint32Array(geometry.index.array) : undefined,
  };
}
function sceneParts(scene: Object3D) {
  const meshes: MeshPart[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    if (meshes.length >= maxMeshes) throw Error("Слишком много частей модели.");
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    meshes.push(part(geometry));
    geometry.dispose();
    mesh.geometry.dispose();
  });
  return meshes;
}
function threeMf(buffer: ArrayBuffer) {
  let expanded = 0,
    entries = 0;
  const archive = unzipSync(new Uint8Array(buffer), {
    filter: (entry) => {
      expanded += entry.originalSize;
      entries++;
      if (entries > 128 || expanded > 32 * 1024 * 1024)
        throw Error("Архив модели слишком большой.");
      return /\.model$/i.test(entry.name);
    },
  });
  const names = Object.keys(archive);
  if (names.length !== 1) throw Error("3MF должен содержать одну встроенную модель.");
  const xml = decoder.decode(archive[names[0]!]!);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error("Внешние сущности не поддерживаются.");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    processEntities: false,
    isArray: (name: string) => ["object", "vertex", "triangle", "component", "item"].includes(name),
  }).parse(xml);
  const model = parsed.model;
  if (!model?.resources?.object || !model.build?.item) throw Error("Некорректный 3MF.");
  const objects = new Map<string, Record<string, any>>();
  for (const o of model.resources.object) {
    if (objects.has(String(o.id)) || objects.size >= maxMeshes)
      throw Error("Некорректные части 3MF.");
    objects.set(String(o.id), o);
  }
  const transform = (text: string | undefined) => {
    if (!text) return new Matrix4();
    const v = text.trim().split(/\s+/).map(Number);
    if (v.length !== 12 || v.some((n) => !Number.isFinite(n)))
      throw Error("Некорректное преобразование 3MF.");
    return new Matrix4().set(
      v[0]!,
      v[3]!,
      v[6]!,
      v[9]!,
      v[1]!,
      v[4]!,
      v[7]!,
      v[10]!,
      v[2]!,
      v[5]!,
      v[8]!,
      v[11]!,
      0,
      0,
      0,
      1,
    );
  };
  const meshes: MeshPart[] = [];
  let triangles = 0;
  const add = (id: string, matrix: Matrix4, ancestors: Set<string>) => {
    if (ancestors.has(id) || ancestors.size > 32 || meshes.length >= maxMeshes)
      throw Error("Рекурсивная или слишком сложная сборка.");
    const o = objects.get(id);
    if (!o) throw Error("Отсутствует часть 3MF.");
    const next = new Set(ancestors).add(id);
    if (o.mesh) {
      const verts = o.mesh.vertices?.vertex ?? [],
        faces = o.mesh.triangles?.triangle ?? [];
      triangles += faces.length;
      if (verts.length > 750000 || triangles > maxTriangles) throw Error("Модель слишком сложная.");
      const positions = new Float32Array(verts.length * 3),
        indices = new Uint32Array(faces.length * 3);
      verts.forEach((v: Record<string, string>, i: number) => {
        new Vector3(Number(v.x), Number(v.y), Number(v.z))
          .applyMatrix4(matrix)
          .toArray(positions, i * 3);
      });
      faces.forEach((f: Record<string, string>, i: number) => {
        const ids = [Number(f.v1), Number(f.v2), Number(f.v3)];
        if (ids.some((n) => !Number.isInteger(n) || n < 0 || n >= verts.length))
          throw Error("Некорректная грань.");
        indices.set(ids, i * 3);
      });
      meshes.push({ positions, indices });
    }
    for (const c of o.components?.component ?? [])
      add(String(c.objectid), matrix.clone().multiply(transform(c.transform)), next);
  };
  for (const item of model.build.item)
    add(String(item.objectid), transform(item.transform), new Set());
  const units: Record<string, string> = {
    micron: "µm",
    millimeter: "mm",
    centimeter: "cm",
    meter: "m",
    inch: "in",
    foot: "ft",
  };
  if (model.unit && !units[model.unit]) throw Error("Неизвестные единицы 3MF.");
  return validate(meshes, units[model.unit || "millimeter"]!, "document");
}
async function gltf(buffer: ArrayBuffer, binary: boolean) {
  let data: any, bin: Uint8Array | undefined;
  if (binary) {
    const view = new DataView(buffer);
    if (
      buffer.byteLength < 20 ||
      view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== buffer.byteLength
    )
      throw Error("Некорректный GLB.");
    const len = view.getUint32(12, true);
    if (
      view.getUint32(16, true) !== 0x4e4f534a ||
      len > 4 * 1024 * 1024 ||
      len + 20 > buffer.byteLength
    )
      throw Error("Некорректный GLB.");
    data = JSON.parse(decoder.decode(new Uint8Array(buffer, 20, len)).trim());
    if (len + 28 <= buffer.byteLength) {
      const size = view.getUint32(len + 20, true);
      if (view.getUint32(len + 24, true) !== 0x004e4942 || len + 28 + size !== buffer.byteLength)
        throw Error("Некорректный GLB.");
      bin = new Uint8Array(buffer, len + 28, size);
    }
  } else data = JSON.parse(decoder.decode(buffer));
  if (
    data.asset?.version !== "2.0" ||
    (data.nodes?.length ?? 0) > 1024 ||
    (data.accessors?.length ?? 0) > 4096
  )
    throw Error("Слишком сложный glTF.");
  // Shaded geometry only. Never fetch textures, URIs, decoder modules or companion files.
  if (data.extensionsRequired?.length)
    throw Error("Для этой модели нужны дополнительные расширения.");
  let bufferBytes = 0;
  for (const b of data.buffers ?? []) {
    if (
      b.uri &&
      (!/^data:application\/(octet-stream|gltf-buffer);base64,[a-zA-Z0-9+/=]+$/.test(b.uri) ||
        b.uri.length > 44 * 1024 * 1024)
    )
      throw Error("Открой самодостаточный GLB или glTF со встроенными буферами.");
    bufferBytes += Number(b.byteLength);
    if (!Number.isFinite(bufferBytes) || b.byteLength < 0 || bufferBytes > 32 * 1024 * 1024)
      throw Error("Буфер модели слишком большой.");
  }
  for (const a of data.accessors ?? [])
    if (a.count > 750000 || a.sparse) throw Error("Слишком большой или разреженный буфер модели.");
  // A cyclic scene can recurse before the loader returns.
  let visits = 0;
  const visit = (i: number, trail: Set<number>, depth = 0) => {
    if (++visits > 8192 || depth > 32 || trail.has(i))
      throw Error("Рекурсивная или слишком сложная сцена.");
    for (const c of data.nodes?.[i]?.children ?? []) visit(c, new Set(trail).add(i), depth + 1);
  };
  for (let i = 0; i < (data.nodes?.length ?? 0); i++) visit(i, new Set());
  data.images = [];
  data.textures = [];
  data.materials = [];
  data.animations = [];
  data.extensions = {};
  for (const m of data.meshes ?? [])
    for (const p of m.primitives ?? []) {
      delete p.material;
      delete p.extensions;
      if (p.mode !== undefined && p.mode !== 4)
        throw Error("Поддерживаются треугольные поверхности.");
    }
  const manager = new LoadingManager();
  manager.setURLModifier(() => {
    throw Error("Внешние ресурсы запрещены.");
  });
  const loader = new GLTFLoader(manager);
  loader.register((parser) => {
    parser.loadBuffer = async (index: number) => {
      const def = data.buffers[index];
      if (!def) throw Error("Отсутствует буфер модели.");
      const bytes = def.uri
        ? Uint8Array.from(atob(def.uri.split(",")[1]), (c) => c.charCodeAt(0))
        : index === 0 && bin
          ? new Uint8Array(bin)
          : null;
      if (!bytes || bytes.length < def.byteLength) throw Error("Повреждённый буфер модели.");
      return bytes.buffer;
    };
    return { name: "CODEXWEB_EMBEDDED_BUFFERS" };
  });
  const result = await loader.parseAsync(JSON.stringify(data), "");
  return validate(sceneParts(result.scene), "m", "document");
}
self.onmessage = async (event: MessageEvent<{ format: string; buffer: ArrayBuffer }>) => {
  try {
    const { format, buffer } = event.data;
    if (buffer.byteLength > 32 * 1024 * 1024) throw Error("Файл слишком большой.");
    let doc: MeshDocument;
    if (format === "3mf") doc = threeMf(buffer);
    else if (format === "gltf" || format === "glb") doc = await gltf(buffer, format === "glb");
    else if (format === "obj") {
      const text = decoder.decode(buffer);
      let faces = 0,
        vertices = 0;
      for (const line of text.split("\n")) {
        if (line.length > 4096) throw Error("Слишком сложная грань OBJ.");
        if (line.startsWith("v ")) vertices++;
        if (line.startsWith("f ")) faces += Math.max(0, line.trim().split(/\s+/).length - 3);
        if (vertices > 750000 || faces > maxTriangles) throw Error("Модель слишком сложная.");
      }
      doc = validate(sceneParts(new OBJLoader().parse(text)));
    } else if (format === "stl") {
      const count = buffer.byteLength >= 84 ? new DataView(buffer).getUint32(80, true) : 0;
      if (84 + count * 50 === buffer.byteLength) {
        if (count > maxTriangles) throw Error("Модель слишком сложная.");
      } else if (
        !/^\s*solid\b/i.test(decoder.decode(buffer.slice(0, 256))) ||
        (decoder.decode(buffer).match(/facet\s+normal/gi)?.length ?? 0) > maxTriangles
      )
        throw Error("Некорректный или слишком большой STL.");
      const g = new STLLoader().parse(buffer);
      doc = validate([part(g)]);
      g.dispose();
    } else throw Error("Неизвестный формат.");
    const transfers = doc.meshes.flatMap((m) =>
      [m.positions, m.indices]
        .filter((a) => ArrayBuffer.isView(a))
        .map((a) => (a as Float32Array).buffer),
    );
    self.postMessage({ document: doc }, { transfer: transfers });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Не удалось прочитать модель.",
    });
  }
};
