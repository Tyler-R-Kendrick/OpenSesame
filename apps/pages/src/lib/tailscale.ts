import { type DaemonHealth, probeDaemon } from "./daemon.js";
import { loadSettings, shippedDaemonApi } from "./settings.js";

const TAILSCALE_START = "https://login.tailscale.com/start";
const HELLO = "https://hello.ts.net";
const PROBE_MS = 2500;

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
  window.open(TAILSCALE_START, "_blank", "noopener,noreferrer");
}
