/**
 * Calls that outlive the pairing or the vault they began under must not
 * reach past it: a held DELETE never drops a newer pairing, and a held code
 * exchange never seals its key into another vault's tomb.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EgressPort } from "../capabilities/runtime-contract.js";
import { kvDelete } from "../kv.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { vaultStore } from "../vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  lockTomb,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "../vfs.js";
import {
  currentPluginPairing,
  keepPluginPairing,
  subscribePluginPairing,
} from "./plugin-daemon-store.js";
import { pluginDaemonSeams, tailnetPluginDaemon } from "./plugin-daemon.js";
import {
  type PluginDaemonPairing,
  formatPluginPairingCode,
  readPluginDaemonConfig,
} from "./plugin-pairing.js";

const PASSWORD = "correct horse battery staple";
const PAGES = "https://tyler-r-kendrick.github.io";
const KEY_X = "UGx1Z2luLWRhZW1vbi1rZXktbm90LWEtcmVhbC0wMSE";
const KEY_Y = "UGx1Z2luLWRhZW1vbi1rZXktbm90LWEtcmVhbC0wMiE";
const KEY_Z = "UGx1Z2luLWRhZW1vbi1rZXktbm90LWEtcmVhbC0wMyE";
const CODE = "UGx1Z2luLXBhaXJpbmctY29kZS1ub3QtcmVhbC0wMSE";
const pairingFor = (token: string): PluginDaemonPairing => ({
  url: "https://desk.tail4c2e.ts.net",
  token,
  origin: PAGES,
  label: "Desk",
});
const PASTED = formatPluginPairingCode({
  url: "https://desk.tail4c2e.ts.net",
  code: CODE,
  origin: PAGES,
  label: "Desk",
});
const OTHER_TOMB = "project-4f2a";
const signal = new AbortController().signal;

/** An egress whose answers the test releases by hand. */
function heldEgress() {
  const waiting: Array<(response: Response) => void> = [];
  const egress: EgressPort = {
    fetch: () =>
      new Promise<Response>((resolve) => {
        waiting.push(resolve);
      }),
  };
  return { egress, waiting };
}

const issued = (token: string) =>
  new Response(JSON.stringify({ id: "4f2a", origin: PAGES, token }), {
    status: 201,
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: () => void = () => {};

beforeEach(async () => {
  await vfsFlush();
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  vi.spyOn(localNetworkFetchSeams, "eligible").mockReturnValue(true);
  vi.spyOn(pluginDaemonSeams, "pageOrigin").mockReturnValue(PAGES);
  await vaultStore.create(PASSWORD);
  stop = subscribePluginPairing(() => {});
});

afterEach(() => {
  stop();
  if (vaultStore.isUnlocked()) vaultStore.lock();
  vi.restoreAllMocks();
});

describe("forgetting while the pairing moves", () => {
  it("leaves a pairing made while the DELETE was out in force, in memory and in the vault", async () => {
    await keepPluginPairing(pairingFor(KEY_X));
    const { egress, waiting } = heldEgress();
    const daemon = tailnetPluginDaemon(egress, "agents.surrogate-credentials");
    const forgetting = daemon.forget?.(signal);
    await settle();
    expect(waiting).toHaveLength(1);
    await keepPluginPairing(pairingFor(KEY_Y));
    waiting[0]?.(new Response(null, { status: 204 }));
    await forgetting;
    expect(currentPluginPairing()).toEqual(pairingFor(KEY_Y));
    expect(await readPluginDaemonConfig(vaultStore.activeTomb())).toEqual(
      pairingFor(KEY_Y),
    );
  });

  it("still forgets the pairing it was issued for", async () => {
    await keepPluginPairing(pairingFor(KEY_X));
    const { egress, waiting } = heldEgress();
    const daemon = tailnetPluginDaemon(egress, "agents.surrogate-credentials");
    const forgetting = daemon.forget?.(signal);
    await settle();
    waiting[0]?.(new Response(null, { status: 204 }));
    await forgetting;
    expect(currentPluginPairing()).toBeNull();
    expect(await readPluginDaemonConfig(vaultStore.activeTomb())).toBeNull();
  });
});

describe("pairing while the vault or the pairing moves", () => {
  it("seals nothing into another vault's tomb when the vault switched during the exchange", async () => {
    const { egress, waiting } = heldEgress();
    const daemon = tailnetPluginDaemon(egress, "agents.surrogate-credentials");
    const home = vaultStore.activeTomb();
    const pairing = daemon.pair?.(PASTED, signal);
    const refused = expect(pairing).rejects.toMatchObject({ code: "locked" });
    await settle();
    unlockTomb(
      OTHER_TOMB,
      await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]),
    );
    vi.spyOn(vaultStore, "activeTomb").mockReturnValue(OTHER_TOMB);
    waiting[0]?.(issued(KEY_Z));
    await refused;
    expect(await readPluginDaemonConfig(OTHER_TOMB)).toBeNull();
    vi.mocked(vaultStore.activeTomb).mockRestore();
    lockTomb(OTHER_TOMB);
    expect(currentPluginPairing()).toBeNull();
    expect(await readPluginDaemonConfig(home)).toBeNull();
  });

  it("refuses, and replaces nothing, when the pairing moved during the exchange", async () => {
    const { egress, waiting } = heldEgress();
    const daemon = tailnetPluginDaemon(egress, "agents.surrogate-credentials");
    const pairing = daemon.pair?.(PASTED, signal);
    const refused = expect(pairing).rejects.toMatchObject({
      code: "target-changed",
    });
    await settle();
    await keepPluginPairing(pairingFor(KEY_Y));
    waiting[0]?.(issued(KEY_Z));
    await refused;
    expect(currentPluginPairing()).toEqual(pairingFor(KEY_Y));
    expect(await readPluginDaemonConfig(vaultStore.activeTomb())).toEqual(
      pairingFor(KEY_Y),
    );
  });

  it("seals the key when nothing moved", async () => {
    const { egress, waiting } = heldEgress();
    const daemon = tailnetPluginDaemon(egress, "agents.surrogate-credentials");
    const pairing = daemon.pair?.(PASTED, signal);
    await settle();
    waiting[0]?.(issued(KEY_Z));
    await pairing;
    expect(currentPluginPairing()).toEqual(pairingFor(KEY_Z));
  });
});
