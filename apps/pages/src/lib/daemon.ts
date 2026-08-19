import { localNetworkFetch } from "./local-network-fetch.js";
import {
  loadSettings,
  pageIsLoopback,
  saveSettingsDurable,
  shippedDaemonApi,
  shippedHostApi,
  shippedIdentityApi,
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
 * From github.io (or any non-loopback page), pin Host/Identity to the Serve
 * base we paired with — the daemon may still advertise loopback upstreams that
 * this page cannot call.
 *
 * From localhost / 127.0.0.1 Pages, keep Host/Identity on the loopback
 * upstreams the daemon advertises. Rewriting them to `https://…ts.net/host`
 * breaks Settings pairing: the tab can already reach 127.0.0.1, and forcing
 * Serve introduces CORS / Serve / TLS failures that look like "Tailscale
 * connect failed." Still remember the Tailscale URL as `daemonApi` so QR /
 * later github.io pairing have the FQDN.
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

  if (pageIsLoopback()) {
    if (publicBase && !isLoopbackUrl(publicBase)) {
      savedDaemon = publicBase.replace(/\/$/, "");
    } else {
      savedDaemon = daemonApi.trim() || savedDaemon;
    }
    // Prefer daemon-advertised loopback planes; fall back to shipped locals
    // (pages-dev Host :18787 / Identity :18788 — not the classic :8787 collision).
    if (!hostApi || !isLoopbackUrl(hostApi)) {
      hostApi =
        current.hostApi && isLoopbackUrl(current.hostApi)
          ? current.hostApi
          : shippedHostApi;
    }
    if (!identityApi || !isLoopbackUrl(identityApi)) {
      identityApi =
        current.identityApi && isLoopbackUrl(current.identityApi)
          ? current.identityApi
          : shippedIdentityApi;
    }
  } else if (publicBase && !isLoopbackUrl(publicBase)) {
    const root = publicBase.replace(/\/$/, "");
    hostApi = `${root}/host`;
    identityApi = `${root}/identity`;
    savedDaemon = root;
  } else {
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
