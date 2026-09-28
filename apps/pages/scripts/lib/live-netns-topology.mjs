/**
 * The network verify:live-netns runs on (ADR 0150 §6): three Linux network
 * namespaces in one unprivileged user namespace, built from nothing but
 * `unshare`, `nsenter` and `lib/netns-plumb.py` (rtnetlink — no `ip`, no
 * sudo).
 *
 *     A (owner) ──tn0── 10.77.0.0/24 ──tn0── B (joiner)     no multicast
 *      │ up0                                    up0 │
 *      └── 10.78.1.0/24 ── H (harness) ── 10.78.2.0/24 ──┘  no forwarding
 *                        10.99.0.1 on lo: the "internet"
 *
 * `tn0` is what a tailnet interface looks like: a plain point-to-point
 * address with the multicast flag off, so an mDNS name never resolves across
 * it. `up0` is the machine's ordinary uplink — each side's default route —
 * and reaches only the harness (`H`), which does not forward: A and B have no
 * route to each other except `tn0`, and nothing but H hosts a carrier or TURN.
 *
 * Everything lives in a PID namespace as well, so when the runner dies —
 * however it dies — the kernel takes every process, and with them every
 * namespace, down with it.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUMB = path.join(here, "netns-plumb.py");
const INNER = "LIVE_NETNS_INNER";
const UNSHARE = [
  "--user",
  "--map-root-user",
  "--net",
  "--pid",
  "--fork",
  "--kill-child",
  "--mount-proc",
];

export const ADDRESS = {
  a: "10.77.0.1",
  b: "10.77.0.2",
  aUplink: "10.78.1.2",
  bUplink: "10.78.2.2",
  /** Where the harness's servers listen: an address on H's loopback. */
  internet: "10.99.0.1",
};

/** Why this machine cannot build the network, or null when it can. */
export function unsupported() {
  if (process.platform !== "linux") return "Linux network namespaces";
  for (const tool of ["unshare", "nsenter", "setpriv", "python3"]) {
    const found = spawnSync(tool, ["--version"], { stdio: "ignore" });
    if (found.error) return `\`${tool}\` on PATH`;
  }
  const probe = spawnSync("unshare", [...UNSHARE, "true"], {
    encoding: "utf8",
  });
  if (probe.status !== 0)
    return `unprivileged user, network and PID namespaces (unshare said: ${(probe.stderr || probe.error?.message || "nothing").trim()})`;
  return null;
}

/**
 * Re-run this script as root of a fresh user + network + PID namespace.
 * Returns the exit code of that run, or null when this process is the
 * inner one and should get on with it.
 */
export async function enterNamespace(script) {
  if (process.env[INNER]) return null;
  const missing = unsupported();
  if (missing) {
    console.error(
      `verify:live-netns cannot run: this machine has no ${missing}.
It needs Linux with unprivileged user namespaces (no root, no sudo). It never
skips itself: a skipped network test proves nothing.`,
    );
    return 2;
  }
  // setpriv: if this process is killed outright, so is everything beneath it.
  const child = spawn(
    "setpriv",
    [
      "--pdeathsig",
      "SIGKILL",
      "unshare",
      ...UNSHARE,
      process.execPath,
      script,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, [INNER]: "1" } },
  );
  const stop = () => child.kill("SIGKILL");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

function plumb(...args) {
  return execFileSync("python3", [PLUMB, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const netOf = (pid) => fs.readlinkSync(`/proc/${pid}/ns/net`);

/** A process alone in a new network namespace, waited for until it is. */
async function holder() {
  const own = netOf("self");
  const child = spawn("unshare", ["--net", "sleep", "86400"], {
    stdio: "ignore",
  });
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      const comm = fs.readFileSync(`/proc/${child.pid}/comm`, "utf8").trim();
      if (comm === "sleep" && netOf(child.pid) !== own) return child;
    } catch {
      // Not exec'd yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGKILL");
  throw new Error("a network namespace never came up");
}

/** A `chrome` that enters `pid`'s network namespace, then is the browser. */
function wrapper(dir, name, pid, chrome) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\nexec nsenter --net=/proc/${pid}/ns/net -- "${chrome}" "$@"\n`,
    { mode: 0o755 },
  );
  return file;
}

/**
 * Build A, B and their links. `chrome` is the real browser binary; the
 * result's `chrome.a` / `chrome.b` are executables to hand Playwright.
 */
export async function buildTopology(chrome) {
  const holders = [await holder(), await holder()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-netns-"));
  const stop = () => {
    for (const held of holders) held.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const [a, b] = holders.map((held) => held.pid);
    const { a: A, b: B } = ADDRESS;
    for (const pid of [0, a, b]) plumb("lo", String(pid));
    plumb("veth", `${a}:tn0:${A}/24`, `${b}:tn0:${B}/24`);
    plumb("veth", `${a}:up0:${ADDRESS.aUplink}/24`, "0:hA:10.78.1.1/24");
    plumb("veth", `${b}:up0:${ADDRESS.bUplink}/24`, "0:hB:10.78.2.1/24");
    plumb("alias", "0", "lo", `${ADDRESS.internet}/32`);
    plumb("route", String(a), "10.78.1.1", "up0");
    plumb("route", String(b), "10.78.2.1", "up0");
    return {
      pids: { a, b },
      chrome: {
        a: wrapper(dir, "chrome-a", a, chrome),
        b: wrapper(dir, "chrome-b", b, chrome),
      },
      /** Can `from` (a pid, 0 for H) send a datagram to `ip` inside `to`? */
      reach(from, to, ip) {
        try {
          plumb("reach", String(from), String(to), ip);
          return true;
        } catch {
          return false;
        }
      },
      interfaces: (pid) => JSON.parse(plumb("show", String(pid))),
      /** Take a link down: from then on there is no route over it at all. */
      down: (pid, dev) => plumb("down", String(pid), dev),
      forwarding: () =>
        fs.readFileSync("/proc/sys/net/ipv4/ip_forward", "utf8").trim() === "1",
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
