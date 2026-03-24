#!/usr/bin/env bun
/**
 * claude-multiplayer MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-multiplayer
 *
 * With .mcp.json:
 *   { "claude-multiplayer": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
  RoomMessage,
  PollRoomMessagesResponse,
  CreateRoomResponse,
  JoinRoomResponse,
  ListRoomsResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_MULTIPLAYER_PORT ?? "7899", 10);
const BROKER_URL = process.env.CLAUDE_MULTIPLAYER_BROKER ?? `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_WS_URL = BROKER_URL.replace(/^http/, "ws") + "/ws";
const IS_REMOTE = !!process.env.CLAUDE_MULTIPLAYER_BROKER;
const POLL_INTERVAL_MS = 10_000; // fallback poll — WS handles real-time delivery
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-multiplayer] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myName: string = "";
let myCwd = process.cwd();
let myGitRoot: string | null = null;

async function getGitUserName(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "config", "user.name"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {}
  return "";
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-multiplayer", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-multiplayer network. Claude Code instances can discover each other, send direct messages, and join group chat rooms.

IMPORTANT: When you receive a <channel source="claude-multiplayer" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply, then resume your work.

For DIRECT MESSAGES (meta.type === "direct_message" or no type):
- Reply with send_message using the from_id in meta

For ROOM MESSAGES (meta.type === "room_message"):
- Reply with post_to_room using the room_id in meta
- Your reply will be seen by everyone in the room

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a direct message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on
- check_messages: Manually check for new direct messages
- create_room: Create a named group chat room
- join_room: Join an existing room by name
- leave_room: Leave a room
- post_to_room: Post a message to a room (seen by all members)
- list_rooms: List rooms you're in (or all rooms)

When you start, proactively call set_summary to describe what you're working on.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "set_status",
    description:
      "Set your presence status. Visible to other peers and broadcast to rooms you're in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string" as const,
          enum: ["online", "idle", "busy"],
          description: 'Your presence status: "online" (active), "idle" (not actively working), "busy" (focused, prefer not to be interrupted)',
        },
      },
      required: ["status"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "create_room",
    description: "Create a named group chat room. Everyone who joins will see all messages posted to the room.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Room name (lowercase letters, numbers, hyphens, underscores)" },
        topic: { type: "string" as const, description: "Optional topic or description" },
      },
      required: ["name"],
    },
  },
  {
    name: "join_room",
    description: "Join an existing group chat room by name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        room_name: { type: "string" as const, description: "The room name to join" },
      },
      required: ["room_name"],
    },
  },
  {
    name: "leave_room",
    description: "Leave a group chat room.",
    inputSchema: {
      type: "object" as const,
      properties: {
        room_id: { type: "string" as const, description: "The room ID to leave (from list_rooms)" },
      },
      required: ["room_id"],
    },
  },
  {
    name: "post_to_room",
    description: "Post a message to a group chat room. All members will receive it instantly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        room_id: { type: "string" as const, description: "The room ID to post to" },
        message: { type: "string" as const, description: "The message to post" },
      },
      required: ["room_id", "message"],
    },
  },
  {
    name: "list_rooms",
    description: "List group chat rooms.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: {
          type: "string" as const,
          enum: ["mine", "all"],
          description: '"mine" = rooms you are in (default), "all" = all rooms on this broker',
        },
      },
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const statusEmoji = (s: string) => s === "online" ? "🟢" : s === "idle" ? "🟡" : s === "busy" ? "🔴" : "⚪";
        const lines = peers.map((p) => {
          const parts = [
            `${statusEmoji(p.status ?? "online")} ${p.name || p.id} (${p.status ?? "online"})`,
            `  ID: ${p.id}`,
            `  CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`  Repo: ${p.git_root}`);
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          parts.push(`  Last seen: ${p.last_seen}`);
          return parts.join("\n");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_status": {
      const { status } = args as { status: "online" | "idle" | "busy" };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-status", { id: myId, status });
        const emoji = status === "online" ? "🟢" : status === "idle" ? "🟡" : "🔴";
        return {
          content: [{ type: "text" as const, text: `${emoji} Status set to: ${status}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting status: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "create_room": {
      const { name, topic } = args as { name: string; topic?: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        const result = await brokerFetch<CreateRoomResponse>("/create-room", { peer_id: myId, name, topic });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Room created! Name: #${result.room!.name}  ID: ${result.room!.id}\nShare the room name with others so they can join_room.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "join_room": {
      const { room_name } = args as { room_name: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        const result = await brokerFetch<JoinRoomResponse>("/join-room", { peer_id: myId, room_name });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Joined #${result.room!.name} (ID: ${result.room!.id})${result.room!.topic ? `\nTopic: ${result.room!.topic}` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "leave_room": {
      const { room_id } = args as { room_id: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        await brokerFetch("/leave-room", { peer_id: myId, room_id });
        return { content: [{ type: "text" as const, text: "Left the room." }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "post_to_room": {
      const { room_id, message } = args as { room_id: string; message: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/post-to-room", { from_id: myId, room_id, text: message });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: "Message posted to room." }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "list_rooms": {
      const { filter = "mine" } = (args ?? {}) as { filter?: "mine" | "all" };
      try {
        const result = await brokerFetch<{ rooms: Array<{ id: string; name: string; topic: string; member_count: number; last_message_at: string | null }> }>(
          "/list-rooms", filter === "mine" && myId ? { peer_id: myId } : {}
        );
        if (result.rooms.length === 0) return { content: [{ type: "text" as const, text: `No rooms found (filter: ${filter}).` }] };
        const lines = result.rooms.map((r) => {
          const parts = [`#${r.name}  ID: ${r.id}  Members: ${r.member_count}`];
          if (r.topic) parts.push(`  Topic: ${r.topic}`);
          if (r.last_message_at) parts.push(`  Last message: ${r.last_message_at}`);
          return parts.join("\n");
        });
        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Notification helpers ---

async function pushDm(msg: { id: number; from_id: string; to_id: string; text: string; sent_at: string }) {
  let fromName = "", fromSummary = "", fromCwd = "";
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
    const sender = peers.find((p) => p.id === msg.from_id);
    if (sender) { fromName = sender.name; fromSummary = sender.summary; fromCwd = sender.cwd; }
  } catch { /* non-critical */ }

  const label = fromName ? `${fromName} (${msg.from_id})` : msg.from_id;
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: `[DM from ${label}] ${msg.text}`,
      meta: { type: "direct_message", from_id: msg.from_id, from_name: fromName, from_summary: fromSummary, from_cwd: fromCwd, sent_at: msg.sent_at },
    },
  });
  log(`DM from ${label}: ${msg.text}`);
}

