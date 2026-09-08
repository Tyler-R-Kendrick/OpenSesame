import { readBoundedObject } from "./bounded-response.js";
import { BrowserPairingError, browserPairingSeams } from "./browser-pairing.js";
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
  /** Legacy fixture field, never accepted as service identity by the probe. */
  service?: string;
  /**
   * The upstream planes, *if the daemon said*.
   *
   * Public health carries only status. It cannot establish service identity
   * or advertise trusted endpoints. These are always null in probe results;
   * null means "not stated" rather than a guess:
   * inventing `127.0.0.1:8787` here made pairing overwrite a working Host.
   */
  hostApi: string | null;
  identityApi: string | null;
  tailscaleUrl: string | null;
};

const PROBE_MS = 4000;

async function probeDaemonDefault(
  raw: string = loadSettings().daemonApi || shippedDaemonApi,
): Promise<DaemonHealth> {
  if (!browserPairingSeams.eligible())
    throw new BrowserPairingError("restricted_demo");
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
  const body = await readBoundedObject(res, 4096, PROBE_MS);
  if (body.status !== "ok") {
    throw new Error("That URL did not report healthy liveness.");
  }
  return {
    status: "ok",
    hostApi: null,
    identityApi: null,
    tailscaleUrl: null,
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
async function applyDaemonPairingDefault(
  daemonApi: string,
  health: DaemonHealth,
): Promise<void> {
  if (!browserPairingSeams.eligible())
    throw new BrowserPairingError("restricted_demo");
  const current = loadSettings();
  const publicBase =
    normalizeTailnetBase(health.tailscaleUrl || daemonApi) ||
    normalizeTailnetBase(daemonApi);

  let hostApi = health.hostApi?.trim() ?? "";
  let identityApi = health.identityApi?.trim() ?? "";
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

export const daemonSeams = {
  probeDaemon: probeDaemonDefault,
  applyDaemonPairing: applyDaemonPairingDefault,
};

export async function probeDaemon(raw?: string): Promise<DaemonHealth> {
  return raw === undefined
    ? daemonSeams.probeDaemon()
    : daemonSeams.probeDaemon(raw);
}

export async function applyDaemonPairing(
  daemonApi: string,
  health: DaemonHealth,
): Promise<void> {
  return daemonSeams.applyDaemonPairing(daemonApi, health);
}
