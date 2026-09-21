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
  access: "owner" | CollaborationAccess;
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
};
export type CollaborationCatalog = {
  spaces: CollaborationSpace[];
  invitations: CollaborationInvitation[];
};
