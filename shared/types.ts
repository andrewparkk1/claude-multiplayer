// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;
export type RoomId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// --- Room types ---

export interface Room {
  id: RoomId;
  name: string;
  topic: string;
  created_by: PeerId;
  created_at: string;
}

export interface RoomWithMeta extends Room {
  member_count: number;
  last_message_at: string | null;
}

export interface RoomMessage {
  id: number;
  room_id: RoomId;
  room_name: string;
  from_id: PeerId;
  text: string;
  sent_at: string;
}

export interface CreateRoomRequest { peer_id: PeerId; name: string; topic?: string; }
export interface CreateRoomResponse { ok: boolean; room?: Room; error?: string; }
export interface JoinRoomRequest { peer_id: PeerId; room_name: string; }
export interface JoinRoomResponse { ok: boolean; room?: Room; error?: string; }
export interface LeaveRoomRequest { peer_id: PeerId; room_id: RoomId; }
export interface PostToRoomRequest { from_id: PeerId; room_id: RoomId; text: string; }
export interface PostToRoomResponse { ok: boolean; message_id?: number; error?: string; }
export interface ListRoomsRequest { peer_id?: PeerId; }
export interface ListRoomsResponse { rooms: RoomWithMeta[]; }
export interface PollRoomMessagesRequest { peer_id: PeerId; }
export interface PollRoomMessagesResponse { messages: RoomMessage[]; }
