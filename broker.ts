#!/usr/bin/env bun
/**
 * claude-multiplayer broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  SetStatusRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  PeerStatus,
  Message,
  Room,
  RoomWithMeta,
  RoomMessage,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  LeaveRoomRequest,
  PostToRoomRequest,
  PostToRoomResponse,
  ListRoomsRequest,
  ListRoomsResponse,
  PollRoomMessagesRequest,
  PollRoomMessagesResponse,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_MULTIPLAYER_PORT ?? "7899", 10);
const HOST = process.env.CLAUDE_MULTIPLAYER_HOST ?? "0.0.0.0";
const DB_PATH = process.env.CLAUDE_MULTIPLAYER_DB ?? `${process.env.HOME}/.claude-multiplayer.db`;

// --- Activity logging ---

function logActivity(icon: string, msg: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  console.error(`  ${time}  ${icon}  ${msg}`);
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'online',
    status_updated_at TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

// Migrate: add status columns if missing (existing DBs)
try {
  db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'online'");
  db.run("ALTER TABLE peers ADD COLUMN status_updated_at TEXT NOT NULL DEFAULT ''");
} catch { /* columns already exist */ }

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    peer_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, peer_id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    from_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL
  )
`);

// Clean up stale peers — use PID check for local, heartbeat timeout for remote
const STALE_TIMEOUT_MS = 60_000; // 60s without heartbeat = stale

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, last_seen FROM peers").all() as { id: string; pid: number; last_seen: string }[];
  const now = Date.now();
  for (const peer of peers) {
    if (peer.pid > 0) {
      // Local peer — try PID check first
      try {
        process.kill(peer.pid, 0);
        continue; // alive, skip
      } catch {
        // PID dead — remove
      }
    }
    // Remote peer (pid=0) or dead local peer — check heartbeat timeout
    const lastSeen = new Date(peer.last_seen).getTime();
    if (peer.pid === 0 && now - lastSeen < STALE_TIMEOUT_MS) {
      continue; // remote peer still fresh
    }
    logActivity("🔴", `stale peer removed: ${peer.id}`);
    db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    db.run("DELETE FROM room_members WHERE peer_id = ?", [peer.id]);
  }
}

function cleanEmptyRooms() {
  const emptyRooms = db.query(`
    SELECT r.id, r.name FROM rooms r
    LEFT JOIN room_members rm ON rm.room_id = r.id
    GROUP BY r.id
    HAVING COUNT(rm.peer_id) = 0
  `).all() as { id: string; name: string }[];
  for (const room of emptyRooms) {
    logActivity("🗑️", `empty room deleted: #${room.name}`);
    db.run("DELETE FROM room_messages WHERE room_id = ?", [room.id]);
    db.run("DELETE FROM rooms WHERE id = ?", [room.id]);
  }
}

cleanStalePeers();
cleanEmptyRooms();

