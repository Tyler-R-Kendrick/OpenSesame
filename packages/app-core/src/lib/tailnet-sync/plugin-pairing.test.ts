import { mintVaultKey } from "@opensesame/vault-core";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import spec from "../../../../../spec/conformance/plugin-pairing.json" with {
  type: "json",
};
import { kvGet } from "../kv.js";
import { lockAllTombs, tombFileKey, unlockTomb, vfsFlush } from "../vfs.js";
import {
  PLUGIN_DAEMON_CONFIG_PATH,
  PLUGIN_PAIRING_EXCHANGE_PATH,
  PLUGIN_PAIRING_PREFIX,
  type PluginDaemonPairing,
  formatPluginPairingCode,
  isPairableOrigin,
  parsePluginPairingCode,
  readPluginDaemonConfig,
  writePluginDaemonConfig,
} from "./plugin-pairing.js";

type Case = Readonly<{
  url: string;
  code: string;
  origin: string;
  label: string;
  text: string;
}>;
type Spec = Readonly<{
  prefix: string;
  exchangePath: string;
  example: Case;
  localExample: Case;
  refused: readonly Readonly<{ name: string; text: string }>[];
}>;

const SPEC: Spec = spec;

const TOKEN = "UGx1Z2luLWRhZW1vbi1rZXktbm90LWEtcmVhbC0wMSE"; // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier

describe("the plugin pairing code, as the CLI prints it", () => {
  it("shares the prefix and the exchange route with the daemon", () => {
    expect(PLUGIN_PAIRING_PREFIX).toBe(SPEC.prefix);
    expect(PLUGIN_PAIRING_EXCHANGE_PATH).toBe(SPEC.exchangePath);
  });

  for (const key of ["example", "localExample"] as const) {
    it(`reads the ${key} vector and writes the same bytes back`, () => {
      const { text, ...fields } = SPEC[key];
      expect(parsePluginPairingCode(text)).toEqual(fields);
      expect(formatPluginPairingCode(fields)).toBe(text);
    });
  }

  for (const refused of SPEC.refused) {
    it(`refuses ${refused.name}`, () => {
      expect(parsePluginPairingCode(refused.text)).toBeNull();
    });
  }

  it("names only an origin exactly as a browser sends it", () => {
    for (const good of [
      "https://tyler-r-kendrick.github.io",
      "https://example.com:8443",
      "http://localhost:5180",
    ])
      expect(isPairableOrigin(good), good).toBe(true);
    for (const bad of [
      "https://tyler-r-kendrick.github.io/",
      "https://example.com:443",
      "http://127.0.0.1:5180",
      "http://localhost",
      "null",
      "",
    ])
      expect(isPairableOrigin(bad), bad).toBe(false);
  });
});

describe("the traded key, sealed in the vault", () => {
  const pairing: PluginDaemonPairing = {
    url: "https://desk.tail4c2e.ts.net",
    token: TOKEN,
    origin: "https://tyler-r-kendrick.github.io",
    label: "Desk",
  };

  beforeEach(() => {
    vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
    vi.stubGlobal(
      "ArrayBuffer",
      new TextEncoder().encode("").buffer.constructor,
    );
  });

  afterEach(() => {
    lockAllTombs();
    vi.unstubAllGlobals();
  });

  async function openTomb(): Promise<string> {
    const tomb = `plugins-${crypto.randomUUID()}`;
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    return tomb;
  }

  it("round-trips, and the key never reaches storage in the clear", async () => {
    const tomb = await openTomb();
    await writePluginDaemonConfig(tomb, pairing);
    await vfsFlush();
    const stored = kvGet(tombFileKey(tomb, PLUGIN_DAEMON_CONFIG_PATH));
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain("desk.tail4c2e");
    expect(await readPluginDaemonConfig(tomb)).toEqual(pairing);
  });

  it("reads nothing once it is forgotten, and nothing from a locked vault", async () => {
    const tomb = await openTomb();
    await writePluginDaemonConfig(tomb, pairing);
    await writePluginDaemonConfig(tomb, null);
    expect(await readPluginDaemonConfig(tomb)).toBeNull();
    await writePluginDaemonConfig(tomb, pairing);
    lockAllTombs();
    await expect(readPluginDaemonConfig(tomb)).rejects.toThrow();
  });

  it("drops a stored pairing that points off the tailnet", async () => {
    const tomb = await openTomb();
    await writePluginDaemonConfig(tomb, {
      ...pairing,
      url: "https://attacker.example",
    });
    expect(await readPluginDaemonConfig(tomb)).toBeNull();
  });
});
