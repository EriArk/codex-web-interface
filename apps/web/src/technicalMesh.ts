export type MeshPart = {
  positions: Float32Array | number[];
  indices?: Uint32Array | number[];
  color?: number[];
};
export type MeshDocument = {
  meshes: MeshPart[];
  unit: string;
  unitSource: "document" | "unknown";
  triangles: number;
  warnings?: string[];
};
