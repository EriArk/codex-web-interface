export type StagingFile = { path: string; bytes: number; mtime: number; sha256: string };
export type StagingInventory = {
  bytes: number;
  files: number;
  temporaryBytes: number;
  temporaryFiles: number;
  previewBytes: number;
  receipts: number;
  partial: boolean;
  checkedAt: number;
};
export type StagingRequest =
  | { op: "inspect" }
  | { op: "plan" }
  | { op: "read"; files: StagingFile[] }
  | { op: "remove"; files: StagingFile[] };
export type StagingResponse = StagingInventory & {
  candidates?: StagingFile[];
  contents?: { file: StagingFile; base64: string }[];
  removed?: number;
  reclaimedBytes?: number;
};
