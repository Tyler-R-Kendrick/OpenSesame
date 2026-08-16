import { localNetworkFetch } from "./local-network-fetch.js";
import {
  loadSettings,
  pageIsLoopback,
  saveSettingsDurable,
  shippedDaemonApi,
} from "./settings.js";
import { isLoopbackUrl, normalizeTailnetBase } from "./urls.js";

export type DaemonHealth = {
  status: string;
  service: string;
  hostApi: string;
  identityApi: string;
  tailscaleUrl: string | null;
};

const PROBE_MS = 4000;

export async function probeDaemon(
  raw: string = loadSettings().daemonApi || shippedDaemonApi,
): Promise<DaemonHealth> {
  const base = normalizeTailnetBase(raw);
  if (!base) {
    throw new Error("That daemon address is not one this page may call.");
  }
  const res = await localNetworkFetch(`${base}/health`, {
    credentials: "omit",
    timeoutMs: PROBE_MS,
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

/**
 * Remember the daemon and Host/Identity bases for this browser.
 *
 * From github.io, always pin Host/Identity to the Serve base we paired with.
 * The daemon may still advertise loopback upstreams that this page cannot call.
 */
export async function applyDaemonPairing(
  daemonApi: string,
  health: DaemonHealth,
): Promise<void> {
  const current = loadSettings();
  const publicBase =
    normalizeTailnetBase(health.tailscaleUrl || daemonApi) ||
    normalizeTailnetBase(daemonApi);

  let hostApi = health.hostApi.trim();
  let identityApi = health.identityApi.trim();
  let savedDaemon = publicBase || daemonApi.trim();

  if (publicBase && !isLoopbackUrl(publicBase)) {
    const root = publicBase.replace(/\/$/, "");
    hostApi = `${root}/host`;
    identityApi = `${root}/identity`;
    savedDaemon = root;
  } else if (!pageIsLoopback()) {
    // Never persist loopback Host endpoints on a remote page — that forces
    // "Connect this machine" on every navigation.
    if (!hostApi || isLoopbackUrl(hostApi)) hostApi = current.hostApi;
    if (!identityApi || isLoopbackUrl(identityApi)) {
      identityApi = current.identityApi;
    }
  }

  await saveSettingsDurable({
    ...current,
    daemonApi: savedDaemon,
    hostApi,
    identityApi,
  });
}
