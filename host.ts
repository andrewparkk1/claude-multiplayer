#!/usr/bin/env bun
/**
 * claude-multiplayer host
 *
 * One command to start everything and share with others:
 *   bun host.ts
 *
 * Starts the broker, opens an ngrok tunnel, and prints the
 * command your friend needs to run to join.
 */

const PORT = parseInt(process.env.CLAUDE_MULTIPLAYER_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${PORT}`;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

function log(msg: string) {
  console.log(msg);
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startBroker() {
  if (await isBrokerAlive()) {
    log("✓ Broker already running");
    return;
  }

  log("Starting broker...");

  // Kill anything on the port first
  const kill = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]);
  const pids = new TextDecoder().decode(kill.stdout).trim().split("\n").filter(Boolean);
  for (const pid of pids) process.kill(parseInt(pid), "SIGTERM");
  if (pids.length) await new Promise((r) => setTimeout(r, 500));

  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("✓ Broker started");
      return;
    }
  }
  throw new Error("Broker failed to start");
}

async function startNgrok(): Promise<string> {
  // Kill any existing ngrok on this port
  Bun.spawnSync(["pkill", "-f", `ngrok http ${PORT}`]);
  await new Promise((r) => setTimeout(r, 500));

  log("Starting ngrok tunnel...");
  const proc = Bun.spawn(["ngrok", "http", String(PORT), "--log=stdout"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  proc.unref();

  // Poll the ngrok API until the tunnel is up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch("http://localhost:4040/api/tunnels", {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = (await res.json()) as { tunnels: { public_url: string }[] };
        const url = data.tunnels.find((t) => t.public_url.startsWith("https"))?.public_url;
        if (url) return url;
      }
    } catch {
      // not up yet
    }
  }
  throw new Error("ngrok failed to start. Is it installed? (brew install ngrok)");
}

// --- Main ---

await startBroker();
const publicUrl = await startNgrok();

console.log("");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  claude-multiplayer is live!");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("");
console.log("  Share this command with your friend:");
console.log("");
console.log(`  CLAUDE_MULTIPLAYER_BROKER=${publicUrl} \\`);
console.log(`    claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-multiplayer`);
console.log("");
console.log("  Your broker URL:");
console.log(`  ${publicUrl}`);
console.log("");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  Press Ctrl+C to stop");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("");

// Keep process alive so ngrok stays up
process.on("SIGINT", async () => {
  console.log("\nShutting down...");

  // Kill ngrok
  Bun.spawnSync(["pkill", "-f", `ngrok http ${PORT}`]);

  // Kill the broker
  const kill = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]);
  const pids = new TextDecoder().decode(kill.stdout).trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    try { process.kill(parseInt(pid), "SIGTERM"); } catch {}
  }
  if (pids.length) log("Broker stopped");

  // Delete the database so next session starts clean
  const DB_PATH = process.env.CLAUDE_MULTIPLAYER_DB ?? `${process.env.HOME}/.claude-multiplayer.db`;
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(DB_PATH);
    try { unlinkSync(DB_PATH + "-wal"); } catch {}
    try { unlinkSync(DB_PATH + "-shm"); } catch {}
    log("Database cleared");
  } catch {}

  process.exit(0);
});

// Ping broker every 30s to keep it alive
setInterval(async () => {
  if (!(await isBrokerAlive())) {
    console.error("Broker died, restarting...");
    await startBroker();
  }
}, 30_000);
