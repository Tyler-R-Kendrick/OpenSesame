import { createHash } from "node:crypto";
/** Safe actual SDK/HTTP observations; never retain private frame or credential values. */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function officialAssets(repo, dist, workerAsset) {
  const pins = JSON.parse(
    fs.readFileSync(
      path.join(
        repo,
        "apps/pages/src/lib/capabilities/tailscale-artifacts.json",
      ),
    ),
  );
  const compressed = fs.readFileSync(path.join(dist, pins.assets.wasm));
  if (
    digest(compressed) !== pins.sdk.gzipHash ||
    digest(gunzipSync(compressed)) !== pins.sdk.wasmHash
  )
    throw Error("Official WASM pin mismatch");
  if (
    digest(fs.readFileSync(path.join(dist, pins.assets.runtime))) !==
    pins.sdk.runtimeHash
  )
    throw Error("Official runtime pin mismatch");
  return {
    sdk: pins.sdk,
    wasm: {
      file: pins.assets.wasm,
      bytes: compressed.length,
      sha256: digest(compressed),
    },
    runtime: { file: pins.assets.runtime, sha256: pins.sdk.runtimeHash },
    worker: {
      file: workerAsset,
      sha256: digest(fs.readFileSync(path.join(dist, workerAsset))),
    },
  };
}
export function attachObservers({
  page,
  context,
  width,
  h,
  origin,
  base,
  workerAsset,
  workers,
  network,
  sockets,
  record,
}) {
  page.on("worker", (worker) => {
    if (new URL(worker.url()).pathname !== base + workerAsset) return;
    const row = {
      width,
      url: worker.url(),
      startedDuring: h.step(),
      closed: false,
    };
    workers.push(row);
    worker.on("close", () => {
      row.closed = true;
      row.closedDuring = h.step();
    });
  });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && /go-runtime|\.wasm\.gz$/.test(url.pathname))
      record("official-sdk-resource", url.pathname);
    network.push({
      step: h.step(),
      method: request.method(),
      origin: url.origin,
      path: url.pathname,
    });
  });
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    const row = {
      width,
      origin: url.origin,
      path: url.pathname,
      sentFrames: 0,
      receivedFrames: 0,
      sentBytes: 0,
      receivedBytes: 0,
      closed: false,
    };
    sockets.push(row);
    socket.on("framesent", ({ payload }) => {
      row.sentFrames++;
      row.sentBytes += Buffer.byteLength(payload);
    });
    socket.on("framereceived", ({ payload }) => {
      row.receivedFrames++;
      row.receivedBytes += Buffer.byteLength(payload);
    });
    socket.on("close", () => {
      row.closed = true;
    });
  });
}
export async function primaryInventory(page) {
  return page.locator(".cx-setup").evaluate((root) => ({
    panels: [...root.querySelectorAll(":scope > section.panel")].map((n) => ({
      name: n.getAttribute("aria-label"),
      heading: n.querySelector("h2")?.innerText ?? null,
    })),
    headings: [...root.querySelectorAll("h2,h3")].map((n) => n.innerText),
    labels: [...root.querySelectorAll("label")].map((n) => n.innerText),
    buttons: [...root.querySelectorAll("button")].map(
      (n) => n.getAttribute("aria-label") ?? n.textContent,
    ),
    help: root.innerText,
  }));
}
export function assertPrimary(h, phase, width, stage, inventory) {
  h.check(
    inventory.panels.filter((n) => n.name === "Tailscale browser node")
      .length === 1,
    `${width} ${stage}: exactly one actual browser peering panel`,
  );
  if (phase !== "after") return;
  h.check(
    inventory.panels.length === 1,
    `${width} ${stage}: primary entry mounts only the browser peering panel`,
  );
  const management =
    /Tailscale OAuth app configuration|Returned Tailscale app configuration|Tailscale device provisioning|Tailscale device key handoff|Prepare Tailscale registration|Import returned app|Admin API access token|Returned OAuth app JSON|Download registration request|Register app with Tailscale|Prepare device key handoff|App name|Redirect URI to register/;
  h.check(
    !management.test(JSON.stringify(inventory)),
    `${width} ${stage}: no OAuth app registration/import/device management controls or help`,
  );
}
export function assertHomeMembership(h, width, stage, live, homeMeasurements) {
  const result = homeMeasurements.at(-1);
  const current = result.rows.filter(
    (r) => r.group === "connected" && r.isCurrentNode,
  );
  h.check(
    current.length === (live ? 1 : 0) &&
      current.every((r) => r.statuses.some((s) => s.tone === "ok")),
    `${width} ${stage}: actual home admits only the live current browser node`,
  );
  if (width !== 1280) return;
  const branch = result.rail.find((r) => r.label === "Connected");
  h.check(
    branch?.count === (live ? "1" : "-"),
    `${width} ${stage}: actual Connected rail count matches membership`,
  );
}
export function protocolReceipt(fixture) {
  return {
    controlUpgrades: fixture.control.filter(
      (r) =>
        r.kind === "upgrade" &&
        r.path === "/ts2021" &&
        r.subprotocol === "tailscale-control-protocol",
    ).length,
    derpUpgrades: fixture.derp.filter(
      (r) =>
        r.kind === "upgrade" && r.path === "/derp" && r.subprotocol === "derp",
    ).length,
    nativePeerGets: fixture.peer.filter(
      (r) => r.method === "GET" && r.path === "/proof",
    ).length,
  };
}
export function checkNetwork(h, network, protocol) {
  const kinds = [
    "PAGE-ERROR",
    "console-error",
    "HTTP-ERROR",
    "MISSING-ASSET",
    "unexpected-external-request",
    "worker-network-error",
    "network-failure",
  ];
  for (const row of h.log)
    if (kinds.includes(row.kind)) h.failures.push(`${row.kind}: ${row.detail}`);
  const management = network.filter((r) =>
    /\/api\/v2\/(?:tailnet\/[^/]+\/oauth-apps|oauth\/token)|\/a\/oauth_authorize(?:$|\/)/.test(
      r.path,
    ),
  );
  h.check(
    management.length === 0,
    "No observed OAuth app registration/token/provisioning management HTTP traffic",
  );
  h.check(
    (protocol?.controlUpgrades ?? 0) > 0,
    "Actual provider observed Noise control WebSocket upgrades",
  );
  h.check(
    (protocol?.derpUpgrades ?? 0) > 0,
    "Actual provider observed real DERP WebSocket upgrades",
  );
  h.check(
    (protocol?.nativePeerGets ?? 0) > 0,
    "Actual native peer received encrypted tailnet GETs",
  );
  h.check(
    h.log.some(
      (r) =>
        r.kind === "official-sdk-resource" && r.detail.endsWith(".wasm.gz"),
    ),
    "Actual official owned WASM asset loaded",
  );
  return management;
}
