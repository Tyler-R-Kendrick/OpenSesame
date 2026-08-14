import { loadSettings, saveSettings, shippedDaemonApi } from "./settings.js";
import { normalizeTailnetBase } from "./urls.js";

export type DaemonHealth = {
  status: string;
  service: string;
  hostApi: string;
  identityApi: string;
  tailscaleUrl: string | null;
};

const PROBE_MS = 2500;

export async function probeDaemon(
  raw: string = loadSettings().daemonApi || shippedDaemonApi,
): Promise<DaemonHealth> {
  const base = normalizeTailnetBase(raw);
  if (!base) {
    throw new Error("That daemon address is not one this page may call.");
  }
  const res = await fetch(`${base}/health`, {
    credentials: "omit",
    signal: AbortSignal.timeout(PROBE_MS),
  });
  if (!res.ok) {
    throw new Error(`Daemon ${res.status} at ${base}`);
  }
  const body = (await res.json()) as {
    status?: unknown;
    service?: unknown;
    host_api?: unknown;
    identity_api?: unknown;
    tailscale_url?: unknown;
  };
  if (body.service !== "opensesame-daemon") {
    throw new Error("That URL answered, but it is not an OpenSesame daemon.");
  }
  return {
    status: typeof body.status === "string" ? body.status : "ok",
    service: "opensesame-daemon",
    hostApi:
      typeof body.host_api === "string" && body.host_api
        ? body.host_api
        : "http://127.0.0.1:8787",
    identityApi:
      typeof body.identity_api === "string" && body.identity_api
        ? body.identity_api
        : "http://127.0.0.1:8788",
    tailscaleUrl:
      typeof body.tailscale_url === "string" && body.tailscale_url
        ? body.tailscale_url
        : null,
  };
}

/** Remember the daemon and the Host/Identity it advertised. */
export function applyDaemonPairing(
  daemonApi: string,
  health: DaemonHealth,
): void {
  const current = loadSettings();
  const publicBase = health.tailscaleUrl || daemonApi;
  saveSettings({
    ...current,
    daemonApi: publicBase,
    hostApi: health.hostApi,
    identityApi: health.identityApi,
  });
}
