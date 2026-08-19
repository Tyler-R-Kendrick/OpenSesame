import { type DaemonHealth, probeDaemon } from "./daemon.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import { loadSettings, pageIsLoopback, shippedDaemonApi } from "./settings.js";
import { isLoopbackUrl, normalizeTailnetBase } from "./urls.js";

/**
 * Install / open the Tailscale *client* on this machine.
 *
 * Do not use `https://login.tailscale.com/start` — for a browser already signed
 * into Tailscale it redirects to the admin console (`/admin/machines`) and never
 * posts auth back to github.io. Joining the tailnet requires the local client.
 */
export const TAILSCALE_CLIENT_URL = "https://tailscale.com/download";

const HELLO = "https://hello.ts.net";
const PROBE_MS = 4000;
const WAIT_INTERVAL_MS = 1500;
const WAIT_TIMEOUT_MS = 45_000;

export type CandidateOptions = {
  /** Include http://127.0.0.1:18790 — only useful when the page is on loopback. */
  allowLoopback?: boolean;
};

/**
 * Candidate daemon bases this page may probe.
 *
 * Tailscale Serve TLS certs are issued for `https://machine.tailnet.ts.net` only.
 * Bare `https://hostname` names fail certificate checks and must not be probed.
 * Loopback is unreachable from github.io.
 */
export function tailscaleCandidates(
  saved?: string,
  options: CandidateOptions = {},
): string[] {
  const allowLoopback = options.allowLoopback ?? pageIsLoopback();
  const urls: string[] = [];
  const trimmed = saved?.trim();
  if (trimmed) {
    const normalized = normalizeTailnetBase(trimmed);
    if (normalized) {
      const loopback = isLoopbackUrl(normalized);
      if (!loopback || allowLoopback) {
        // Prefer full Serve FQDNs; skip bare https MagicDNS (invalid cert).
        try {
          const host = new URL(normalized).hostname.toLowerCase();
          const bareHttps =
            normalized.startsWith("https://") &&
            !host.includes(".") &&
            !host.endsWith(".ts.net");
          if (!bareHttps) urls.push(normalized);
        } catch {
          urls.push(normalized);
        }
      }
    }
  }
  if (allowLoopback) {
    urls.push(shippedDaemonApi);
  }
  return [...new Set(urls.filter(Boolean))];
}

export async function detectTailnet(): Promise<boolean> {
  try {
    // no-cors: opaque success means the OS resolved hello.ts.net on the tailnet.
    // Hard timeout so Chrome's local-network permission dialog cannot strand us.
    const res = await localNetworkFetch(HELLO, {
      mode: "no-cors",
      credentials: "omit",
      timeoutMs: PROBE_MS,
    });
    return res.type === "opaque" || res.type === "opaqueredirect" || res.ok;
  } catch {
    return false;
  }
}

export type WaitForTailnetOptions = {
  probe?: () => Promise<boolean>;
  intervalMs?: number;
  timeoutMs?: number;
};

/** Poll until this browser/OS is on the tailnet, or time out. */
export async function waitForTailnet(
  options: WaitForTailnetOptions = {},
): Promise<boolean> {
  const probe = options.probe ?? detectTailnet;
  const intervalMs = options.intervalMs ?? WAIT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function discoverErrorMessage(input: {
  fromGithubPages: boolean;
  triedLoopback: boolean;
  detail?: string;
}): string {
  const parts: string[] = [];
  if (input.fromGithubPages && input.triedLoopback) {
    parts.push("This github.io page cannot reach 127.0.0.1 (or localhost).");
  }
  if (!input.fromGithubPages && input.triedLoopback) {
    parts.push(
      "No daemon answered on loopback (http://127.0.0.1:18790). Start opensesame-daemon on this machine, or paste its Tailscale Serve URL.",
    );
  }
  parts.push(
    "Paste the daemon's Tailscale Serve URL (https://YOUR-MACHINE.YOUR-TAILNET.ts.net).",
  );
  parts.push(
    "On the daemon machine: curl -s http://127.0.0.1:18790/health — if Serve is off, open tailscale_serve_enable_url, sign in, restart the daemon, then paste tailscale_url here.",
  );
  if (input.fromGithubPages) {
    parts.push(
      "github.io cannot use localhost. Bare https://hostname MagicDNS names fail TLS; the FQDN .ts.net Serve URL is required.",
    );
  } else {
    parts.push(
      "Bare https://hostname MagicDNS names fail TLS; use the FQDN ending in .ts.net.",
    );
  }
  if (input.detail) parts.push(input.detail);
  return parts.join(" ");
}

export async function discoverTailscaleDaemon(
  preferred?: string,
): Promise<DaemonHealth> {
  const saved = preferred?.trim() || loadSettings().daemonApi;
  const allowLoopback = pageIsLoopback();
  const candidates = tailscaleCandidates(saved, { allowLoopback });
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return await probeDaemon(candidate);
    } catch (error) {
      errors.push(
        `${candidate}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }
  throw new Error(
    discoverErrorMessage({
      fromGithubPages: !allowLoopback,
      triedLoopback:
        Boolean(saved && isLoopbackUrl(saved)) ||
        candidates.some((c) => isLoopbackUrl(c)) ||
        (!allowLoopback && Boolean(saved && isLoopbackUrl(saved))),
      detail: errors[0],
    }),
  );
}

export function openTailscaleLogin(): void {
  globalThis.open(TAILSCALE_CLIENT_URL, "_blank", "noopener,noreferrer");
}

/** Reject loopback daemon URLs when this tab is not on loopback. */
export function assertDaemonReachableFromPage(raw: string): void {
  if (pageIsLoopback()) return;
  const base = normalizeTailnetBase(raw);
  if (base && isLoopbackUrl(base)) {
    throw new Error(
      discoverErrorMessage({
        fromGithubPages: true,
        triedLoopback: true,
      }),
    );
  }
  if (!base) {
    throw new Error(
      "Daemon URL must be https://machine.tailnet.ts.net (Tailscale Serve) or a Tailscale CGNAT http URL.",
    );
  }
  try {
    const host = new URL(base).hostname.toLowerCase();
    if (base.startsWith("https://") && !host.endsWith(".ts.net")) {
      throw new Error(
        "Tailscale Serve HTTPS needs the full name ending in .ts.net (bare https://hostname fails TLS).",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Tailscale Serve")) {
      throw error;
    }
  }
}