// Periodically clean stale peers and empty rooms (every 30s)
setInterval(() => {
  cleanStalePeers();
  cleanEmptyRooms();
}, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, name, pid, cwd, git_root, tty, summary, status, status_updated_at, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function peerLabel(id: string): string {
  const row = db.query("SELECT name FROM peers WHERE id = ?").get(id) as { name: string } | null;
  return row?.name ? `${row.name} (${id})` : id;
}

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateStatus = db.prepare(`
  UPDATE peers SET status = ?, status_updated_at = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.name ?? "", body.pid, body.cwd, body.git_root, body.tty, body.summary, "online", now, now, now);
  const displayName = body.name ? `${body.name} (${id})` : id;
  logActivity("🟢", `peer joined: ${displayName} — ${body.cwd}`);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleSetStatus(body: SetStatusRequest): void {
  const now = new Date().toISOString();
  updateStatus.run(body.status, now, body.id);
  logActivity("🔵", `${peerLabel(body.id)} status → ${body.status}`);

  // Broadcast presence change to all rooms this peer is in
  const memberships = db.query("SELECT room_id FROM room_members WHERE peer_id = ?")
    .all(body.id) as { room_id: string }[];

  for (const { room_id } of memberships) {
    const members = db.query("SELECT peer_id FROM room_members WHERE room_id = ?")
      .all(room_id) as { peer_id: string }[];
    const payload = {
      type: "presence",
      peer_id: body.id,
      status: body.status,
      updated_at: now,
      room_id,
    };
    for (const { peer_id } of members) {
      if (peer_id === body.id) continue;
      wsPush(peer_id, payload);
    }
  }
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer is still alive
  const now = Date.now();
  return peers.filter((p) => {
    if (p.pid > 0) {
      // Local peer — PID check
      try {
        process.kill(p.pid, 0);
        return true;
      } catch {
        deletePeer.run(p.id);
        return false;
      }
    }
    // Remote peer (pid=0) — heartbeat check
    const lastSeen = new Date(p.last_seen).getTime();
    if (now - lastSeen > STALE_TIMEOUT_MS) {
      deletePeer.run(p.id);
      return false;
    }
    return true;
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) return { ok: false, error: `Peer ${body.to_id} not found` };

  const now = new Date().toISOString();
  const result = insertMessage.run(body.from_id, body.to_id, body.text, now);
  const msgId = result.lastInsertRowid as number;
  logActivity("💬", `DM ${peerLabel(body.from_id)} → ${peerLabel(body.to_id)}: ${body.text}`);

  // Push over WebSocket immediately if target is connected
  const pushed = wsPush(body.to_id, {
    type: "dm",
    message: { id: msgId, from_id: body.from_id, to_id: body.to_id, text: body.text, sent_at: now },
  });
  // Mark delivered immediately if pushed over WS (avoids double-delivery via poll)
  if (pushed) markDelivered.run(msgId);

  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  logActivity("🔴", `peer left: ${body.id}`);
  deletePeer.run(body.id);
}

// --- Room handlers ---

function handleCreateRoom(body: CreateRoomRequest): CreateRoomResponse {
  if (!/^[a-z0-9][a-z0-9-_]{0,39}$/.test(body.name)) {
    return { ok: false, error: "Room name must be lowercase letters, numbers, hyphens or underscores (max 40 chars)" };
  }
  const existing = db.query("SELECT id FROM rooms WHERE name = ?").get(body.name);
  if (existing) return { ok: false, error: `Room "${body.name}" already exists` };

  const id = generateId();
  const now = new Date().toISOString();
  db.run("INSERT INTO rooms (id, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, body.name, body.topic ?? "", body.peer_id, now]);
  db.run("INSERT INTO room_members (room_id, peer_id, joined_at, last_read_id) VALUES (?, ?, ?, 0)",
    [id, body.peer_id, now]);

  const room = db.query("SELECT * FROM rooms WHERE id = ?").get(id) as Room;
  logActivity("🏠", `room created: #${body.name} by ${body.peer_id}`);
  return { ok: true, room };
}

function handleJoinRoom(body: JoinRoomRequest): JoinRoomResponse {
  const room = db.query("SELECT * FROM rooms WHERE name = ?").get(body.room_name) as Room | null;
  if (!room) return { ok: false, error: `Room "${body.room_name}" not found` };

  const already = db.query("SELECT 1 FROM room_members WHERE room_id = ? AND peer_id = ?").get(room.id, body.peer_id);
  if (already) return { ok: false, error: "Already a member" };

  const maxId = (db.query("SELECT MAX(id) as m FROM room_messages WHERE room_id = ?").get(room.id) as { m: number | null }).m ?? 0;
  db.run("INSERT INTO room_members (room_id, peer_id, joined_at, last_read_id) VALUES (?, ?, ?, ?)",
    [room.id, body.peer_id, new Date().toISOString(), maxId]);

  logActivity("📥", `${peerLabel(body.peer_id)} joined #${body.room_name}`);
  return { ok: true, room };
}

function handleLeaveRoom(body: LeaveRoomRequest): { ok: boolean } {
  db.run("DELETE FROM room_members WHERE room_id = ? AND peer_id = ?", [body.room_id, body.peer_id]);
  // Delete room if empty
  const count = (db.query("SELECT COUNT(*) as c FROM room_members WHERE room_id = ?").get(body.room_id) as { c: number }).c;
  if (count === 0) db.run("DELETE FROM rooms WHERE id = ?", [body.room_id]);
  return { ok: true };
}

function handlePostToRoom(body: PostToRoomRequest): PostToRoomResponse {
  const member = db.query("SELECT 1 FROM room_members WHERE room_id = ? AND peer_id = ?").get(body.room_id, body.from_id);
  if (!member) return { ok: false, error: "Not a member of this room" };

  const now = new Date().toISOString();
  const result = db.run("INSERT INTO room_messages (room_id, from_id, text, sent_at) VALUES (?, ?, ?, ?)",
    [body.room_id, body.from_id, body.text, now]);
  const msgId = result.lastInsertRowid as number;

  // Get room name and all members for push
  const room = db.query("SELECT name FROM rooms WHERE id = ?").get(body.room_id) as { name: string } | null;
  logActivity("💬", `#${room?.name ?? body.room_id} ${peerLabel(body.from_id)}: ${body.text}`);
  const members = db.query("SELECT peer_id FROM room_members WHERE room_id = ?")
    .all(body.room_id) as { peer_id: string }[];

  const payload = {
    type: "room_message",
    message: { id: msgId, room_id: body.room_id, room_name: room?.name ?? "", from_id: body.from_id, text: body.text, sent_at: now },
  };

  // Push to all connected members and advance their last_read_id
  for (const { peer_id } of members) {
    if (peer_id === body.from_id) continue; // don't echo back to sender
    const pushed = wsPush(peer_id, payload);
    if (pushed) {
      // Advance cursor so HTTP poll fallback doesn't re-deliver
      db.run("UPDATE room_members SET last_read_id = ? WHERE room_id = ? AND peer_id = ?",
        [msgId, body.room_id, peer_id]);
    }
  }

  return { ok: true, message_id: msgId };
}

function handleListRooms(body: ListRoomsRequest): ListRoomsResponse {
  let rooms: RoomWithMeta[];
  if (body.peer_id) {
    rooms = db.query(`
      SELECT r.*, COUNT(DISTINCT rm2.peer_id) as member_count,
             MAX(msg.sent_at) as last_message_at
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id AND rm.peer_id = ?
      LEFT JOIN room_members rm2 ON rm2.room_id = r.id
      LEFT JOIN room_messages msg ON msg.room_id = r.id
      GROUP BY r.id
    `).all(body.peer_id) as RoomWithMeta[];
  } else {
    rooms = db.query(`
      SELECT r.*, COUNT(DISTINCT rm.peer_id) as member_count,
             MAX(msg.sent_at) as last_message_at
      FROM rooms r
      LEFT JOIN room_members rm ON rm.room_id = r.id
      LEFT JOIN room_messages msg ON msg.room_id = r.id
      GROUP BY r.id
    `).all() as RoomWithMeta[];
  }
  return { rooms };
}

function handlePollRoomMessages(body: PollRoomMessagesRequest): PollRoomMessagesResponse {
  const memberships = db.query("SELECT room_id, last_read_id FROM room_members WHERE peer_id = ?")
    .all(body.peer_id) as { room_id: string; last_read_id: number }[];

  const allMessages: RoomMessage[] = [];

  for (const m of memberships) {
    const msgs = db.query(`
      SELECT rm.*, r.name as room_name
      FROM room_messages rm
      JOIN rooms r ON r.id = rm.room_id
      WHERE rm.room_id = ? AND rm.id > ?
      ORDER BY rm.id ASC
    `).all(m.room_id, m.last_read_id) as RoomMessage[];

    if (msgs.length > 0) {
      allMessages.push(...msgs);
      const maxId = msgs[msgs.length - 1].id;
      db.run("UPDATE room_members SET last_read_id = ? WHERE room_id = ? AND peer_id = ?",
        [maxId, m.room_id, body.peer_id]);
    }
  }

  return { messages: allMessages };
}

// --- WebSocket client registry ---

interface WSData { peerId: string | null }
const wsClients = new Map<string, ServerWebSocket<WSData>>();

function wsPush(peerId: string, payload: unknown): boolean {
  const ws = wsClients.get(peerId);
  if (!ws) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    wsClients.delete(peerId);
    return false;
  }
}

