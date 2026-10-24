import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWindows } from "./web-score-common.mjs";

export function signalTree(pid, signal) {
  if (!pid) return;
  try {
    if (isWindows) {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // already stopped
  }
}

function waitForExit(child, timeout = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChild(child, timeout = 1_500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child.pid, "SIGTERM");
  if (await waitForExit(child, timeout)) return;
  signalTree(child.pid, "SIGKILL");
  await waitForExit(child, timeout);
}

export async function cleanup(children, profileDir) {
  await Promise.all([...children].map((child) => stopChild(child)));
  try {
    await rm(profileDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    // A locked profile is swept after it ages out on a later run.
  }
}

export function cleanupSync(children, profileDir) {
  for (const child of children) signalTree(child.pid, "SIGKILL");
  try {
    rmSync(profileDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  } catch {
    // A locked profile is swept after it ages out on a later run.
  }
}

/** Remove abandoned web-score profiles without touching a concurrent run. */
export function sweepProfiles(maxAgeMs = 2 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith("web-score-")) continue;
    const path = join(tmpdir(), name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Already removed or still held by another process.
    }
  }
}

/** Launch Chrome on an ephemeral debugging port; the port is read from disk. */
export function startChrome({ chrome, profileDir, noSandbox, children }) {
  let spawnError = null;
  const child = spawn(
    chrome,
    [
      "--headless=new",
      ...(noSandbox ? ["--no-sandbox"] : []),
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();
  children.add(child);
  return { child, getError: () => spawnError };
}

/** Wait for Chrome's DevToolsActivePort file and return the bound port. */
export async function waitForChrome(profileDir, child, getError) {
  const activePortPath = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (getError()) throw getError();
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited ${child.exitCode} before opening DevTools`,
      );
    }
    try {
      const port = Number.parseInt(
        readFileSync(activePortPath, "utf8").split(/\r?\n/u)[0],
        10,
      );
      if (port > 0) {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return port;
      }
    } catch {
      // Keep waiting for Chrome to write the active-port file.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Chrome did not expose a DevTools port");
}
