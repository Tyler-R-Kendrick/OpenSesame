import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost, host } from "../../../../host.js";
import { encryptedOwner } from "../../../__tests__/backup-prf-owner.test-support.js";
import { createWebauthnPrfProtector } from "./webauthn-prf-ops.js";
import { webauthnPrfCapabilities } from "./webauthn-prf.js";
import {
  PhysicalCredential,
  physicalAuthenticator,
} from "./webauthn-prf.physical.test-support.js";

let owner: Awaited<ReturnType<typeof encryptedOwner>>;
let physical: ReturnType<typeof physicalAuthenticator>;
beforeEach(async () => {
  physical = physicalAuthenticator();
  owner = await encryptedOwner(physical.port);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await owner.recoverOwner();
  await owner.close();
});

describe("PRF availability describes physical capability without claiming a key", () => {
  it("handles current, legacy and unavailable physical advertisement APIs honestly", async () => {
    const advertisement = vi.spyOn(PhysicalCredential, "getClientCapabilities");
    const advertised: Record<string, boolean>[] = [
      { "extension:prf": true },
      { prf: true },
    ];
    for (const caps of advertised) {
      advertisement.mockResolvedValueOnce(caps);
      const report = await webauthnPrfCapabilities();
      expect(report.availability).toMatchObject({
        runtime: "available",
        reasonCode: "prf_requires_ceremony",
      });
      expect(report.details).toMatchObject({
        extensionPrf: true,
        usablePrfOutput: false,
      });
    }
    advertisement.mockResolvedValueOnce({ "extension:prf": false });
    expect((await webauthnPrfCapabilities()).availability).toMatchObject({
      runtime: "unavailable",
      reasonCode: "prf_extension_unavailable",
    });
    advertisement.mockResolvedValueOnce({});
    expect((await webauthnPrfCapabilities()).details.extensionPrf).toBe(
      "unknown",
    );
    advertisement.mockResolvedValueOnce(overlapCast(null));
    expect((await webauthnPrfCapabilities()).details.extensionPrf).toBe(
      "unknown",
    );
    advertisement.mockRejectedValueOnce(
      new Error("fixture native advertisement unavailable"),
    );
    expect((await webauthnPrfCapabilities()).details.extensionPrf).toBe(
      "unknown",
    );
    const current = host();
    configureHost({
      ...current,
      authenticator: {
        credentials: { create: physical.create, get: physical.get },
        publicKeyCredential: overlapCast(class LegacyCredential {}),
      },
    });
    expect((await webauthnPrfCapabilities()).details.extensionPrf).toBe(
      "unknown",
    );
    configureHost({ ...current, authenticator: {} });
    expect((await webauthnPrfCapabilities()).availability).toMatchObject({
      runtime: "unavailable",
      reasonCode: "webauthn_missing",
    });
    expect(createWebauthnPrfProtector().capabilities()).toMatchObject({
      runtime: "unavailable",
      reasonCode: "webauthn_missing",
    });
    configureHost(current);
  });

  it("does not mistake an enabled extension or bad relying host for usable PRF output", async () => {
    const enabled = await webauthnPrfCapabilities({
      extensionResults: overlapCast({ prf: { enabled: true } }),
    });
    expect(enabled.details).toMatchObject({
      prfExtensionAdvertised: true,
      usablePrfOutput: false,
    });
    expect(enabled.availability.reasonCode).toBe("prf_requires_ceremony");
    const output = await webauthnPrfCapabilities({
      extensionResults: overlapCast({
        prf: { results: { first: physical.output } },
      }),
    });
    expect(output.details.usablePrfOutput).toBe(true);
    expect(output.availability.reasonCode).toBe("prf_output_ready");
    const invalid = await webauthnPrfCapabilities({
      hostname: "127.0.0.1",
      href: "http://127.0.0.1/",
    });
    expect(invalid.availability).toMatchObject({
      runtime: "unavailable",
      reasonCode: "invalid_webauthn_host",
    });
    const unavailable = await webauthnPrfCapabilities({
      clientCapabilities: { extensions: { prf: false } },
    });
    expect(unavailable.availability.reasonCode).toBe(
      "prf_extension_unavailable",
    );
  });
});
