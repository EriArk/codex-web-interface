export type GptNativeProject = {
  id: string;
  name: string;
  instructions: string;
  revision: string;
  canWrite: boolean;
  files: { id: string; name: string; bytes: number | null }[];
};
export type GptProjectOperation = {
  id: string;
  projectId: string;
  action: "instructions" | "upload" | "remove";
  state: "pending" | "unknown" | "completed" | "failed" | "checked";
  error: string;
  createdAt: number;
};
