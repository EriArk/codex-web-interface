export interface BrainstormRoom {
  id: string;
  title: string;
  description: string;
  owner: { id: string; name: string };
  revision: number;
  closed: boolean;
  createdAt: number;
  updatedAt: number;
  following: boolean;
  muted: boolean;
  unread: number;
  projects: { id: string; name: string; repository: string | null; spaceId: string | null }[];
}
export interface BrainstormCard {
  id: string;
  kind: "note" | "link" | "file" | "drawing";
  title: string;
  text: string;
  url: string;
  fileId: string | null;
  file?: { name: string; mime: string; bytes: number };
  x: number;
  y: number;
  width: number;
  points: number[][];
  group?: string;
  links?: string[];
  revision: number;
  author: { id: string; name: string };
  updatedAt: number;
}
export interface BrainstormState {
  room: BrainstormRoom;
  cards: BrainstormCard[];
  removed: string[];
  version: number;
  reset: boolean;
  people: { id: string; name: string }[];
}
export interface BrainstormConversion {
  id: string;
  roomId: string;
  title: string;
  createdAt: number;
  projectId: string | null;
  spaceId: string | null;
  participants: { userId: string; access: "collaborate" | "direct" }[];
  summary: string;
  snapshot: {
    room: BrainstormRoom;
    cards: BrainstormCard[];
    messages: import("./collaboration.js").SpaceChatMessage[];
  };
}
