import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import { CloudflareSandboxProvider } from "../src/index.js";
import {
  PEPPER,
  expectNewPasswordAccepted,
  runtimeForDriver,
} from "./harness.js";
import { MockResetSite } from "./mock-site.js";

const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? "/usr/bin/google-chrome";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    address instanceof Object && "port" in address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface ChromiumCdp {
  webSocketUrl: string;
  stop: () => Promise<void>;
}

const versionSchema = z.object({ webSocketDebuggerUrl: z.string() });

async function launchChromiumCdp(): Promise<ChromiumCdp> {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), "os-cdp-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);
  const stopChrome = async () => {
    if (chrome.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        chrome.once("exit", () => resolve()),
      );
      chrome.kill("SIGKILL");
      await exited;
    }
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  };
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = versionSchema.parse(await response.json());
          return {
            webSocketUrl: version.webSocketDebuggerUrl,
            stop: stopChrome,
          };
        }
      } catch {
        // Chromium is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("chromium CDP endpoint did not start");
  } catch (error) {
    await stopChrome();
    throw error;
  }
}

function fakeBrowserRun(webSocketUrl: string): Promise<{
  baseUrl: string;
  deleted: string[];
  close: () => Promise<void>;
}> {
  const deleted: string[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/devtools/browser") {
      if (request.headers.authorization !== "Bearer cf-test-token") {
        response.writeHead(401).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (part: string) => {
        body += part;
      });
      request.on("end", () => {
        if (
          body !==
          JSON.stringify({ guardrails: { allowedDomains: ["127.0.0.1"] } })
        ) {
          response.writeHead(400).end();
          return;
        }
        const address = z
          .object({ port: z.number() })
          .safeParse(server.address());
        if (!address.success)
          throw new Error("missing test server address");
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            sessionId: "fake-session-1",
            webSocketDebuggerUrl: `ws://127.0.0.1:${address.data.port}/devtools/browser/fake-session-1`,
          }),
        );
      });
      return;
    }
    if (request.method === "DELETE") {
      deleted.push(request.url ?? "");
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ success: true, result: null }));
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/devtools/browser/fake-session-1" ||
      request.headers.authorization !== "Bearer cf-test-token"
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (incoming) => {
      incoming.pause();
      const chrome = new WebSocket(webSocketUrl);
      chrome.once("open", () => {
        incoming.on("message", (data, binary) => chrome.send(data, { binary }));
        chrome.on("message", (data, binary) => incoming.send(data, { binary }));
        incoming.resume();
      });
      chrome.on("error", () => incoming.close());
      chrome.on("close", () => incoming.close());
      incoming.on("error", () => chrome.close());
      incoming.on("close", () => chrome.close());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address instanceof Object && "port" in address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        deleted,
        close: async () => {
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

test("full reset on Cloudflare Browser Run shape: REST allocation + CDP driver", async () => {
  const site = new MockResetSite();
  await site.start(true);
  const chromium = await launchChromiumCdp();
  const fake = await fakeBrowserRun(chromium.webSocketUrl);
  try {
    const provider = new CloudflareSandboxProvider({
      accountId: "acct-test",
      apiToken: "cf-test-token",
      baseUrl: fake.baseUrl,
      allowInsecureLoopbackForTesting: true,
    });
    const sandbox = await provider.allocate({ origin: site.origin });
    expect(sandbox.provider).toBe("cloudflare");
    expect(sandbox.session).toBe("fake-session-1");
    const runtime = runtimeForDriver(sandbox.browser, site, true);
    const parked = await runtime.runner.start(runtime.initial);
    expect(parked.status).toBe("awaiting_human");
    const finished = await runtime.runner.resumeAfterHuman(parked);
    expect(finished.status).toBe("succeeded");
    expect(site.submissions).toBe(1);
    await expectNewPasswordAccepted(runtime.custody, site);
    const journalText = JSON.stringify(await runtime.store.load("run-1"));
    expect(journalText).not.toContain(PEPPER);
    await sandbox.close();
    expect(fake.deleted).toEqual(["/devtools/browser/fake-session-1"]);
  } finally {
    await fake.close();
    await chromium.stop();
    await site.stop();
  }
});
