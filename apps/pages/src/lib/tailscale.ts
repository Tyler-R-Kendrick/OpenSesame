import { type DaemonHealth, probeDaemon } from "./daemon.js";
import { loadSettings, shippedDaemonApi } from "./settings.js";

/**
 * Install / open the Tailscale *client* on this machine.
 *
 * Do not use `https://login.tailscale.com/start` — for a browser already signed
 * into Tailscale it redirects to the admin console (`/admin/machines`) and never
 * posts auth back to github.io. Joining the tailnet requires the local client.
 */
export const TAILSCALE_CLIENT_URL = "https://tailscale.com/download";

const HELLO = "https://hello.ts.net";
const PROBE_MS = 2500;
const WAIT_INTERVAL_MS = 1500;
const WAIT_TIMEOUT_MS = 120_000;

export function tailscaleCandidates(saved?: string): string[] {
  const names = ["opensesame", "opensesame-daemon"];
  const urls = [
    ...names.map((name) => `https://${name}`),
    ...names.map((name) => `http://${name}:18790`),
    shippedDaemonApi,
  ];
  if (saved) urls.unshift(saved);
  return [...new Set(urls.filter(Boolean))];
}

export async function detectTailnet(): Promise<boolean> {
  try {
    await fetch(HELLO, {
      mode: "no-cors",
      signal: AbortSignal.timeout(PROBE_MS),
    });
    return true;
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

export async function discoverTailscaleDaemon(): Promise<DaemonHealth> {
  const saved = loadSettings().daemonApi;
  const errors: string[] = [];
  for (const candidate of tailscaleCandidates(saved)) {
    try {
      return await probeDaemon(candidate);
    } catch (error) {
      errors.push(
        `${candidate}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }
  throw new Error(
    `On the tailnet, but no OpenSesame daemon answered. Start the daemon on a Tailscale machine. ${errors[0] ?? ""}`,
  );
}

export function openTailscaleLogin(): void {
  globalThis.open(TAILSCALE_CLIENT_URL, "_blank", "noopener,noreferrer");
}
