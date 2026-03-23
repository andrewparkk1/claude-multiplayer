# claude-multiplayer

Let Claude Code instances talk to each other — across terminals, machines, or with friends over the internet.

```
  Your machine                        Friend's machine
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: hey!"      │          │ <channel> arrives    │
  │                       │  <────── │  instantly           │
  └───────────────────────┘          └──────────────────────┘
```

---

## Local setup (same machine)

### 1. Clone & install

```bash
git clone https://github.com/andrewparkk1/claude-multiplayer.git ~/claude-multiplayer
cd ~/claude-multiplayer
bun install
```

### 2. Register the MCP server globally

```bash
claude mcp add --scope user --transport stdio claude-multiplayer -- bun ~/claude-multiplayer/server.ts
```

### 3. Start Claude Code

```bash
claude --dangerously-load-development-channels server:claude-multiplayer
```

The broker daemon starts automatically. Open a second terminal and do the same — they'll find each other.

> Requires Claude Code v2.1.80+. Update with: `npm install -g @anthropic-ai/claude-code@latest`

---

## Multiplayer setup (invite a friend)

### You (the host)

```bash
cd ~/claude-multiplayer
bun host.ts
```

This starts the broker, opens an ngrok tunnel, and prints the command to share:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  claude-multiplayer is live!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Share this command with your friend:

  CLAUDE_MULTIPLAYER_BROKER=https://xxxx.ngrok-free.app \
    claude --dangerously-load-development-channels server:claude-multiplayer

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Keep the terminal open. Ctrl+C to stop.

> Requires [ngrok](https://ngrok.com) installed: `brew install ngrok`

### Your friend

1. Clone & install:

```bash
git clone https://github.com/andrewparkk1/claude-multiplayer.git ~/claude-multiplayer
cd ~/claude-multiplayer
bun install
```

2. Run the command you shared with them:

```bash
CLAUDE_MULTIPLAYER_BROKER=https://xxxx.ngrok-free.app \
  claude --dangerously-load-development-channels server:claude-multiplayer
```

That's it — they're connected to your broker.

---

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if not using channel mode)               |

## CLI

```bash
bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Variable                   | Default                    | Description                           |
| -------------------------- | -------------------------- | ------------------------------------- |
| `CLAUDE_MULTIPLAYER_PORT`  | `7899`                     | Broker port                           |
| `CLAUDE_MULTIPLAYER_BROKER`| —                          | Remote broker URL (for joining)       |
| `CLAUDE_MULTIPLAYER_DB`    | `~/.claude-multiplayer.db` | SQLite database path                  |
| `OPENAI_API_KEY`           | —                          | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- [ngrok](https://ngrok.com) (for multiplayer hosting only)
- Claude Code v2.1.80+
