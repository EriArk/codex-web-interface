export type FileSnapshot = {
  checkout?: string;
  path: string;
  fingerprint: string;
  kind: "file" | "directory";
  size: number;
  text?: string;
  bom?: boolean;
};
export type FileOperation =
  | "read"
  | "stat"
  | "save"
  | "create"
  | "mkdir"
  | "copy"
  | "move"
  | "delete";
export type FileImport = { path: string; bytes: number; sha256: string };
export type FileArchiveEntry = { path: string; data?: string };
export type FileRequest = {
  op: FileOperation;
  path: string;
  target?: string;
  fingerprint?: string;
  targetFingerprint?: string;
  text?: string;
  bom?: boolean;
  id?: string;
};
export const editableFile = (path: string) =>
  /(?:\.(?:[cm]?[jt]sx?|py|rs|c|h|cpp|hpp|cs|java|dart|kt|kts|qml|html?|css|scss|less|jsonc?|ya?ml|toml|xml|md|txt|csv|sh|bash|zsh|ps1|psm1|bat|cmd|sql|go|rb|php|vue|svelte|ini|cfg|conf|properties|svg|gitignore|gitattributes)|(?:^|\/)(?:Dockerfile|Makefile|LICENSE|README))$/i.test(
    path,
  );
