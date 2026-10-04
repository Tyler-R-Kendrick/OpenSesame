/**
 * A vault that travels takes its device identity key with it (ADR 0143, ADR
 * 0160 §5). Travel moves every file of a tomb by its storage name, not by a
 * list of modules, so `config/device-identity-key` goes and comes back byte for
 * byte: sealed under the vault key, bound to the tomb, the same principal.
 */

import { describe, expect, it } from "vitest";
import { openTravelBundle } from "./bundle-format.js";
import { parseReturnCode } from "./return-code.js";
import { completeReturn, openReturn } from "./return.js";
import { vaultNamespace } from "./storage.js";
import {
  PRJ_TRIP,
  PRJ_WORK,
  depart,
  packedDevice,
  tombFile,
} from "./travel.test-support.js";

const KEY_FILE = "config/device-identity-key";
const SEALED_KEY = '{"ivB64":"key-iv","ctB64":"key-ciphertext"}';

describe("travel and the device identity key", () => {
  it("packs the key file with the vault, takes it off the device and puts it back unchanged", async () => {
    const origin = packedDevice();
    const file = tombFile(PRJ_WORK, KEY_FILE);
    origin.files.set(file, SEALED_KEY);

    const { pkg } = await depart(origin, [PRJ_TRIP]);
    // Gone from the device with the rest of the vault it belongs to.
    expect(origin.files.has(file)).toBe(false);

    const bundle = await openTravelBundle(
      pkg.bundleJson,
      await parseReturnCode(pkg.returnCode),
      vaultNamespace([PRJ_TRIP, "personal", PRJ_WORK]),
    );
    const work = bundle.vaults.find((vault) => vault.id === PRJ_WORK);
    expect(work?.files.find((entry) => entry.file === file)?.text).toBe(
      SEALED_KEY,
    );

    const opened = await openReturn(origin.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: pkg.returnCode,
    });
    if (!opened.ok) throw new Error(opened.code);
    await completeReturn(origin.deps, opened.opened);
    expect(origin.files.get(file)).toBe(SEALED_KEY);
  });
});
