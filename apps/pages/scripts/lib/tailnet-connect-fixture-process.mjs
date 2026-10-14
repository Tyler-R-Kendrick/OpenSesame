import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const HEADSCALE_SHA =
  "af2a232ff407c100f05980b4d8fceaafc7fdb2e8de5eba8e184a8bb029cb6c00";
const TAILSCALE_SHA =
  "50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9";

export async function command(binary, args, options = {}) {
  try {
    const result = await execute(binary, args, {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
      ...options,
    });
    return result.stdout;
  } catch {
    // Command arguments/output can contain fixture enrollment credentials.
    throw new Error(
      `Tailnet fixture command failed: ${binary.split("/").at(-1)}`,
    );
  }
}

async function verifiedDownload(path, url, digest) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    await command("curl", ["-fLsS", "--retry", "3", "-o", path, url], {
      timeout: 180_000,
    });
    bytes = await readFile(path);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error("Tailnet fixture binary SHA-256 mismatch");
}

export async function fixtureBinaries(cache) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Pinned real tailnet fixture requires Linux x86-64");
  await mkdir(cache, { recursive: true });
  const headscale = join(cache, "headscale");
  const archive = join(cache, "tailscale.tgz");
  await verifiedDownload(
    headscale,
    "https://github.com/juanfont/headscale/releases/download/v0.27.1/headscale_0.27.1_linux_amd64",
    HEADSCALE_SHA,
  );
  await verifiedDownload(
    archive,
    "https://pkgs.tailscale.com/stable/tailscale_1.102.4_amd64.tgz",
    TAILSCALE_SHA,
  );
  await chmod(headscale, 0o700);
  await command("tar", ["-xzf", archive, "-C", cache]);
  return {
    headscale,
    tailscale: join(cache, "tailscale_1.102.4_amd64", "tailscale"),
    tailscaled: join(cache, "tailscale_1.102.4_amd64", "tailscaled"),
  };
}

export async function waitUntil(probe, description, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      // Servers and Unix sockets become available asynchronously.
    }
    await delay(200);
  }
  throw new Error(`Tailnet fixture timed out: ${description}`);
}

export async function ownedProcess(binary, args, log, env) {
  const output = await open(log, "w", 0o600);
  const child = spawn(binary, args, {
    env,
    stdio: ["ignore", output.fd, output.fd],
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () =>
      reject(new Error("Tailnet fixture process failed")),
    );
  });
  await output.close();
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  };
}
