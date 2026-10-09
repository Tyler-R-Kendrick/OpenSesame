/**
 * Gateway relay profile. Uses `OPENSESAME_RELAY_URL` when a process is
 * already up. Otherwise spawns `opensesame host run --profile relay` and
 * serves the join page beside it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeServer, listen, send } from "./vault-relay-io.mjs";
import { JOIN_HTML } from "./vault-relay-join-page.mjs";

function repoRoot() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function relayCommand(root, listenAddr) {
  const args = ["host", "run", "--profile", "relay", "--listen", listenAddr];
  const named = process.env.OPENSESAME_RELAY_BIN;
  if (named) return { cmd: named, args };
  const built = path.join(root, "target/debug/opensesame");
  if (existsSync(built)) return { cmd: built, args };
  return {
    cmd: "cargo",
    args: [
      "run",
      "-q",
      "-p",
      "opensesame-cli",
      "--bin",
      "opensesame",
      "--",
      ...args,
    ],
  };
}

async function waitForLive(origin, child, timeoutMs) {
  const started = Date.now();
  let log = "";
  const take = (chunk) => {
    log = `${log}${chunk}`.slice(-4000);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`relay exited ${child.exitCode}\n${log}`);
    }
    try {
      const response = await fetch(`${origin}/health/live`);
      if (response.status === 200 && (await response.text()) === "ok") return;
    } catch {
      // The process is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`relay did not answer ${origin}\n${log}`);
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function joinPageServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if ((request.method ?? "GET") === "GET" && url.pathname === "/join.html") {
      send(response, 200, JOIN_HTML, "text/html; charset=utf-8");
      return;
    }
    send(response, 404, { error: "not_found" });
  });
}

export async function startLiveRelay() {
  const page = joinPageServer();
  const pageOrigin = await listen(page);
  const already = process.env.OPENSESAME_RELAY_URL?.replace(/\/$/, "");
  if (already) {
    await waitForLive(already, { exitCode: null }, 5_000);
    return {
      origin: already,
      pageOrigin,
      live: true,
      close: () => closeServer(page),
    };
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const root = repoRoot();
  const command = relayCommand(root, `127.0.0.1:${port}`);
  const env = { ...process.env };
  env.OPENSESAME_SERVICE_BINDINGS_FILE = undefined;
  const child = spawn(command.cmd, command.args, {
    cwd: root,
    env: {
      ...env,
      OPENSESAME_GATEWAY_PROFILE: "relay",
      OPENSESAME_CORS_ORIGINS: pageOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForLive(
      origin,
      child,
      command.cmd === "cargo" ? 180_000 : 30_000,
    );
  } catch (error) {
    await stopChild(child);
    await closeServer(page);
    throw error;
  }
  return {
    origin,
    pageOrigin,
    live: true,
    close: async () => {
      await stopChild(child);
      await closeServer(page);
    },
  };
}
