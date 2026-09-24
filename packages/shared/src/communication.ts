export type HumanConversation = {
  id: string;
  title: string;
  ownerId: string;
  kind: "direct" | "group";
  members: { id: string; name: string }[];
  unread: number;
  muted: boolean;
  updatedAt: number;
  preview?: string;
};
export type SharedResultCard = {
  id: string;
  snapshotId: string;
  title: string;
  mime: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  ownerId: string;
  revoked: boolean;
};
export type ResultShareSource = {
  client: "codex" | "gpt" | "human";
  threadId: string;
  resultId: string;
};
export type ResultShareDestination = { kind: "conversation" | "brainstorm" | "space"; id: string };
