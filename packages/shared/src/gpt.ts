export interface GptFile {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  url: string;
  image: boolean;
}
export interface GptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  files: GptFile[];
}
export interface GptConversation {
  id: string;
  title: string;
  updatedAt: number;
  projectId?: string;
}
export interface GptProject {
  id: string;
  name: string;
}
export interface GptModels {
  models: { id: string; label: string }[];
  efforts: { id: string; label: string }[];
  currentModel: string;
  currentEffort: string;
}
export interface GptJob {
  id: string;
  nativeId: string | null;
  text: string;
  files: GptFile[];
  model: string;
  effort: string;
  status: "queued" | "preparing" | "running" | "completed" | "failed" | "unknown" | "cancelled";
  answer: string;
  assets: GptFile[];
  createdAt: number;
  updatedAt: number;
  error: string;
}
