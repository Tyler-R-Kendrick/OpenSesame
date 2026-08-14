import { loadSettings, saveSettings, shippedDaemonApi } from "./settings.js";
import { normalizeApiBase } from "./urls.js";

export type DaemonHealth = {
  status: string;
  service: string;
  hostApi: string;
  identityApi: string;
};

const PROBE_MS = 2500;

export async function probeDaemon(
  raw: string = loadSettings().daemonApi || shippedDaemonApi,
): Promise<DaemonHealth> {
  const base = normalizeApiBase(raw);
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
  };
}

/** Remember the daemon and the Host/Identity it advertised. */
export function applyDaemonPairing(
  daemonApi: string,
  health: DaemonHealth,
): void {
  const current = loadSettings();
  saveSettings({
    ...current,
    daemonApi,
    hostApi: health.hostApi,
    identityApi: health.identityApi,
  });
}
