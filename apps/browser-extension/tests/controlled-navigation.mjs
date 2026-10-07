import { readFile } from "node:fs/promises";
import path from "node:path";

/** Connect only to the random loopback debugging endpoint of our own browser profile. */
async function profileDebugger(profile) {
  const raw = await readFile(path.join(profile, "DevToolsActivePort"), "utf8");
  if (raw.length > 4096) throw new Error("Invalid local debugging endpoint.");
  const [port, endpoint] = raw.trim().split("\n");
  if (
    !/^[0-9]{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    !/^\/devtools\/browser\/[a-f0-9-]+$/.test(endpoint)
  )
    throw new Error("Invalid local debugging endpoint.");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

function debuggingCommands(socket) {
  const pending = new Map();
  let next = 0;
  function command(sessionId, method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const key = `${sessionId ?? "browser"}:${id}`;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`Controlled debugging request failed: ${method}`));
      }, 5000);
      pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const packet = { id, method, params };
      if (sessionId) packet.sessionId = sessionId;
      socket.send(JSON.stringify(packet));
    });
  }
  return {
    command,
    accept(reply) {
      if (!reply.id) return false;
      const key = `${reply.sessionId ?? "browser"}:${reply.id}`;
      const operation = pending.get(key);
      pending.delete(key);
      if (reply.error) operation?.reject(new Error(reply.error.message));
      else operation?.resolve(reply.result);
      return true;
    },
    close() {
      for (const operation of pending.values())
        operation.reject(new Error("Controlled navigation ended."));
      pending.clear();
    },
  };
}

/** Intercept native extension-created tabs before their initial document dispatch. */
export async function controlWorkflowNavigation(profile, destination) {
  const socket = await profileDebugger(profile);
  const reached = [];
  const errors = [];
  const commands = debuggingCommands(socket);
  const { command } = commands;
  const work = new Set();
  function track(task) {
    work.add(task);
    void task
      .catch((error) => errors.push(error.message))
      .finally(() => work.delete(task));
  }
  const receive = ({ data }) => {
    const reply = JSON.parse(data);
    const sessionId = reply.sessionId;
    if (commands.accept(reply)) return;
    if (reply.method === "Fetch.requestPaused") {
      reached.push(reply.params.request.url);
      track(
        command(sessionId, "Fetch.fulfillRequest", {
          requestId: reply.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
          body: Buffer.from(
            '<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Controlled navigation endpoint; no vault or credentials.</body></html>',
          ).toString("base64"),
        }),
      );
    }
  };
  socket.addEventListener("message", receive);
  // Browser-session Fetch catches native tabs before their initial document dispatch.
  // Page-session attachment happens too late for chrome.tabs.create navigation.
  try {
    await command(undefined, "Fetch.enable", {
      patterns: [{ urlPattern: `${destination}*`, requestStage: "Request" }],
    });
  } catch (error) {
    socket.removeEventListener("message", receive);
    commands.close();
    socket.close();
    throw error;
  }
  return {
    reached,
    errors,
    async close() {
      try {
        await command(undefined, "Fetch.disable");
        while (work.size) await Promise.allSettled([...work]);
      } finally {
        socket.removeEventListener("message", receive);
        commands.close();
        socket.close();
      }
    },
  };
}
