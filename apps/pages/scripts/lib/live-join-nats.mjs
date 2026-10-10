/**
 * verify:live-join's NATS walks (ADR 0167): a real nats-server in operator
 * mode, configured by `pnpm dev:live-nats`, and an owner who names it in
 * Routes with the account signing key — through the Form, as a person does.
 * Each session mints its own credentials; the link carries the joiner's and
 * never the signing key.
 *
 * - **nats-always** — the owner says the session always crosses the server:
 *   the joiner reveals a value with no peer connection up, and the server
 *   passed only sealed frames.
 * - **nats-fallback** — the default. The joiner's browser has no route to
 *   the owner's (no candidate at all), so after its wait the seat moves onto
 *   the server, sealed the same way.
 *
 * Both ask the server for the owner's tab as a NATS service (`$SRV.PING`)
 * and its `info` endpoint, which only a live session answers.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { freePort, spawnServer } from "./live-carriers.mjs";
import { engineOf } from "./live-engines.mjs";
import { linkRoutes } from "./live-join-profile.mjs";
import {
  endSession,
  joinerAsks,
  peerStates,
  setRoutes,
  startSession,
} from "./live-join-walk.mjs";
import { reachableBy } from "./live-tls-front.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const JOINER = "Ada Lovelace";
let walk;

export function bindNats(bound) {
  walk = bound;
}

/** No candidate of any kind: a browser with no route to anyone. */
export const NO_ROUTE = () => {
  const Inner = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Inner {
    constructor(config) {
      super({ ...(config ?? {}), iceServers: [], iceTransportPolicy: "relay" });
    }
  };
};

/** `pnpm dev:live-nats` into a fresh directory, and the server it configures. */
export async function startMintedNats(binary) {
  if (!binary || !fs.existsSync(binary)) return { missing: binary };
  const [port, wsPort] = [await freePort(), await freePort()];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-nats-op-"));
  const made = spawnSync(
    "pnpm",
    [
      "-s",
      "dev:live-nats",
      "--",
      "--websocket",
      `127.0.0.1:${wsPort}`,
      "--listen",
      `127.0.0.1:${port}`,
      "--out",
      dir,
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (made.status !== 0)
    throw new Error(`dev:live-nats failed: ${made.stderr || made.stdout}`);
  const { config, mint, watcher } = JSON.parse(
    made.stdout.trim().split("\n").at(-1),
  );
  const server = await spawnServer(binary, ["-c", config], wsPort);
  const url = `ws://127.0.0.1:${wsPort}`;
  const { jwtAuthenticator, wsconnect } = await import("@nats-io/nats-core");
  // The account's console: everything the server passed, anyone could have.
  const console_ = await wsconnect({
    servers: url,
    authenticator: jwtAuthenticator(
      watcher.jwt,
      new TextEncoder().encode(watcher.seed),
    ),
  });
  const frames = [];
  console_.subscribe(">", {
    callback: (_error, message) =>
      frames.push({ subject: message.subject, data: message.string() }),
  });
  return {
    url,
    mint,
    frames,
    console: console_,
    output: server.output,
    stop: async () => {
      await console_.close();
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function claimsOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
}

function checkLink(link, server, label) {
  const { check } = walk;
  check(
    !link.includes(server.mint.signingKey),
    `${label}: the link never carries the signing key`,
  );
  const carrier = linkRoutes(link)?.carriers?.[0] ?? {};
  check(
    Boolean(carrier.jwt && carrier.seed) && carrier.mint === undefined,
    `${label}: the link carries a credential minted for the session`,
  );
  const claims = claimsOf(carrier.jwt ?? "e30.e30.");
  const allow = claims.nats?.pub?.allow ?? [];
  check(
    allow.length === 2 &&
      allow.every((subject) => subject.startsWith("opensesame.live.")) &&
      // The start form's default: a session of an hour.
      Math.abs(claims.exp - (Date.now() / 1000 + 60 * 60)) < 120,
    `${label}: scoped to the session's subjects, expiring with it (${allow.join(", ")})`,
  );
  return allow[0];
}

async function checkService(server, base, label) {
  const { check } = walk;
  const ping = await server.console.request("$SRV.PING.opensesame-live", "", {
    timeout: 5000,
  });
  check(
    JSON.parse(ping.string()).name === "opensesame-live",
    `${label}: the owner's tab answers as a NATS service`,
  );
  const info = await server.console.request(`${base}.info`, "", {
    timeout: 5000,
  });
  check(
    info.string() === '{"live":true}',
    `${label}: its info endpoint says the session is live`,
  );
}

function checkFrames(server, base, label) {
  const { check, SECRET } = walk;
  const seat = server.frames.filter(({ subject }) =>
    subject.startsWith(`${base}.seat.`),
  );
  check(
    seat.length > 2,
    `${label}: the seat crossed the server (${seat.length} frames)`,
  );
  const heard = server.frames.map(({ data }) => data).join("\n");
  for (const [what, plain] of [
    ["the name", JOINER],
    ["an SDP", "v=0"],
    ["a field", '"octo"'],
    ["the value", SECRET],
  ])
    check(!heard.includes(plain), `${label}: the server never saw ${what}`);
}

/** One NATS walk: `always`, or the default fallback with no route between. */
export async function natsSession(browser, owner, binary, mode) {
  const { setStep, failures, device, shot, joined, check, SECRET, PHONE, TLS } =
    walk;
  const label = `nats-${mode}`;
  setStep(label);
  const started = await startMintedNats(binary);
  if (started.missing) {
    failures.push(`[${label}] no nats-server binary at ${started.missing}`);
    return;
  }
  const server = await reachableBy(
    started,
    [owner.engine, engineOf(browser)],
    TLS.cert,
  );
  try {
    const carrier = { kind: "nats", url: server.url, mint: server.mint };
    if (mode === "always") carrier.session = "always";
    await setRoutes(owner.page, { carriers: [carrier] });
    const { panel, code, link } = await startSession(owner.page);
    await panel
      .getByRole("img", { name: /^Carrying codes: / })
      .waitFor({ timeout: 20_000 });
    const base = checkLink(link, server, label);
    await checkService(server, base, label);
    const joiner = await device(browser, {
      ...PHONE,
      origin: owner.origin,
      dist: owner.dist,
      init: mode === "fallback" ? [[NO_ROUTE]] : [],
    });
    await joinerAsks(joiner.page, { link, code, name: JOINER, routes: true });
    const admit = panel.getByRole("button", { name: `Let ${JOINER} in` });
    await admit.waitFor({ timeout: 30_000 });
    await admit.click();
    await joined(joiner.page).waitFor({ timeout: 60_000 });
    await joiner.page
      .getByRole("button", { name: "Reveal GitHub Value" })
      .click();
    await expect(joiner.page.getByText(SECRET)).toBeVisible({
      timeout: 15_000,
    });
    await shot(joiner.page, `${label}-joined`);
    const { peers } = await peerStates(joiner.page);
    check(
      peers.every((peer) => peer.connection !== "connected"),
      `${label}: revealed with no peer connection up (${peers.map((peer) => peer.connection).join(", ")})`,
    );
    checkFrames(server, base, label);
    await endSession(panel);
    await joiner.context.close();
  } finally {
    await server.stop();
  }
}
