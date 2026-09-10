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
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  id: string;
  title: string;
  updatedAt: number;
  projectId?: string;
}
export interface GptProject {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
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
  dismissed?: boolean;
  id: string;
  nativeId: string | null;
  text: string;
  files: GptFile[];
  model: string;
  effort: string;
  status: "queued" | "preparing" | "running" | "completed" | "failed" | "unknown" | "cancelled";
  answer: string;
  progress?: GptProgress[];
  summaryOnly?: boolean;
  assets: GptFile[];
  createdAt: number;
  updatedAt: number;
  error: string;
}

export interface GptProgress {
  id: string;
  text: string;
  state: "active" | "completed";
}
export interface GptHistoryPage {
  contextMessage?: string;
  hasNewer?: boolean;
  items: GptMessage[];
  nextBefore: string | null;
  revision: string;
  prefix: string;
  notModified: boolean;
  retainOlder: boolean;
}