async function pushRoomMessage(msg: RoomMessage) {
  if (msg.from_id === myId) return; // don't echo own messages

  let fromName = "", fromSummary = "", fromCwd = "";
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
    const sender = peers.find((p) => p.id === msg.from_id);
    if (sender) { fromName = sender.name; fromSummary = sender.summary; fromCwd = sender.cwd; }
  } catch { /* non-critical */ }

  const label = fromName ? `${fromName} (${msg.from_id})` : msg.from_id;
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: `[#${msg.room_name}] ${label}: ${msg.text}`,
      meta: { type: "room_message", room_id: msg.room_id, room_name: msg.room_name, from_id: msg.from_id, from_name: fromName, from_summary: fromSummary, from_cwd: fromCwd, sent_at: msg.sent_at },
    },
  });
  log(`Room #${msg.room_name} from ${label}: ${msg.text}`);
}

async function pushPresenceChange(data: { peer_id: string; status: string; room_id: string; updated_at: string }) {
  if (data.peer_id === myId) return;

  let peerName = "";
  try {
    const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
    const peer = peers.find((p) => p.id === data.peer_id);
    if (peer) peerName = peer.name;
  } catch { /* non-critical */ }

  const label = peerName ? `${peerName} (${data.peer_id})` : data.peer_id;
  const emoji = data.status === "online" ? "🟢" : data.status === "idle" ? "🟡" : "🔴";
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: `${emoji} ${label} is now ${data.status}`,
      meta: { type: "presence_change", peer_id: data.peer_id, status: data.status, room_id: data.room_id, updated_at: data.updated_at },
    },
  });
  log(`Presence: ${label} → ${data.status}`);
}

// --- WebSocket connection to broker ---

let brokerWs: WebSocket | null = null;
let wsReady = false;

function connectBrokerWs() {
  if (!myId) return;
  log(`Connecting WebSocket to ${BROKER_WS_URL}...`);

  const ws = new WebSocket(BROKER_WS_URL);
  brokerWs = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", peer_id: myId }));
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data as string);
      if (data.type === "auth_ok") {
        wsReady = true;
        log(`WebSocket ready (peer ${data.peer_id})`);
      } else if (data.type === "dm") {
        await pushDm(data.message);
      } else if (data.type === "room_message") {
        await pushRoomMessage(data.message);
      } else if (data.type === "presence") {
        await pushPresenceChange(data);
      }
    } catch (e) {
      log(`WS message error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  ws.onclose = () => {
    wsReady = false;
    brokerWs = null;
    log("WebSocket closed, reconnecting in 3s...");
    setTimeout(connectBrokerWs, 3000);
  };

  ws.onerror = () => ws.close();
}

// --- Fallback poll (runs every 10s to catch anything missed during WS downtime) ---

async function pollAndPushMessages() {
  if (!myId) return;
  try {
    const [dmResult, roomResult] = await Promise.all([
      brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId }),
      brokerFetch<PollRoomMessagesResponse>("/poll-room-messages", { peer_id: myId }),
    ]);
    for (const msg of dmResult.messages) await pushDm(msg);
    for (const msg of roomResult.messages) await pushRoomMessage(msg);
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running (skip auto-launch for remote brokers)
  if (IS_REMOTE) {
    if (!(await isBrokerAlive())) {
      throw new Error(`Remote broker at ${BROKER_URL} is not reachable`);
    }
    log(`Connected to remote broker at ${BROKER_URL}`);
  } else {
    await ensureBroker();
  }

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Detect username (env var override or git config)
  myName = process.env.CLAUDE_MULTIPLAYER_NAME ?? await getGitUserName();
  if (myName) log(`Username: ${myName}`);

  // 5. Register with broker (pid=0 for remote so broker uses heartbeat-only liveness)
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: IS_REMOTE ? 0 : process.pid,
    name: myName,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // Connect WebSocket for real-time push delivery
  connectBrokerWs();

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