// Periodically prune room messages older than 24h
setInterval(() => {
  db.run("DELETE FROM room_messages WHERE sent_at < datetime('now', '-24 hours')");
}, 60_000);

// --- HTTP Server ---

Bun.serve<WSData>({
  port: PORT,
  hostname: HOST,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (path === "/ws" && req.headers.get("upgrade") === "websocket") {
      const ok = server.upgrade(req, { data: { peerId: null } });
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length, ws_clients: wsClients.size });
      }
      return new Response("claude-multiplayer broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/set-status":
          handleSetStatus(body as SetStatusRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        case "/create-room":
          return Response.json(handleCreateRoom(body as CreateRoomRequest));
        case "/join-room":
          return Response.json(handleJoinRoom(body as JoinRoomRequest));
        case "/leave-room":
          handleLeaveRoom(body as LeaveRoomRequest);
          return Response.json({ ok: true });
        case "/post-to-room":
          return Response.json(handlePostToRoom(body as PostToRoomRequest));
        case "/list-rooms":
          return Response.json(handleListRooms(body as ListRoomsRequest));
        case "/poll-room-messages":
          return Response.json(handlePollRoomMessages(body as PollRoomMessagesRequest));
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
  websocket: {
    open(ws) {
      ws.data = { peerId: null };
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(raw as string);
        if (msg.type === "auth" && msg.peer_id) {
          ws.data.peerId = msg.peer_id;
          wsClients.set(msg.peer_id, ws);
          logActivity("⚡", `WebSocket connected: ${peerLabel(msg.peer_id)}`);
          ws.send(JSON.stringify({ type: "auth_ok", peer_id: msg.peer_id }));
        }
      } catch { /* ignore malformed */ }
    },
    close(ws) {
      if (ws.data?.peerId) {
        logActivity("⚡", `WebSocket disconnected: ${peerLabel(ws.data.peerId)}`);
        wsClients.delete(ws.data.peerId);
      }
    },
  },
});

console.error(`[claude-multiplayer broker] listening on ${HOST}:${PORT} (db: ${DB_PATH})`);
