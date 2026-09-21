/** Public collaboration metadata. Native chats and local paths remain personal. */
export type CollaborationAccess = "collaborate" | "direct";
export type CollaborationKind = "project" | "space";
export type CollaborationPerson = { id: string; name: string };
export type CollaborationProject = {
  id: string;
  ownerId: string;
  name: string;
  repository: string;
  personalProjectId?: string;
  access: "owner" | "none" | CollaborationAccess;
  grants: { userId: string; access: CollaborationAccess }[];
  requests: string[];
};
export type CollaborationSpace = {
  id: string;
  title: string;
  kind: CollaborationKind;
  curatorId: string;
  revision: number;
  members: CollaborationPerson[];
  projects: CollaborationProject[];
  pending: CollaborationPerson[];
  unread: number;
};
export type CollaborationInvitation = {
  spaceId: string;
  title: string;
  kind: CollaborationKind;
  revision: number;
  from: CollaborationPerson;
  project: { name: string; repository: string };
  access: CollaborationAccess;
  requestedAccess: CollaborationAccess;
  projects?: { id: string; name: string; repository: string; access: CollaborationAccess }[];
  members?: CollaborationPerson[];
  recommendations?: import("./project-gpt.js").ProjectRules;
};
export type CollaborationCatalog = {
  spaces: CollaborationSpace[];
  invitations: CollaborationInvitation[];
};
export type SpaceChatFile = { id: string; name: string; mime: string; bytes: number };
export type SpaceChatMessage = {
  seq: number;
  id: string;
  author: CollaborationPerson;
  text: string;
  files: SpaceChatFile[];
  createdAt: number;
};
export type SpaceChatPage = { messages: SpaceChatMessage[]; more: boolean };
