import {
  InMemoryWalletRegistrationStore,
  type WalletLauncherArtifact,
  type WalletLauncherCapabilities,
  type WalletLauncherInput,
  type WalletLauncherProvider,
} from "@opensesame/wallet";
import { describe, expect, it } from "vitest";
import {
  WalletRegistrationRefused,
  createWalletRegistrationService,
} from "./wallet-registration.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");

/**
 * A scripted launcher provider. It never touches a network; each method records
 * what it was asked so a test can assert the service's ordering, and its
 * `disableLauncher` throws so a test can prove local disablement stands even
 * when the vendor call fails.
 */
class FakeLauncherProvider implements WalletLauncherProvider {
  issued: WalletLauncherInput[] = [];
  provisioned: WalletLauncherInput[] = [];
  disabled: string[] = [];
  disableThrows = false;
  private readonly caps: WalletLauncherCapabilities;

  constructor(caps?: Partial<WalletLauncherCapabilities>) {
    this.caps = {
      provider: "fake",
      available: true,
      issue: true,
      rotatingBarcode: caps?.rotatingBarcode ?? true,
      disable: caps?.disable ?? true,
    };
  }

  capabilities(): WalletLauncherCapabilities {
    return { ...this.caps };
  }

  issueLauncher(input: WalletLauncherInput): Promise<WalletLauncherArtifact> {
    this.issued.push(input);
    return Promise.resolve({
      provider: "fake",
      saveUrl: `https://pay.google.com/gp/v/save/${input.registrationId}`,
      passId: `338800.l_${input.registrationId}`,
    });
  }

  provisionRotatingBarcode(input: WalletLauncherInput): Promise<void> {
    this.provisioned.push(input);
    return Promise.resolve();
  }

  disableLauncher(input: { registrationId: string }): Promise<void> {
    this.disabled.push(input.registrationId);
    if (this.disableThrows) {
      return Promise.reject(new Error("walletobjects.googleapis.com down"));
    }
    return Promise.resolve();
  }
}

function harness(provider = new FakeLauncherProvider()) {
  const store = new InMemoryWalletRegistrationStore(() => NOW);
  const service = createWalletRegistrationService({ provider, store });
  return { provider, store, service };
}

const INPUT = {
  ownerPrincipalId: "prn_alice",
  registrationId: "dev-laptop",
  header: "Tyler's laptop",
};

describe("register — persistent, idempotent, owned", () => {
  it("issues a launcher link and records it active", async () => {
    const { service, store } = harness();
    const result = await service.register(INPUT);
    expect(result.reissued).toBe(false);
    expect(result.saveUrl).toContain("/save/dev-laptop");
    expect(result.registration.state).toBe("active");
    expect(await store.get("dev-laptop")).toMatchObject({ state: "active" });
  });

  it("re-issues for the same id and owner rather than duplicating", async () => {
    const { service, provider } = harness();
    await service.register(INPUT);
    const again = await service.register(INPUT);
    expect(again.reissued).toBe(true);
    // Two links signed, one record.
    expect(provider.issued).toHaveLength(2);
    expect(await harness().store.list("prn_alice")).toHaveLength(0);
  });

  it("hides a registration owned by another principal", async () => {
    const { service } = harness();
    await service.register(INPUT);
    await expect(
      service.register({ ...INPUT, ownerPrincipalId: "prn_bob" }),
    ).rejects.toMatchObject({ reason: "owned_by_another" });
  });

  it("refuses to silently re-enable a disabled launcher", async () => {
    const { service } = harness();
    await service.register(INPUT);
    await service.disable("prn_alice", "dev-laptop");
    await expect(service.register(INPUT)).rejects.toBeInstanceOf(
      WalletRegistrationRefused,
    );
  });
});

describe("register — rotating barcode is honestly reported", () => {
  it("provisions when asked and supported", async () => {
    const { service, provider } = harness();
    const result = await service.register({ ...INPUT, rotatingBarcode: true });
    expect(result.rotatingBarcodeProvisioned).toBe(true);
    expect(provider.provisioned).toHaveLength(1);
  });

  it("does not claim to provision when the provider cannot", async () => {
    const provider = new FakeLauncherProvider({ rotatingBarcode: false });
    const { service } = harness(provider);
    const result = await service.register({ ...INPUT, rotatingBarcode: true });
    expect(result.rotatingBarcodeProvisioned).toBe(false);
    expect(provider.provisioned).toHaveLength(0);
  });
});

describe("disable — local first, independent of Google (T-29)", () => {
  it("turns the launcher off even when the Google call fails", async () => {
    const provider = new FakeLauncherProvider();
    provider.disableThrows = true;
    const { service, store } = harness(provider);
    await service.register(INPUT);

    const outcome = await service.disable("prn_alice", "dev-laptop");
    // The local record is disabled regardless of the vendor throwing.
    expect(outcome.registration?.state).toBe("disabled");
    expect(outcome.googleAcknowledged).toBe(false);
    expect(await store.get("dev-laptop")).toMatchObject({ state: "disabled" });
    // The best-effort vendor call was still attempted.
    expect(provider.disabled).toEqual(["dev-laptop"]);
  });

  it("acknowledges Google when the vendor call succeeds", async () => {
    const { service } = harness();
    await service.register(INPUT);
    const outcome = await service.disable("prn_alice", "dev-laptop");
    expect(outcome.registration?.state).toBe("disabled");
    expect(outcome.googleAcknowledged).toBe(true);
  });

  it("is a not-found for a launcher the caller does not own", async () => {
    const { service } = harness();
    await service.register(INPUT);
    const outcome = await service.disable("prn_bob", "dev-laptop");
    expect(outcome.registration).toBeNull();
  });
});
